// @vitest-environment jsdom

// Every value a press on the LCD writes is one the SIM view answers for.
//
// urx-lcd-sim's store sends an edit whole or not at all: where the view's transport cannot write
// one of the paths a press writes, and the path is not one the screens keep for themselves, the
// whole press is taken back. The transport takes a path the table binds, one the view keeps as
// the simulator's own (`GLASS_OWN`), a [CUE] flag, HOME's [Sends] destination and the unit's
// values. A path the simulator starts writing beside an edit is none of those until it is added
// to one, and the control that writes it is drawn as usable and does nothing — which is what a
// newer commit of the submodule can bring in.
//
// The paths are collected by pressing: each screen the simulator registers is mounted on its own
// shell, in the states that bring its controls into reach, and every control it draws is pressed
// the way its kind is pressed, with the controls of a list or a sheet the press opens. What is
// read is the path of every `store.set` a press makes and of every write its edit sends. The walk
// and its states are those of the simulator's own src/app/lock-names.contract.test.ts, which holds
// each control to naming what it writes, except that every control a screen draws is pressed here:
// a run of controls built alike can write a path each, as an effect's values do. A write made only
// by a gesture this does not make (a drag, a held press, a wheel), in a state it does not seed, by
// a timer, by the middle of a long list or sheet a press opens, or on a screen only the URX22 or
// the URX44 draws, is not collected.

import { beforeAll, describe, expect, it } from "vitest";
import { type ParamPath, type ParamValue, refusedActions, shippedValues } from "urx-lcd-sim/embed";
import type { Route } from "../../node_modules/urx-lcd-sim/src/app/navigator";
import { Shell } from "../../node_modules/urx-lcd-sim/src/app/shell";
import { SimTransport } from "../../node_modules/urx-lcd-sim/src/device/sim-transport";
import { DeviceStore } from "../../node_modules/urx-lcd-sim/src/device/store";
import { type CardEntry, writeCard } from "../../node_modules/urx-lcd-sim/src/model/card";
import { factoryState } from "../../node_modules/urx-lcd-sim/src/model/defaults";
import {
  effectParams,
  FX_EFFECTS,
  INPUT_INSERT_EFFECTS,
  NO_EFFECT,
  OUTPUT_INSERT_EFFECTS,
} from "../../node_modules/urx-lcd-sim/src/model/effects";
import { carriesInsert, findStrip, type Strip } from "../../node_modules/urx-lcd-sim/src/model/types";
import { unitById } from "../../node_modules/urx-lcd-sim/src/model/units";
import { buildRegistry } from "../../node_modules/urx-lcd-sim/src/screens";
import { startPlayback } from "../../node_modules/urx-lcd-sim/src/screens/recording";
import { screenOnly } from "../../node_modules/urx-lcd-sim/src/screens/screen-only";
import { integrationSlotAt } from "../core/control/daw-integration";
import { cueAddrs } from "../core/control/translate";
import { simLocks } from "../core/sim-locks";
import { simBindings } from "../core/sim-map";
import { isSetupGlassPath } from "../core/sim-map-setup";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";
import { GLASS_OWN, PlanTransport } from "./sim-view";

const MODEL_ID = "URX44V";
const UNIT = unitById(MODEL_ID);
const model = getModel(MODEL_ID);
const bindings = simBindings(model);
const registry = buildRegistry();

/** The view's transport as a Live sync session leaves it, which is where it takes the most: the
 *  [Sends] destination and every [CUE] flag held, and the unit's values the app's entry names. */
const plan = defaultPlan(MODEL_ID);
const transport = new PlanTransport(bindings, shippedValues(MODEL_ID), {
  getPlan: () => plan,
  apply: () => true,
  unitSendsTarget: () => "ST",
  setUnitSendsTarget: () => true,
  unitCues: () => new Map(cueAddrs(model).map((a) => [a.node, false])),
  setUnitCue: () => true,
  clearUnitCues: () => true,
  unitCueMemory: () => [],
  unitValues: () => new Map(),
  // main.ts's `isUnitPath`, which it builds in place.
  isUnitPath: (path) => path === "setup.followUsb" || integrationSlotAt(path) !== null || isSetupGlassPath(model, path),
  writeUnitValue: (_path, value) => Promise.resolve(value),
});

