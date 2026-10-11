// The unit's LCD selection (param 762) as it concerns a stereo channel's displayed side. The
// value packs `(block << 8) | index`; block 1 is the stereo channels, and its index runs along
// the individual-channel axis, so a stereo channel at position p takes 2p for its L side and
// 2p + 1 for its R side. Every other block names no side and decodes to nothing.

import type { DeviceModel } from "../../models/types";
import type { JackSide } from "../plan";
import { SETTLE_TIMEOUT_MS } from "./settle";
import { stereoIndexMap } from "./translate";

const STEREO_BLOCK = 1;

/** The 762 value that selects `channelId` on the unit with `side` shown, or null for a node
 *  that is not one of the model's stereo channels. */
export function encodeStereoSide(model: DeviceModel, channelId: string, side: JackSide): number | null {
  const position = stereoIndexMap(model).get(channelId);
  if (position === undefined) return null;
  return (STEREO_BLOCK << 8) | (2 * position + (side === "R" ? 1 : 0));
}

/** The stereo channel and side a 762 value selects, or null for any other block and for a
 *  position the model has no stereo channel at. */
export function decodeLcdSelection(model: DeviceModel, raw: number): { channel: string; side: JackSide } | null {
  if (raw >> 8 !== STEREO_BLOCK) return null;
  const index = raw & 0xff;
  for (const [channel, position] of stereoIndexMap(model)) {
    if (position === index >> 1) return { channel, side: index & 1 ? "R" : "L" };
  }
  return null;
}

/**
 * The 762 values this app has written and the unit has not yet announced, oldest first. A
 * notify carrying one of them is the unit answering that write rather than a selection made
 * on the panel. An entry is kept for SETTLE_TIMEOUT_MS; the unit can leave a write
 * unannounced, so an entry nothing takes expires.
 *
 * `take` consumes the NEWEST entry carrying the value and every entry older than it, so a
 * stale earlier write cannot later swallow a genuine panel selection of the same value. The
 * clock is `Date.now()`, which vitest fakes by default, so the retention is testable.
 */
export class LcdEchoes {
  private q: Array<{ raw: number; at: number }> = [];

  note(raw: number): void {
    const now = Date.now();
    this.expire(now);
    this.q.push({ raw, at: now });
  }

  take(raw: number): boolean {
    this.expire(Date.now());
    let i = this.q.length - 1;
    while (i >= 0 && this.q[i].raw !== raw) i--;
    if (i >= 0) this.q.splice(0, i + 1);
    return i >= 0;
  }

  clear(): void {
    this.q = [];
  }

  private expire(now: number): void {
    let i = 0;
    while (i < this.q.length && this.q[i].at < now - SETTLE_TIMEOUT_MS) i++;
    if (i) this.q.splice(0, i);
  }
}
