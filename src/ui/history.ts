// Undo / redo for the plan: gesture boundaries, the keyboard shortcut, and the
// apply sequence. The reversible patch itself lives in core/plan-history.ts; this
// is the part that knows about pointers, focus and the views.
//
// One entry spans from the first edit after the previous commit to the first
// boundary, and the diff is taken at the commit rather than at the edit. That is
// what makes the mutations the funnels perform *after* markChanged() land in the
// same entry — switching COMP/EQ type resets the destination chain, and linking a
// STEREO pair moves the partner's position, both after their funnel call.
//
// Boundaries are global and observational (capture phase, never preventing or
// stopping anything), because per-control begin/end bracketing would be twenty
// places to remember and a missed one is an edit that silently cannot be undone.

import { t } from "../i18n";
import type { Plan } from "../core/plan";
import type { PatchTouch, PlanPatch } from "../core/plan-history";
import { applyPatch, patchTouch, PlanHistoryStack } from "../core/plan-history";
import { ownsNativeUndo } from "./keys";

/** How long after the last edit an entry closes when no pointer or focus boundary
 *  ends it — a wheel notch burst, or an incoming MIDI sweep, which produce no DOM
 *  gesture at all. Matches the 300 ms the MIDI engine already treats as "messages
 *  from this control have stopped arriving" (core/midi/engine.ts RECENT_MS). The
 *  timer re-arms on every edit, unlike live.ts's deliberately non-re-arming
 *  debounce: live sync cannot let a drag go unsent, whereas the values are already
 *  in the plan here and the entry only has to close before the next Ctrl+Z. */
export const IDLE_COMMIT_MS = 300;

/** Which way the history is being walked. Also the `document.execCommand` name for
 *  the same operation, which is what lets the menu path hand it to a text field. */
export type Direction = "undo" | "redo";

/** Keys that end an edit rather than continue one. Arrow / Page / Home / End step
 *  a fader or a knob one detent per keydown and autorepeat while held, with no
 *  other terminator. */
const BOUNDARY_KEYS = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
  "Enter",
  " ",
]);

export interface PlanHistoryHooks {
  getPlan: () => Plan;
  /** Re-render the views for a patch that has already been applied to the plan,
   *  and report the change through the normal edit funnel. */
  reflect: (touch: PatchTouch) => void;
  /** A localized refusal, or null when the operation may proceed (a device read
   *  mutating the plan across awaits, a file flow, a blocking modal). */
  blocked: () => string | null;
  /** True while a live session holds the sample rate at the device's value. */
  rateLocked: () => boolean;
  /** Display name for a node id, for the status line. */
  labelOf: (nodeId: string) => string;
  onStatus: (msg: string) => void;
  /** The undo / redo depth changed. Unused while the shortcut is the only entry
   *  point; a menu or toolbar affordance would drive its enabled state from here
   *  together with canUndo / canRedo. */
  onDepthChange?: () => void;
}

export class PlanHistory {
  private readonly stack: PlanHistoryStack;
  /** An entry is open: at least one edit has landed since the last commit. */
  private open = false;
  /** Suppresses recording while an undo's own reflect runs back through the funnel. */
  private applying = false;
  /** Where the pointer is in a gesture. `down` means the gesture will close its own
   *  entry, so the idle backstop must not split it at a pause; `drag` (it has moved)
   *  is additionally what an undo refuses, since a drag holds start values and
   *  element references in closures the repaint would rebuild under it. */
  private press: "none" | "down" | "drag" = "none";
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private commitTimer: ReturnType<typeof setTimeout> | null = null;
  /** The last (canUndo, canRedo) pair reported, so only real transitions are. Seeded
   *  with the state a fresh history is in; the initial push is the caller's, once. */
  private reported = { undo: false, redo: false };

  constructor(private readonly hooks: PlanHistoryHooks) {
    this.stack = new PlanHistoryStack(hooks.getPlan());
  }