/** Whether a press that writes `path` is kept: the screens' own value, which the simulator holds
 *  no edit back for, a path the table binds, or one the view's transport takes. */
const answered = (path: string): boolean => screenOnly(path) || bindings.has(path) || transport.writable(path);

/** What the view holds shut whatever the session: the unit's own operations and the screens of
 *  the settings the app does not write. The walk leaves them shut, as the glass does. */
const LOCKS = simLocks(
  [],
  [],
  { linked: true, live: true, rateOpen: true, rateScope: false, followUsbOn: false },
  {
    unitOnly: "",
    notAccepted: "",
    unitOp: "",
    rateLinked: "",
    rateScope: "",
    rateFollowUsb: "",
    trackCountLive: "",
    integrationOff: "",
    setupOffline: "",
  },
);
const SHUT_SCREENS = new Set(LOCKS.flatMap((l) => (l.target.kind === "screen" ? [l.target.id] : [])));

type Edit = [ParamPath, ParamValue];
type Seed = (store: DeviceStore) => Promise<void>;

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** One strip of each kind, the first the unit lists. */
const STRIPS: Strip[] = (() => {
  const seen = new Set<string>();
  return [...UNIT.inputs, ...UNIT.outputs].filter((s) => !seen.has(s.kind) && seen.add(s.kind));
})();

const channelScreen = (id: string): boolean => id === "channel-view" || id.startsWith("ch.");

const entry = (name: string, kind: CardEntry["kind"], dir: string): CardEntry => ({
  name,
  kind,
  seconds: kind === "take" ? 10 : 0,
  tracks: kind === "take" ? 2 : 0,
  stamp: kind === "folder" ? "" : "04/30/2026\n15:29:28",
  dir,
});

/** Every effect the strip `id` can carry, taken, and again with its 1-knob on where it has one. */
function effectStates(id: string): Record<string, Seed> {
  const strip = findStrip(UNIT, id);
  const out: Record<string, Seed> = {};
  if (!strip) return out;
  const fx = FX_EFFECTS[id];
  const taking = fx
    ? fx.map((o) => ({ name: o.name, base: `ch.${id}.effect`, namePath: `ch.${id}.effect.type`, onPath: "" }))
    : carriesInsert(strip)
      ? (strip.side === "output" ? OUTPUT_INSERT_EFFECTS : INPUT_INSERT_EFFECTS).map((o) => ({
          name: o.name,
          base: `ch.${id}.insFx`,
          namePath: `ch.${id}.insFx.effect`,
          onPath: `ch.${id}.insFx.on`,
        }))
      : [];
  for (const t of taking) {
    if (t.name === NO_EFFECT) continue;
    const taken =
      (oneKnob: boolean): Seed =>
      async (store) => {
        await store.set(t.namePath, t.name);
        if (t.onPath) await store.set(t.onPath, true);
        for (const p of effectParams(t.name)) await store.set(`${t.base}.${p.key}`, p.fallback);
        if (oneKnob) await store.set(`${t.base}.oneKnobOn`, true);
      };
    out[`with ${t.name} taken`] = taken(false);
    if (effectParams(t.name).some((p) => p.key === "oneKnobOn")) out[`with ${t.name} taken, 1-knob on`] = taken(true);
  }
  return out;
}

/** The units a route's presses start from: as it ships, and in the states that bring into reach
 *  the controls the factory state leaves out of it — a strip in the cue and a card holding an
 *  open folder with a take in it playing, 1-knob on, Follow USB off, and each effect a channel
 *  can carry. */
