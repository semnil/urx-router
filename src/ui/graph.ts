// SVG node-graph editor. Renders the device as boxes + wires, drags nodes, draws
// wires only along legal routes, and highlights legal targets while connecting.
// Visual attributes are inline so the PNG export matches.

import type { DeviceModel, DeviceNode, NodeKind, PortDirection } from "../models/types";
import { fullLabel, hangsUnderHeader, isSingleInput, parseRef, ref } from "../models/types";
import type { Plan, PlanConnection } from "../core/plan";
import { hasConnection, LEVEL_MIN_DB, removeConnection } from "../core/plan";
import { canConnect, isFixedConnection, legalSources, legalTargets, pairPrimary, partnerChannel, possibleSources, possibleTargets, ruleKind, sendHasTap, upstreamNodes } from "../core/routing";
import { baseName, exportSvgToPdf, exportSvgToPng } from "../core/storage";
import type { SaveResult } from "../core/storage";
import { oscAssign } from "../core/control/translate";
import { SD_REC_TRACK_COUNT_DEFAULT } from "../core/control/params";
import { t } from "../i18n";

const SVGNS = "http://www.w3.org/2000/svg";

const NODE_W = 184;
const NODE_H = 44;
const COL_GAP = 256;
const ROW_GAP = 60;
const MARGIN = 40;

// Vertical gap between a parent channel and the ducker hung directly under it.
const DUCKER_GAP = 8;

// Visible jack radius is 6; the clickable target is widened to this so the
// small connector is easy to grab. Stays within the column/row gaps so the
// halos of neighboring ports never overlap.
const PORT_HIT_R = 14;

// Visible wire is 2-3.5px; the clickable band along it is widened to this so
// the thin curve is easy to select.
const WIRE_HIT_W = 14;

// Pointer travel (screen px) past which a port press becomes a connect drag
// rather than a click. A click on an input port selects its incoming wire.
const DRAG_THRESHOLD = 4;

// A node press held this long (ms) without moving past LONG_PRESS_TOLERANCE (px)
// traces the node's signal path instead of selecting / dragging it. The tolerance
// lets the press survive a little jitter before it commits to a drag.
const LONG_PRESS_MS = 450;
const LONG_PRESS_TOLERANCE = 6;

// Zoom bounds shared by the wheel, pinch, and fit-to-view paths.
const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2.5;

const LABEL_FONT = '"SF Mono", "SFMono-Regular", "Menlo", "Cascadia Code", "Consolas", monospace';

// Label geometry. The label starts at LABEL_X and must clear the header button,
// whose visible box begins at NODE_W-25-8; a wider single line is scaled down to
// fit. A node with a sublabel stacks two tiers within the fixed header height.
const LABEL_X = 24;
const LABEL_MAX_W = NODE_W - 25 - 8 - 5 - LABEL_X; // 122
const MONO_ADVANCE = 0.6; // monospace glyph advance as a fraction of font size
const LABEL_MIN_SCALE = 0.7;
const LABEL_FS = 12;
const LABEL_SUB_FS = 9;
const LABEL_TIER1_Y = 16;
const LABEL_TIER2_Y = 32;

// Note panel: an annotation area that lives INSIDE the node frame, below the
// header, separated by a seam. The node grows to contain it; it can be collapsed
// to the header alone and re-expanded with the header button.
const NOTE_INSET = 9; // well inset from the node's left/right edges
const NOTE_PAD_X = 10; // text inset inside the well
const NOTE_PAD_Y = 9; // text inset inside the well (vertical)
const NOTE_TOP_GAP = 4; // gap between the header seam and the well
const NOTE_BOT_GAP = 5; // gap between the well and the node's bottom edge
const NOTE_LINE_H = 15;
const NOTE_MAX_CHARS = 21;
const NOTE_MAX_LINES = 6;
const NOTE_FONT_SIZE = 11;

export type ThemeName = "dark" | "light";
/** Which name the canvas shows on each node: the planner's fixed label
 *  ("CH 1") or the device CH SETTING name ("ch 1"). */
export type LabelSource = "model" | "device";

interface Palette {
  /** Single brushed-metal node fill; the kind is shown by the rail color. */
  nodeFill: string;
  nodeStroke: string;
  nodeHi: string;
  rail: Record<NodeKind, string>;
  screwFill: string;
  screwStroke: string;
  label: string;
  /** Jack-socket hole and (unconnected) pin. */
  portOuter: string;
  portPinOff: string;
  wire: Record<string, string>;
  tempWire: string;
  /** Legal-target highlight shown on input ports while connecting. */
  legalFill: string;
  legalStroke: string;
  /** "Could route, but occupied" highlight: outline only, no fill, so a full
   *  target reads as a possibility without looking connectable. */
  possibleStroke: string;
  /** Outline for nodes unavailable at the current sample rate. */
  warn: string;
  /** Accent for the PRE (pre-fader) send marker; the brand LED amber. */
  pre: string;
  /** In-frame note panel: recessed-well tint and ink. */
  noteWell: string;
  noteInk: string;
}

const PALETTES: Record<ThemeName, Palette> = {
  dark: {
    nodeFill: "#221b12",
    nodeStroke: "#4a3d27",
    nodeHi: "rgba(255,255,255,0.05)",
    rail: { input: "#3f7fb0", channel: "#9a6fc0", bus: "#5fb088", output: "#c79a4e", ducker: "#cf6f7e" },
    screwFill: "#0e0b07",
    screwStroke: "#5a4b30",
    label: "#f1e8d6",
    portOuter: "#0c0a07",
    portPinOff: "#241d12",
    wire: { source: "#59b2ff", send: "#76d690", sendSwitch: "#4fc8b0", patch: "#ffb347", key: "#59b2ff", record: "#b58fe0" },
    tempWire: "#caa86a",
    legalFill: "#1d3b2a",
    legalStroke: "#7fd0a0",
    possibleStroke: "#5a7d6a",
    warn: "#e2794e",
    pre: "#ffc24d",
    noteWell: "rgba(0,0,0,0.24)",
    noteInk: "#e9ddc3",
  },
  light: {
    nodeFill: "#f4efe5",
    nodeStroke: "#b7a884",
    nodeHi: "rgba(255,255,255,0.92)",
    rail: { input: "#2f6f9e", channel: "#7a4fa0", bus: "#2f8f63", output: "#b07a1e", ducker: "#b04a5e" },
    screwFill: "#a99c80",
    screwStroke: "#857a5e",
    label: "#2a2418",
    portOuter: "#d9d0bd",
    portPinOff: "#cabd9f",
    wire: { source: "#1f6fc8", send: "#1f8a52", sendSwitch: "#13836f", patch: "#b8700a", key: "#1f6fc8", record: "#7a52c0" },
    tempWire: "#9a8d70",
    legalFill: "#cde7d6",
    legalStroke: "#2f8f63",
    possibleStroke: "#8fb6a0",
    warn: "#c2531f",
    pre: "#e8920f",
    noteWell: "rgba(95,78,42,0.10)",
    noteInk: "#3c3320",
  },
};

export type Selection =
  | { type: "node"; id: string }
  | { type: "conn"; from: string; to: string }
  | null;

export interface GraphCallbacks {
  onSelect: (sel: Selection) => void;
  onStatus: (message: string) => void;
  onChange: () => void;
  // Fired whenever the shelved-node set changes, so the host can persist it.
  onHiddenChange: (hidden: string[]) => void;
}

interface Pt {
  x: number;
  y: number;
}

export class Graph {
  private svg!: SVGSVGElement;
  private viewport!: SVGGElement;
  private wireLayer!: SVGGElement;
  private nodeLayer!: SVGGElement;
  private overlay!: SVGGElement;
  private shelf!: HTMLDivElement;
  // Floating contextual bar shown while several nodes are multi-selected.
  private selbar!: HTMLDivElement;
  private host!: HTMLElement;

  private model: DeviceModel;
  private plan: Plan;
  private readonly cb: GraphCallbacks;

  private nodeById = new Map<string, DeviceNode>();
  private nodeEls = new Map<string, SVGGElement>();
  private portEls = new Map<string, SVGCircleElement>();
  private portPinEls = new Map<string, SVGCircleElement>();
  // STEREO-link tie elements, keyed by the pair's primary (odd) channel id, so a
  // drag can redraw the tie in place as the pair moves.
  private stereoLinkEls = new Map<string, SVGGElement>();

  private palette: Palette = PALETTES.dark;
  private themeName: ThemeName = "dark";
  // Which name the canvas shows: the planner's fixed label ("CH 1") or the
  // device CH SETTING name held in plan.nodeNames ("ch 1"). Default is the
  // planner label, so the device names a fetch/seed brings in are opt-in.
  private labelSource: LabelSource = "model";
  // Hide the off / -∞ sends (params.on === false or level at -∞) from the canvas.
  // Off by default so every fixed send shows (dimmed); the toolbar toggle declutters
  // a board where most of the always-wired CH → MIX/FX sends sit at -∞.
  private hideOffSends = false;
  private disabledNodes = new Set<string>();
  // Nodes still showing their plan default after a device readback (a body read
  // failed). Mirrors plan.unreadNodes; empty when the plan has no device
  // provenance (new / loaded / hand-edited plan).
  private unreadNodes = new Set<string>();
  // Node ids collapsed off the canvas into the bottom shelf. Kept in sync with
  // plan.hidden; a node is only actually hidden while it has no connections.
  private hidden = new Set<string>();
  // Node ids whose in-frame note panel is minimized to the header. Synced with
  // plan.noteCollapsed.
  private collapsed = new Set<string>();

  private pan: Pt = { x: 0, y: 0 };
  private zoom = 1;
  // Auto-fit the diagram to the viewport until the user pans or zooms by hand.
  // A ResizeObserver re-fits on the first real layout (the webview can report a
  // stale size during construction) and on window resize while this stays true.
  private autoFit = true;
  private selection: Selection = null;
  // Ctrl/Cmd-click builds a multi-selection of nodes to shelve together. The
  // anchor (shown in the inspector) is selection.id; this set holds it plus any
  // others. Empty whenever selection is a connection or null.
  private selectedNodes = new Set<string>();
  // Path-trace highlight: the upstream signal closure of a double-clicked node
  // (the node plus every input/channel/bus that feeds it through live wiring).
  // Empty when no trace is active. Independent of the selection; cleared by any
  // selection change so it never lingers behind a fresh focus.
  private pathNodes = new Set<string>();

