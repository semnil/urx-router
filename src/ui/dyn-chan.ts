// The binding both channel-strip dynamics processors resolve. GATE and COMP exist only
// on a MONO IN channel, and only in the COMP->EQ bank (SSMCS replaces the compressor
// with the morphing strip), with a level tap either side and a gain-reduction meter of
// their own — so the pair states that rule once here rather than twice.
//
// The EQ resolves a different rule entirely (four node kinds, stereo taps, no reduction
// meter), which is why this is a helper the descriptors call and not something the
// screen host does for them.

import { channelDynamics } from "../core/control/translate";
import type { ChannelDynamics, DynField } from "../core/control/translate";
import { COMP_EQ_COMP_FIRST } from "../core/control/params";
import { el, settingsRow, settingsSelect } from "./dom";
import type { SettingsRowOptions } from "./dom";
import { grAddr, tapFor } from "../core/meters";
import type { GrKind } from "../core/meters";
import type { NodeParams } from "../core/plan";
import type { DynBinding, DynCtx, DynLane } from "./dyn-screen";

export function bindChannelStrip(
  ctx: DynCtx,
  o: {
    /** The processor's fields for this channel, or null where it has none (COMP in
     *  SSMCS mode) — which is also how the screen learns to refuse to open. */
    fields: (dyn: ChannelDynamics) => DynField[] | null;
    grKind: GrKind;
    inTapKey: string;
    outTapKey: string;
    /** The value key the input lane carries a fader cap for, or null where the
     *  processor has none. Stated rather than defaulted: a cap is only possible where
     *  the processor exposes a value in the meter's own dBFS, and the SSMCS strip does
     *  not — its knee is driven by an internal value the unit never shows. Answering
     *  that with a missing option would read as an oversight in the caller that omits
     *  it, which is the one thing a lane rack's only gesture must not be. */
    cap: string | null;
    /**
     * dB to take off the merged bar so it cannot run into the level it
     * shares a column with — which makes that bar an INDICATION of the reduction rather
     * than the reduction. `DynLane.grOffsetDb` carries what it is, and why it is a number
     * rather than a second pair of taps.
     *
     * ONE RULE across the screens: a reduction drawn in a column of its own is the
     * reduction, absolute, and agrees with its readout; a reduction merged into a level
     * column is relative, offset by whatever gain the processor adds, because two bars
     * growing from opposite ends of one ruler are both unreadable where they overlap. So
     * this is passed wherever there is a gain to subtract — the SSMCS strip's makeup, the
     * shipped compressor's — and omitted where there is none, which is the gate.
     */
    grNetDb?: number;
    /**
     * A lane between the input and the reduction, for a processor whose detector listens
     * to something other than the signal on the input lane.
     *
     * It stands there rather than at the end because that is where it belongs in the
     * causal order — the level arrives, the detector hears its own version of it, the
     * reduction follows, the level leaves — and NOT because it is a stage the audio
     * passes through. On the SSMCS strip it is not: measured on a URX44V, sweeping the
     * side-chain filter over 36 dB moved `109` against `108` by the full amount while
     * `111` against `108` held at 5.0 dB with the compressor off its knee throughout.
     */
    keyLane?: DynLane;
    /** Extra lanes after the three, for a face that meters further down the strip. */
    extraLanes?: DynLane[];
    /**
     * Caption the pair with the TAP names rather than with Input / Output.
     *
     * Position captions work because a screen is one processor, so "the input" is
     * unambiguous. The SSMCS bank is not: it is several effects behind one title, and its
     * faces meter overlapping points of one strip — PRE EQ is the compressor's output on one
     * face and the EQ's input on another, and on the side-chain face it is neither, since
     * that face's own output is the detector feed and is not metered at all. Naming the tap
     * says which point it is, and the face's own bar already says which processor is being
     * read.
     */
    tapCaptions?: true;
  },
): DynBinding | null {
  const np = ctx.plan.nodeParams[ctx.nodeId];
  const dyn = channelDynamics(ctx.model, ctx.nodeId, np?.compEqType ?? COMP_EQ_COMP_FIRST);
  const fields = dyn && o.fields(dyn);
  if (!fields) return null;
  const text = ctx.m.dynTuning[o.grKind];
  const inLane: DynLane = {
    key: "in",
    label: text.tapIn,
    ...(o.tapCaptions ? {} : { caption: ctx.m.dynTuning.laneIn }),
    kind: "level",
    tap: tapFor(ctx.nodeId, o.inTapKey, ctx.model.id) ?? null,
    // The threshold rides the input meter: its dB and the meter's dBFS are the
    // same coordinate, which is what earns the rack its one gesture.
    ...(o.cap ? { cap: o.cap } : {}),
  };
  const outLane: DynLane = {
    key: "out",
    label: text.tapOut,
    ...(o.tapCaptions ? {} : { caption: ctx.m.dynTuning.laneOut }),
    kind: "level",
    tap: tapFor(ctx.nodeId, o.outTapKey, ctx.model.id) ?? null,
  };
  const grLane = (extra: Partial<DynLane>): DynLane => ({
    key: "gr",
    label: text.tapGr,
    kind: "gr",
    gr: grAddr(o.grKind, ctx.nodeId, ctx.model.id),
    ...extra,
  });
  const key = o.keyLane ? [o.keyLane] : [];
  return {
    fields,
    // The reduction hangs on the OUTPUT column rather than standing between the two — it
    // reads better against the level it was taken off, which is what the DUCKER screen has
    // always done, and one arrangement across every screen beats one per screen.
    // `sameSlot` merges into the column built BEFORE it, so the order is in / out / gr.
    lanes: [
      inLane,
      ...key,
      outLane,
      grLane({ sameSlot: true, ...(o.grNetDb ? { grOffsetDb: o.grNetDb } : {}) }),
      ...(o.extraLanes ?? []),
    ],
  };
}

/** GATE and COMP both keep their values in one `nodeParams` sub-object named after the
 *  processor, so reading and patching is the same shape for both. The patch is cast
 *  back to `NodeParams`: the keys are the field table's own, and every value has been
 *  through a bounded control, with `translate.ts` clamping again before the wire. */
export function subObjectIo(key: "gate" | "comp"): {
  read: (ctx: DynCtx) => Record<string, unknown>;
  patch: (ctx: DynCtx, patch: Record<string, number | boolean>) => NodeParams;
} {
  const cur = (ctx: DynCtx): Record<string, unknown> =>
    (ctx.plan.nodeParams[ctx.nodeId]?.[key] ?? {}) as Record<string, unknown>;
  return {
    read: cur,
    patch: (ctx, patch) => ({ [key]: { ...cur(ctx), ...patch } }) as NodeParams,
  };
}

/** A row whose control is a dropdown over the catalog's `{ value, label }` options — the
 *  shape every enum in `params.ts` takes, spelled once instead of per row. */
export function enumRow(
  label: string,
  options: readonly { value: number; label: string }[],
  current: number,
  apply: (v: number) => void,
  opts?: SettingsRowOptions,
): HTMLElement {
  return settingsRow(
    label,
    settingsSelect(
      options.map((o) => o.value),
      current,
      (v) => options.find((o) => o.value === v)?.label ?? String(v),
      apply,
    ),
    opts,
  );
}

/** The one element that ends a row of a knob grid: it spans every column, so what follows
 *  it starts a row of its own. Empty and hidden — it separates two groups and names
 *  neither, and a caption here would be a heading inside a panel that has one already. */
export function rowBreak(): HTMLElement {
  const b = el("span", "gt-break");
  b.setAttribute("aria-hidden", "true");
  return b;
}
