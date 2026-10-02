// Everything the plan loader reports about a document, in one place. Split out of
// constraints.ts, which is the sample-rate-dependent feature limits and nothing else:
// a rate limit is a warning about a plan the app itself authored, while these are the
// checks a plan built ELSEWHERE (a file, a ?plan= link, a generator) has to pass.
// routing.ts cannot host them — constraints -> translate -> routing is a real
// dependency chain — so they live here. Language-agnostic: the UI maps codes to
// messages. Nothing here runs on a device readback (see insertFxSlotProblems).

import type { DeviceModel } from "../models/types";
import { parseRef } from "../models/types";
import { factoryNodeParams, fillFactoryParams } from "../models/initial-state";
import { getModel, MODEL_IDS } from "../models";
import { insertFxCensus } from "./constraints";
import { FX_CHANNEL_NODE_INDEX, fxEffectTypes, fxParams, fxRawForDesc } from "./control/fx-effect";
import type { InsertFxSlot } from "./control/params";
import { fixedConnection, isPlainRecord, requiredSourceWire, setPlanSampleRate } from "./plan";
import type { Plan } from "./plan";
import { admitLeaf, insertFxWireState, nodeLeafRules } from "./control/translate";
import { hiZOn } from "./input-lock";
import { mixSendLocks, sourcePan, validatePlan } from "./routing";
import type { PlanProblem } from "./routing";

/** One device-wide 1-of insert-FX slot claimed by more than one node. Not a wire,
 *  so it carries the contended slot and its holders instead of two endpoints. */
export interface InsertFxSlotProblem {
  reason: "insertFxSlot";
  slot: InsertFxSlot;
  /** Every node whose selection claims the slot, in model order (two or more). */
  nodes: string[];
}

// Insert-FX slot collisions in a whole plan. The screens cannot author one
// (insertFxMenu locks a slot another node holds), so a plan carrying one came
// from outside — a file, a ?plan= link, a generator. Unlike an illegal wire this
// does not refuse the document: the loader reports it and offers to open it anyway,
// since the plan is otherwise usable and only the unit decides what it runs.
// A device readback deliberately does not run this: the unit is the authority for
// what it is actually running, and refusing there would leave the operator unable
// to read the hardware at all.
export function insertFxSlotProblems(model: DeviceModel, plan: Plan): InsertFxSlotProblem[] {
  return [...insertFxCensus(model, plan)]
    .filter(([, nodes]) => nodes.length > 1)
    .map(([slot, nodes]) => ({ reason: "insertFxSlot" as const, slot, nodes: [...nodes] }));
}

/** A STEREO-linked MONO IN pair whose two members do not agree about their one insert
 *  effect. Carries the pair and which of `INSERT_FX_PAIR_KEYS` disagree. */
export interface InsertFxPairProblem {
  reason: "insertFxPair";
  /** The pair, primary first. */
  nodes: [string, string];
  /** The stored keys whose written state disagrees, selector first. */
  keys: string[];
}

/** Which stored key each half of the wire state came from, so the report names what the
 *  author wrote rather than what the wire calls it. */
const PAIR_STATE_KEYS = { selector: "insertFx", on: "insertFxOn", params: "insertFxParams" } as const;

/**
 * A STEREO-linked pair holds ONE insert effect between its two channels: the unit keeps a
 * single selector, one bypass and one engine for the pair and mirrors a write to either
 * member onto the other. The app's own edit funnels keep the two sides equal
 * (`mirrorLinkedInsertFx`), but a document built elsewhere is under no such discipline, and
 * nothing downstream repairs it — `translate` emits each channel from its own params, so a
 * disagreeing pair sends two different selectors, the unit keeps whichever landed last, and
 * `sendConverging` re-sends both to its round limit and finishes unconverged.
 *
 * So it is a refusal rather than a warning: there is no state of the unit that satisfies the
 * document, and the operator has nothing to decide.
 *
 * What is compared is the state a WRITE would leave, not what the document stores. The two
 * are different questions, and stored values answer the wrong one: an off-menu selector and
 * No Effect reach the unit as one value, `true` and `1` are one bypass, a bypass beside No
 * Effect is never sent, and an engine value under another family's namespace is not sent
 * either. Each of those is a document the unit CAN satisfy, and refusing it would be a load
 * the operator cannot explain. `insertFxWireState` is that projection and lives in the emit
 * path, so it and the write cannot drift apart; the plan is filled first because the write
 * sees a completed document.
 */