  // transient interaction state. `link` is a STEREO-linked, visible partner that
  // moves with the dragged node (keeping its offset), plus the pair to redraw the
  // tie for. Null when the dragged node has no visible linked partner.
  private dragNode: {
    id: string;
    grabDx: number;
    grabDy: number;
    link: { partner: string; dx: number; dy: number; pair: [string, string] } | null;
    // True once the pointer actually moved the node, so a plain select-click (no
    // movement) does not mark the plan dirty.
    moved: boolean;
  } | null = null;
  // A port press: starts as "pending", becomes a "connecting" rubber-band once
  // dragged past the threshold, or "noop" if the dragged port has no legal
  // partner. On release a non-connecting input press selects its incoming wire.
  private connect:
    | { ref: string; dir: PortDirection; startX: number; startY: number; mode: "pending" | "connecting" | "noop" }
    | null = null;
  private tempWire: SVGPathElement | null = null;
  private panning: { startX: number; startY: number; panX: number; panY: number } | null = null;
  // Active touch points, used to detect a two-finger pinch. While two are down a
  // pinch zooms/pans the canvas and single-pointer gestures are suspended.
  private pointers = new Map<number, { x: number; y: number }>();
  // left/top cache the svg's viewport origin for the gesture: it never moves
  // (the pinch transforms an inner <g>), so reading it once avoids a forced
  // reflow on every move frame.
  private pinch: { lastDist: number; lastCx: number; lastCy: number; left: number; top: number } | null = null;
  // Floating HTML textarea for editing a node's note in place on the canvas.
  private noteEditor: { id: string; el: HTMLTextAreaElement } | null = null;
  // In-flight long-press on a node: a timer that traces the node's signal path if
  // the pointer holds still for LONG_PRESS_MS. Cleared the moment the pointer moves
  // past the tolerance (the press became a drag) or lifts (it was a plain click).
  private longPress: { id: string; timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
  // Last node pointerdown, used to detect a double-press that opens the note editor.
  // A real dblclick event is unreliable here: onPointerDown calls preventDefault(),
  // which suppresses the browser's compatibility mouse events.
  private lastNodeClick: { id: string; time: number } | null = null;

  constructor(host: HTMLElement, model: DeviceModel, plan: Plan, cb: GraphCallbacks) {
    this.model = model;
    this.plan = plan;
    this.hidden = new Set(plan.hidden);
    this.collapsed = new Set(plan.noteCollapsed);
    this.cb = cb;
    this.syncUnread();
    this.buildScaffold(host);
    this.render();
    this.fitView();
  }

  setModel(model: DeviceModel, plan: Plan): void {
    this.model = model;
    this.plan = plan;
    this.hidden = new Set(plan.hidden);
    this.collapsed = new Set(plan.noteCollapsed);
    this.selection = null;
    this.selectedNodes.clear();
    this.syncUnread();
    this.render();
    this.fitView();
  }

  /** Re-render the current (same-reference) plan after it was mutated in place —
   *  e.g. a device-follow readback. Unlike setModel this keeps the selection and
   *  viewport, so reflecting a device-side change does not disturb the user. */
  refresh(): void {
    this.syncUnread();
    this.render();
  }

  // Mirror the plan's device provenance: plan.unreadNodes holds exactly the nodes
  // whose body read failed. No provenance (a plan never fetched) means nothing is
  // flagged.
  private syncUnread(): void {
    this.unreadNodes = new Set(this.plan.unreadNodes ?? []);
  }

  setTheme(name: ThemeName): void {
    this.palette = PALETTES[name];
    this.themeName = name;
    this.render();
  }

  /** Choose whether the canvas shows planner labels or device names. */
  setLabelSource(source: LabelSource): void {
    this.labelSource = source;
    this.render();
  }

  /** Whether the canvas hides off / -∞ sends (toolbar declutter toggle). */
  isHideOffSends(): boolean {
    return this.hideOffSends;
  }

  /** Show or hide the off / -∞ sends; repaints the wires. */
  setHideOffSends(hide: boolean): void {
    this.hideOffSends = hide;
    this.redrawWires();
  }

  /** Mark nodes unavailable at the current sample rate (dimmed + dashed outline). */
  setDisabledNodes(ids: string[]): void {
    this.disabledNodes = new Set(ids);
    this.render();
  }

  /** Repaint nodes after a node-parameter change (e.g. a channel muted). */
  repaintNodes(): void {
    this.renderNodes();
    // renderNodes rebuilds every node with its jacks reset to off; restore the lit
    // ports and the selection frame, as render() and the note repaints do.
    this.refreshPortStates();
    this.highlightSelectedNode();
  }

  /** Set or clear a node's free-text note and repaint its in-frame panel. */
  setNote(id: string, text: string): void {
    this.plan.notes ??= {};
    if (text.trim()) {
      this.plan.notes[id] = text;
    } else {
      delete this.plan.notes[id];
      // A note-less node has nothing to collapse; drop any stale collapse flag.
      if (this.collapsed.delete(id)) this.plan.noteCollapsed = [...this.collapsed];
    }
    this.renderNodes();
    this.refreshPortStates();
    this.highlightSelectedNode();
  }

  /** Minimize a node's note to its header, or re-expand it. */
  toggleNoteCollapse(id: string): void {
    if (!this.noteLines(id).length) return;
    const nowCollapsed = !this.collapsed.has(id);
    if (nowCollapsed) this.collapsed.add(id);
    else this.collapsed.delete(id);
    this.plan.noteCollapsed = [...this.collapsed];
    if (this.noteEditor?.id === id) {
      this.closeNoteEditor();
    } else {
      this.renderNodes();
      this.refreshPortStates();
      this.highlightSelectedNode();
    }
    this.cb.onChange();
    this.cb.onStatus(nowCollapsed ? t().status.noteMinimized : t().status.noteExpanded);
  }

  // --- inline note editing -------------------------------------------------

  /** Open a floating textarea over the node's note panel, editing in context. */
  private openNoteEditor(id: string): void {
    this.closeNoteEditor();
    this.select({ type: "node", id });
    // Editing always shows the panel, so un-collapse first.
    if (this.collapsed.delete(id)) this.plan.noteCollapsed = [...this.collapsed];
    const ta = document.createElement("textarea");
    ta.className = "note-edit-overlay";
    ta.value = this.plan.notes?.[id] ?? "";
    ta.placeholder = t().inspector.notesPlaceholder;
    ta.spellcheck = false;
    this.host.append(ta);
    this.noteEditor = { id, el: ta };
    // Re-render so the panel's text is hidden behind the editor.
    this.renderNodes();
    this.refreshPortStates();
    this.highlightSelectedNode();
    this.positionNoteEditor();
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);

    ta.addEventListener("input", () => {
      this.setNote(id, ta.value);
      this.cb.onChange();
    });
    ta.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Escape" || (e.key === "Enter" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        this.closeNoteEditor();
      }
    });
    ta.addEventListener("blur", () => this.closeNoteEditor());
    ta.addEventListener("pointerdown", (e) => e.stopPropagation());
  }

  /** Keep the open editor pinned over its node's panel through pan / zoom. */
  private positionNoteEditor(): void {
    const ed = this.noteEditor;
    if (!ed) return;
    const pos = this.posOf(ed.id);
    ed.el.style.left = `${this.pan.x + (pos.x + NOTE_INSET) * this.zoom}px`;
    ed.el.style.top = `${this.pan.y + (pos.y + NODE_H + NOTE_TOP_GAP) * this.zoom}px`;
    ed.el.style.width = `${Math.max((NODE_W - NOTE_INSET * 2) * this.zoom, 156)}px`;
  }

  private closeNoteEditor(): void {
    const ed = this.noteEditor;
    if (!ed) return;
    this.noteEditor = null;
    ed.el.remove();
    // Restore the panel text now that its editor is gone.
    this.renderNodes();
    this.refreshPortStates();
    this.highlightSelectedNode();
  }

  /** Center and scale the diagram to fit the current viewport. */
  fitView(): void {
    const rect = this.svg.getBoundingClientRect();
    const vw = rect.width || 1000;
    // Keep the framed content clear of the hidden-node shelf when it is open.
    const reserved = this.shelf.style.display === "none" ? 0 : this.shelf.offsetHeight;
    const vh = (rect.height || 700) - reserved;
    const b = this.contentBounds();
    const pad = 48;
    const zoom = Math.min(vw / (b.w + pad * 2), vh / (b.h + pad * 2), 1.2);
    this.zoom = Math.max(ZOOM_MIN, zoom);
    this.pan.x = (vw - b.w * this.zoom) / 2 - b.x * this.zoom;
    this.pan.y = (vh - b.h * this.zoom) / 2 - b.y * this.zoom;
    // An intentional fit (construction, model change, hide/show) becomes the new
    // baseline the ResizeObserver keeps in sync until the user pans or zooms.
    this.autoFit = true;
    this.applyTransform();
  }

  getPlan(): Plan {
    return this.plan;
  }

  // --- scaffold ------------------------------------------------------------

  private buildScaffold(host: HTMLElement): void {
    host.replaceChildren();
    this.host = host;
    this.svg = document.createElementNS(SVGNS, "svg");
    this.svg.setAttribute("width", "100%");
    this.svg.setAttribute("height", "100%");
    this.svg.style.display = "block";
    this.svg.style.touchAction = "none";

    this.svg.append(makeGlowDefs());

    this.viewport = document.createElementNS(SVGNS, "g");
    this.wireLayer = document.createElementNS(SVGNS, "g");
    this.nodeLayer = document.createElementNS(SVGNS, "g");
    this.overlay = document.createElementNS(SVGNS, "g");
    this.viewport.append(this.wireLayer, this.nodeLayer, this.overlay);
    this.svg.append(this.viewport);
    host.append(this.svg);

    // Bottom "spares rack" of hidden nodes; an HTML overlay so it stays out of
    // the SVG export. Empty until something is hidden (renderShelf toggles it).
    this.shelf = document.createElement("div");
    this.shelf.className = "hidden-shelf";
    this.shelf.style.display = "none";
    host.append(this.shelf);

    // Multi-select action bar; an HTML overlay so it stays out of the SVG export.
    // Empty until two or more nodes are selected (renderSelBar toggles it).
    this.selbar = document.createElement("div");
    this.selbar.className = "sel-bar";
    this.selbar.style.display = "none";
    host.append(this.selbar);

    this.svg.addEventListener("pointerdown", (e) => this.onPointerDown(e));
    this.svg.addEventListener("pointermove", (e) => this.onPointerMove(e));
    this.svg.addEventListener("pointerup", (e) => this.onPointerUp(e));
    this.svg.addEventListener("pointercancel", (e) => this.onPointerCancel(e));
    this.svg.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });

    // The initial fitView() in the constructor can measure a stale viewport size
    // before the webview has applied its stylesheet/layout (notably WKWebView in
    // the desktop build), leaving the diagram clamped to a tiny zoom. Re-fit once
    // the host gets its real size, and on later resizes, until the user takes over.
    new ResizeObserver(() => {
      if (this.autoFit) this.fitView();
    }).observe(host);
  }

  // --- geometry ------------------------------------------------------------

  private defaultPos(node: DeviceNode): Pt {
    return { x: MARGIN + node.pos.col * COL_GAP, y: MARGIN + node.pos.row * ROW_GAP };
  }

  private posOf(nodeId: string): Pt {
    // A hung node always derives its position from its parent — just below it — so
    // it moves as a unit and any saved position is ignored. Several nodes can hang
    // on one parent (the SD Rec track slots under their header): each stacks after
    // the earlier visible siblings, so a shelved/inactive slot collapses the rest
    // up. A ducker is its channel's only child, so this adds nothing for it.
    const node = this.nodeById.get(nodeId);
    if (node?.attachTo) {
      const base = this.posOf(node.attachTo);
      let y = base.y + this.nodeHeight(node.attachTo) + DUCKER_GAP;
      for (const sib of this.model.nodes) {
        if (sib.id === nodeId) break;
        if (sib.attachTo === node.attachTo && !this.isHidden(sib.id)) y += this.nodeHeight(sib.id) + DUCKER_GAP;
      }
      return { x: base.x, y };
    }
    const saved = this.plan.positions[nodeId];
    if (saved) return saved;
    return this.defaultPos(this.nodeById.get(nodeId)!);
  }

  private parentOf(id: string): string | undefined {
    return this.nodeById.get(id)?.attachTo;
  }

  /** All hung children of a node — a single ducker, or every SD Rec track slot
   *  under the recorder header. They move with the parent as a unit. */
  private attachedDescendants(parentId: string): string[] {
    return this.model.nodes.filter((n) => n.attachTo === parentId).map((n) => n.id);
  }

  private portPoint(r: string): Pt {
    const { nodeId, portId } = parseRef(r);
    const node = this.nodeById.get(nodeId)!;
    const base = this.posOf(nodeId);
    const port = node.ports.find((p) => p.id === portId)!;
    const x = port.direction === "in" ? base.x : base.x + NODE_W;
    return { x, y: base.y + NODE_H / 2 };
  }

  private clientToContent(e: PointerEvent): Pt {
    const rect = this.svg.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left - this.pan.x) / this.zoom,
      y: (e.clientY - rect.top - this.pan.y) / this.zoom,
    };
  }

  private applyTransform(): void {
    this.viewport.setAttribute(
      "transform",
      `translate(${this.pan.x} ${this.pan.y}) scale(${this.zoom})`,
    );
    this.positionNoteEditor();
  }

  // --- rendering -----------------------------------------------------------

  render(): void {
    this.closeNoteEditor();
    this.nodeById.clear();
    for (const node of this.model.nodes) this.nodeById.set(node.id, node);
    this.applyTransform();
    this.renderNodes();
    this.refreshPortStates();
    this.redrawWires();
    this.renderShelf();
    this.highlightSelectedNode();
    this.renderSelBar();
  }

  private renderNodes(): void {
    this.nodeLayer.replaceChildren();
    this.nodeEls.clear();
    this.portEls.clear();
    this.portPinEls.clear();
    for (const node of this.model.nodes) {
      if (this.isHidden(node.id)) continue;
      this.nodeLayer.append(this.makeNode(node));
    }
    // STEREO-link ties: a heart connector between the two nodes of a STEREO-linked
    // MONO IN pair (Signal Type), mirroring the device's linked-channel look.
    this.stereoLinkEls.clear();
    for (const [a, b] of this.model.channelPairs) {
      if (!this.plan.nodeParams[a]?.stereoLink) continue;
      if (this.isHidden(a) || this.isHidden(b)) continue;
      this.redrawStereoLink(a, b);
    }
  }

  /** Snap a pair's partner next to the kept node when STEREO-linking, so the heart
   *  tie isn't stretched across a gap left by an earlier manual move. The selected
   *  member stays put; the other moves to its canonical relative offset. */
  alignStereoPair(primary: string): void {
    const partner = partnerChannel(this.model, primary);
    if (!partner) return;
    const keepPartner = this.selection?.type === "node" && this.selection.id === partner;
    const kept = keepPartner ? partner : primary;
    const other = keepPartner ? primary : partner;
    const dk = this.defaultPos(this.nodeById.get(kept)!);
    const dother = this.defaultPos(this.nodeById.get(other)!);
    const kp = this.posOf(kept);
    this.plan.positions[other] = { x: kp.x + (dother.x - dk.x), y: kp.y + (dother.y - dk.y) };
  }

  /** The channelPairs entry [primary, partner] containing `id` when that pair is
   *  STEREO-linked, else null. Used to drag a linked pair as one unit. */
  private linkedPairOf(id: string): [string, string] | null {
    const a = pairPrimary(this.model, id);
    if (!a || !this.plan.nodeParams[a]?.stereoLink) return null;
    return [a, partnerChannel(this.model, a)!];
  }

  // Build (or rebuild) the heart tie for a pair, keyed by its primary `a`, and put
  // it in the node layer — replacing any existing tie. Shared by the full repaint
  // and the live drag so the two stay in sync.
  private redrawStereoLink(a: string, b: string): void {
    const tie = this.makeStereoLink(a, b);
    const old = this.stereoLinkEls.get(a);
    if (old) old.replaceWith(tie);
    else this.nodeLayer.append(tie);
    this.stereoLinkEls.set(a, tie);
  }

  // A decorative heart tie drawn in the gap between a STEREO-linked pair, anchored
  // bottom-center of the upper node to top-center of the lower one.
  private makeStereoLink(a: string, b: string): SVGGElement {
    const pa = this.posOf(a);
    const pb = this.posOf(b);
    const [up, lo] = pa.y <= pb.y ? [pa, pb] : [pb, pa];
    const x1 = up.x + NODE_W / 2;
    const y1 = up.y + NODE_H;
    const x2 = lo.x + NODE_W / 2;
    const y2 = lo.y;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const accent = this.palette.rail.channel;
    const g = document.createElementNS(SVGNS, "g");
    g.style.pointerEvents = "none";
    g.append(svgLine(x1, y1, x2, y2, accent, 2, 0.85));
    const disc = document.createElementNS(SVGNS, "circle");
    disc.setAttribute("cx", String(mx));
    disc.setAttribute("cy", String(my));
    disc.setAttribute("r", "8");
    disc.setAttribute("fill", this.palette.nodeFill);
    disc.setAttribute("stroke", accent);
    disc.setAttribute("stroke-width", "1");
    g.append(disc);
    const heart = document.createElementNS(SVGNS, "text");
    heart.setAttribute("x", String(mx));
    heart.setAttribute("y", String(my));
    heart.setAttribute("text-anchor", "middle");
    heart.setAttribute("dominant-baseline", "central");
    heart.setAttribute("font-size", "10");
    heart.setAttribute("fill", accent);
    heart.textContent = "♥";
    g.append(heart);
    return g;
  }

  // A node is hidden whenever it is shelved; its wires — fixed or editable — are
  // hidden along with it (see redrawWires). A hung child is also hidden whenever
  // its parent is, so a ducker is never shown without its channel.
  private isHidden(id: string): boolean {
    const parent = this.parentOf(id);
    if (parent && this.isHidden(parent)) return true;
    if (this.sdRecSlotInactive(id)) return true;
    return this.hidden.has(id);
  }

  /** A structural child slot (hung under a header — a microSD Rec track slot). It
   *  belongs to the recorder, so "hide unused" leaves it for the header to manage
   *  rather than shelving it loose; the user may still shelve one by hand (it gets
   *  a chip like a ducker). */
  private isStructuralSlot(id: string): boolean {
    return hangsUnderHeader(this.model, id);
  }

  // A microSD Rec track-pair slot beyond the current Track Count is inactive — the
  // device records only Track Count tracks — so it is not drawn. The count is
  // read-only on the device; the planner edits it on the SD Rec header node.
  private sdRecSlotInactive(id: string): boolean {
    const m = /^out\.sdrec\.t(\d+)$/.exec(id);
    if (!m) return false;
    const count = this.plan.nodeParams["out.sdrec"]?.sdRecTrackCount ?? SD_REC_TRACK_COUNT_DEFAULT;
    return Number(m[1]) > Math.floor(count / 2);
  }

  // Whether a node is an endpoint of any wire (fixed sends included).
  private nodeHasWire(id: string): boolean {
    return this.plan.connections.some(
      (c) => parseRef(c.from).nodeId === id || parseRef(c.to).nodeId === id,
    );
  }

  // Whether a connection is an inaudible send: switched off (params.on === false —
  // a CH/FX send or the MIX → STEREO "TO ST"), bound to an inactive node (either
  // endpoint muted / bypassed — a muted channel, a bus/FX/MONITOR master OFF, or a
  // bypassed ducker on its key wire), or a `send` whose level sits at -∞
  // (≤ LEVEL_MIN_DB). Every CH/FX send and the TO ST are fixed now, so this — not
  // wire presence — is what marks one silent. The main fader paths (CH/FX → STEREO)
  // carry no `on` and default to unity, so they only read off when pulled to -∞.
  // OSC → bus carries oscL/oscR (per-bus assign), so its wire also reads off when
  // both its L and R assigns are off — and a muted endpoint (incl. the oscillator
  // off, via isNodeInactive) recedes it too, the same uniform rule every node follows.
  private isOffSend(conn: PlanConnection): boolean {
    if (conn.params?.on === false) return true;
    const fromId = parseRef(conn.from).nodeId;
    const toId = parseRef(conn.to).nodeId;
    const src = this.nodeById.get(fromId);
    const dst = this.nodeById.get(toId);
    if ((src && this.isNodeInactive(src)) || (dst && this.isNodeInactive(dst))) return true;
    // OSC → bus assign: silent when its L (and R, on a stereo bus) are off, even
    // while the oscillator runs. A mono FX bus uses L only (r === null).
    if (fromId === "bus.osc") {
      const a = oscAssign(toId);
      const rOff = !a || a.r === null || conn.params?.oscR === false;
      return conn.params?.oscL === false && rOff;
    }
    if (conn.kind !== "send") return false;
    return (conn.params?.level ?? 0) <= LEVEL_MIN_DB;
  }

  // Whether a node reads as inactive and should be dimmed: a muted node (CH_ON, a
  // bus/FX/MONITOR master ON — all on params.on), a bypassed ducker (on/off lives
  // in duckerOn) or the oscillator when not generating (osc.on) — each off-state
  // lives on a different param, so each kind needs its own predicate to dim alike.
  private isNodeInactive(node: DeviceNode): boolean {
    const np = this.plan.nodeParams?.[node.id];
    if (node.kind === "ducker") return np?.duckerOn !== true;
    if (node.id === "bus.osc") return np?.osc?.on !== true;
    return np?.on === false;
  }

  // Resting opacity of a node's faceplate, by the same precedence makeNode dims it
  // (rate-disabled > inactive > unread > plain). A path trace fades the off-path
  // nodes to a fraction of this, so the dim stays derived from state, not stored.
  private restingOpacity(node: DeviceNode): number {
    if (this.disabledNodes.has(node.id)) return 0.62;
    if (this.isNodeInactive(node)) return 0.4;
    if (this.unreadNodes.has(node.id)) return 0.7;
    return 1;
  }

  /** The device CH SETTING name (plan.nodeNames) to show for a node, or undefined
   *  in model-label mode or when no name is set — the single source both the
   *  faceplate and labelOf use to decide a name override. */
  private deviceName(id: string): string | undefined {
    return this.labelSource === "device" ? this.plan.nodeNames?.[id]?.trim() || undefined : undefined;
  }

  /** Full display name (both label tiers) for status lines and the shelf. In
   *  device mode the CH SETTING name wins over the model's label; in model mode
   *  the planner label always shows. */
  private labelOf(id: string): string {
    const custom = this.deviceName(id);
    if (custom) return custom;
    const node = this.nodeById.get(id);
    return node ? fullLabel(node) : id;
  }

  private makeNode(node: DeviceNode): SVGGElement {
    const p = this.palette;
    const rail = p.rail[node.kind];
    const g = document.createElementNS(SVGNS, "g");
    g.classList.add("node");
    g.dataset.id = node.id;
    const pos = this.posOf(node.id);
    g.setAttribute("transform", `translate(${pos.x} ${pos.y})`);

    // A hung node (ducker) shows a thin tether up into the gap to its parent, so
    // the two read as one unit. Inline attributes keep it in the PNG/PDF export.
    if (node.attachTo) g.append(svgLine(NODE_W / 2, -DUCKER_GAP, NODE_W / 2, 0, rail, 2, 0.5));

    // A note expands the node downward into an in-frame panel; the header keeps
    // its fixed height so jacks, label and wires stay anchored to the top.
    const lines = this.noteLines(node.id);
    const editing = this.noteEditor?.id === node.id;
    const showPanel = lines.length > 0 && (!this.collapsed.has(node.id) || editing);
    const h = NODE_H + (showPanel ? notePanelHeight(lines) : 0);

    const rect = document.createElementNS(SVGNS, "rect");
    rect.setAttribute("width", String(NODE_W));
    rect.setAttribute("height", String(h));
    rect.setAttribute("rx", "7");
    rect.setAttribute("fill", p.nodeFill);
    rect.setAttribute("stroke", p.nodeStroke);
    rect.setAttribute("stroke-width", "1");
    if (this.themeName === "light") rect.setAttribute("filter", "url(#node-shadow)");
    g.append(rect);

    const hi = svgRect(1, 1, NODE_W - 2, 13, 5, p.nodeHi);
    g.append(hi);

    const railEl = svgRect(0, 0, 6, h, 2, rail);
    g.append(railEl);

    // User color override (plan.nodeColors): a thin accent cap along the top
    // edge. Keeps the kind rail intact, so the cap is purely additional.
    const capColor = this.plan.nodeColors?.[node.id];
    if (capColor) g.append(svgRect(6, 0, NODE_W - 6, 3, 1.5, capColor));

    for (const sx of [12, NODE_W - 12]) {
      for (const sy of [9, h - 9]) {
        const screw = document.createElementNS(SVGNS, "circle");
        screw.setAttribute("cx", String(sx));
        screw.setAttribute("cy", String(sy));
        screw.setAttribute("r", "2.2");
        screw.setAttribute("fill", p.screwFill);
        screw.setAttribute("stroke", p.screwStroke);
        screw.setAttribute("stroke-width", "0.8");
        screw.style.pointerEvents = "none";
        g.append(screw);
      }
    }

    // Device mode shows the CH SETTING name (plan.nodeNames) in place of the
    // model's primary label; model mode keeps the planner label. The dim
    // sublabel legend (if any) stays as secondary context either way.
    const primary = this.deviceName(node.id) ?? node.label;
    if (node.sublabel) {
      // Two-tier faceplate label: the node name, then a dim secondary legend
      // beneath it, so a long name fits the fixed header height.
      const s1 = fitScale(primary, LABEL_FS, 1);
      g.append(labelText(primary, LABEL_TIER1_Y, LABEL_FS * s1, s1, p.label, 1));
      const s2 = fitScale(node.sublabel, LABEL_SUB_FS, 0.5);
      g.append(labelText(node.sublabel, LABEL_TIER2_Y, LABEL_SUB_FS * s2, 0.5 * s2, p.label, 0.6));
    } else {
      // Single line, scaled down only when it would otherwise run under the button.
      const s = fitScale(primary, LABEL_FS, 1);
      g.append(labelText(primary, NODE_H / 2 + 1, LABEL_FS * s, s, p.label, 1));
    }

    // A header node (microSD Rec) takes no direct wire — its I/O lives on the
    // child slots — so its port connector is not drawn.
    for (const port of node.header ? [] : node.ports) {
      const cx = port.direction === "in" ? 0 : NODE_W;
      const r = ref(node.id, port.id);

      // Oversized transparent disc that actually receives the pointer; the
      // class/ref the handlers and elementFromPoint look up live here, while
      // the visible jack below stays decorative. Kept first so the painted
      // jack and pin (pointer-events: none) sit on top without blocking it.
      const hit = document.createElementNS(SVGNS, "circle");
      hit.classList.add("port", "port-hit", port.direction === "in" ? "port-in" : "port-out");
      hit.dataset.ref = r;
      hit.setAttribute("cx", String(cx));
      hit.setAttribute("cy", String(NODE_H / 2));
      hit.setAttribute("r", String(PORT_HIT_R));
      hit.setAttribute("fill", "transparent");
      hit.style.pointerEvents = "all";
      g.append(hit);

      const c = document.createElementNS(SVGNS, "circle");
      c.dataset.dir = port.direction;
      c.setAttribute("cx", String(cx));
      c.setAttribute("cy", String(NODE_H / 2));
      c.setAttribute("r", "6");
      c.setAttribute("fill", p.portOuter);
      c.setAttribute("stroke", rail);
      c.setAttribute("stroke-width", "1.5");
      c.style.pointerEvents = "none";
      g.append(c);
      this.portEls.set(r, c);

      const pin = document.createElementNS(SVGNS, "circle");
      pin.classList.add("port-pin");
      pin.dataset.pin = r;
      pin.setAttribute("cx", String(cx));
      pin.setAttribute("cy", String(NODE_H / 2));
      pin.setAttribute("r", "2.4");
      pin.setAttribute("fill", p.portPinOff);
      pin.style.pointerEvents = "none";
      g.append(pin);
      this.portPinEls.set(r, pin);
    }

    // A node may read as inactive (muted / bypassed / osc-off), rate-disabled or
    // unread-from-device at once; show only the highest-ranked state so the badges
    // and frames never collide. Precedence: rate-disabled > inactive > unread —
    // a feature unusable at this rate dominates a user mute, which dominates a
    // mere provenance warning.
    if (this.disabledNodes.has(node.id)) {
      g.setAttribute("opacity", "0.62");
      rect.setAttribute("stroke", p.warn);
      rect.setAttribute("stroke-width", "1.5");
      rect.setAttribute("stroke-dasharray", "4 3");
      g.append(svgRect(NODE_W - 34, -8, 30, 15, 3, p.warn));
      const badge = document.createElementNS(SVGNS, "text");
      badge.setAttribute("x", String(NODE_W - 19));
      badge.setAttribute("y", "0");
      badge.setAttribute("text-anchor", "middle");
      badge.setAttribute("dominant-baseline", "central");
      badge.setAttribute("fill", "#14110d");
      badge.setAttribute("font-family", LABEL_FONT);
      badge.setAttribute("font-size", "8.5");
      badge.setAttribute("font-weight", "700");
      badge.style.pointerEvents = "none";
      badge.textContent = "OFF";
      g.append(badge);
    } else if (this.isNodeInactive(node)) {
      // A muted node (CH_ON off) / bypassed ducker (duckerOn off) / oscillator off
      // (osc.on): dim the whole node and tag it MUTE (a mute) or OFF (a ducker /
      // the oscillator, whose resting state is off, not muted).
      g.setAttribute("opacity", "0.4");
      const tag = svgRect(NODE_W - 40, -8, 36, 15, 3, p.nodeStroke);
      g.append(tag);
      const tagText = document.createElementNS(SVGNS, "text");
      tagText.setAttribute("x", String(NODE_W - 22));
      tagText.setAttribute("y", "0");
      tagText.setAttribute("text-anchor", "middle");
      tagText.setAttribute("dominant-baseline", "central");
      tagText.setAttribute("fill", p.label);
      tagText.setAttribute("font-family", LABEL_FONT);
      tagText.setAttribute("font-size", "8.5");
      tagText.setAttribute("font-weight", "700");
      tagText.style.pointerEvents = "none";
      tagText.textContent = node.kind === "ducker" || node.id === "bus.osc" ? "OFF" : "MUTE";
      g.append(tagText);
    }

    // A node still showing its plan default after a device readback (not confirmed
    // by the device): a dim node with a dashed warn frame and a top-left "?" badge.
    // Ranks below MUTE and DISABLED (the else-if keeps it from stacking), so the
    // badge sits alone in the top-left, never colliding with their top-right tags.
    else if (this.unreadNodes.has(node.id)) {
      g.setAttribute("opacity", "0.7");
      rect.setAttribute("stroke", p.warn);
      rect.setAttribute("stroke-width", "1.2");
      rect.setAttribute("stroke-dasharray", "2 3");
      g.append(svgRect(8, -8, 16, 15, 3, p.warn));
      const badge = document.createElementNS(SVGNS, "text");
      badge.setAttribute("x", "16");
      badge.setAttribute("y", "0");
      badge.setAttribute("text-anchor", "middle");
      badge.setAttribute("dominant-baseline", "central");
      badge.setAttribute("fill", "#14110d");
      badge.setAttribute("font-family", LABEL_FONT);
      badge.setAttribute("font-size", "9");
      badge.setAttribute("font-weight", "700");
      badge.style.pointerEvents = "none";
      badge.textContent = "?";
      g.append(badge);
    }

    if (lines.length) {
      g.append(this.makeNoteToggle(node, this.collapsed.has(node.id) && !editing));
      // Draw the panel when expanded; its text is hidden while the inline editor
      // stands in its place (the well + seam stay so the frame reads as a panel).
      if (showPanel) g.append(this.makeNotePanel(node, lines, h, !editing));
    } else {
      // No note yet: the pen button is the way in (double-click now traces the
      // signal path instead of opening the note editor).
      g.append(this.makeNoteAdd(node));
    }

    this.nodeEls.set(node.id, g);
    return g;
  }

  /** Full node height including an expanded in-frame note panel. */
  private nodeHeight(id: string): number {
    const lines = this.noteLines(id);
    const editing = this.noteEditor?.id === id;
    const showPanel = lines.length > 0 && (!this.collapsed.has(id) || editing);
    return NODE_H + (showPanel ? notePanelHeight(lines) : 0);
  }

  /** Clipped, wrapped lines for a node's note, or [] when it carries none. */
  private noteLines(id: string): string[] {
    const raw = (this.plan.notes?.[id] ?? "").trim();
    if (!raw) return [];
    const all = wrapNote(raw, NOTE_MAX_CHARS);
    if (all.length <= NOTE_MAX_LINES) return all;
    const lines = all.slice(0, NOTE_MAX_LINES);
    let last = lines[NOTE_MAX_LINES - 1].replace(/\s+$/, "");
    // Trim until the ellipsis fits the cell budget (one cell wide).
    while (last && noteWidth(last) + 1 > NOTE_MAX_CHARS) last = Array.from(last).slice(0, -1).join("");
    lines[NOTE_MAX_LINES - 1] = `${last}…`;
    return lines;
  }

  // Header control center, kept left of the right-edge jack hit zone.
  private static readonly BTN_CX = NODE_W - 25;

  /** A small bordered header button (the visible affordance) with a padded hit
   *  area; `draw` paints the icon glyph centered in it. */
  private makeHeaderButton(
    node: DeviceNode,
    cls: string,
    tip: string,
    draw: (cx: number, cy: number, ink: string) => SVGElement[],
  ): SVGGElement {
    const cx = Graph.BTN_CX;
    const cy = NODE_H / 2;
    const g = document.createElementNS(SVGNS, "g");
    g.classList.add(cls);
    g.style.cursor = "pointer";
    const title = document.createElementNS(SVGNS, "title");
    title.textContent = tip;
    g.append(title);

    const hit = document.createElementNS(SVGNS, "rect");
    hit.setAttribute("x", String(cx - 10));
    hit.setAttribute("y", String(cy - 9));
    hit.setAttribute("width", "20");
    hit.setAttribute("height", "18");
    hit.setAttribute("fill", "transparent");
    hit.style.pointerEvents = "all";
    g.append(hit);

    const btn = document.createElementNS(SVGNS, "rect");
    btn.classList.add("note-btn");
    btn.setAttribute("x", String(cx - 8));
    btn.setAttribute("y", String(cy - 7));
    btn.setAttribute("width", "16");
    btn.setAttribute("height", "14");
    btn.setAttribute("rx", "3.5");
    btn.setAttribute("fill", this.themeName === "dark" ? "rgba(255,255,255,0.10)" : "rgba(0,0,0,0.05)");
    btn.setAttribute("stroke", this.palette.rail[node.kind]);
    btn.setAttribute("stroke-width", "1");
    btn.style.pointerEvents = "none";
    g.append(btn);

    for (const el of draw(cx, cy, this.palette.label)) {
      el.style.pointerEvents = "none";
      g.append(el);
    }
    return g;
  }

  /** Button that minimizes / re-expands the in-frame note panel (− / +). */
  private makeNoteToggle(node: DeviceNode, collapsed: boolean): SVGGElement {
    const m = collapsed ? t().tooltip.expandNote : t().tooltip.collapseNote;
    return this.makeHeaderButton(node, "note-toggle", m, (cx, cy, ink) => {
      const bar = (d: string): SVGPathElement => {
        const el = document.createElementNS(SVGNS, "path");
        el.setAttribute("d", d);
        el.setAttribute("stroke", ink);
        el.setAttribute("stroke-width", "1.8");
        el.setAttribute("stroke-linecap", "round");
        return el;
      };
      const els = [bar(`M ${cx - 3.5} ${cy} L ${cx + 3.5} ${cy}`)];
      // Plus while collapsed (expand action), minus while expanded (collapse).
      if (collapsed) els.push(bar(`M ${cx} ${cy - 3.5} L ${cx} ${cy + 3.5}`));
      return els;
    });
  }

  /** Button that opens the editor on a note-less node (a pen glyph). */
  private makeNoteAdd(node: DeviceNode): SVGGElement {
    return this.makeHeaderButton(node, "note-add", t().tooltip.addNote, (cx, cy, ink) => {
      const shaft = document.createElementNS(SVGNS, "path");
      shaft.setAttribute("d", `M ${cx - 4} ${cy + 4} L ${cx + 2} ${cy - 2}`);
      shaft.setAttribute("stroke", ink);
      shaft.setAttribute("stroke-width", "2.2");
      shaft.setAttribute("stroke-linecap", "round");
      const tip = document.createElementNS(SVGNS, "path");
      tip.setAttribute("d", `M ${cx + 2} ${cy - 2} L ${cx + 4.5} ${cy - 4.5}`);
      tip.setAttribute("stroke", ink);
      tip.setAttribute("stroke-width", "1.3");
      tip.setAttribute("stroke-linecap", "round");
      return [shaft, tip];
    });
  }

  /** The in-frame note area below the header: recessed well, seam and text. */
  private makeNotePanel(node: DeviceNode, lines: string[], h: number, showText: boolean): SVGGElement {
    const p = this.palette;
    const seamY = NODE_H;
    const wellY = NODE_H + NOTE_TOP_GAP;
    const g = document.createElementNS(SVGNS, "g");
    g.classList.add("note-panel");
    g.style.pointerEvents = "none";

    const well = document.createElementNS(SVGNS, "rect");
    well.setAttribute("x", String(NOTE_INSET));
    well.setAttribute("y", String(wellY));
    well.setAttribute("width", String(NODE_W - NOTE_INSET * 2));
    well.setAttribute("height", String(Math.max(0, h - wellY - NOTE_BOT_GAP)));
    well.setAttribute("rx", "3");
    well.setAttribute("fill", p.noteWell);
    g.append(well);

    const seam = document.createElementNS(SVGNS, "path");
    seam.setAttribute("d", `M ${NOTE_INSET} ${seamY} L ${NODE_W - NOTE_INSET} ${seamY}`);
    seam.setAttribute("stroke", p.nodeStroke);
    seam.setAttribute("stroke-width", "1");
    g.append(seam);

    if (showText) {
      const tx = NOTE_INSET + NOTE_PAD_X;
      const text = document.createElementNS(SVGNS, "text");
      text.setAttribute("x", String(tx));
      text.setAttribute("y", String(wellY + NOTE_PAD_Y + NOTE_FONT_SIZE));
      text.setAttribute("fill", p.noteInk);
      text.setAttribute("font-family", LABEL_FONT);
      text.setAttribute("font-size", String(NOTE_FONT_SIZE));
      text.style.userSelect = "none";
      lines.forEach((line, i) => {
        const tspan = document.createElementNS(SVGNS, "tspan");
        tspan.setAttribute("x", String(tx));
        if (i > 0) tspan.setAttribute("dy", String(NOTE_LINE_H));
        tspan.textContent = line || " ";
        text.append(tspan);
      });
      g.append(text);
    }
    return g;
  }

  /** Light the inner pin of every port that currently carries a wire. */
  private refreshPortStates(): void {
    const wired = new Set<string>();
    for (const c of this.plan.connections) {
      // A wire to a hidden endpoint is not drawn, so its ports must not read as
      // in use (e.g. a hidden ducker's key source on the still-visible source).
      if (this.isHidden(parseRef(c.from).nodeId) || this.isHidden(parseRef(c.to).nodeId)) continue;
      // An off / muted wire recedes, so its jacks must not glow as live either — a
      // port lights only when it carries at least one audible (non-off) connection.
      if (this.isOffSend(c)) continue;
      wired.add(c.from);
      wired.add(c.to);
    }
    for (const [r, pin] of this.portPinEls) {
      const on = wired.has(r);
      const kind = this.nodeById.get(parseRef(r).nodeId)!.kind;
      pin.setAttribute("fill", on ? this.palette.rail[kind] : this.palette.portPinOff);
      pin.setAttribute("r", on ? "3" : "2.4");
      if (on) pin.setAttribute("filter", "url(#jack-glow)");
      else pin.removeAttribute("filter");
    }
  }

  private wirePath(from: string, to: string): string {
    const a = this.portPoint(from);
    const b = this.portPoint(to);
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
    return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
  }

  // Point and tangent angle (deg) at parameter t on the same cubic the wire uses,
  // for placing the PRE tap marker along the curve near the source end.
  private wirePoint(from: string, to: string, t: number): { x: number; y: number; angle: number } {
    const a = this.portPoint(from);
    const b = this.portPoint(to);
    const dx = Math.max(40, Math.abs(b.x - a.x) * 0.5);
    const p1x = a.x + dx;
    const p2x = b.x - dx;
    const mt = 1 - t;
    const x = mt * mt * mt * a.x + 3 * mt * mt * t * p1x + 3 * mt * t * t * p2x + t * t * t * b.x;
    const y = mt * mt * mt * a.y + 3 * mt * mt * t * a.y + 3 * mt * t * t * b.y + t * t * t * b.y;
    const ddx = 3 * mt * mt * (p1x - a.x) + 6 * mt * t * (p2x - p1x) + 3 * t * t * (b.x - p2x);
    const ddy = 6 * mt * t * (b.y - a.y);
    return { x, y, angle: (Math.atan2(ddy, ddx) * 180) / Math.PI };
  }

  private redrawWires(): void {
    this.wireLayer.replaceChildren();
    // Partition the visible wires into off / on in one pass. Off / -∞ sends paint
    // first (behind) and the live (on) wires last (on top), so in the dense always-
    // wired mesh the on wires — and their click bands — sit in front and are easier
    // to pick. Each list keeps plan order, so the last on wire stays the most recent.
    const off: PlanConnection[] = [];
    const on: PlanConnection[] = [];
    for (const conn of this.plan.connections) {
      // A wire to a shelved endpoint would dangle into empty space; skip any wire
      // whose node is hidden, so a shelved node takes its wires off-canvas with it.
      if (this.isHidden(parseRef(conn.from).nodeId) || this.isHidden(parseRef(conn.to).nodeId)) continue;
      const isOff = this.isOffSend(conn);
      // Declutter toggle: drop the off / -∞ sends entirely (they are non-removable
      // fixed wires, so hiding is the only way to thin the always-wired send mesh).
      if (this.hideOffSends && isOff) continue;
      (isOff ? off : on).push(conn);
    }
    for (const conn of off) this.wireLayer.append(this.makeWire(conn));
    for (const conn of on) this.wireLayer.append(this.makeWire(conn));
    // Jacks share the wires' off-state, so refresh them in lockstep: a wire-only
    // repaint (a send on/off, a node mute) must re-evaluate which ports stay lit.
    this.refreshPortStates();
  }

  private makeWire(conn: PlanConnection): SVGGElement {
    const g = document.createElementNS(SVGNS, "g");
    const d = this.wirePath(conn.from, conn.to);
    const selected =
      this.selection?.type === "conn" &&
      this.selection.from === conn.from &&
      this.selection.to === conn.to;
    const fromId = parseRef(conn.from).nodeId;
    const toId = parseRef(conn.to).nodeId;
    // An off / -∞ send recedes: faint and finely dotted, so a board of always-wired
    // sends reads as "these few are live, the rest are parked at -∞". A lit/selected
    // wire ignores it so the user can still see and edit the one they picked.
    const off = this.isOffSend(conn);
    // When node(s) are selected, light wires incident to any of them and fade the
    // rest so the selection's routing stands out in a dense diagram. Uses the whole
    // multi-selection, not just the anchor, so it matches the node highlighting.
    const hasNodeSel = this.selectedNodes.size > 0;
    const incident = hasNodeSel && (this.selectedNodes.has(fromId) || this.selectedNodes.has(toId));
    // A traced signal path lights its wires the same way: both endpoints in the
    // upstream closure and the wire itself live (an off send between two closure
    // nodes is a parallel silent route, not part of the flow being traced).
    const pathActive = this.pathNodes.size > 0;
    const inPath = pathActive && !off && this.pathNodes.has(fromId) && this.pathNodes.has(toId);
    const lit = selected || incident || inPath;
    const faded = (hasNodeSel || pathActive) && !lit;

    // Invisible wide band along the wire so the thin curve is easy to click; it
    // carries the pointer handler while the painted wire below stays thin. The
    // transparent stroke is inline so the PNG/PDF export stays invisible.
    const hit = document.createElementNS(SVGNS, "path");
    hit.classList.add("wire-hit");
    hit.setAttribute("data-from", conn.from);
    hit.setAttribute("data-to", conn.to);
    hit.setAttribute("d", d);
    hit.setAttribute("fill", "none");
    hit.setAttribute("stroke", "transparent");
    hit.setAttribute("stroke-width", String(WIRE_HIT_W));
    hit.setAttribute("stroke-linecap", "round");
    hit.style.pointerEvents = "stroke";
    hit.style.cursor = "pointer";
    hit.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      this.select({ type: "conn", from: conn.from, to: conn.to });
    });
    g.append(hit);

    const color = this.palette.wire[conn.kind] ?? "#888";
    // A pre-fader send is dashed and tagged so it reads at a glance without
    // opening the inspector; POST (the default) stays solid and unmarked.
    const isPre = sendHasTap(this.model, conn.from, conn.to) && conn.params?.tap === "pre";

    // Soft underlay halo marks a lit/selected wire. Done with a wide, low-
    // opacity stroke rather than an SVG blur filter: a perfectly horizontal
    // wire (source and channel default to the same row) has a zero-height
    // bounding box, which collapses an objectBoundingBox filter region and
    // makes the filtered wire vanish.
    if (lit) {
      const halo = document.createElementNS(SVGNS, "path");
      halo.setAttribute("d", d);
      halo.setAttribute("fill", "none");
      halo.setAttribute("stroke", color);
      halo.setAttribute("stroke-width", selected ? "9" : "8");
      halo.setAttribute("stroke-linecap", "round");
      halo.setAttribute("opacity", "0.22");
      halo.style.pointerEvents = "none";
      g.append(halo);
    }

    const path = document.createElementNS(SVGNS, "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", color);
    path.setAttribute("stroke-width", selected ? "3.5" : incident ? "3" : off && !lit ? "1.4" : "2");
    path.setAttribute("stroke-linecap", "round");
    // Off sends sit well below the normal 0.85 so they recede behind live routing,
    // but a selected/incident one snaps to full so it stays editable.
    path.setAttribute("opacity", faded ? (off ? "0.08" : "0.16") : lit ? "1" : off ? "0.3" : "0.85");
    // A fine dotted line marks an off send; PRE (a longer dash) wins when both, since
    // the amber PRE glyph already carries the off-ness for a pre-tapped silent send.
    if (isPre) path.setAttribute("stroke-dasharray", "7 5");
    else if (off) path.setAttribute("stroke-dasharray", "1.5 4");
    path.style.pointerEvents = "none";
    g.append(path);

    if (isPre) g.append(this.makePreMarker(conn.from, conn.to, faded));

    return g;
  }

  // Amber tap glyph + "PRE" label near the source end of a pre-fader send. Inline
  // attributes keep it in the PNG/PDF export.
  private makePreMarker(from: string, to: string, faded: boolean): SVGGElement {
    const g = document.createElementNS(SVGNS, "g");
    g.style.pointerEvents = "none";
    if (faded) g.setAttribute("opacity", "0.2");
    const p = this.wirePoint(from, to, 0.22);

    const tri = document.createElementNS(SVGNS, "path");
    tri.setAttribute("d", "M -7.5 -7.5 L 7.5 0 L -7.5 7.5 Z");
    tri.setAttribute("transform", `translate(${p.x} ${p.y}) rotate(${p.angle})`);
    tri.setAttribute("fill", this.palette.pre);
    tri.setAttribute("stroke", "rgba(0,0,0,0.22)");
    tri.setAttribute("stroke-width", "0.6");
    g.append(tri);

    const label = document.createElementNS(SVGNS, "text");
    label.setAttribute("x", String(p.x));
    label.setAttribute("y", String(p.y - 12));
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("fill", this.palette.pre);
    label.setAttribute("font-family", LABEL_FONT);
    label.setAttribute("font-size", "10.5");
    label.setAttribute("font-weight", "700");
    label.setAttribute("letter-spacing", "1");
    label.style.userSelect = "none";
    label.textContent = "PRE";
    g.append(label);
    return g;
  }

  /** Repaint wires only (e.g. after a PRE/POST toggle flips a send's marker). */
  repaintWires(): void {
    this.redrawWires();
  }

  private updateNodeWires(nodeId: string): void {
    // Cheap enough to redraw all wires when a node moves.
    void nodeId;
    this.redrawWires();
  }

  // --- selection -----------------------------------------------------------

  private select(sel: Selection): void {
    this.selection = sel;
    this.selectedNodes.clear();
    this.pathNodes.clear();
    if (sel?.type === "node") this.selectedNodes.add(sel.id);
    this.redrawWires();
    this.highlightSelectedNode();
    this.renderSelBar();
    this.cb.onSelect(sel);
  }

  /** Ctrl/Cmd-click: add or drop a node from the multi-selection without dragging
   *  it, so several nodes can be shelved at once. The anchor (shown in the
   *  inspector) follows the most recently touched node. */
  private toggleNodeSelection(id: string): void {
    this.pathNodes.clear();
    if (this.selectedNodes.has(id)) {
      this.selectedNodes.delete(id);
      if (this.selection?.type === "node" && this.selection.id === id) {
        const next = [...this.selectedNodes].pop();
        this.selection = next ? { type: "node", id: next } : null;
      }
    } else {
      this.selectedNodes.add(id);
      this.selection = { type: "node", id };
    }
    this.redrawWires();
    this.highlightSelectedNode();
    this.renderSelBar();
    this.cb.onSelect(this.selection);
  }

  /** Trace and highlight the live signal path feeding a node: the node plus every
   *  upstream input / channel / bus that reaches it through live wiring (off / -∞
   *  sends are not followed, or the always-wired mesh would light the whole board).
   *  The node stays selected; a leaf with no upstream just reports it. */
  private highlightPath(id: string): void {
    const closure = upstreamNodes(this.plan, id, (c) => !this.isOffSend(c));
    // A leaf (an input) has only itself: nothing upstream to light.
    const hasPath = closure.size > 1;
    if (hasPath) this.pathNodes = closure;
    else this.pathNodes.clear();
    this.redrawWires();
    this.highlightSelectedNode();
    this.cb.onStatus(
      hasPath ? t().status.pathTraced(this.labelOf(id), closure.size) : t().status.pathNone(this.labelOf(id)),
    );
  }

  /** Clear any selection (used by the canvas, the action bar, and Escape). */
  clearSelection(): void {
    if (!this.selection && !this.selectedNodes.size) return;
    this.select(null);
  }

  private highlightSelectedNode(): void {
    const anchor = this.selection?.type === "node" ? this.selection.id : null;
    // While a path trace is active, fade the off-path nodes so the lit chain stands
    // out in the node layer too — the same lit / faded split the wires already use.
    const pathActive = this.pathNodes.size > 0;
    for (const [id, el] of this.nodeEls) {
      const rect = el.querySelector("rect")!;
      const node = this.nodeById.get(id)!;
      const on = this.selectedNodes.has(id);
      // A traced-path node (not itself selected) wears the accent frame too, so the
      // upstream chain reads as one highlighted group with the double-clicked node.
      const onPath = !on && this.pathNodes.has(id);
      // Fade off-path nodes to a fraction of their resting opacity (so a muted /
      // unread node keeps its own dim), and restore the rest to that base.
      const base = this.restingOpacity(node);
      const fadeOff = pathActive && !this.pathNodes.has(id);
      el.setAttribute("opacity", String(fadeOff ? +(base * 0.3).toFixed(3) : base));
      const disabled = !on && !onPath && this.disabledNodes.has(id);
      // Unread frame ranks below selected/path/disabled but above the plain frame, so
      // a re-highlight restores it instead of reverting an unread node to normal.
      const unread = !on && !onPath && !disabled && this.unreadNodes.has(id) && !this.isNodeInactive(node);
      el.classList.toggle("selected", on);
      rect.setAttribute("stroke-width", on ? "2.5" : onPath ? "2" : disabled ? "1.5" : unread ? "1.2" : "1");
      rect.setAttribute("stroke", on || onPath ? this.palette.tempWire : disabled || unread ? this.palette.warn : this.palette.nodeStroke);
      if (disabled) rect.setAttribute("stroke-dasharray", "4 3");
      else if (unread) rect.setAttribute("stroke-dasharray", "2 3");
      else rect.removeAttribute("stroke-dasharray");
    }
    // Raise the anchor node so its note panel sits above any neighbor below it.
    if (anchor) {
      const el = this.nodeEls.get(anchor);
      if (el) this.nodeLayer.append(el);
    }
  }

  deleteSelection(): void {
    if (this.selection?.type === "conn") {
      this.deleteConnection(this.selection.from, this.selection.to);
    }
  }

  deleteConnection(from: string, to: string): void {
    if (isFixedConnection(this.model, from, to)) {
      this.cb.onStatus(t().status.fixedConnection);
      return;
    }
    const kind = ruleKind(this.model, from, to);
    this.plan.connections = this.plan.connections.filter((c) => !(c.from === from && c.to === to));
    // Removing a paired channel's source also clears its partner's mirrored one.
    if (kind === "source") {
      const partner = partnerChannel(this.model, parseRef(to).nodeId);
      if (partner) {
        const mirrorTo = ref(partner, parseRef(to).portId);
        this.plan.connections = this.plan.connections.filter(
          (c) => !(c.to === mirrorTo && isSingleInput(c.kind)),
        );
      }
    }
    const isSel =
      this.selection?.type === "conn" &&
      this.selection.from === from &&
      this.selection.to === to;
    if (isSel) this.select(null);
    else this.redrawWires();
    this.refreshPortStates();
    this.cb.onChange();
    this.cb.onStatus(t().status.connectionDeleted);
  }

  // --- interaction ---------------------------------------------------------

  private onPointerDown(e: PointerEvent): void {
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    // A second finger turns any in-flight drag/connect/pan into a pinch.
    if (this.pointers.size === 2) {
      e.preventDefault();
      this.closeNoteEditor();
      this.cancelInteraction();
      this.lastNodeClick = null;
      this.beginPinch();
      this.capturePointer(e.pointerId);
      return;
    }

    this.closeNoteEditor();
    const target = e.target as Element;

    // Header note controls live inside the node group; read the id from it.
    const btnNode = (target.closest(".note-toggle") || target.closest(".note-add"))
      ? (target.closest(".node") as SVGGElement | null)
      : null;
    if (btnNode) {
      e.preventDefault();
      const id = btnNode.dataset.id!;
      if (target.closest(".note-toggle")) {
        this.select({ type: "node", id });
        this.toggleNoteCollapse(id);
      } else {
        this.openNoteEditor(id);
      }
      return;
    }

    const portEl = target.closest(".port") as SVGCircleElement | null;
    if (portEl) {
      e.preventDefault();
      const dir: PortDirection = portEl.classList.contains("port-out") ? "out" : "in";
      this.connect = { ref: portEl.dataset.ref!, dir, startX: e.clientX, startY: e.clientY, mode: "pending" };
      this.capturePointer(e.pointerId);
      return;
    }

    const nodeEl = target.closest(".node") as SVGGElement | null;
    if (nodeEl) {
      e.preventDefault();
      const id = nodeEl.dataset.id!;
      // Ctrl/Cmd-click toggles the node in a multi-selection instead of dragging
      // or editing it; the action bar then offers to shelve them together.
      if (e.metaKey || e.ctrlKey) {
        this.lastNodeClick = null;
        this.toggleNodeSelection(id);
        return;
      }
      const pos = this.posOf(id);
      const p = this.clientToContent(e);
      // On an already-selected node, pressing in its open note area edits the
      // note; the header (outside the note area) still drags. Other nodes drag
      // as usual — select first, then click the note to edit.
      const inNoteArea = p.y - pos.y > NODE_H;
      const isSelected = this.selection?.type === "node" && this.selection.id === id;
      const noteShown = this.noteLines(id).length > 0 && !this.collapsed.has(id);
      if (isSelected && noteShown && inNoteArea) {
        this.openNoteEditor(id);
        return;
      }
      // A second press on the same node within the threshold opens its note editor;
      // a single sustained press (handled below by the long-press timer) traces the
      // signal path instead, so the two gestures don't collide.
      const now = performance.now();
      if (this.lastNodeClick?.id === id && now - this.lastNodeClick.time < 350) {
        this.lastNodeClick = null;
        this.openNoteEditor(id);
        return;
      }
      this.lastNodeClick = { id, time: now };
      // Grabbing a hung node (ducker) drags its parent so the unit moves as one;
      // selection still lands on the pressed node.
      const dragId = this.parentOf(id) ?? id;
      const dragPos = this.posOf(dragId);
      // A STEREO-linked MONO IN pair moves as one: capture the visible partner's
      // offset so it tracks the dragged node (like a ducker, but with its own
      // position). Skipped when the partner is hidden (no tie to keep in step).
      const pair = this.linkedPairOf(dragId);
      const partner = pair ? (pair[0] === dragId ? pair[1] : pair[0]) : null;
      const link =
        pair && partner && !this.isHidden(partner)
          ? { partner, dx: this.posOf(partner).x - dragPos.x, dy: this.posOf(partner).y - dragPos.y, pair }
          : null;
      this.dragNode = { id: dragId, grabDx: p.x - dragPos.x, grabDy: p.y - dragPos.y, link, moved: false };
      this.select({ type: "node", id });
      this.capturePointer(e.pointerId);
      // Holding the press still (no drag) traces the pressed node's signal path.
      this.startLongPress(id, e.clientX, e.clientY);
      return;
    }

    // empty canvas: start panning + clear selection
    this.select(null);
    this.autoFit = false;
    this.panning = { startX: e.clientX, startY: e.clientY, panX: this.pan.x, panY: this.pan.y };
    this.capturePointer(e.pointerId);
  }

  private capturePointer(id: number): void {
    try {
      this.svg.setPointerCapture(id);
    } catch {
      /* synthetic / inactive pointer */
    }
  }

  // Arm the path-trace timer for a node press. If it fires (the pointer stayed put
  // for LONG_PRESS_MS) it cancels the pending drag and traces the node's path.
  private startLongPress(id: string, x: number, y: number): void {
    this.cancelLongPress();
    const timer = setTimeout(() => {
      this.longPress = null;
      // The hold won: drop the pending drag so a later move can't reposition the
      // node, then trace its signal path.
      this.dragNode = null;
      this.highlightPath(id);
    }, LONG_PRESS_MS);
    this.longPress = { id, timer, x, y };
  }

  private cancelLongPress(): void {
    if (!this.longPress) return;
    clearTimeout(this.longPress.timer);
    this.longPress = null;
  }

  private onPointerMove(e: PointerEvent): void {
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pinch) {
      this.updatePinch();
      return;
    }
    // While a long-press is pending, swallow small jitter so the node stays put and
    // the hold can complete; once the pointer travels past the tolerance the press
    // is a drag, so cancel the trace timer and fall through to move the node.
    if (this.longPress) {
      if (Math.hypot(e.clientX - this.longPress.x, e.clientY - this.longPress.y) < LONG_PRESS_TOLERANCE) return;
      this.cancelLongPress();
    }
    if (this.dragNode) {
      this.dragNode.moved = true;
      const p = this.clientToContent(e);
      this.plan.positions[this.dragNode.id] = {
        x: p.x - this.dragNode.grabDx,
        y: p.y - this.dragNode.grabDy,
      };
      const el = this.nodeEls.get(this.dragNode.id)!;
      const pos = this.plan.positions[this.dragNode.id];
      el.setAttribute("transform", `translate(${pos.x} ${pos.y})`);
      // Hung descendants follow: their positions derive from the parent (a single
      // ducker, or the SD Rec track-slot chain), so move each element and redraw
      // its wires.
      for (const descId of this.attachedDescendants(this.dragNode.id)) {
        if (this.isHidden(descId)) continue;
        const cpos = this.posOf(descId);
        this.nodeEls.get(descId)?.setAttribute("transform", `translate(${cpos.x} ${cpos.y})`);
        this.updateNodeWires(descId);
      }
      // A STEREO-linked partner moves by the captured offset (its own position),
      // and the heart tie is redrawn to track the pair.
      const link = this.dragNode.link;
      if (link) {
        const fp = { x: pos.x + link.dx, y: pos.y + link.dy };
        this.plan.positions[link.partner] = fp;
        this.nodeEls.get(link.partner)?.setAttribute("transform", `translate(${fp.x} ${fp.y})`);
        this.updateNodeWires(link.partner);
        this.redrawStereoLink(link.pair[0], link.pair[1]);
      }
      this.updateNodeWires(this.dragNode.id);
      return;
    }
    if (this.connect) {
      if (this.connect.mode === "pending") {
        const moved = Math.hypot(e.clientX - this.connect.startX, e.clientY - this.connect.startY);
        if (moved < DRAG_THRESHOLD) return;
        this.connect.mode = this.beginConnect(this.connect.ref, this.connect.dir) ? "connecting" : "noop";
      }
      if (this.connect.mode === "connecting") {
        const p = this.clientToContent(e);
        this.updateTempWire(this.connect.ref, this.connect.dir, p);
      }
      return;
    }
    if (this.panning) {
      this.pan.x = this.panning.panX + (e.clientX - this.panning.startX);
      this.pan.y = this.panning.panY + (e.clientY - this.panning.startY);
      this.applyTransform();
    }
  }

  private onPointerUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    // A release before the timer fires means it was a click / drag, not a hold.
    this.cancelLongPress();
    // Lifting one finger ends the pinch; the other finger is left idle (no pan
    // resumes) until it too lifts, avoiding a jump back to single-pointer drag.
    if (this.pinch && this.pointers.size < 2) {
      this.pinch = null;
      try {
        this.svg.releasePointerCapture(e.pointerId);
      } catch {
        /* pointer was not captured */
      }
      return;
    }
    if (this.dragNode) {
      const moved = this.dragNode.moved;
      this.dragNode = null;
      // A plain select-click leaves the node where it was; only a real drag
      // persists a new position, so only that marks the plan dirty.
      if (moved) this.cb.onChange();
    }
    if (this.connect) {
      const c = this.connect;
      this.connect = null;
      if (c.mode === "connecting") {
        // Pointer capture retargets pointerup to the svg, so hit-test the port
        // under the release point rather than trusting e.target.
        const wantClass = c.dir === "out" ? ".port-in" : ".port-out";
        const under = document.elementFromPoint(e.clientX, e.clientY);
        const target = under?.closest(wantClass) as SVGCircleElement | null;
        this.finishConnect(c.ref, c.dir, target?.dataset.ref ?? null);
      } else if (c.dir === "in") {
        // A click (or a drag with no legal source) on an input port selects its
        // single incoming wire, mirroring a click on the wire itself.
        this.selectInputWire(c.ref);
      }
    }
    this.panning = null;
    try {
      this.svg.releasePointerCapture(e.pointerId);
    } catch {
      /* pointer was not captured */
    }
  }

  // Pointer capture can be revoked without a pointerup (touch-scroll gesture,
  // context menu, alert). Tear down any in-flight interaction so the rubber-band
  // wire and port highlights don't linger and dragNode/panning stop firing.
  private cancelInteraction(): void {
    if (this.connect?.mode === "connecting") {
      this.tempWire?.remove();
      this.tempWire = null;
      this.clearPortHighlights();
    }
    this.connect = null;
    this.dragNode = null;
    this.panning = null;
    this.cancelLongPress();
  }

  private onPointerCancel(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pinch && this.pointers.size < 2) this.pinch = null;
    this.cancelInteraction();
  }

  // Snapshot the two-finger distance and midpoint that updatePinch advances from,
  // caching the svg origin so the move loop never re-measures it.
  private beginPinch(): void {
    this.autoFit = false;
    const rect = this.svg.getBoundingClientRect();
    const m = this.fingerSpread(rect.left, rect.top);
    if (m) this.pinch = { ...m, left: rect.left, top: rect.top };
  }

  // Current finger spread and midpoint, the midpoint in svg-local coordinates
  // (left/top are the cached svg origin, not re-measured per frame).
  private fingerSpread(left: number, top: number): { lastDist: number; lastCx: number; lastCy: number } | null {
    const pts = [...this.pointers.values()];
    if (pts.length < 2) return null;
    const [a, b] = pts;
    return {
      lastDist: Math.hypot(a.x - b.x, a.y - b.y),
      lastCx: (a.x + b.x) / 2 - left,
      lastCy: (a.y + b.y) / 2 - top,
    };
  }

  // Zoom by the change in finger spread (anchored at the midpoint) and pan by the
  // midpoint's own movement, so two fingers zoom and drag the canvas together.
  private updatePinch(): void {
    if (!this.pinch) return;
    const m = this.fingerSpread(this.pinch.left, this.pinch.top);
    if (!m || this.pinch.lastDist === 0) return;
    this.zoomAt(m.lastCx, m.lastCy, this.zoom * (m.lastDist / this.pinch.lastDist));
    this.pan.x += m.lastCx - this.pinch.lastCx;
    this.pan.y += m.lastCy - this.pinch.lastCy;
    this.pinch.lastDist = m.lastDist;
    this.pinch.lastCx = m.lastCx;
    this.pinch.lastCy = m.lastCy;
    this.applyTransform();
  }

  // Zoom to `next` (clamped) while keeping the point at svg-local (cx, cy) fixed.
  private zoomAt(cx: number, cy: number, next: number): void {
    const z = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, next));
    this.pan.x = cx - ((cx - this.pan.x) / this.zoom) * z;
    this.pan.y = cy - ((cy - this.pan.y) / this.zoom) * z;
    this.zoom = z;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    this.autoFit = false;
    const rect = this.svg.getBoundingClientRect();
    const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
    this.zoomAt(e.clientX - rect.left, e.clientY - rect.top, this.zoom * factor);
    this.applyTransform();
  }

  // --- connecting ----------------------------------------------------------

  // Enter connect mode from `ref`, highlighting the legal ports on the opposite
  // side and starting a rubber-band wire. Returns false (doing nothing) when the
  // press should fall back to a click: an output with no possible route at all,
  // or an input with no legal source — the latter keeps a press on a full input
  // selecting its incoming wire instead of opening a dead rubber-band.
  private beginConnect(from: string, dir: PortDirection): boolean {
    const legal =
      dir === "out"
        ? legalTargets(this.model, this.plan, from)
        : legalSources(this.model, this.plan, from);
    // Possible partners include occupied ones, shown outline-only so the user can
    // see where a port could route even when the destination is taken.
    const possible =
      dir === "out" ? possibleTargets(this.model, from) : possibleSources(this.model, from);
    // Gate: outputs open on any possible route (occupied targets still highlight);
    // inputs open only on a legal source, so a full input falls back to wire-select.
    if (dir === "out" ? !possible.size : !legal.size) return false;
    // Reset every port to its default look, then light the partners: legal ones
    // filled, occupied-but-possible ones outline-only.
    this.clearPortHighlights();
    const opposite = dir === "out" ? "in" : "out";
    for (const [r, el] of this.portEls) {
      if (el.dataset.dir !== opposite || !possible.has(r)) continue;
      el.setAttribute("r", "8");
      if (legal.has(r)) {
        el.setAttribute("fill", this.palette.legalFill);
        el.setAttribute("stroke", this.palette.legalStroke);
      } else {
        el.setAttribute("stroke", this.palette.possibleStroke);
      }
    }
    this.tempWire = document.createElementNS(SVGNS, "path");
    this.tempWire.classList.add("overlay-temp");
    this.tempWire.style.pointerEvents = "none";
    this.tempWire.setAttribute("fill", "none");
    this.tempWire.setAttribute("stroke", this.palette.tempWire);
    this.tempWire.setAttribute("stroke-width", "2");
    this.tempWire.setAttribute("stroke-dasharray", "5 4");
    this.overlay.append(this.tempWire);
    return true;
  }

  private updateTempWire(from: string, dir: PortDirection, to: Pt): void {
    if (!this.tempWire) return;
    const a = this.portPoint(from);
    const dx = Math.max(40, Math.abs(to.x - a.x) * 0.5);
    // Bow the curve out of the originating side: outputs leave to the right,
    // inputs to the left.
    const aCtrl = dir === "out" ? a.x + dx : a.x - dx;
    const bCtrl = dir === "out" ? to.x - dx : to.x + dx;
    this.tempWire.setAttribute(
      "d",
      `M ${a.x} ${a.y} C ${aCtrl} ${a.y}, ${bCtrl} ${to.y}, ${to.x} ${to.y}`,
    );
  }

  // Commit a wire from a drag that started at `from` (output or input) released
  // over `released`. Normalizes to from=output / to=input so the constraint
  // engine and source mirroring stay direction-agnostic.
  private finishConnect(from: string, dir: PortDirection, released: string | null): void {
    this.tempWire?.remove();
    this.tempWire = null;
    this.clearPortHighlights();

    if (!released) return;
    const out = dir === "out" ? from : released;
    const into = dir === "out" ? released : from;
    const result = canConnect(this.model, this.plan, out, into);
    if (!result.ok) {
      this.cb.onStatus(result.reason ? t().error[result.reason] : t().error.cannotConnect);
      return;
    }
    const kind = ruleKind(this.model, out, into)!;
    this.plan.connections.push({ from: out, to: into, kind });
    if (kind === "source") this.mirrorPairSource(out, into);
    this.redrawWires();
    this.refreshPortStates();
    this.cb.onChange();
    this.cb.onStatus(t().status.connected);
  }

  /** Select the single wire feeding `inputRef`, if exactly one is present. */
  private selectInputWire(inputRef: string): void {
    const wires = this.plan.connections.filter((c) => c.to === inputRef);
    if (wires.length === 1) this.select({ type: "conn", from: wires[0].from, to: wires[0].to });
  }

  // Mono channels are paired: assigning a source to one fixes its partner too.
  // Mirror the same source onto the partner, replacing whatever it held.
  private mirrorPairSource(from: string, to: string): void {
    const { nodeId, portId } = parseRef(to);
    const partner = partnerChannel(this.model, nodeId);
    if (!partner) return;
    const mirrorTo = ref(partner, portId);
    for (const c of this.plan.connections.filter((c) => c.to === mirrorTo && isSingleInput(c.kind)))
      removeConnection(this.plan, c.from, c.to);
    if (!hasConnection(this.plan, from, mirrorTo))
      this.plan.connections.push({ from, to: mirrorTo, kind: "source" });
  }

  private clearPortHighlights(): void {
    for (const [r, el] of this.portEls) {
      const { nodeId } = parseRef(r);
      const node = this.nodeById.get(nodeId)!;
      el.setAttribute("fill", this.palette.portOuter);
      el.setAttribute("r", "6");
      el.setAttribute("stroke", this.palette.rail[node.kind]);
    }
  }

  // --- hide / show ---------------------------------------------------------

  /** Shelve every node that has no wires at all. Fixed sends count as wires, so a
   *  channel on just its factory sends is left in place — collapse it by hand
   *  (inspector / multi-select hide) instead. */
  hideUnused(): void {
    // SD Rec track slots follow their header in a chain, so they are never shelved
    // on their own (shelving the header collapses them via isHidden). The header
    // counts as wired when any of its slots is assigned, so an in-use recorder
    // stays, and an empty one collapses with its slots.
    const wired = (id: string): boolean =>
      this.nodeHasWire(id) || this.attachedDescendants(id).some((d) => this.nodeHasWire(d));
    const unwired = this.model.nodes.filter((n) => !this.isStructuralSlot(n.id) && !wired(n.id));
    const added = unwired.filter((n) => !this.hidden.has(n.id));
    for (const n of unwired) this.hidden.add(n.id);
    this.commitHidden();
    this.dropSelectionIfHidden();
    this.render();
    this.fitView();
    if (added.length) this.cb.onChange();
    this.cb.onStatus(added.length ? t().status.hidUnused(added.length) : t().status.noneToHide);
  }

  /** Shelve one node. Its wires (if any) are hidden along with it. */
  hideNode(id: string): void {
    this.hidden.add(id);
    this.commitHidden();
    this.dropSelectionIfHidden();
    this.render();
    this.cb.onChange();
    this.cb.onStatus(t().status.hidNode(this.labelOf(id)));
  }

  /** Shelve every node in the multi-selection; their wires are hidden with them. */
  hideSelected(): void {
    const ids = [...this.selectedNodes];
    if (!ids.length) return;
    const shelvable = ids.filter((id) => !this.hidden.has(id));
    for (const id of shelvable) this.hidden.add(id);
    this.selection = null;
    this.selectedNodes.clear();
    this.commitHidden();
    this.cb.onSelect(null);
    this.render();
    if (shelvable.length) this.cb.onChange();
    this.cb.onStatus(t().status.hidSelected(shelvable.length));
  }

  /** Bring one node back, placed under the viewport so it is easy to find.
   * Parent and hung child (ducker) restore as one unit: a ducker pulls its parent
   * back (it is never shown alone) and a parent brings its child back. Only the
   * parent is placed — the child's position derives from it. */
  showNode(id: string): void {
    const parent = this.parentOf(id);
    let changed = this.hidden.delete(id);
    if (parent) {
      if (this.hidden.delete(parent)) {
        this.placeInView(parent);
        changed = true;
      }
    } else {
      if (changed) this.placeInView(id);
      // Restore the whole unit: any hung children (a ducker, the SD Rec slots) that
      // were shelved come back with their parent.
      for (const child of this.attachedDescendants(id)) if (this.hidden.delete(child)) changed = true;
    }
    if (!changed) return;
    this.commitHidden();
    this.render();
    this.select({ type: "node", id });
    this.cb.onChange();
    this.cb.onStatus(t().status.shownNode(this.labelOf(id)));
  }

  /** Bring every shelved node back and re-frame the diagram. */
  showAll(): void {
    if (!this.hidden.size) return;
    this.hidden.clear();
    this.commitHidden();
    this.render();
    this.fitView();
    this.cb.onChange();
    this.cb.onStatus(t().status.shownAll);
  }

  private commitHidden(): void {
    this.plan.hidden = [...this.hidden];
    this.cb.onHiddenChange(this.plan.hidden);
  }

  private dropSelectionIfHidden(): void {
    if (this.selection?.type === "node" && this.isHidden(this.selection.id)) {
      this.selection = null;
      this.cb.onSelect(null);
    }
  }

  /** Park a restored node at the current viewport center, in content coords. */
  private placeInView(id: string): void {
    const rect = this.svg.getBoundingClientRect();
    const cx = ((rect.width || 1000) / 2 - this.pan.x) / this.zoom;
    const cy = ((rect.height || 700) / 2 - this.pan.y) / this.zoom;
    this.plan.positions[id] = { x: cx - NODE_W / 2, y: cy - NODE_H / 2 };
  }

  /** Repaint the bottom shelf from the set of currently-shelved nodes. A ducker
   * hidden alongside its (also hidden) parent gets no chip of its own — the
   * parent's chip restores the whole unit. */
  private renderShelf(): void {
    const ids = this.model.nodes
      // Chip every USER-shelved node (not merely hidden — a Track-Count-inactive
      // slot is hidden but gated, not shelved, so it gets no chip). A node whose
      // parent is itself shelved is covered by the parent's chip, so skip it.
      .filter((n) => this.hidden.has(n.id) && !(n.attachTo && this.hidden.has(n.attachTo)))
      .map((n) => n.id);
    if (!ids.length) {
      this.shelf.style.display = "none";
      this.shelf.replaceChildren();
      return;
    }
    const m = t();
    const label = document.createElement("div");
    label.className = "shelf-label";
    label.append(document.createTextNode(m.shelf.title));
    const count = document.createElement("span");
    count.className = "shelf-count";
    count.textContent = String(ids.length);
    label.append(count);

    const chips = document.createElement("div");
    chips.className = "shelf-chips";
    for (const id of ids) {
      const node = this.nodeById.get(id)!;
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.style.setProperty("--rail", this.palette.rail[node.kind]);
      chip.title = m.shelf.restore(fullLabel(node));
      const name = document.createElement("span");
      name.textContent = fullLabel(node);
      const go = document.createElement("span");
      go.className = "chip-go";
      go.setAttribute("aria-hidden", "true");
      go.textContent = "⤴";
      chip.append(name, go);
      chip.addEventListener("click", () => this.showNode(id));
      chips.append(chip);
    }

    const showAll = document.createElement("button");
    showAll.type = "button";
    showAll.className = "shelf-showall";
    showAll.textContent = m.shelf.showAll;
    showAll.addEventListener("click", () => this.showAll());

    this.shelf.replaceChildren(label, chips, showAll);
    this.shelf.style.display = "flex";
  }

  /** Repaint the floating multi-select action bar. Shown only with two or more
   *  nodes selected (a single selection keeps using the inspector). The hide
   *  button shelves every selected node. */
  private renderSelBar(): void {
    // Only count nodes still on the canvas — a stale shelved id never inflates it.
    const ids = [...this.selectedNodes].filter((id) => this.nodeEls.has(id));
    if (ids.length < 2) {
      this.selbar.style.display = "none";
      this.selbar.replaceChildren();
      return;
    }
    const m = t();

    const label = document.createElement("div");
    label.className = "selbar-label";
    const count = document.createElement("span");
    count.className = "selbar-count";
    count.textContent = String(ids.length);
    label.append(count, document.createTextNode(m.selbar.title));

    const hide = document.createElement("button");
    hide.type = "button";
    hide.className = "selbar-hide";
    hide.textContent = m.selbar.hide(ids.length);
    hide.addEventListener("click", () => this.hideSelected());

    const clear = document.createElement("button");
    clear.type = "button";
    clear.className = "selbar-clear";
    clear.textContent = m.selbar.clear;
    clear.addEventListener("click", () => this.clearSelection());

    this.selbar.replaceChildren(label, hide, clear);
    this.selbar.style.display = "flex";
  }

  // --- layout / export -----------------------------------------------------

  autoLayout(): void {
    // Stack each column top-to-bottom, but snap every node onto the ROW_GAP grid
    // so the result is identical to a fresh plan's default positions (which are
    // pure row * ROW_GAP) — running Arrange on an untouched board moves nothing.
    // A node spanning more than one row (an expanded note, or a hung ducker that
    // the default grid reserves a whole row for) advances by enough whole rows to
    // clear it, so expanded notes still never overlap the node below.
    const vgap = ROW_GAP - NODE_H;
    const colY = new Map<number, number>();
    this.plan.positions = {};
    for (const node of this.model.nodes) {
      if (this.isHidden(node.id)) continue;
      // A hung node (ducker) is positioned by its parent, not laid out on its own.
      if (node.attachTo) continue;
      const col = node.pos.col;
      const y = colY.get(col) ?? MARGIN;
      this.plan.positions[node.id] = { x: MARGIN + col * COL_GAP, y };
      // The vertical footprint of this node plus any hung children it must clear
      // (a ducker, or the stacked SD Rec track slots).
      let span = this.nodeHeight(node.id);
      for (const childId of this.attachedDescendants(node.id))
        if (!this.isHidden(childId)) span += DUCKER_GAP + this.nodeHeight(childId);
      const rows = Math.max(1, Math.ceil((span + vgap) / ROW_GAP));
      colY.set(col, y + rows * ROW_GAP);
    }
    this.render();
    this.fitView();
    this.cb.onChange();
    this.cb.onStatus(t().status.arranged);
  }

  private contentBounds(): { x: number; y: number; w: number; h: number } {
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of this.model.nodes) {
      if (this.isHidden(node.id)) continue;
      const p = this.posOf(node.id);
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x + NODE_W);
      // An expanded note panel extends the node's footprint downward; keep it in frame.
      maxY = Math.max(maxY, p.y + this.nodeHeight(node.id));
    }
    if (!Number.isFinite(minX)) return { x: 0, y: 0, w: 100, h: 100 };
    return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  }

  /** A standalone SVG clone, cropped to content with padding, for image export. */
  private cloneForExport(): { svg: SVGSVGElement; w: number; h: number } {
    const b = this.contentBounds();
    const pad = 28;
    const clone = this.svg.cloneNode(true) as SVGSVGElement;
    const vp = clone.querySelector("g") as SVGGElement;
    vp.removeAttribute("transform");
    clone.querySelectorAll(".overlay-temp").forEach((el) => el.remove());
    const w = b.w + pad * 2;
    const h = b.h + pad * 2;
    clone.setAttribute("viewBox", `${b.x - pad} ${b.y - pad} ${w} ${h}`);
    clone.setAttribute("width", String(w));
    clone.setAttribute("height", String(h));
    return { svg: clone, w, h };
  }

  async exportPng(filename: string): Promise<void> {
    const { svg, w, h } = this.cloneForExport();
    const opts = { width: w, height: h, scale: 2 };
    const res = await exportSvgToPng(svg, filename, opts, { ext: "png", label: t().filter.png });
    this.cb.onStatus(exportStatus(res, t().status.pngExported));
  }

  async exportPdf(filename: string): Promise<void> {
    const { svg, w, h } = this.cloneForExport();
    const opts = { width: w, height: h, scale: 2 };
    const res = await exportSvgToPdf(svg, filename, opts, { ext: "pdf", label: t().filter.pdf });
    this.cb.onStatus(exportStatus(res, t().status.pdfExported));
  }
}

