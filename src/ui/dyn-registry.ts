// The processors the channel tuning screen can open. One place that knows which
// exist, so adding DUCKER is a descriptor plus a line here rather than an edit to
// every hook signature and a ternary in main.ts.
import { GATE_DYN } from "./dyn-gate";
import { COMP_DYN } from "./dyn-comp";
import { EQ_DYN } from "./dyn-eq";
import { DUCKER_DYN } from "./dyn-ducker";
import { SSMCS_COMP_DYN, SSMCS_DYN, SSMCS_EQ_DYN } from "./dyn-ssmcs";
import { INSFX_DYN } from "./insert-fx-screen";
import { FX_DYN } from "./fx-effect-screen";
import type { DynProcessor } from "./dyn-screen";
import type { Messages } from "../i18n/en";

export const DYN_PROCESSORS = {
  gate: GATE_DYN,
  comp: COMP_DYN,
  eq: EQ_DYN,
  ducker: DUCKER_DYN,
  // Three faces of one bank rather than three processors: they open from three places
  // and move between each other from the title row. A launcher names the face it opens
  // on, and the choice is not carried to the next open.
  ssmcs: SSMCS_DYN,
  ssmcsComp: SSMCS_COMP_DYN,
  ssmcsEq: SSMCS_EQ_DYN,
  // One entry for four effect families rather than one per family: what a node holds is a
  // plan value the operator changes elsewhere, so the descriptor resolves it per call and
  // a follow re-binds the same modal instead of swapping screens.
  insfx: INSFX_DYN,
  // One entry for the three FX parameter families, for the reason above it: an FX channel's
  // EFFECT TYPE is a plan value changed elsewhere, so the descriptor resolves the family per
  // call and a type change re-binds the same modal.
  fx: FX_DYN,
} satisfies Record<string, DynProcessor>;

/** Which processor a screen is opened for. */
export type DynKind = keyof typeof DYN_PROCESSORS;

/** What a launcher for one kind is called — its button's text and a chip's aria-label.
 *  The morphing strip's COMP and EQ faces reuse the shipped screens' labels: they open
 *  from the same inspector section, and a channel never carries both banks at once, so
 *  "Comp screen" names exactly one thing on it. Those two are the inspector's launchers
 *  alone — the CONSOLE strip carries one opener for the whole bank, beside the SSMCS
 *  chip, and its other faces are reached from the segment inside the screen. */
export function dynOpenLabel(kind: DynKind, m: Messages): string {
  switch (kind) {
    case "ssmcsComp":
      return m.dynTuning.comp.open;
    case "ssmcsEq":
      return m.dynTuning.eq.open;
    default:
      return m.dynTuning[kind].open;
  }
}