export function insertFxPairProblems(model: DeviceModel, plan: Plan): InsertFxPairProblem[] {
  const out: InsertFxPairProblem[] = [];
  const linked = model.channelPairs.filter(([a]) => plan.nodeParams[a]?.stereoLink === true);
  if (linked.length === 0) return out;
  // The fill mutates, so it runs on a copy: this is a question about the document, and
  // answering it must not complete the caller's plan behind their back.
  const filled = structuredClone(plan);
  fillFactoryParams(model.id, filled);
  for (const [a, b] of linked) {
    const sa = insertFxWireState(model, filled, a);
    const sb = insertFxWireState(model, filled, b);
    if (!sa || !sb) continue;
    const keys: string[] = [];
    if (sa.selector !== sb.selector) keys.push(PAIR_STATE_KEYS.selector);
    if (sa.on !== sb.on) keys.push(PAIR_STATE_KEYS.on);
    if (sa.params.join("|") !== sb.params.join("|")) keys.push(PAIR_STATE_KEYS.params);
    if (keys.length > 0) out.push({ reason: "insertFxPair", nodes: [a, b], keys });
  }
  return out;
}

/** One stored parameter outside the range its own control admits. `translate.ts` bounds
 *  every FX slot to the same rawMin/rawMax the slider declares, so a document holding one
 *  means a different thing on screen than on the wire: the panel shows what the plan holds
 *  and the unit receives the bound. The loader normalizes the document to the bound and
 *  says so, which is the only reading under which the two agree.
 *
 *  A plan the app itself authored cannot carry one — the sliders stop at the window and the
 *  write bounds anything else — so this is a document from a file an older build saved, a
 *  hand-edited one, or a `?plan=` payload. Like every check in this file it does NOT run on
 *  a device readback: the unit is the authority for what it is running, and it can hold a
 *  raw this app's range excludes, because its own encoder stops at the window but the wire
 *  does not. A `.urxf` import takes the same exemption for the same reason and by the same
 *  route — it is a FILE, but one the unit wrote, and it reaches the plan through the readback
 *  rather than through this funnel.
 *
 *  SCOPE: the FX channel effect; on every node the model's factory values describe, a leaf or
 *  group whose kind is not the factory value's at that path (`where: "node"`, dropped, so the
 *  fill supplies the factory value) — a number where the factory holds an on/off is converted
 *  instead (`booleanParamProblems`); every node-param leaf the write bounds, bounded by the rule
 *  the write bounds it by (`nodeLeafRules` / `admitLeaf` in translate.ts, `where: "node"`); plus
 *  +48V on a channel carrying HI-Z with HI-Z on, bounded to off (HI-Z kept) — the app never
 *  turns the two on together. A channel's gain is bounded to its own range (`channelGainRange`:
 *  A.Gain -8..+70 dB, -8..+40 under HI-Z, D.Gain -24..+24), and the oscillator level to
 *  -96..0 dB — both encoders clamp only to a wider window, so here the load moves what the
 *  write sends, onto a value the unit's own panel can set. A device read keeps +48V and HI-Z both on where the unit holds
 *  them, so a file this build saved can carry that pair. A repair reaches the oscillator, which
 *  is scene-external: under the Scene-only device scope the write does not carry it, while the
 *  load still moves it and says so. */