/** Map a save result to a status line: the saved path, generic done, or cancel. */
function exportStatus(res: SaveResult, doneMsg: string): string {
  if (!res.saved) return t().status.canceled;
  return res.path ? t().status.savedTo(baseName(res.path)) : doneMsg;
}

/** Soft bloom reused by lit jack pins and the selected wire. */
function makeGlowDefs(): SVGDefsElement {
  const defs = document.createElementNS(SVGNS, "defs");
  const filter = document.createElementNS(SVGNS, "filter");
  filter.setAttribute("id", "jack-glow");
  filter.setAttribute("x", "-120%");
  filter.setAttribute("y", "-120%");
  filter.setAttribute("width", "340%");
  filter.setAttribute("height", "340%");
  const blur = document.createElementNS(SVGNS, "feGaussianBlur");
  blur.setAttribute("stdDeviation", "2.2");
  blur.setAttribute("result", "b");
  const merge = document.createElementNS(SVGNS, "feMerge");
  for (const input of ["b", "SourceGraphic"]) {
    const node = document.createElementNS(SVGNS, "feMergeNode");
    node.setAttribute("in", input);
    merge.append(node);
  }
  filter.append(blur, merge);
  defs.append(filter);

  // Soft drop shadow that gives light-theme nodes physical lift.
  const shadow = document.createElementNS(SVGNS, "filter");
  shadow.setAttribute("id", "node-shadow");
  shadow.setAttribute("x", "-20%");
  shadow.setAttribute("y", "-20%");
  shadow.setAttribute("width", "140%");
  shadow.setAttribute("height", "160%");
  const drop = document.createElementNS(SVGNS, "feDropShadow");
  drop.setAttribute("dx", "0");
  drop.setAttribute("dy", "1.5");
  drop.setAttribute("stdDeviation", "1.6");
  drop.setAttribute("flood-color", "rgba(60,45,20,0.35)");
  shadow.append(drop);
  defs.append(shadow);
  return defs;
}