  /** Register the global gesture boundaries. Call once at startup. */
  install(): void {
    window.addEventListener(
      "pointerdown",
      () => {
        // A new press ends the previous gesture for good, and that gesture's own
        // click has already been dispatched by now, so land its deferred commit
        // rather than let this press join it — a late macrotask on a busy page
        // would otherwise merge two deliberate clicks into one entry.
        if (this.commitTimer !== null) this.commit();
        this.press = "down";
        this.clearIdle();
      },
      true,
    );
    window.addEventListener(
      "pointermove",
      () => {
        // Only the transition matters. A press that never moves is not a drag, so a
        // script-dispatched pointerdown with no matching pointerup (how a wire is
        // selected) cannot wedge the refusal.
        if (this.press !== "down") return;
        this.press = "drag";
        this.clearIdle();
      },
      true,
    );
    const up = (): void => {
      this.press = "none";
      // One macrotask later: click and dblclick are dispatched after pointerup, so
      // a chip toggle's edit arrives after the gesture that produced it ended.
      this.commitSoon();
    };
    window.addEventListener("pointerup", up, true);
    window.addEventListener("pointercancel", up, true);
    // A press that never lifts because the window went away must not leave a drag
    // standing — the same reasoning fine.ts applies to a missed Shift keyup.
    window.addEventListener("blur", up);
    window.addEventListener(
      "keyup",
      (e) => {
        // Character keys are not boundaries: the name field edits the plan on every
        // keystroke, and committing per character would cost one Ctrl+Z per letter.
        // Its own end-of-edit is the focusout below.
        //
        // Committed at once, not deferred: nothing is dispatched after a keyup that
        // edits on this gesture's behalf (unlike click after pointerup), and the
        // next key press is a new gesture — deferring would let an autorepeat
        // outrun the macrotask and merge two presses into one entry.
        if (BOUNDARY_KEYS.has(e.key) && !ownsNativeUndo(e.target)) this.commit();
      },
      true,
    );
    // The only end of edit for the node-name field and the in-frame note editor.
    // Nothing edits the plan on the way out either, so this commits at once too.
    window.addEventListener("focusout", () => this.commit(), true);
  }

  /** An edit changed the plan (called from the one change funnel). */
  note(): void {
    if (this.applying) return;
    this.open = true;
    this.notifyDepth();
    // The backstop is only for edits with no boundary of their own. A pointer
    // gesture closes its entry at pointerup, and a text field at focusout, so
    // arming it under either would split one action in two — a name typed with a
    // pause between letters would otherwise cost an entry per letter.
    if (this.press !== "none" || ownsNativeUndo(document.activeElement)) return;
    this.armIdle();
  }

  /** The plan settled at values no entry should describe: a device readback landed,
   *  or device-follow wrote a node-local scalar straight into it. Re-takes the
   *  baseline so those values cannot ride along in the next entry, and drops any
   *  entry still open (an app edit inside that window goes unrecorded, which is the
   *  conservative side of the trade — the alternative bakes a device-authored value
   *  into a patch whose inverse would then push it back over the operator). */
  rebase(): void {
    this.cancelPending();
    this.open = false;
    this.stack.rebase(this.hooks.getPlan());
    this.notifyDepth();
  }

  /** A device read re-authored part of the plan, possibly inside an open entry: take
   *  exactly the keys it authored into the baseline. The entry stays OPEN and its
   *  boundaries are untouched, so a gesture that straddles the read still commits as one
   *  entry — which rebase() cannot do, since a whole-plan baseline cannot tell the
   *  device's values from the ones the gesture is putting there. Neither stack moves and
   *  the depth cannot change, so nothing is reported (a report crosses IPC to a native
   *  menu item, and this runs once per flush window of a drag). */
  absorb(patch: PlanPatch): void {
    this.stack.absorb(patch);
  }

  /** A different document, or every value re-authored by the device: drop both
   *  stacks. No earlier entry describes a state this plan can return to. */
  reset(): void {
    this.cancelPending();
    this.open = false;
    this.stack.reset(this.hooks.getPlan());
    this.notifyDepth();
  }

  /** An open entry counts: undo() commits before it acts, so a gesture still in
   *  progress is undoable — even though it may yet diff to nothing. */
  canUndo(): boolean {
    return this.open || this.stack.canUndo();
  }

  canRedo(): boolean {
    return this.stack.canRedo();
  }

  /** Committed entry counts. `canUndo` deliberately answers true for an entry that is
   *  still open, which is what a menu needs; this is the settled depth instead, so a
   *  caller counting gestures is not off by the one in progress. */
  depth(): { undo: number; redo: number } {
    return this.stack.depth();
  }

  /** Report a depth change only when what a menu would render actually moved. note()
   *  fires on every edit — dozens per drag — and each report crosses the IPC boundary
   *  to push a native menu item's enabled state, so an unguarded call would spend one
   *  round-trip per pointermove. */
  private notifyDepth(): void {
    const undo = this.canUndo();
    const redo = this.canRedo();
    if (this.reported.undo === undo && this.reported.redo === redo) return;
    this.reported = { undo, redo };
    this.hooks.onDepthChange?.();
  }

  /** Undo from the application menu. A text surface owns its own undo stack and the
   *  shortcut already leaves the chord to it, so the menu has to agree — otherwise the
   *  same command means two different things depending on how it was invoked. */
  menu(kind: Direction): void {
    // The focused text surface owns the command, exactly as it owns the chord.
    // execCommand is deprecated but is the only way to reach WebKit's field undo from
    // script, and it was measured working in WKWebView (a typing burst is one unit,
    // as it is for the chord). Handled either way: a field with nothing to undo is
    // the field's answer, not a reason to undo the plan behind it.
    if (ownsNativeUndo(document.activeElement)) {
      document.execCommand(kind);
      return;
    }
    if (kind === "undo") this.undo();
    else this.redo();
  }