export interface ParamRangeProblem {
  reason: "paramRange";
  node: string;
  /** Which container holds it: the node's `fxEffect` value itself, a field of that object
   *  (`type` / `params`), a member of its `params` map, or one of the node's own params
   *  (`node`). A `params` member is bounded by its own descriptor. */
  where: "effect" | "field" | "params" | "node";
  /** The field or catalogue key, as the plan stores it. `fxEffect` for the object itself. For
   *  `node`, the dotted path inside the node's params, an array element by its index
   *  (`eqOneKnob.level`, `eqBands.0.q`). */
  key: string;
  /** What the document carries. NOT always a number: the sanitiser keeps a boolean leaf and a
   *  non-empty object, since node params have toggles and groups, and a document can put
   *  either under a key that holds a number. */
  stored: unknown;
  /** `bound` writes the value the window admits; `drop` removes the key.
   *
   *  A leaf that is not a finite number is DROPPED rather than replaced by a default, because
   *  the default is the one thing about a key that is not shared: the window is the same under
   *  every type a channel offers (the catalogue pins that), but `FX_TYPE_DEFAULTS` gives each
   *  type its own value. Writing one type's default is therefore a guess about which type is
   *  selected — and the emit already substitutes the SELECTED type's default for a key that is
   *  absent, so dropping it lands on the same value now and stays right if the type changes.
   *
   *  A `type` outside the channel's menu is dropped for a different reason: a menu is a set,
   *  so there is no nearest member to bound to, and `resolveFxEffectType` already answers the
   *  channel's own default for it. Same for the two containers — an `fxEffect` or a `params`
   *  that is not an object holds nothing to bound. All four cases emit exactly what the same
   *  document emits with the key absent, so the drop moves no value; what it changes is that
   *  the plan stops carrying something the write path silently ignores, and the load says so. */
  action: "bound" | "drop";
  /** The value the loader writes. Absent for `drop`, which writes nothing. A boolean only for
   *  a HI-Z channel's `phantom`, which is bounded to false. */
  bound?: number | boolean;
}

/** Every FX parameter a plan holds outside its own control's range, in model order, then the
 *  +48V / A.Gain of each HI-Z channel the SCOPE note above names. Reads the FX type
 *  through `resolveFxEffectType` like every other consumer, so the window
 *  asked about is the one the write path will bound against. */
export function paramRangeProblems(plan: Plan): ParamRangeProblem[] {
  const out: ParamRangeProblem[] = [];
  const take = (
    node: string,
    where: "field" | "params",
    key: string,
    stored: number | undefined,
    normalise: (raw: number) => number,
  ): void => {
    // An ABSENT value is not a problem: the emit substitutes the catalogue default and the
    // panel shows that same default, so the two already agree, and reporting it would write
    // a key the document never carried.
    if (stored === undefined) return;
    // Not a NUMBER at all — a boolean or an object, which the document sanitiser keeps — so
    // there is no value to bound. Dropped rather than defaulted, for the reason on `action`.
    if (typeof stored !== "number" || !Number.isFinite(stored)) {
      out.push({ reason: "paramRange", node, where, key, stored, action: "drop" });
      return;
    }
    // The nearest value the control admits, which is the emit's own answer for it. A raw is a
    // broker integer, so a fractional value names no setting the unit has — and it is not
    // dropped, because unlike a boolean it HAS a numeric neighbour: dropping sends the type's
    // own default instead, which for the delay LPF is 8.50 kHz where the document said 118 Hz.
    //
    // The admitted set is the CONTROL's, not a window: a window is what a slider has, while a
    // toggle admits 0 and 1 with no bounds written down at all and a select admits its option
    // values. Normalising against bounds alone left 2 on a two-state control and 15 on a menu
    // that ends at 14. Which value a key belongs to is the same under every type the channel
    // offers, so whichever type named it, this is the answer the emit will reach.
    const bound = normalise(stored);
    if (bound !== stored) out.push({ reason: "paramRange", node, where, key, stored, action: "bound", bound });
  };
  for (const [node, fxIndex] of Object.entries(FX_CHANNEL_NODE_INDEX)) {
    const fx: unknown = plan.nodeParams[node]?.fxEffect;
    if (fx === undefined) continue;
    // The effect OBJECT. The sanitiser keeps a boolean and a non-empty array of objects, and
    // every reader of the plan treats one as no effect at all — that channel's whole address
    // set the write path then never sends, with the document still holding what it holds.
    if (!isPlainRecord(fx)) {
      out.push({ reason: "paramRange", node, where: "effect", key: "fxEffect", stored: fx, action: "drop" });
      continue;
    }
    // The effect TYPE, against the channel's MENU rather than a window.
    if (fx.type !== undefined && !fxEffectTypes(fxIndex).some((o) => o.value === fx.type)) {
      out.push({ reason: "paramRange", node, where: "field", key: "type", stored: fx.type, action: "drop" });
    }
    // The parameter MAP, which the readers below and the write path both skip when it is not
    // an object — the same silent loss as an unreadable effect, one channel's worth of raws.
    if (fx.params !== undefined && !isPlainRecord(fx.params)) {
      out.push({ reason: "paramRange", node, where: "field", key: "params", stored: fx.params, action: "drop" });
      continue;
    }
    const fxParamsMap = fx.params as Record<string, number> | undefined;
    if (!fxParamsMap) continue;
    // EVERY type the CHANNEL offers, not only the one selected. The migration leaves a key
    // the selected type does not own exactly where it is (fx-effect.ts), so a document saved
    // under another type keeps the raw untouched, and selecting that type later brings it
    // back — the load was the one chance to repair it. The catalogue pins that one channel
    // never gives a key two different windows, so whichever of its types names the key, the
    // window found is the window the write path will bound against.
    const seen = new Set<string>();
    for (const type of fxEffectTypes(fxIndex)) {
      for (const d of fxParams(type.value)) {
        if (seen.has(d.key)) continue;
        seen.add(d.key);
        take(node, "params", d.key, fxParamsMap[d.key], (v) => fxRawForDesc(d, v));
      }
    }
  }
  for (const [node, carried] of Object.entries(plan.nodeParams)) {
    // A leaf or group of a shape the factory value at that path does not have. The checks
    // after it read the node as the drop leaves it.
    const factory = factoryNodeParams(plan.modelId, node);
    const drops = factory ? kindMismatches(carried, factory) : [];
    const np = drops.length ? structuredClone(carried) : carried;
    for (const path of drops) {
      const parent = path.slice(0, -1).reduce<unknown>((v, k) => (v as Record<string, unknown>)[k], np) as Record<
        string,
        unknown
      >;
      const key = path[path.length - 1];
      out.push({ reason: "paramRange", node, where: "node", key: path.join("."), stored: parent[key], action: "drop" });
      delete parent[key];
    }
    // A HI-Z channel with HI-Z on: +48V goes off (A.Gain's +40 dB ceiling is in its rule).
    if (hiZOn(plan.modelId, node, np) && np.phantom) {
      out.push({
        reason: "paramRange",
        node,
        where: "node",
        key: "phantom",
        stored: np.phantom,
        action: "bound",
        bound: false,
      });
    }
    // A value outside what the write sends for it: the value the write sends.
    const model = MODEL_IDS.includes(plan.modelId) ? getModel(plan.modelId) : null;
    for (const [path, rule] of model ? nodeLeafRules(model, node, np) : []) {
      const stored = path
        .split(".")
        .reduce<unknown>(
          (v, k) => (isPlainRecord(v) || Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined),
          np,
        );
      if (typeof stored !== "number" || !Number.isFinite(stored)) continue;
      if ("unsent" in rule) {
        out.push({ reason: "paramRange", node, where: "node", key: path, stored, action: "drop" });
        continue;
      }
      const bound = admitLeaf(rule, stored);
      if (bound !== stored)
        out.push({ reason: "paramRange", node, where: "node", key: path, stored, action: "bound", bound });
    }
  }
  return out;
}

