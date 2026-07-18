import type { Page } from "@playwright/test";

/**
 * Boot-time Tauri IPC stub for desktop-only UI: seeds the language / model /
 * consent gate and answers the constant boot-time queries. `commands` extends
 * or overrides the responses per spec — values must be serializable constants.
 * Specs needing stateful handlers (midi.spec.ts captures the input channel and
 * records sent bytes) keep their own bespoke stub instead.
 */
export async function stubTauriBoot(page: Page, commands: Record<string, unknown> = {}): Promise<void> {
  await page.addInitScript((extra) => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-model", "URX44V");
    localStorage.setItem("urx-disclaimer-accepted", "1"); // skip the consent gate
    const responses: Record<string, unknown> = {
      experimental_enabled: false,
      self_test_requested: false,
      reset_storage_requested: false,
      "plugin:updater|check": null,
      ...extra,
    };
    (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
      Channel: class {
        onmessage: (data: unknown) => void = () => {};
      },
      invoke: (cmd: string) =>
        cmd in responses
          ? Promise.resolve(responses[cmd])
          : Promise.reject(new Error(`stub: unhandled command ${cmd}`)),
    };
  }, commands);
}