function statesFor(route: Route): Record<string, Seed> {
  const states: Record<string, Seed> = { "as shipped": async () => undefined };
  const id = route.id;
  if (
    ["home", "bank-select", "sends-select", "channel-view"].includes(id) ||
    id.startsWith("microsd") ||
    id.startsWith("monitor")
  )
    states["in use"] = async (store) => {
      await store.set("ch.ch1.cue", true);
      await writeCard(store, [
        entry("Recordings", "folder", "/"),
        entry("take.wav", "take", "/Recordings/"),
        entry("other.wav", "take", "/Recordings/"),
      ]);
      await store.set("sd.path", "/Recordings/");
      startPlayback(store, 1);
    };
  if (["channel-view", "ch.eq", "ch.comp"].includes(id))
    states["with 1-knob on"] = async (store) => {
      for (const path of store.paths()) if (/\.(eq|comp)\.oneKnob\.on$/.test(path)) await store.set(path, true);
    };
  if (id === "setup.rate")
    states["with Follow USB off"] = async (store) => void (await store.set("setup.followUsb", false));
  if ((id === "ch.insfx" || id === "ch.effect") && route.strip) Object.assign(states, effectStates(route.strip));
  return states;
}

/** What a press on a control can be: a touch on a button or on an element in one of the touched
 *  roles, or a turn of a value by the keys. */
const PRESSED_ROLES = new Set(["button", "switch", "option", "tab", "radio", "checkbox"]);
const TURNED_ROLES = new Set(["slider", "spinbutton"]);
const turned = (node: Element): boolean => TURNED_ROLES.has(node.getAttribute("role") ?? "");

/** How many states of its screen a route is pressed in at most: the one it opens on, and those
 *  its own tabs and pages lead to. */
const STATES_PER_ROUTE = 8;

/** How many controls of a run built alike are pressed at each end of it, on a list or a sheet a
 *  press opens: its rows and tiles are the choices of one value. */
const RUN_ENDS = 2;

/** The screens' own values that move the screen onto another strip, which a route of its own
 *  covers. */
const OTHER_STRIP = /^ui\.(selectedStrip|lane\.)/;

/** A value that only changes what the screen shows next: the screens' own, and the tab a screen
 *  of the simulator's own stands on. A press that writes nothing else is carried into the next
 *  survey of the same screen, so the controls behind a tab are pressed too. */
const shows = (path: string): boolean => path.startsWith("ui.") || (GLASS_OWN.has(path) && path.endsWith(".tab"));

/** The controls in reach on the glass, in the order the screen draws them. */
const controls = (root: HTMLElement): HTMLElement[] =>
  [...root.getElementsByTagName("*")].filter(
    (n): n is HTMLElement =>
      (n.tagName === "BUTTON" || PRESSED_ROLES.has(n.getAttribute("role") ?? "") || turned(n)) &&
      !n.classList.contains("is-disabled") &&
      n.getAttribute("aria-disabled") !== "true",
  );

/** What a run of controls built alike stands in: their parent, or the parent's own parent where
 *  the parent is one of a run of rows built alike. */
function holderOf(node: HTMLElement): Element | null {
  const row = node.parentElement;
  const rows = row?.parentElement;
  if (!row || !rows) return row;
  return [...rows.children].filter((c) => c.tagName === row.tagName && c.className === row.className).length > 1
    ? rows
    : row;
}

/** The indexes of `nodes` pressed: every one, but only the ends of a run built alike. */
function sampled(nodes: readonly HTMLElement[]): number[] {
  const runs = new Map<string, number[]>();
  const holders = new Map<Element, number>();
  nodes.forEach((n, i) => {
    const holder = holderOf(n);
    if (holder && !holders.has(holder)) holders.set(holder, holders.size);
    const kind = [...n.classList].filter((c) => !c.startsWith("is-")).join(".");
    const key = `${holder ? holders.get(holder) : -1}|${n.tagName}|${n.getAttribute("role") ?? ""}|${kind}`;
    runs.set(key, [...(runs.get(key) ?? []), i]);
  });
  return [...runs.values()]
    .flatMap((run) => (run.length <= RUN_ENDS * 2 ? run : [...run.slice(0, RUN_ENDS), ...run.slice(-RUN_ENDS)]))
    .sort((a, b) => a - b);
}

const describeNode = (node: HTMLElement): string =>
  `${node.tagName.toLowerCase()}.${[...node.classList].join(".")} "${(
    node.getAttribute("aria-label") ??
    node.textContent ??
    ""
  )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 30)}"`;