/** The node-param keys whose shape the FX walk owns rather than the factory comparison. */
const KIND_WALK_SKIPS: ReadonlySet<string> = new Set(["fxEffect"]);

/**
 * Every path in `carried` holding a value whose kind is not the factory value's there: a
 * value that is not a number where the factory holds a number, a group where it holds an
 * on/off, and anything but a group (or an array) where it holds one. Neither the sanitiser
 * nor the fill catches these — the sanitiser keeps an on/off and a non-empty group under any
 * key, and the fill keeps whatever the document wrote at a scalar — so the write would encode
 * one (an on/off at A.Gain goes out as +1 dB, a group as the encoder's floor) and a reader
 * that formats a number would throw on it. A path the factory does not carry is left alone.
 */
function kindMismatches(carried: unknown, factory: unknown, path: string[] = []): string[][] {
  if (carried === undefined) return [];
  if (typeof factory === "number") return typeof carried === "number" ? [] : [path];
  if (typeof factory === "boolean") return isPlainRecord(carried) || Array.isArray(carried) ? [path] : [];
  if (Array.isArray(factory)) {
    if (!Array.isArray(carried)) return [path];
    return factory.flatMap((f, i) => kindMismatches(carried[i], f, [...path, String(i)]));
  }
  if (isPlainRecord(factory)) {
    if (!isPlainRecord(carried)) return [path];
    return Object.entries(factory).flatMap(([key, f]) =>
      path.length === 0 && KIND_WALK_SKIPS.has(key) ? [] : kindMismatches(carried[key], f, [...path, key]),
    );
  }
  return [];
}