// Full-width (CJK, kana, fullwidth forms, emoji) glyphs occupy two monospace
// cells; everything else one. Lets the wrap measure mixed JP/ASCII notes by
// rendered width instead of raw character count.
function cellW(ch: string): number {
  const c = ch.codePointAt(0) ?? 0;
  const wide =
    (c >= 0x1100 && c <= 0x115f) ||
    (c >= 0x2e80 && c <= 0x303e) ||
    (c >= 0x3041 && c <= 0x33ff) ||
    (c >= 0x3400 && c <= 0x4dbf) ||
    (c >= 0x4e00 && c <= 0x9fff) ||
    (c >= 0xa000 && c <= 0xa4cf) ||
    (c >= 0xac00 && c <= 0xd7a3) ||
    (c >= 0xf900 && c <= 0xfaff) ||
    (c >= 0xfe30 && c <= 0xfe4f) ||
    (c >= 0xff00 && c <= 0xff60) ||
    (c >= 0xffe0 && c <= 0xffe6) ||
    (c >= 0x1f300 && c <= 0x1faff) ||
    (c >= 0x20000 && c <= 0x3fffd);
  return wide ? 2 : 1;
}

function noteWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += cellW(ch);
  return w;
}

function notePanelHeight(lines: string[]): number {
  return NOTE_TOP_GAP + NOTE_PAD_Y * 2 + lines.length * NOTE_LINE_H + NOTE_BOT_GAP;
}

