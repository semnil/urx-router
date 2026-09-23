// Which of a write's changes the operator never chose, lifted out of the entry so it is
// drivable without booting the app.
//
// The plan is dense: `fillFactoryParams` gives every key the unit has a value, so a document
// that named four of them still writes the whole model. That is what makes a write predictable
// — every key it sends is a key the operator can see in the Inspector — and it is also what
// puts values on the wire that nobody chose. `Plan.paramSource` records where each key came
// from, and this reports the ones that would MOVE the unit without the operator having asked.
//
// `load` and `manual` are the two the operator chose: the document named the value, or an edit
// funnel wrote it. Everything else is not — `default` is the factory fill, `device` is a value
// read off the unit, and a key NOBODY recorded is one no funnel claims. The classification is
// total and falls toward warning, since a leaf that reached the plan unrecorded is exactly the
// kind this cannot vouch for.
//
// A routing selector is the exception, because its value is a WIRE rather than a key: every wire
// is drawn on the board, so the one it names is the one nobody drew, loaded or read — a wire the
// app completed (the load, or a Fetch / Live start that found the unit on NONE), recorded
// `default` under the wire's own contest name.

import {
  planToCommandOrigins,
  planToCommands,
  cmdAddr,
  ROUTING_SELECTORS,
  type WriteScope,
} from "../core/control/translate";
import type { Plan } from "../core/plan";
import { connectionContestKey } from "../core/plan-history";
import { ref, type DeviceModel } from "../models/types";

/**
 * The owner nodes a write would change at addresses the operator never authored.
 *
 * `changing` is the addresses the diff says differ from the device — the write's own set, so
 * a factory-filled key the unit already agrees with says nothing.
 *
 * Which of those the operator chose is asked of the key each command took its VALUE from
 * (`planToCommandOrigins`). A key that merely GATES a command needs no separate reading: it
 * owns its own command's value, and that command sits on the same node, so a write that is
 * actually changing the selector already names the strip through it — while one that is not
 * changing it leaves an engine parameter the operator dialled in as theirs, which is what it
 * is.
 *
 * Returns node ids in the model's own order, so a caller naming strips lists them the way the
 * board does.
 */
export function unauthoredWriteNodes(
  model: DeviceModel,
  plan: Plan,
  scope: WriteScope,
  changing: ReadonlySet<number>,
): string[] {
  if (!changing.size) return [];
  const source = plan.paramSource;
  const chose = (name: string): boolean => {
    const from = source?.get(name);
    return from === "load" || from === "manual";
  };

  // The receivers whose selector carries a wire the app completed, with that selector's names.
  const completed = new Map<string, Set<string>>();
  for (const [to, , pl, pr] of ROUTING_SELECTORS) {
    const fill = plan.connections.some(
      (c) => c.to === ref(to, "in") && source?.get(connectionContestKey(c.from, c.to)) === "default",
    );
    if (fill) completed.set(to, new Set([pl, pr]));
  }

  const origins = planToCommandOrigins(model, plan, scope);
  const named = new Set<string>();
  for (const c of planToCommands(model, plan, scope)) {
    const addr = cmdAddr(c);
    if (c.node === undefined || !changing.has(addr)) continue;
    const origin = origins.get(addr);
    // `null` is the emit supplying the value itself, which is nobody's to choose — except a
    // routing selector's, whose value is the wire into its receiver. `undefined` is a command
    // that carries no record at all — a value this cannot vouch for, which is the same standing
    // as one the operator did not set, and it must not read as the first.
    if (origin === null) {
      if (completed.get(c.node)?.has(c.name)) named.add(c.node);
      continue;
    }
    if (origin === undefined || !chose(origin)) named.add(c.node);
  }
  return model.nodes.filter((n) => named.has(n.id)).map((n) => n.id);
}