/** Write each reported bound into the plan. Separate from finding them so a caller can
 *  report without repairing, and so a test can assert the two halves apart. */
export function applyParamRange(plan: Plan, problems: ParamRangeProblem[]): void {
  for (const p of problems) {
    const np = plan.nodeParams[p.node]!;
    if (p.where === "node") {
      const keys = p.key.split(".");
      let holder = np as Record<string, unknown> | undefined;
      for (const key of keys.slice(0, -1)) holder = holder?.[key] as Record<string, unknown> | undefined;
      if (!holder) continue;
      const last = keys[keys.length - 1];
      if (p.action === "drop") delete holder[last];
      else holder[last] = p.bound;
      continue;
    }
    if (p.where === "effect") {
      delete np.fxEffect;
      continue;
    }
    const fx = np.fxEffect!;
    if (p.where === "field") {
      // Every field problem reported today is a drop — the effect TYPE is checked against the
      // channel's menu and the parameter map against its own shape, and neither carries a
      // window — but the bound is applied rather than assumed away, so a field that gains one
      // is repaired instead of being silently removed.
      const rec = fx as unknown as Record<string, unknown>;
      if (p.action === "drop") delete rec[p.key];
      else rec[p.key] = p.bound;
    } else if (p.action === "drop") {
      delete fx.params![p.key];
    } else {
      fx.params![p.key] = p.bound as number;
    }
  }
}

/** A receiver the unit never leaves without a source (`DeviceModel.requiredSources`) that the
 *  document gives no wire. Carries the wire the loader adds: the model's own default source for
 *  that receiver, which is the unit's factory selection.
 *
 *  Completed rather than refused: the unit's list for these offers no "none", so a document
 *  without the wire describes a state the unit cannot be put in from its own panel, and the one
 *  value to give it is the one a new plan starts from. Reported, because the load then writes a
 *  selection the document did not name. Any wire into the receiver counts, whatever kind it is
 *  stored under — the install restates the kind from the rule table — and a wire the sanitiser
 *  dropped does not. Like every check in this file it does NOT run on a device readback: Fetch
 *  and Live start give a unit read on NONE there the same source themselves
 *  (`ReadbackResult.unsourced`). */
export interface RequiredSourceProblem {
  reason: "requiredSource";
  /** The source the loader wires in. */
  from: string;
  /** The receiver's input ref. */
  to: string;
}

/** Every required receiver the plan gives no wire, in the model's order. */
export function requiredSourceProblems(model: DeviceModel, plan: Plan): RequiredSourceProblem[] {
  return Object.entries(model.requiredSources)
    .filter(([to]) => !plan.connections.some((c) => c.to === to))
    .map(([to, from]) => ({ reason: "requiredSource" as const, from, to }));
}

/** Add each reported wire to the plan. Separate from finding them for the reason
 *  `applyParamRange` is. */
export function applyRequiredSources(model: DeviceModel, plan: Plan, problems: RequiredSourceProblem[]): void {
  for (const p of problems) plan.connections.push(requiredSourceWire(model, p.to));
}

/** A send into a MIX bus whose Pan Link is on, carrying a pan other than its source's own pan /
 *  balance. While Pan Link is on the unit holds every send pan into that MIX there, and the write
 *  sends none of them, so the pan a document carries is one the unit never takes — while the
 *  CONSOLE's read-only SEND PAN knob, the MIDI feedback and the next save all read it. The loader
 *  sets it to the source's value, the one `sendPansToSources` sets when the link turns on, and
 *  says so.
 *
 *  Counted the way every reader counts it: an absent pan — on the send, on the source's main path
 *  into STEREO, or a send or main path the document omits — is 0. A send the document omits is
 *  one the load adds (`ensureFixedConnections`), so it is reported and added here with the pan.
 *  Each member of a STEREO-linked pair takes the pan on its own main path: its own position in
 *  PAN mode, the pair's one balance in BAL.
 *  Like every check in this file it does NOT run on a device readback or the `.urxf` import:
 *  there the unit's own values arrive. */
export interface LinkedSendPanProblem {
  reason: "linkedSendPan";
  /** The send's source, as its out ref. */
  from: string;
  /** The linked MIX's input ref. */
  to: string;
  /** The pan the document carries on the send; absent where it names none, or no send at all. */
  stored?: number;
  /** The source's own pan / balance, which the loader writes. */
  pan: number;
}