  /** Handle the shortcut. Returns true when it acted, so the caller can stop. */
  handleKey(e: KeyboardEvent): boolean {
    if (e.isComposing) return false;
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return false;
    const key = e.key.toLowerCase();
    if (key !== "z" && key !== "y") return false;
    // The field's own stack owns the chord; not preventing default is what lets
    // WebKit / Chromium run the native text undo.
    if (ownsNativeUndo(e.target)) return false;
    e.preventDefault();
    if (key === "y" || e.shiftKey) this.redo();
    else this.undo();
    return true;
  }

  undo(): void {
    this.run("undo");
  }

  redo(): void {
    this.run("redo");
  }

  private run(kind: Direction): void {
    // Resolved once, so the direction is not re-tested at every step below.
    const s = t().status;
    const op =
      kind === "undo"
        ? { peek: () => this.stack.peekUndo(), take: () => this.stack.takeUndo(), none: s.nothingToUndo, done: s.undone, doneNode: s.undoneNode } // prettier-ignore
        : { peek: () => this.stack.peekRedo(), take: () => this.stack.takeRedo(), none: s.nothingToRedo, done: s.redone, doneNode: s.redoneNode }; // prettier-ignore
    // Answered without committing when nothing is open: the stack is then already
    // authoritative, and a refusal below would otherwise imply an entry the press
    // could have lost.
    if (!this.open && !op.peek()) {
      this.hooks.onStatus(op.none);
      return;
    }
    // Refusals run before the open entry is CLOSED, not merely before it is consumed.
    // commit() diffs the live plan, and under a device read that plan is mid-
    // re-authoring: committing there would freeze the readback's own writes into the
    // entry, and the retry the refusal invites would then push them back at the unit.
    const refusal = this.hooks.blocked();
    if (refusal) {
      this.hooks.onStatus(refusal);
      return;
    }
    if (this.press === "drag") {
      this.hooks.onStatus(s.undoBusyDrag);
      return;
    }
    this.commit();
    const pending = op.peek();
    if (!pending) {
      this.hooks.onStatus(op.none);
      return;
    }
    const touch = patchTouch(pending);
    // While a session is up the rate is the device's, settled at the write
    // boundary; the picker is locked for the same reason. Refusing keeps the patch
    // atomic, so an entry that moved something else too is refused whole — the
    // wording says so, chosen by whether the entry is nothing but the rate. The
    // entry is held back rather than lost: this runs on a peeked entry, before
    // op.take(), and leaving the session makes the same press work.
    if (touch.fields.has("sampleRate") && this.hooks.rateLocked()) {
      this.hooks.onStatus(touch.fields.size === 1 ? s.undoRateLive : s.undoRateLiveMixed);
      return;
    }
    const patch = op.take();
    if (!patch) return;
    this.apply(patch, touch);
    const single = touch.nodes.size === 1 ? this.hooks.labelOf([...touch.nodes][0]) : null;
    this.hooks.onStatus(single ? op.doneNode(single) : op.done);
  }

  private apply(patch: PlanPatch, touch: PatchTouch): void {
    this.applying = true;
    try {
      const missing = applyPatch(this.hooks.getPlan(), patch);
      if (missing.length) {
        // The plan moved on under the entry (a wire removed since). What could be
        // applied was; the rest has nowhere to land.
        console.warn("history: patch targets no longer in the plan", missing);
      }
      this.hooks.reflect(touch);
    } finally {
      this.applying = false;
    }
    // The plan now holds the patched values; the next entry diffs from here.
    this.stack.rebase(this.hooks.getPlan());
    this.notifyDepth();
  }

  /** Close the open entry now. A gesture that moved no value diffs to nothing and
   *  records no entry, so a mis-grab costs no Ctrl+Z. */
  private commit(): void {
    this.cancelPending();
    if (!this.open) return;
    this.open = false;
    this.stack.record(this.hooks.getPlan());
    // Reported unconditionally: a gesture that recorded nothing still closed the open
    // entry, which can take canUndo back to false.
    this.notifyDepth();
  }

  private commitSoon(): void {
    if (this.commitTimer !== null) return;
    this.commitTimer = setTimeout(() => {
      this.commitTimer = null;
      this.commit();
    }, 0);
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      this.commit();
    }, IDLE_COMMIT_MS);
  }

  private clearIdle(): void {
    if (this.idleTimer === null) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private cancelPending(): void {
    this.clearIdle();
    if (this.commitTimer === null) return;
    clearTimeout(this.commitTimer);
    this.commitTimer = null;
  }
}
