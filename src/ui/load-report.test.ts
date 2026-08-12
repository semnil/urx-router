// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ copyText: vi.fn<(text: string) => Promise<boolean>>() }));
// Only the clipboard is stubbed. The rest of ./dom stays real so that adding an
// import to load-report.ts fails here as a missing behaviour, not as a missing
// mock export — and so the modal's inert claim runs the code it ships with.
vi.mock("./dom", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dom")>()),
  copyText: mocks.copyText,
}));

import { t } from "../i18n";
import { showLoadReport } from "./load-report";

function installDom(): void {
  document.body.innerHTML = `
    <div id="load-report" hidden>
      <h1 id="load-report-title"></h1>
      <p id="load-report-intro"></p>
      <pre id="load-report-body"></pre>
      <button id="load-report-copy"></button>
      <button id="load-report-close"></button>
    </div>`;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.copyText.mockResolvedValue(true);
  installDom();
});

describe("showLoadReport", () => {
  it("renders the default report, copies it and restores the button on close", async () => {
    showLoadReport("invalid connection");
    const scrim = document.getElementById("load-report") as HTMLElement;
    const copy = document.getElementById("load-report-copy") as HTMLButtonElement;
    const close = document.getElementById("load-report-close") as HTMLButtonElement;

    expect(scrim.hidden).toBe(false);
    expect(document.getElementById("load-report-title")?.textContent).toBe(t().loadReport.title);
    expect(document.getElementById("load-report-intro")?.textContent).toBe(t().loadReport.intro);
    expect(document.getElementById("load-report-body")?.textContent).toBe("invalid connection");
    expect(document.activeElement).toBe(close);

    copy.click();
    await vi.waitFor(() => expect(copy.textContent).toBe(t().loadReport.copied));
    expect(mocks.copyText).toHaveBeenCalledWith("invalid connection");

    close.click();
    expect(scrim.hidden).toBe(true);
    expect(copy.textContent).toBe(t().loadReport.copy);
  });

  it("selects the report when clipboard copying is unavailable", async () => {
    mocks.copyText.mockResolvedValue(false);
    const removeAllRanges = vi.fn();
    const addRange = vi.fn();
    vi.spyOn(window, "getSelection").mockReturnValue({ removeAllRanges, addRange } as unknown as Selection);
    showLoadReport("copy me");

    (document.getElementById("load-report-copy") as HTMLButtonElement).click();
    await vi.waitFor(() => expect(addRange).toHaveBeenCalledOnce());
    expect(removeAllRanges).toHaveBeenCalledOnce();
    expect(copyTextLabel()).toBe(t().loadReport.copy);
  });

  it("offers an explicit proceed action and dismisses before running it", () => {
    const run = vi.fn(() => {
      expect((document.getElementById("load-report") as HTMLElement).hidden).toBe(true);
    });
    showLoadReport("warning", { title: "Compare", intro: "Differences", proceed: { label: "Open", run } });
    const proceed = document.getElementById("load-report-proceed") as HTMLButtonElement;
    expect(proceed.textContent).toBe("Open");
    expect(document.getElementById("load-report-title")?.textContent).toBe("Compare");
    expect(document.getElementById("load-report-intro")?.textContent).toBe("Differences");

    proceed.click();
    expect(run).toHaveBeenCalledOnce();
    expect(document.getElementById("load-report-proceed")).toBeNull();
  });

  it("removes a stale proceed button when the next report is informational", () => {
    showLoadReport("first", { title: "First", intro: "First", proceed: { label: "Continue", run: vi.fn() } });
    expect(document.getElementById("load-report-proceed")).not.toBeNull();
    showLoadReport("second");
    expect(document.getElementById("load-report-proceed")).toBeNull();
    expect(document.getElementById("load-report-body")?.textContent).toBe("second");
  });
});

function copyTextLabel(): string | null {
  return document.getElementById("load-report-copy")?.textContent ?? null;
}