/** Every send into a linked MIX whose pan is not its source's, in rule order. */
export function linkedSendPanProblems(model: DeviceModel, plan: Plan): LinkedSendPanProblem[] {
  const out: LinkedSendPanProblem[] = [];
  for (const rule of model.rules) {
    if (!rule.fixed || rule.kind !== "send" || !mixSendLocks(plan, parseRef(rule.to).nodeId).panLinked) continue;
    const stored = plan.connections.find((c) => c.from === rule.from && c.to === rule.to)?.params?.pan;
    const pan = sourcePan(plan, parseRef(rule.from).nodeId);
    if ((stored ?? 0) === pan) continue;
    out.push({
      reason: "linkedSendPan",
      from: rule.from,
      to: rule.to,
      ...(stored === undefined ? {} : { stored }),
      pan,
    });
  }
  return out;
}

/** Set each reported send's pan, adding the send where the document omits it. Separate from
 *  finding them for the reason `applyParamRange` is. */
export function applyLinkedSendPans(model: DeviceModel, plan: Plan, problems: LinkedSendPanProblem[]): void {
  for (const p of problems) {
    let send = plan.connections.find((c) => c.from === p.from && c.to === p.to);
    if (!send) {
      send = fixedConnection(
        model,
        model.rules.find((r) => r.from === p.from && r.to === p.to)!,
      );
      plan.connections.push(send);
    }
    send.params = { ...send.params, pan: p.pan };
  }
}

/** An on/off leaf written as a number. The document sanitiser keeps any finite number, and the
 *  write sends one where an on/off belongs as on unless it is 0. The loader converts it to that
 *  on/off, so every reader of the plan holds a boolean there and reads what the write sends,
 *  and says so.
 *
 *  Which leaves are on/off is read off the model's factory values rather than listed here: a
 *  leaf the factory holds as a boolean is one, at the same path on the same node, an array
 *  element matched by its index. A leaf the factory does not carry is left alone. Like every
 *  check in this file it does NOT run on a device readback or the `.urxf` import, which write
 *  booleans. */
export interface BooleanParamProblem {
  reason: "booleanParam";
  node: string;
  /** The leaf inside the node's params, dotted, an array element by its index (`eqBands.0.on`). */
  path: string;
  /** The number the document carries. */
  stored: number;
  /** What the loader writes: off for 0, on for any other number. */
  value: boolean;
}

/** Every on/off leaf the plan holds as a number, node by node in the plan's order. */
export function booleanParamProblems(model: DeviceModel, plan: Plan): BooleanParamProblem[] {
  const out: BooleanParamProblem[] = [];
  for (const [node, params] of Object.entries(plan.nodeParams)) {
    const walk = (carried: unknown, factory: unknown, path: string[]): void => {
      if (typeof factory === "boolean") {
        if (typeof carried === "number")
          out.push({ reason: "booleanParam", node, path: path.join("."), stored: carried, value: carried !== 0 });
      } else if (Array.isArray(factory) && Array.isArray(carried)) {
        factory.forEach((f, i) => walk(carried[i], f, [...path, String(i)]));
      } else if (isPlainRecord(factory) && isPlainRecord(carried)) {
        for (const [key, f] of Object.entries(factory)) walk(carried[key], f, [...path, key]);
      }
    };
    walk(params, factoryNodeParams(model.id, node), []);
  }
  return out;
}

/** Write each reported leaf's on/off. Separate from finding them for the reason
 *  `applyParamRange` is. */
export function applyBooleanParams(plan: Plan, problems: BooleanParamProblem[]): void {
  for (const p of problems) {
    const keys = p.path.split(".");
    let holder = plan.nodeParams[p.node] as Record<string, unknown>;
    for (const key of keys.slice(0, -1)) holder = holder[key] as Record<string, unknown>;
    holder[keys[keys.length - 1]] = p.value;
  }
}

/** Everything a plan load reports: an illegal wire (refused), a slot claimed twice (the
 *  operator decides), a value outside its range (normalized, then reported), a receiver
 *  given no source (completed, then reported), a linked send pan off its source's value
 *  (set to it, then reported), or an on/off written as a number (converted, then reported). */