// Wrap a note to a cell-width budget, hard-splitting tokens too wide to fit
// (the only break CJK allows) and preserving the line breaks the user typed.
function wrapNote(text: string, maxUnits: number): string[] {
  const out: string[] = [];
  for (const para of text.replace(/\r/g, "").split("\n")) {
    if (para.trim() === "") {
      out.push("");
      continue;
    }
    let line = "";
    let lineW = 0;
    const flush = (): void => {
      out.push(line);
      line = "";
      lineW = 0;
    };
    for (const word of para.split(/\s+/).filter(Boolean)) {
      if (noteWidth(word) > maxUnits) {
        if (line) flush();
        for (const ch of word) {
          const cw = cellW(ch);
          if (lineW + cw > maxUnits) flush();
          line += ch;
          lineW += cw;
        }
        continue;
      }
      const sep = line ? 1 : 0;
      if (lineW + sep + noteWidth(word) > maxUnits) flush();
      line = line ? `${line} ${word}` : word;
      lineW += sep + noteWidth(word);
    }
    out.push(line);
  }
  return out;
}

/** One label line at the fixed left inset, vertically centered on `y`. */
function labelText(
  text: string,
  y: number,
  fontSize: number,
  letterSpacing: number,
  fill: string,
  opacity: number,
): SVGTextElement {
  const el = document.createElementNS(SVGNS, "text");
  el.setAttribute("x", String(LABEL_X));
  el.setAttribute("y", String(y));
  el.setAttribute("dominant-baseline", "central");
  el.setAttribute("fill", fill);
  if (opacity !== 1) el.setAttribute("fill-opacity", String(opacity));
  el.setAttribute("font-family", LABEL_FONT);
  el.setAttribute("font-size", String(fontSize));
  el.setAttribute("letter-spacing", String(letterSpacing));
  el.style.pointerEvents = "none";
  el.style.userSelect = "none";
  el.textContent = text;
  return el;
}

