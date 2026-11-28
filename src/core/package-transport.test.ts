// @vitest-environment jsdom

// The control package's transport over the shell (package-transport.ts): the IPC it sends, and what
// urx-device's operation context makes of what the shell answers. The records themselves are the
// shell's (src-tauri/src/vd/package.rs); the fixture they are checked against here is the list the
// shell's own test builds them from, so the two sides cannot drift apart unseen.

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OperationContext,
  OperationFailureError,
  validateNameRead,
  validateNumericRead,
  validatePost,
  validateTextRead,
  type ParameterAddress,
} from "@urx/device-control/operations";
import shared from "./package-records.fixture.json";
import { packageTransport } from "./package-transport";
import * as platform from "./platform";

type Args = Record<string, unknown>;

/** The shell as the transport reaches it: what each command answers, and every call made. */
function installShell(answers: Record<string, (args: Args) => unknown>) {
  const calls: Array<[string, Args]> = [];
  const invoke = vi.fn(async (cmd: string, args?: Args): Promise<unknown> => {
    calls.push([cmd, args ?? {}]);
    const answer = answers[cmd];
    if (!answer) throw new Error(`no answer for ${cmd}`);
    return answer(args ?? {});
  });
  Object.defineProperty(window, "__TAURI_INTERNALS__", {
    configurable: true,
    writable: true,
    value: { invoke },
  });
  return { calls, invoke };
}

const ADDRESS: ParameterAddress = { paramId: 101, x: "2", y: "-1" };

const read = (value: string) => ({ kind: "success", value, evidence: { state: "read" } });
const accepted = { kind: "success", value: null, evidence: { state: "accepted" } };

afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  platform.holdDeviceWrites(false);
  vi.restoreAllMocks();
});

describe("the records the shell builds", () => {
  const validators = {
    getNumeric: validateNumericRead,
    getText: validateTextRead,
    getName: validateNameRead,
    setNumeric: validatePost,
    setText: validatePost,
  } as const;

  it("holds every shape the shell builds", () => {
    expect(shared.length).toBeGreaterThanOrEqual(20);
    for (const method of Object.keys(validators)) {
      expect(
        shared.some((entry) => entry.method === method),
        method,
      ).toBe(true);
    }
  });

  it.each(shared.map((entry) => [entry.case, entry] as const))("passes urx-device's validation: %s", (_case, entry) => {
    const validate = validators[entry.method as keyof typeof validators];
    expect(validate(entry.record)).toEqual(entry.record);
  });
});

