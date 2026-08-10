// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  langHandler: undefined as (() => void) | undefined,
  onLangChange: vi.fn<(handler: () => void) => void>(),
  words: {
    title: "Device Center link",
    row: {
      up: "Link up",
      sent: "Sent",
      subscriptions: "Subscriptions",
      frames: "Registration frames",
      reads: "Full reads",
      noanswer: "No answer",
      log: "Log",
    },
    set: "set",
    get: "get",
    params: "params",
    meters: "meters",
    regist: "regist",
    unregist: "unregist",
    stall: (n: number, limit: number): string => `${n}/${limit} to cutoff`,
    noLog: "not written yet",
    copy: "Copy",
    copied: "Link ledger copied",
    copyFailed: "Copy failed",
  },
}));

vi.mock("../i18n", () => ({
  onLangChange: mocks.onLangChange,
  t: () => ({ linkStats: mocks.words }),
}));

import { LINK_BAR_KEYS, LINK_LEDGER_KEYS, type LinkLedger } from "../core/control/link-stats";
import { LinkStatsView } from "./link-stats";

const LEDGER: LinkLedger = {
  upMs: 3_723_000,
  sets: 40,
  gets: 5,
  paramSubscribes: 2,
  meterSubscribes: 7,
  registFrames: 300,
  unregistFrames: 20,
  fullReads: 11,
  deadlines: 6,
  stalled: 1,
};

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

function installView(options: { logPath?: string | null; ledger?: LinkLedger } = {}) {
  const host = document.createElement("div");
  document.body.append(host);
  const read = vi.fn(async () => options.ledger ?? LEDGER);
  const onCopied = vi.fn();
  let logPath = options.logPath ?? null;
  const view = new LinkStatsView(host, { read, logPath: () => logPath, onCopied });
  return { host, read, onCopied, view, setLogPath: (path: string | null) => void (logPath = path) };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.langHandler = undefined;
  mocks.words.title = "Device Center link";
  mocks.words.row.up = "Link up";
  mocks.onLangChange.mockImplementation((handler) => void (mocks.langHandler = handler));
  document.body.replaceChildren();
  Object.defineProperty(document, "hidden", { configurable: true, value: false });
  Reflect.deleteProperty(navigator, "clipboard");
});

afterEach(() => vi.useRealTimers());

describe("LinkStatsView", () => {
  it("polls only while a visible session is shown", async () => {
    const { host, read, view } = installView();
    const button = host.querySelector(".linkbar-open") as HTMLButtonElement;
    expect(host.hidden).toBe(true);
    expect(button.title).toBe("Device Center link");
    expect(mocks.onLangChange).toHaveBeenCalledOnce();

    view.setSession(true);
    await settle();
    expect(host.hidden).toBe(false);
    expect(read).toHaveBeenCalledOnce();
    const cells = host.querySelectorAll<HTMLElement>("[data-link-cell]");
    expect(cells).toHaveLength(LINK_BAR_KEYS.length);
    expect(cells[0].textContent).toBe("Link up1:02:03");
    expect(cells[1].textContent).toBe("No answer6");
    expect(cells[1].classList.contains("warn")).toBe(true);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "hidden", { configurable: true, value: true });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(read).toHaveBeenCalledTimes(2);

    view.setSession(false);
    expect(host.hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("renders every ledger row and refreshes an open panel", async () => {
    const { host, view, setLogPath } = installView();
    view.setSession(true);
    await settle();
    (host.querySelector(".linkbar-open") as HTMLButtonElement).click();

    const pop = document.querySelector<HTMLElement>(".linkbar-pop")!;
    expect(pop.getAttribute("role")).toBe("dialog");
    expect(pop.getAttribute("aria-label")).toBe("Device Center link");
    expect(pop.querySelectorAll("[data-ledger-row]")).toHaveLength(LINK_LEDGER_KEYS.length);
    expect(pop.querySelector('[data-ledger-row="sent"]')?.textContent).toBe("Sent4540 set · 5 get");
    expect(pop.querySelector('[data-ledger-row="subscriptions"]')?.textContent).toBe(
      "Subscriptions92 params · 7 meters",
    );
    expect(pop.querySelector('[data-ledger-row="frames"]')?.textContent).toBe(
      "Registration frames320300 regist · 20 unregist",
    );
    expect(pop.querySelector('[data-ledger-row="noanswer"]')?.textContent).toBe("No answer61/3 to cutoff");
    expect(pop.querySelector('[data-ledger-row="log"]')?.textContent).toBe("Lognot written yet");

    setLogPath("/tmp/link-ledger.jsonl");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(pop.querySelector('[data-ledger-row="log"]')?.textContent).toBe("Log/tmp/link-ledger.jsonl");

    mocks.words.title = "Link diagnostics";
    mocks.words.row.up = "Uptime";
    mocks.langHandler?.();
    expect(pop.getAttribute("aria-label")).toBe("Link diagnostics");
    expect(pop.querySelector("h4")?.textContent).toBe("Link diagnostics");
    expect(host.querySelector('[data-link-label="up"]')?.textContent).toBe("Uptime");
  });

  it("copies exactly what the panel shows and reports clipboard failures", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    const { host, onCopied, view } = installView({ logPath: "/tmp/link-ledger.jsonl" });

    // Before the first reading there is deliberately nothing stale to copy.
    (host.querySelector(".linkbar-open") as HTMLButtonElement).click();
    (document.querySelector("[data-ledger-copy]") as HTMLButtonElement).click();
    await settle();
    expect(writeText).not.toHaveBeenCalled();

    view.setSession(true);
    await settle();
    (document.querySelector("[data-ledger-copy]") as HTMLButtonElement).click();
    await settle();
    expect(writeText).toHaveBeenCalledWith(
      [
        "Link up: 1:02:03",
        "Sent: 45 40 set · 5 get",
        "Subscriptions: 9 2 params · 7 meters",
        "Registration frames: 320 300 regist · 20 unregist",
        "Full reads: 11",
        "No answer: 6 1/3 to cutoff",
        "Log: /tmp/link-ledger.jsonl",
      ].join("\n"),
    );
    expect(onCopied).toHaveBeenLastCalledWith("Link ledger copied");

    writeText.mockRejectedValueOnce(new Error("denied"));
    (document.querySelector("[data-ledger-copy]") as HTMLButtonElement).click();
    await settle();
    expect(onCopied).toHaveBeenLastCalledWith("Copy failed");
  });

  it("dismisses the panel with Escape, outside presses and session end", async () => {
    const { host, view } = installView();
    const button = host.querySelector(".linkbar-open") as HTMLButtonElement;
    button.click();
    expect(button.getAttribute("aria-expanded")).toBe("true");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(".linkbar-pop")).toBeNull();
    expect(button.getAttribute("aria-expanded")).toBe("false");

    button.click();
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    expect(document.querySelector(".linkbar-pop")).toBeNull();

    button.click();
    view.setSession(false);
    expect(document.querySelector(".linkbar-pop")).toBeNull();
  });
});