/** Press `node` the way its kind is pressed. */
function press(node: HTMLElement): void {
  if (turned(node)) {
    for (const key of ["ArrowUp", "ArrowDown", "ArrowRight", "ArrowLeft"])
      node.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  } else node.click();
}

/** The controls a list or a sheet laid over the screen carries that `before` did not hold. */
const layered = (root: HTMLElement, before: ReadonlySet<HTMLElement>): HTMLElement[] =>
  controls(root).filter((n) => !before.has(n) && n.closest("[data-overlay]") !== null);

/** The line of the simulator's source a `store.set` was made from, off the stack taken at the call. */
function callSite(taken: Error): string | null {
  for (const line of (taken.stack ?? "").split("\n")) {
    const at = /urx-lcd-sim[\\/](src[\\/][^\s:)]+):(\d+)/.exec(line);
    if (at && !/device[\\/]store\.ts$/.test(at[1]!)) return `vendor/urx-lcd-sim/${at[1]!.replace(/\\/g, "/")}:${at[2]}`;
  }
  return null;
}

/** A glass on `route`, on a unit in the state `seed` and `shown` leave it in, with what a press
 *  on it writes: each `store.set` it makes, and each path its edit sends that it did not name. */
interface Mounted {
  shell: Shell;
  edits: { path: ParamPath; value: ParamValue; taken: Error }[];
  sent: ParamPath[];
}

async function mount(route: Route, seed: Seed, shown: readonly Edit[]): Promise<Mounted> {
  const store = new DeviceStore();
  const unit = new SimTransport(factoryState(UNIT));
  await store.attach(unit);
  await seed(store);
  if (route.id.startsWith("ch.ssmcs") && STRIPS.find((s) => s.id === route.strip)?.kind === "monoIn")
    await store.set(`ch.${route.strip}.compEqOrder`, "SSMCS");
  for (const [path, value] of shown) await store.set(path, value);
  // As the view mounts the glass: the unit's own operations refused, an insert's values the page's.
  const shell = new Shell(registry, store, UNIT, [route], {
    actions: refusedActions(),
    locks: LOCKS,
    insertValuesFromPage: true,
  });
  await flush();
  const edits: Mounted["edits"] = [];
  const sent: ParamPath[] = [];
  // What a control counts as it is drawn (`writesOf`) writes nothing.
  let counting = 0;
  const set = store.set.bind(store);
  const writesOf = store.writesOf.bind(store);
  store.writesOf = (op: () => void): ParamPath[] => {
    counting++;
    try {
      return writesOf(op);
    } finally {
      counting--;
    }
  };
  store.set = (path: ParamPath, value: ParamValue): Promise<void> => {
    if (counting === 0) edits.push({ path, value, taken: new Error() });
    return set(path, value);
  };
  const write = unit.write.bind(unit);
  unit.write = (path: ParamPath, value: ParamValue, onSent?: () => void): Promise<ParamValue> => {
    sent.push(path);
    return write(path, value, onSent);
  };
  return { shell, edits, sent };
}

/** Every path the walk saw written, with the first press that wrote it: the control, the screen and
 *  the state, and the call that made the write where the press named the path itself. */
const written = new Map<string, { where: string; taken: Error | null }>();
/** The screens the walk pressed nothing on. */
const unpressed: string[] = [];

function note(at: Mounted, where: string): void {
  for (const e of at.edits) if (!written.has(e.path)) written.set(e.path, { where, taken: e.taken });
  const named = [...new Set(at.edits.map((e) => e.path))];
  for (const path of at.sent)
    if (!written.has(path)) written.set(path, { where: `${where}, carried with ${named.join(", ")}`, taken: null });
}

/** Press every control `route` draws on a unit in `state`, one press to a glass: a press that
 *  moves only the screen's own showing leads to another state of the same screen, which is
 *  pressed in turn, and a press that opens a list or a sheet leads to the controls it carries. */