describe("the control package's transport", () => {
  it("sends a read to the shell for the connection the page follows, and adopts the result", async () => {
    const shell = installShell({
      vd_package_request: () => ({ record: read("7") }),
      vd_package_adopt: () => true,
      vd_package_finish: () => undefined,
    });
    const transport = packageTransport();
    const context = new OperationContext(transport, "URX44V");
    const got = await context.getNumeric(ADDRESS);
    context.finish();
    expect(got.record).toEqual(read("7"));
    const [request, adopt] = shell.calls;
    expect(request?.[0]).toBe("vd_package_request");
    expect(request?.[1]).toEqual({
      epoch: 0,
      operation: expect.any(Number),
      ticket: expect.stringMatching(/^request-\d+$/),
      ticketFloor: expect.any(Number),
      operationFloor: expect.any(Number),
      method: "getNumeric",
      paramId: 101,
      x: "2",
      y: "-1",
      value: null,
    });
    expect(adopt).toEqual(["vd_package_adopt", { epoch: 0, ticket: request?.[1].ticket }]);
    await vi.waitFor(() =>
      expect(shell.calls.at(-1)).toEqual(["vd_package_finish", { epoch: 0, operation: request?.[1].operation }]),
    );
  });

  it("sends a write's value as I64Text, and a text write's as the string", async () => {
    const shell = installShell({ vd_package_request: () => ({ record: accepted }), vd_package_adopt: () => true });
    const context = new OperationContext(packageTransport(), "URX44V");
    expect(await context.setNumeric(ADDRESS, "-9223372036854775808")).toEqual(accepted);
    expect(await context.setText(ADDRESS, "")).toEqual(accepted);
    const writes = shell.calls
      .filter(([cmd]) => cmd === "vd_package_request")
      .map(([, args]) => [args.method, args.value]);
    expect(writes).toEqual([
      ["setNumeric", "-9223372036854775808"],
      ["setText", ""],
    ]);
  });

  it("tells the shell the oldest ticket the page may still name", async () => {
    let adopt = true;
    const shell = installShell({
      vd_package_request: () => ({ record: read("7") }),
      vd_package_adopt: () => adopt,
      vd_package_fail_delivery: () => false,
      vd_package_terminate: () => Promise.reject(new Error("lost")),
      vd_package_finish: () => undefined,
    });
    const requests = () => shell.calls.filter(([cmd]) => cmd === "vd_package_request").map(([, args]) => args);
    const ticketOf = (args: Args | undefined) => Number(String(args?.ticket).slice("request-".length));
    // A fresh module, so no ticket an earlier case left live is the oldest.
    vi.resetModules();
    const { packageTransport: fresh } = await import("./package-transport");
    const context = new OperationContext(fresh(), "URX44V");
    await context.getNumeric(ADDRESS);
    await context.getNumeric(ADDRESS);
    const [first, second] = requests();
    expect(first?.ticketFloor, "nothing older is live").toBe(ticketOf(first));
    expect(second?.ticketFloor, "the first was adopted").toBe(ticketOf(second));
    // A ticket whose adoption, report and terminate all fail is given up all the same: the next
    // request's floor passes it, so the shell can end the connection with the slot it holds.
    adopt = false;
    await context.getNumeric(ADDRESS);
    adopt = true;
    await context.getNumeric(ADDRESS);
    const [, , third, fourth] = requests();
    expect(fourth?.ticketFloor, "the given-up ticket is behind the floor").toBeGreaterThan(ticketOf(third));
    context.finish();
  });

  it("tells the shell the oldest owner the page has not finished, whether or not a finish arrived", async () => {
    const shell = installShell({
      vd_package_request: () => ({ record: read("7") }),
      vd_package_adopt: () => true,
      vd_package_finish: () => Promise.reject(new Error("lost")),
    });
    const requests = () => shell.calls.filter(([cmd]) => cmd === "vd_package_request").map(([, args]) => args);
    // A fresh module, so no owner an earlier case left live is the oldest.
    vi.resetModules();
    const { packageTransport: fresh } = await import("./package-transport");
    const transport = fresh();
    const open = new OperationContext(transport, "URX44V");
    await open.getNumeric(ADDRESS);
    const first = requests()[0];
    expect(first?.operationFloor, "nothing older is live").toBe(first?.operation);
    for (let n = 0; n < 3; n++) {
      const context = new OperationContext(transport, "URX44V");
      await context.getNumeric(ADDRESS);
      context.finish();
    }
    open.finish();
    const after = new OperationContext(transport, "URX44V");
    await after.getNumeric(ADDRESS);
    after.finish();
    const all = requests();
    expect(
      all.slice(1, 4).map((args) => args.operationFloor),
      "an owner left open keeps the floor",
    ).toEqual([first?.operation, first?.operation, first?.operation]);
    expect(all.at(-1)?.operationFloor, "every earlier owner finished, its finish lost").toBe(all.at(-1)?.operation);
  });

  it("passes a held write on at once once its connection is no longer the one followed", async () => {
    let answerHeld: (reply: unknown) => void = () => {};
    let epoch = 7;
    installShell({
      vd_connect: () => ({ model: "URX44V", label: "URX44V", firmware: "", epoch: epoch++ }),
      vd_params_subscribe: () => undefined,
      vd_notifications: () => new Promise(() => {}),
      vd_package_request: () => new Promise((resolve) => (answerHeld = resolve)),
      vd_disconnect: () => undefined,
    });
    await platform.vdConnect("URX44V");
    try {
      await platform.vdParamsSubscribe([], () => {});
      const context = new OperationContext(packageTransport(), "URX44V");
      const write = context.setNumeric(ADDRESS, "1");
      // The page follows another connection before the shell's refusal comes back.
      await platform.vdConnect("URX44V");
      await platform.vdParamsSubscribe([], () => {});
      answerHeld({
        record: {
          kind: "failure",
          failure: { kind: "cause", code: "precondition_failed", phase: "admission" },
          evidence: { state: "not_sent" },
        },
        held: { fetch: 2 },
      });
      const settled = await Promise.race([
        write.then(() => "settled"),
        new Promise((resolve) => setTimeout(() => resolve("waiting"), 50)),
      ]);
      expect(settled, "the other connection's fetches carry nothing of it").toBe("settled");
    } finally {
      await platform.vdDisconnect(8).catch(() => {});
    }
  });

  it("refuses a write the page holds before it reaches the shell, and holds no slot for it", async () => {
    const shell = installShell({});
    platform.holdDeviceWrites(true);
    const context = new OperationContext(packageTransport(), "URX44V");
    const record = await context.setNumeric(ADDRESS, "1");
    expect(record).toEqual({
      kind: "failure",
      failure: { kind: "cause", code: "precondition_failed", phase: "admission" },
      evidence: { state: "not_sent" },
    });
    expect(shell.calls, "nothing reached the shell, not even an adoption").toEqual([]);
  });

  it("refuses a write on a connection that lost its notifications before it reaches the shell", async () => {
    const shell = installShell({
      vd_connect: () => ({ model: "URX44V", label: "URX44V", firmware: "", epoch: 4 }),
      vd_params_subscribe: () => undefined,
      vd_notifications: () => Promise.reject(new Error("fetch failed")),
    });
    await platform.vdConnect("URX44V");
    try {
      const lost = new Promise<void>((resolve) => platform.onNotificationsLost(resolve));
      await platform.vdParamsSubscribe([], () => {});
      await lost;
      const context = new OperationContext(packageTransport(), "URX44V");
      expect(await context.setText(ADDRESS, "a")).toMatchObject({ kind: "failure", evidence: { state: "not_sent" } });
      expect(
        shell.calls.some(([cmd]) => cmd.startsWith("vd_package_")),
        "nothing reached the shell",
      ).toBe(false);
    } finally {
      await platform.vdDisconnect(4).catch(() => {});
    }
  });

  it("passes a write the shell held for Console Lock on once the page has the fetch that carries the lock", async () => {
    let answerFetch: (runs: unknown[]) => void = () => {};
    const shell = installShell({
      vd_connect: () => ({ model: "URX44V", label: "URX44V", firmware: "", epoch: 3 }),
      vd_params_subscribe: () => undefined,
      vd_notifications: (args) =>
        args.seq === 0 ? new Promise((resolve) => (answerFetch = resolve)) : new Promise(() => {}),
      vd_package_request: () => ({
        record: {
          kind: "failure",
          failure: { kind: "cause", code: "precondition_failed", phase: "admission" },
          evidence: { state: "not_sent" },
        },
        held: { fetch: 0 },
      }),
      vd_package_adopt: () => true,
    });
    await platform.vdConnect("URX44V");
    try {
      await platform.vdParamsSubscribe([], () => {});
      const context = new OperationContext(packageTransport(), "URX44V");
      let settled = false;
      const write = context.setNumeric(ADDRESS, "1").then((record) => {
        settled = true;
        return record;
      });
      await vi.waitFor(() => expect(shell.calls.some(([cmd]) => cmd === "vd_package_request")).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(settled, "held until fetch 0 is handed on").toBe(false);
      answerFetch([]);
      expect((await write).kind).toBe("failure");
      expect(shell.calls.find(([cmd]) => cmd === "vd_package_request")?.[1].epoch).toBe(3);
    } finally {
      // The connection this case followed, let go whatever the case found.
      await platform.vdDisconnect(3).catch(() => {});
    }
  });

  it("reports a result it could not adopt, and the context keeps no success from it", async () => {
    const shell = installShell({
      vd_package_request: () => ({ record: read("7") }),
      vd_package_adopt: () => false,
      vd_package_fail_delivery: () => true,
    });
    const context = new OperationContext(packageTransport(), "URX44V");
    const got = await context.getNumeric(ADDRESS);
    expect(got.record).toEqual({
      kind: "failure",
      failure: { kind: "cause", code: "internal_error", phase: "delivery" },
      evidence: { state: "read" },
    });
    const ticket = shell.calls[0]?.[1].ticket;
    expect(shell.calls.map(([cmd]) => cmd)).toEqual([
      "vd_package_request",
      "vd_package_adopt",
      "vd_package_fail_delivery",
    ]);
    expect(shell.calls[2]?.[1]).toEqual({ epoch: 0, ticket });
  });

  it("ends the connection for a result it cannot report, through terminate", async () => {
    const shell = installShell({
      vd_package_request: () => ({ record: { kind: "success" } }),
      vd_package_fail_delivery: () => false,
      vd_package_terminate: () => true,
    });
    const context = new OperationContext(packageTransport(), "URX44V");
    await expect(context.getNumeric(ADDRESS)).rejects.toBeInstanceOf(OperationFailureError);
    expect(shell.calls.map(([cmd]) => cmd)).toEqual([
      "vd_package_request",
      "vd_package_fail_delivery",
      "vd_package_terminate",
    ]);
  });

  it("sends nothing for an operation another transport made", async () => {
    const shell = installShell({});
    const transport = packageTransport();
    for (const operation of [packageTransport().createOperation(), { cancel() {}, finish() {} }]) {
      await expect(
        transport.getNumeric(ADDRESS, { operation, requestTicket: transport.newRequestTicket() }),
      ).rejects.toThrow("not created by this transport");
    }
    expect(shell.calls).toEqual([]);
  });

  it("numbers tickets and owners for the page's lifetime, whichever transport makes them", () => {
    const a = packageTransport();
    const b = packageTransport();
    const tickets = [a.newRequestTicket(), b.newRequestTicket(), a.newRequestTicket()];
    expect(new Set(tickets).size).toBe(3);
  });

  it("cancels and finishes an owner in the shell", () => {
    const shell = installShell({ vd_package_cancel: () => undefined, vd_package_finish: () => undefined });
    const operation = packageTransport().createOperation();
    operation.cancel("interrupted");
    operation.finish();
    const [cancel, finish] = shell.calls;
    expect(cancel?.[0]).toBe("vd_package_cancel");
    expect(finish?.[0]).toBe("vd_package_finish");
    expect(cancel?.[1]).toEqual(finish?.[1]);
    expect(cancel?.[1]).toEqual({ epoch: 0, operation: expect.any(Number) });
  });

  it("refuses a subscription's admission", () => {
    const transport = packageTransport();
    let thrown: unknown;
    try {
      transport.prepareSubscription([ADDRESS], transport.createOperation(), () => {});
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(OperationFailureError);
    expect((thrown as OperationFailureError<null>).failure).toMatchObject({
      code: "precondition_failed",
      phase: "admission",
    });
  });
});