// Shrink factor that keeps a label clear of the header button. Monospace, so the
// rendered width is estimated from the cell count (CJK glyphs span two cells).
function fitScale(text: string, fontSize: number, letterSpacing: number): number {
  const est = noteWidth(text) * (fontSize * MONO_ADVANCE + letterSpacing);
  return est > LABEL_MAX_W ? Math.max(LABEL_MIN_SCALE, LABEL_MAX_W / est) : 1;
}

function svgRect(x: number, y: number, w: number, h: number, rx: number, fill: string): SVGRectElement {
  const r = document.createElementNS(SVGNS, "rect");
  r.setAttribute("x", String(x));
  r.setAttribute("y", String(y));
  r.setAttribute("width", String(w));
  r.setAttribute("height", String(h));
  r.setAttribute("rx", String(rx));
  r.setAttribute("fill", fill);
  r.style.pointerEvents = "none";
  return r;
}

function svgLine(x1: number, y1: number, x2: number, y2: number, stroke: string, width: number, opacity: number): SVGLineElement {
  const l = document.createElementNS(SVGNS, "line");
  l.setAttribute("x1", String(x1));
  l.setAttribute("y1", String(y1));
  l.setAttribute("x2", String(x2));
  l.setAttribute("y2", String(y2));
  l.setAttribute("stroke", stroke);
  l.setAttribute("stroke-width", String(width));
  l.setAttribute("stroke-linecap", "round");
  l.setAttribute("opacity", String(opacity));
  l.style.pointerEvents = "none";
  return l;
}