async function survey(route: Route, state: string, seed: Seed): Promise<void> {
  const name = `${route.id}${route.strip ? ` on ${route.strip}` : ""} (${state})`;
  const seen = new Set<string>(["[]"]);
  const queue: Edit[][] = [[]];
  let presses = 0;
  for (let shown = queue.shift(); shown; shown = queue.shift()) {
    const drawn = await mount(route, seed, shown);
    const count = drawn.shell.root.dataset["screen"] === route.id ? controls(drawn.shell.root).length : 0;
    drawn.shell.destroy();
    for (let i = 0; i < count; i++) {
      const at = await mount(route, seed, shown);
      const root = at.shell.root;
      const before = new Set(controls(root));
      const node = [...before][i];
      if (!node) throw new Error(`no control ${i} on ${name}`);
      const where = `${describeNode(node)} on ${name}`;
      press(node);
      await flush();
      presses++;
      note(at, where);
      const paths = [...new Set(at.edits.map((e) => e.path))];
      const sameScreen = root.dataset["screen"] === route.id;
      const shownOnly = paths.every(shows);
      if (sameScreen && shownOnly && paths.length && !paths.some((p) => OTHER_STRIP.test(p))) {
        const next: Edit[] = [
          ...shown.filter(([p]) => !paths.includes(p)),
          ...at.edits.map((e): Edit => [e.path, e.value]),
        ];
        const key = JSON.stringify([...next].sort(([a], [b]) => a.localeCompare(b)));
        if (!seen.has(key) && seen.size < STATES_PER_ROUTE) {
          seen.add(key);
          queue.push(next);
        }
      }
      const picks = sameScreen && shownOnly ? sampled(layered(root, before)) : [];
      at.shell.destroy();
      for (const j of picks) {
        const again = await mount(route, seed, shown);
        const held = new Set(controls(again.shell.root));
        const opener = [...held][i];
        if (!opener) throw new Error(`no control ${i} on ${name}`);
        press(opener);
        await flush();
        const pick = layered(again.shell.root, held)[j];
        if (!pick) throw new Error(`no control ${j} on what ${where} opens`);
        again.edits.length = 0;
        again.sent.length = 0;
        press(pick);
        await flush();
        note(again, `${describeNode(pick)} on what ${where} opens`);
        again.shell.destroy();
      }
    }
  }
  if (presses === 0) unpressed.push(name);
}

describe("the paths a press on the LCD writes", () => {
  beforeAll(async () => {
    const routes = registry
      .ids()
      .sort()
      .filter((id) => !SHUT_SCREENS.has(id))
      .flatMap((id): Route[] => (channelScreen(id) ? STRIPS.map((s) => ({ id, strip: s.id })) : [{ id }]));
    for (const route of routes)
      for (const [state, seed] of Object.entries(statesFor(route))) await survey(route, state, seed);
  }, 300_000);

  it("are each one the view answers for: the table's, the screens' own, GLASS_OWN, a [CUE] flag or the unit's", () => {
    const unanswered = [...written]
      .filter(([path]) => !answered(path))
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([path, { where, taken }]) => {
        const site = taken && callSite(taken);
        return `${path} — written ${site ? `at ${site} ` : ""}by ${where}`;
      });
    expect(unanswered).toEqual([]);
  });

  it("were collected on every screen the view leaves open", () => {
    expect(unpressed).toEqual([]);
  });

  // The walk reaches the writes the view already keeps: one it has stopped seeing is either a
  // path the simulator no longer writes or a press the walk no longer makes.
  it("reach the controls behind a tab of the simulator's own: the USB outputs and the HDMI settings", () => {
    const behind = [
      "setup.outputPatch.usbMainA",
      "setup.outputPatch.usbMainB",
      "setup.outputPatch.usbMainC",
      "setup.outputPatch.usbSub",
      "setup.peripheral.hdmiChannels",
      "setup.peripheral.hdmiEnable",
    ];
    expect(behind.filter((path) => !written.has(path))).toEqual([]);
  });

  it("include every path GLASS_OWN names, and a linked pair's compressor split", () => {
    expect([...GLASS_OWN].filter((path) => !written.has(path))).toEqual([]);
    expect([...written.keys()].filter((path) => /^pair\.[^.]+\.compSplit$/.test(path))).not.toEqual([]);
  });
});
