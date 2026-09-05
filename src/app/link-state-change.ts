// Whether a device read changed which channel pairs are STEREO-linked.
//
// Lifted out of main.ts because the answer decides a REPAINT and the two are easy to
// confuse: the follow reflect has a fine-grained branch that repaints the nodes a read
// named, and the heart tie a linked pair is drawn with belongs to the pair rather than to
// either node — only a full render builds it. So a read that turns a link on or off needs
// the full branch even when nothing moved, and "nothing moved" is exactly what an already
// adjacent pair reports.

import type { PlanPatch } from "../core/plan-history";

/** The node-parameter key the tie is drawn from. Held on the pair's primary. */
const LINK_KEY = "stereoLink";

/** True when `patch` carries a `stereoLink` change for any node. */
export function changesLinkState(patch: PlanPatch): boolean {
  return patch.some(
    (e) => e.field === "nodeParams" && (Object.hasOwn(e.before, LINK_KEY) || Object.hasOwn(e.after, LINK_KEY)),
  );
}
