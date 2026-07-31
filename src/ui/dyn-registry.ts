// The dynamics processors the screen can open. One place that knows which exist,
// so adding DUCKER is a descriptor plus a line here rather than an edit to every
// hook signature and a ternary in main.ts.
import { GATE_DYN } from "./dyn-gate";
import { COMP_DYN } from "./dyn-comp";
import type { DynProcessor } from "./dyn-screen";

export const DYN_PROCESSORS = {
  gate: GATE_DYN,
  comp: COMP_DYN,
} satisfies Record<string, DynProcessor>;

/** Which processor a screen is opened for. */
export type DynKind = keyof typeof DYN_PROCESSORS;
