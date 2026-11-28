// The control package's `Transport` over this app's shell (K2, K34, K37): what urx-device's
// operations reach the unit through, on the connection the page follows. Each request goes to the
// shell (`vd_package_request`, src-tauri/src/vd/package.rs) and resolves with its K34 record as the
// shell built it; urx-device's operation context validates it before adopting anything. A result
// that reached the unit keeps the connection's wire slot until the context adopts it
// (`adoptResult`), and one it cannot adopt ends the connection (`failDelivery`, `terminate`).
//
// Writes pass the page's own holds first, as `vdSet` does (`deviceWritesRefused`): refused there,
// a write sends nothing and resolves with the refusal's record, which holds no slot. A write the
// shell held for the unit's Console Lock resolves once the page has handed on the fetch that
// carries the announcement, so whoever handles the refusal finds the lock already taken.

import type { I64Text } from "@urx/device-control/catalog";
import {
  OperationFailureError,
  type ParameterAddress,
  type RequestTicket,
  type Transport,
  type TransportNotification,
  type TransportOperation,
  type TransportRequest,
  type TransportSubscription,
} from "@urx/device-control/operations";
import { connectedEpoch, deviceWritesRefused, invoke, untilHandedOn } from "./platform";

/** What the shell answers a request with (vd/package.rs `Reply`). */
interface ShellReply {
  readonly record: unknown;
  /** A write the unit's Console Lock held, and the fetch that carries the announcement, if known. */
  readonly held?: { readonly fetch: number | null };
}

type Method = "getNumeric" | "getText" | "getName" | "setNumeric" | "setText";

/** The record of a write the page refused before it reached the shell: nothing was sent. */
const refusedHere = (): unknown => ({
  kind: "failure",
  failure: { kind: "cause", code: "precondition_failed", phase: "admission" },
  evidence: { state: "not_sent" },
});

// Operation owners and request tickets are numbered for the page's lifetime, so no two on one
// connection share a number, whichever transport made them.
let nextOperation = 0;
let nextTicket = 0;

/** One operation owner on the connection of generation `epoch`; the shell makes its own on first use. */
class ShellOperation implements TransportOperation {
  constructor(
    readonly epoch: number,
    readonly id: number,
  ) {}

  // Fire-and-forget, as the interface is: the shell's command answers at once, in the order the
  // page sent it, so a request issued after it meets the cancelled owner. A rejection is the shell
  // being gone, where nothing more can be sent anyway.
  cancel(): void {
    invoke<void>("vd_package_cancel", { epoch: this.epoch, operation: this.id }).catch(() => {});
  }

  finish(): void {
    invoke<void>("vd_package_finish", { epoch: this.epoch, operation: this.id }).catch(() => {});
  }
}

/**
 * The control package's transport on the connection the page follows now (`vdConnect`). With no
 * connection, every request is refused unsent by the shell.
 */
export function packageTransport(): Transport {
  return new ShellTransport(connectedEpoch() ?? 0);
}

class ShellTransport implements Transport {
  readonly #epoch: number;
  /** Tickets whose record the page made itself: they hold no slot in the shell. */
  readonly #local = new Set<RequestTicket>();
  /** The operations this transport made; no other is forwarded to the shell. */
  readonly #operations = new WeakSet<ShellOperation>();

  constructor(epoch: number) {
    this.#epoch = epoch;
  }

  createOperation(): TransportOperation {
    const operation = new ShellOperation(this.#epoch, ++nextOperation);
    this.#operations.add(operation);
    return operation;
  }

  newRequestTicket(): RequestTicket {
    return `request-${++nextTicket}`;
  }

  getNumeric(address: ParameterAddress, request: TransportRequest): Promise<unknown> {
    return this.#request("getNumeric", address, undefined, request);
  }

  getText(address: ParameterAddress, request: TransportRequest): Promise<unknown> {
    return this.#request("getText", address, undefined, request);
  }

  getName(address: ParameterAddress, request: TransportRequest): Promise<unknown> {
    return this.#request("getName", address, undefined, request);
  }

  setNumeric(address: ParameterAddress, value: I64Text, request: TransportRequest): Promise<unknown> {
    return this.#request("setNumeric", address, value, request);
  }

  setText(address: ParameterAddress, value: string, request: TransportRequest): Promise<unknown> {
    return this.#request("setText", address, value, request);
  }

  /**
   * No operation this app runs through the package subscribes yet, so an admission is refused, as
   * the interface lets an adapter refuse one; the stage that adopts the first operation that does
   * gives the shell its subscriptions.
   */
  prepareSubscription(
    _addresses: readonly ParameterAddress[],
    _operation: TransportOperation,
    _deliver: (notification: TransportNotification) => void,
  ): TransportSubscription {
    throw new OperationFailureError({ code: "precondition_failed", phase: "admission", progress: null });
  }

  async adoptResult(requestTicket: RequestTicket): Promise<void> {
    if (this.#local.delete(requestTicket)) return;
    const adopted = await invoke<boolean>("vd_package_adopt", { epoch: this.#epoch, ticket: requestTicket });
    if (!adopted) throw new Error("the result's slot could not be released");
  }

  async failDelivery(requestTicket: RequestTicket): Promise<void> {
    if (this.#local.delete(requestTicket)) return;
    const reported = await invoke<boolean>("vd_package_fail_delivery", { epoch: this.#epoch, ticket: requestTicket });
    if (!reported) throw new Error("the undelivered result could not be reported");
  }

  async terminate(requestTicket: RequestTicket): Promise<void> {
    if (this.#local.delete(requestTicket)) return;
    await invoke<boolean>("vd_package_terminate", { epoch: this.#epoch, ticket: requestTicket });
  }

  /**
   * One request: refused here when the operation is not one this transport made, or when the page
   * holds its writes; otherwise the shell's record, passed on once a write the shell held for
   * Console Lock has its announcement handed on.
   */
  async #request(
    method: Method,
    address: ParameterAddress,
    value: string | undefined,
    request: TransportRequest,
  ): Promise<unknown> {
    const { operation, requestTicket } = request;
    if (!(operation instanceof ShellOperation) || !this.#operations.has(operation)) {
      throw new Error("the operation was not created by this transport");
    }
    if (value !== undefined && deviceWritesRefused()) {
      this.#local.add(requestTicket);
      return refusedHere();
    }
    const reply = await invoke<ShellReply>("vd_package_request", {
      epoch: this.#epoch,
      operation: operation.id,
      ticket: requestTicket,
      method,
      paramId: address.paramId,
      x: address.x,
      y: address.y,
      value: value ?? null,
    });
    if (reply.held) await untilHandedOn(reply.held.fetch ?? undefined);
    return reply.record;
  }
}
