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
import { grAddr, tapFor } from "../core/meters";
import type { GrKind } from "../core/meters";
import type { NodeParams } from "../core/plan";
import type { DynBinding, DynCtx } from "./dyn-screen";

export function bindChannelStrip(
  ctx: DynCtx,
  o: {
    /** The processor's fields for this channel, or null where it has none (COMP in
     *  SSMCS mode) — which is also how the screen learns to refuse to open. */
    fields: (dyn: ChannelDynamics) => DynField[] | null;
    grKind: GrKind;
    inTapKey: string;
    outTapKey: string;
    /** GR lane full scale, when the reduction's own domain is far shallower than the
     *  level ruler. */
    grFullDb?: number;
  },
): DynBinding | null {
  const np = ctx.plan.nodeParams[ctx.nodeId];
  const dyn = channelDynamics(ctx.model, ctx.nodeId, np?.compEqType ?? COMP_EQ_COMP_FIRST);
  const fields = dyn && o.fields(dyn);
  if (!fields) return null;
  const text = ctx.m.dynTuning[o.grKind];
  return {
    fields,
    lanes: [
      {
        key: "in",
        label: text.tapIn,
        kind: "level",
        tap: tapFor(ctx.nodeId, o.inTapKey, ctx.model.id) ?? null,
        // The threshold rides the input meter: its dB and the meter's dBFS are the
        // same coordinate, which is what earns the rack its one gesture.
        cap: "threshold",
      },
      { key: "gr", label: text.tapGr, kind: "gr", gr: grAddr(o.grKind, ctx.nodeId, ctx.model.id), fullDb: o.grFullDb },
      { key: "out", label: text.tapOut, kind: "level", tap: tapFor(ctx.nodeId, o.outTapKey, ctx.model.id) ?? null },
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

/** The two-item display bar GATE and COMP share: the lane rack or the transfer plot. Both
 *  set `persistSel`, because which one you read a processor in is a lasting preference. */
export function displayBar(ctx: DynCtx): { label: string; items: readonly { label: string; id: string }[] } {
  return {
    label: ctx.m.dynTuning.display,
    items: [
      { label: ctx.m.dynTuning.modeLadder, id: "dyn-mode-ladder" },
      { label: ctx.m.dynTuning.modeCurve, id: "dyn-mode-curve" },
    ],
  };
}

/** LADDER is index 0, CURVE index 1. */
export const LADDER_SEL = 0;
export const CURVE_SEL = 1;

/** The legacy shape of the persisted selection: this bar's choice was stored by name before
 *  a bar could select something other than a display mode, and a session that had chosen
 *  CURVE must not silently land back on LADDER. Lives here because the names and the index
 *  order are this bar's, not the host's. */
export function migrateSel(v: unknown): number | undefined {
  if (typeof v === "number") return v;
  if (v === "curve") return CURVE_SEL;
  if (v === "ladder") return LADDER_SEL;
  return undefined;
}