export type LoadProblem =
  | PlanProblem
  | InsertFxSlotProblem
  | InsertFxPairProblem
  | ParamRangeProblem
  | RequiredSourceProblem
  | LinkedSendPanProblem
  | BooleanParamProblem;

// Every violation the plan loader reports on a file / ?plan= link / drop, in one
// list so a load path cannot pick up half of them. The caller splits them by
// reason — a wire violation refuses the document, a slot collision only warns.
// Both halves check a plan built elsewhere; neither runs on a device readback.
// The on/off conversions come first and the other checks read the document as they leave
// it, which is the order the loader applies them in: `panLink: 1` is a linked MIX to the
// send-pan check, and `stereoLink: 1` a linked pair to the insert-FX pair check.
export function planProblems(model: DeviceModel, plan: Plan): LoadProblem[] {
  const booleans = booleanParamProblems(model, plan);
  const read = booleans.length > 0 ? structuredClone(plan) : plan;
  applyBooleanParams(read, booleans);
  return [
    ...booleans,
    ...validatePlan(model, read),
    ...insertFxPairProblems(model, read),
    ...insertFxSlotProblems(model, read),
    ...paramRangeProblems(read),
    ...requiredSourceProblems(model, read),
    ...linkedSendPanProblems(model, read),
  ];
}

/** Which side of that split a problem falls on: true refuses the document, false warns
 *  and offers to open it anyway. One seat, because the rule was written out three times
 *  — the loader, the report's caller and a test — and moving a reason between the sides
 *  in one of them would leave the others agreeing with the old split. */
export function isRefusal(problem: LoadProblem): boolean {
  return (
    problem.reason !== "insertFxSlot" &&
    problem.reason !== "paramRange" &&
    problem.reason !== "requiredSource" &&
    problem.reason !== "linkedSendPan" &&
    problem.reason !== "booleanParam"
  );
}

/** Whether a problem stops the load until the operator answers. A refusal does not — there
 *  is nothing to answer — and neither a normalized range, a completed source, a linked send
 *  pan set to its source's value nor a converted on/off does: each is
 *  repaired before the document opens and reported on the status line, which is where
 *  architecture.md puts a partial success. Only the slot collision leaves a document the app
 *  can open and the unit cannot run, which is a decision and nobody else's. */
export function needsDecision(problem: LoadProblem): boolean {
  return problem.reason === "insertFxSlot";
}

/** What a load repaired, by kind. The status line says each kind in its own sentence. */
export interface LoadRepairs {
  booleans: BooleanParamProblem[];
  ranged: ParamRangeProblem[];
  supplied: RequiredSourceProblem[];
  linkedPans: LinkedSendPanProblem[];
}

/** Apply every repair `planProblems` reported, in the order `planProblems` reads them: an on/off
 *  written as a number is converted first, then a value outside what the app can write is
 *  bounded or dropped, a receiver the unit never leaves without a source gets the one a new plan
 *  carries, and a send into a MIX whose Pan Link is on takes its source's own pan / balance.
 *  Refusals and decisions are the caller's; the reasons they carry are not repaired here. */
export function applyLoadRepairs(model: DeviceModel, plan: Plan, problems: LoadProblem[]): LoadRepairs {
  const booleans = problems.filter((p) => p.reason === "booleanParam");
  applyBooleanParams(plan, booleans);
  const ranged = problems.filter((p) => p.reason === "paramRange");
  applyParamRange(plan, ranged);
  const supplied = problems.filter((p) => p.reason === "requiredSource");
  applyRequiredSources(model, plan, supplied);
  const linkedPans = problems.filter((p) => p.reason === "linkedSendPan");
  applyLinkedSendPans(model, plan, linkedPans);
  return { booleans, ranged, supplied, linkedPans };
}

/** A document as the loader opens it: repaired (`applyLoadRepairs`), then completed from the
 *  model's factory values — a value a repair dropped is completed like any other absent one —
 *  then put back through the rate rule, which a Track Count the fill completes can exceed. */
export function prepareLoadedPlan(model: DeviceModel, plan: Plan, problems: LoadProblem[]): LoadRepairs {
  const repairs = applyLoadRepairs(model, plan, problems);
  fillFactoryParams(model.id, plan);
  setPlanSampleRate(plan, plan.sampleRate);
  return repairs;
}
