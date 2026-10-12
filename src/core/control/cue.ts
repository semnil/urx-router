// The unit's [CUE] flags, which the app holds outside the plan: the unit clears them at
// power-off and keeps them in no scene and no settings file, so a cue is state of the live
// session rather than of a routing plan. Nothing here is saved or undoable.
//
// Six strip kinds carry one, in two groups. The INPUT group is the mono channels, the stereo
// channels and the FX channels; the OUTPUT group is STEREO, the MIX buses and STREAMING.
// Cues within one group add up. A cue in the other group clears every cue of the group in use,
// and the output cues an input cue clears come back once the last input cue is turned off. The
// unit does not announce the flags it clears or puts back on a write over the link, and a panel
// press announces only some of them — so those rules are applied here, to every change from
// either side, rather than waited for. A STEREO-linked mono pair shares one flag: a cue on
// either member is a cue on both.

import type { DeviceModel } from "../../models/types";
import { vdGet, vdSet } from "../platform";
import { cueAddrOf, cueAddrs, type CueAddr, type CueGroup } from "./translate";
import { LcdEchoes } from "./lcd-selection";

/** Which strips are cued, kept by the unit's rules. `version` moves on every change, so a read
 *  that started before one can tell it no longer describes the state it would replace. */
export class CueSet {
  private cued = new Set<string>();
  // The output cues an input cue cleared, which the unit puts back once the last input cue is
  // turned off. Null when the unit holds none.
  private displaced: Set<string> | null = null;
  private ver = 0;

  constructor(private readonly model: DeviceModel) {}

  get version(): number {
    return this.ver;
  }

  has(node: string): boolean {
    return this.cued.has(node);
  }

  get size(): number {
    return this.cued.size;
  }

  /** The cued strips in board order. */
  nodes(): string[] {
    return cueAddrs(this.model)
      .filter((a) => this.cued.has(a.node))
      .map((a) => a.node);
  }

  /** The group the cued strips belong to, or null when nothing is cued. */
  group(): CueGroup | null {
    for (const a of cueAddrs(this.model)) if (this.cued.has(a.node)) return a.group;
    return null;
  }

  /**
   * One flag turned on or off, as the unit applies it. A cue in the other group clears every
   * cue of the group in use; the output cues an input cue clears come back, all of them, when
   * the last input cue is turned off, and a new output cue in the meantime forgets them. Input
   * cues never come back. `partner` — the other member of a STEREO-linked mono pair — follows
   * the flag it shares. True when the set changed.
   */
  apply(node: string, on: boolean, partner?: string): boolean {
    const addr = cueAddrOf(this.model, node);
    if (!addr) return false;
    const before = this.key();
    const members = partner ? [node, partner] : [node];
    if (on) {
      if (addr.group === "input") {
        const outputs = this.inGroup("output");
        if (outputs.length) this.displaced = new Set(outputs);
      } else this.displaced = null;
      for (const a of cueAddrs(this.model)) if (a.group !== addr.group) this.cued.delete(a.node);
      for (const m of members) this.cued.add(m);
    } else {
      for (const m of members) this.cued.delete(m);
      // An output cue turned off is not one the unit puts back: its panel's CLEAR CUE turns
      // every cue off, the outputs it holds included, and announces those in either order.
      if (addr.group === "output") this.displaced?.delete(node);
      if (addr.group === "input" && this.displaced?.size && !this.inGroup("input").length) {
        for (const n of this.displaced) this.cued.add(n);
        this.displaced = null;
      }
    }
    return this.changed(before);
  }

  /**
   * The whole set, as a read of the unit found it. True when the set changed. The read cannot
   * see which output cues the unit holds to put back, so they are kept while the read still
   * finds input cues and no output cue, and forgotten otherwise.
   */
  replace(nodes: Iterable<string>): boolean {
    const before = this.key();
    const known = new Set(cueAddrs(this.model).map((a) => a.node));
    this.cued = new Set([...nodes].filter((n) => known.has(n)));
    if (this.inGroup("output").length || !this.inGroup("input").length) this.displaced = null;
    return this.changed(before);
  }

  /** Forget every cue, and the output cues held to put back: the session that knew them ended. */
  clear(): boolean {
    this.displaced = null;
    return this.replace([]);
  }

  private inGroup(group: CueGroup): string[] {
    return cueAddrs(this.model)
      .filter((a) => a.group === group && this.cued.has(a.node))
      .map((a) => a.node);
  }

  private key(): string {
    return this.nodes().join(",");
  }

  private changed(before: string): boolean {
    if (this.key() === before) return false;
    this.ver++;
    return true;
  }
}

/**
 * The flag values this app has written and the unit has not yet announced, per address. A
 * notify carrying one of them is the unit answering that write rather than a press on its
 * panel. Each address keeps the retention and the newest-match rule `LcdEchoes` keeps for the
 * LCD selection.
 */
export class CueEchoes {
  private byAddr = new Map<string, LcdEchoes>();

  note(param: number, y: number, value: number): void {
    const key = `${param}:${y}`;
    let q = this.byAddr.get(key);
    if (!q) this.byAddr.set(key, (q = new LcdEchoes()));
    q.note(value);
  }

  take(param: number, y: number, value: number): boolean {
    return this.byAddr.get(`${param}:${y}`)?.take(value) ?? false;
  }

  clear(): void {
    this.byAddr.clear();
  }
}

/** Read every cue flag of the model from the unit. The caller must have connected first.
 *  Rejects when a read fails, so a partial answer is never taken for the unit's state. */
export async function readCues(
  model: DeviceModel,
  get: (paramId: number, x: number, y: number) => Promise<number> = vdGet,
): Promise<string[]> {
  const out: string[] = [];
  for (const a of cueAddrs(model)) if ((await get(a.param, 0, a.y)) !== 0) out.push(a.node);
  return out;
}

/** Write one strip's flag. The caller must have connected first. */
export function writeCueFlag(addr: CueAddr, on: boolean): Promise<void> {
  return vdSet(addr.param, 0, addr.y, on ? 1 : 0);
}
