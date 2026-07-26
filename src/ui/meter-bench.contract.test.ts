// @vitest-environment jsdom
// The meter bench (scripts/meter-bench.mjs) is not part of the bundle: it attaches to
// a running Console through the dev-only window handle and drives it by name — it
// feeds `store` at the addresses `subSig` says are subscribed, walks `refs` for the
// strips to rebuild, gates the loop with `setLive`, rebuilds through `refresh` /
// `refreshStrip`, scrolls `stripsHost`, and times the prototype's `paintMeters`. None
// of that is checked by the compiler, and a bench that silently measures nothing is
// worse than no bench, so the shape it depends on is pinned here: a rename on this
// side has to be a rename on that side.
import { describe, it, expect } from "vitest";
import { Console } from "./console";
import { getModel } from "../models";
import { defaultPlan } from "../models/initial-state";

const mount = (): { view: Console; host: HTMLElement } => {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const model = getModel("URX44V");
  const plan = defaultPlan("URX44V");
  const view = new Console(host, { getModel: () => model, getPlan: () => plan, onChange: () => {} });
  view.show();
  return { view, host };
};

const unmount = (view: Console, host: HTMLElement): void => {
  view.hide();
  host.remove();
};

describe("meter bench contract", () => {
  it("publishes the running console on window in a dev build", () => {
    const { view, host } = mount();
    expect((window as unknown as { __urxConsole?: Console }).__urxConsole).toBe(view);
    unmount(view, host);
  });

  it("exposes the members the bench drives", () => {
    const { view, host } = mount();
    const v = view as unknown as {
      refs: Map<string, unknown>;
      store: { apply: unknown };
      stripsHost: HTMLElement;
      subSig: string;
    };
    expect(v.refs).toBeInstanceOf(Map);
    expect(v.refs.get("ch1")).toBeDefined(); // the bench rebuilds strips by these ids
    expect(typeof v.store.apply).toBe("function");
    expect(v.stripsHost).toBeInstanceOf(HTMLElement);
    for (const name of ["setLive", "refresh", "refreshStrip"] as const) {
      expect(typeof view[name]).toBe("function");
    }
    // Timed by shadowing it on the instance, so it has to stay on the prototype.
    expect(typeof (Object.getPrototypeOf(view) as { paintMeters?: unknown }).paintMeters).toBe("function");
    unmount(view, host);
  });

  it("publishes the subscribed meter addresses the bench feeds", () => {
    const { view, host } = mount();
    view.setLive(true); // outside Tauri the registration is a no-op, the signature is not
    const sig = (view as unknown as { subSig: string }).subSig;
    // "meterId:x" pairs, comma-joined — what the bench splits back into addresses.
    expect(sig).toMatch(/^\d+:\d+(,\d+:\d+)*$/);
    view.setLive(false);
    unmount(view, host);
  });

  it("marks up the strips with the classes the bench counts", () => {
    const { view, host } = mount();
    expect(host.querySelectorAll(".con-strip").length).toBeGreaterThan(0);
    // One `.shade` per metered channel — the count the render cost follows.
    expect(host.querySelectorAll(".con-ladder .shade").length).toBeGreaterThan(0);
    unmount(view, host);
  });
});
