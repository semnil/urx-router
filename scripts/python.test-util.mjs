// The CPython the script pins run, found by asking each name a machine may carry one under.
//
// `python3` alone is not that question on Windows: there it can be the Microsoft Store's
// app-execution alias, resolving to an older interpreter than the one `python` names on the
// same machine, and a pin that needs a recent grammar then fails on the interpreter it
// happened to reach rather than on the code. So every name is asked for its version and the
// newest answer wins; a name that does not run is not an answer.
import { spawnSync } from "node:child_process";

const NAMES = ["python3", "python"];

/** `{ exe, version: [major, minor] }` for the newest CPython on the PATH, or null where none runs. */
export function newestPython() {
  let best = null;
  for (const exe of NAMES) {
    const r = spawnSync(exe, ["-c", "import sys; print('%d.%d' % sys.version_info[:2])"], { encoding: "utf8" });
    const m = r.status === 0 && /^(\d+)\.(\d+)/.exec(r.stdout ?? "");
    if (!m) continue;
    const version = [Number(m[1]), Number(m[2])];
    if (!best || version[0] > best.version[0] || (version[0] === best.version[0] && version[1] > best.version[1]))
      best = { exe, version };
  }
  return best;
}

/** Whether `found` is at least `major.minor`. */
export const atLeast = (found, major, minor) =>
  !!found && (found.version[0] > major || (found.version[0] === major && found.version[1] >= minor));
