// In-page bench for the CONSOLE view's live meter loop. Drives the view's own
// paint loop from a synthetic reading feed so the render cost can be measured
// without a device, and reports what one run actually cost: painted frames, the
// JS time inside them, the DOM mutations they produced, the rAF cadence they ran
// at, and the event-loop lag they left behind.
//
// The file is a single expression: `scripts/meter-bench-run.mjs` hands it to
// page.evaluate (CSP does not apply there), and it can equally be pasted into the
// Web Inspector console of a `pnpm tauri dev` window to measure a real device
// feed (`__urxBench.run({ feed: "none", live: false })` while Live sync is up —
// `live` only gates whether the bench turns Live sync on and off itself).
//
// It reaches the view through `window.__urxConsole`, the dev-only handle the
// Console constructor publishes, and touches nothing else: the measured code path
// is the shipped one.
(() => {
  const view = window.__urxConsole;
  if (!view) {
    throw new Error("meter bench: window.__urxConsole is missing — run a dev build (pnpm dev / pnpm tauri dev)");
  }
  const host = view.host ?? document.getElementById("console-host");
  if (!host) throw new Error("meter bench: no console host in the document");

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () => new Promise((r) => requestAnimationFrame(() => r()));
  const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
  // Percentile off a copy, so the caller's sample order survives.
  const pct = (xs, p) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))];
  };
  // One sample series, summarised the same way wherever it is reported. Sum and max
  // are folded rather than spread, so a long hand-driven session cannot overflow the
  // argument limit.
  const stats = (xs, digits) => {
    let sum = 0;
    let max = 0;
    for (const v of xs) {
      sum += v;
      if (v > max) max = v;
    }
    return {
      total: round(sum, digits),
      avg: round(sum / Math.max(1, xs.length), digits),
      p50: round(pct(xs, 0.5), digits),
      p95: round(pct(xs, 0.95), digits),
      max: round(max, digits),
    };
  };

  // The meter addresses the strips are actually reading, taken from the subscription
  // the view registered (`tapAddrs`' own output, kept as a signature) rather than
  // re-derived here — one source for what "the addresses on screen" means.
  const feedAddrs = () => (view.subSig ? view.subSig.split(",").map((k) => k.split(":").map(Number)) : []);

  const freshMutations = () => ({ style: 0, class: 0, text: 0, child: 0, other: 0 });

  // Only what is on screen is composited, and the strip rack scrolls horizontally,
  // so the visible counts are the ones the render cost follows.
  const onScreen = (sel) => {
    let n = 0;
    for (const e of host.querySelectorAll(sel)) {
      const r = e.getBoundingClientRect();
      if (r.width > 0 && r.height > 0 && r.right > 0 && r.left < innerWidth && r.bottom > 0 && r.top < innerHeight) n++;
    }
    return n;
  };
  const structure = () => ({
    strips: host.querySelectorAll(".con-strip").length,
    visibleStrips: onScreen(".con-strip"),
    lanes: host.querySelectorAll(".con-ladder .shade").length,
    visibleLanes: onScreen(".con-ladder .shade"),
    liveLanes: host.querySelectorAll(".con-ladder.live, .con-ladder .live").length,
    hostNodes: host.querySelectorAll("*").length,
    docNodes: document.querySelectorAll("*").length,
  });

  // A deterministic reading for address index `i` at `t` seconds: a slow sweep
  // over the whole ladder, phase-spread across addresses so the strips never move
  // in lockstep. Values are the broker's raw deci-dBFS.
  const readingFor = (i, t, feed) => {
    if (feed === "static") return -200;
    if (feed === "silent") return -1280;
    const db = -60 + 60 * (0.5 + 0.5 * Math.sin(2 * Math.PI * (t / 3 + i / 17)));
    return Math.round(db * 10);
  };

  let run = null;

  const start = (opts = {}) => {
    if (run) throw new Error("meter bench: already running");
    const feed = opts.feed ?? "sweep"; // sweep | static | silent | none
    const hz = opts.hz ?? 10; // the device streams its meters at ~10 Hz
    const live = opts.live ?? true; // anything but true leaves Live sync as it is
    const observe = opts.observe ?? true; // count DOM mutations (adds a small cost of its own)
    // Rebuilds per second, standing in for device follow: a knob sweep on the unit
    // lands as one refreshStrip per coalesced reflect, up to ~20 Hz ("strip"), while
    // a scoped or full read-back re-renders the whole view ("view").
    const churn = opts.churn ?? 0;
    const churnTarget = opts.churnTarget ?? "strip";

    if (live === true) view.setLive(true);
    const addrs = feed === "none" ? [] : feedAddrs();
    if (feed !== "none" && !addrs.length) {
      throw new Error("meter bench: nothing subscribed to feed — the console must be visible with Live sync on");
    }

    const s = {
      opts: { feed, hz, live, observe, churn, churnTarget },
      t0: performance.now(),
      frames: 0,
      paint: [], // ms inside each paintMeters call
      churn: [], // ms inside each rebuild
      rafGaps: [], // ms between consecutive animation frames
      lastRaf: 0,
      lag: [], // ms a 20 ms timer came back late
      mut: freshMutations(),
      feedTicks: 0,
      churnTicks: 0,
      addrs: addrs.length,
      structure: structure(),
      feedTimer: 0,
      churnTimer: 0,
      lagTimer: 0,
      rafId: 0,
      obs: null,
      paintOwn: Object.prototype.hasOwnProperty.call(view, "paintMeters"),
    };

    // Time the view's own paint. Shadowing the prototype method on the instance
    // keeps every other Console (and a later restore) untouched.
    const paintMeters = Object.getPrototypeOf(view).paintMeters;
    view.paintMeters = function () {
      const t = performance.now();
      paintMeters.call(this);
      s.paint.push(performance.now() - t);
      s.frames++;
    };

    if (observe) {
      s.obs = new MutationObserver((records) => {
        for (const r of records) {
          if (r.type === "childList") s.mut.child++;
          else if (r.type === "characterData") s.mut.text++;
          else if (r.attributeName === "style") s.mut.style++;
          else if (r.attributeName === "class") s.mut.class++;
          else s.mut.other++;
        }
      });
      s.obs.observe(host, { subtree: true, childList: true, characterData: true, attributes: true });
    }

    if (addrs.length) {
      s.feedTimer = setInterval(() => {
        const t = (performance.now() - s.t0) / 1000;
        for (let i = 0; i < addrs.length; i++) {
          view.store.apply({ meterId: addrs[i][0], x: addrs[i][1], value: readingFor(i, t, feed) });
        }
        s.feedTicks++;
      }, 1000 / hz);
    }

    if (churn > 0) {
      const ids = [...view.refs.keys()];
      let i = 0;
      s.churnTimer = setInterval(() => {
        const t = performance.now();
        if (churnTarget === "view") view.refresh();
        else view.refreshStrip(ids[i++ % ids.length]);
        s.churn.push(performance.now() - t);
        s.churnTicks++;
      }, 1000 / churn);
    }

    // Event-loop lag: how late a 20 ms timer comes back while the meters animate.
    // It catches the main-thread work (style recalc / layout / text paint) that the
    // JS timing inside paintMeters does not see.
    const LAG_MS = 20;
    let due = performance.now() + LAG_MS;
    const lagTick = () => {
      const now = performance.now();
      s.lag.push(now - due);
      due = now + LAG_MS;
      s.lagTimer = setTimeout(lagTick, LAG_MS);
    };
    s.lagTimer = setTimeout(lagTick, LAG_MS);

    // Frame cadence, sampled from a loop of our own: the display's rate when the
    // pipeline keeps up, and the stretched gaps when it does not.
    const rafTick = (now) => {
      if (!run) return;
      if (s.lastRaf) s.rafGaps.push(now - s.lastRaf);
      s.lastRaf = now;
      s.rafId = requestAnimationFrame(rafTick);
    };
    s.rafId = requestAnimationFrame(rafTick);

    run = s;
    return s.opts;
  };

  // Drop the samples taken so far and restart the clock, keeping the loop, the
  // feed and the ballistics exactly where they are — how a warm-up is excluded
  // without re-rendering the view.
  const resetCounters = () => {
    if (!run) throw new Error("meter bench: not running");
    run.t0 = performance.now();
    run.frames = 0;
    run.feedTicks = 0;
    run.churnTicks = 0;
    run.paint.length = 0;
    run.churn.length = 0;
    run.rafGaps.length = 0;
    run.lag.length = 0;
    run.mut = freshMutations();
    run.structure = structure();
  };

  const stop = () => {
    if (!run) throw new Error("meter bench: not running");
    const s = run;
    run = null;
    const seconds = (performance.now() - s.t0) / 1000;
    clearInterval(s.feedTimer);
    clearInterval(s.churnTimer);
    clearTimeout(s.lagTimer);
    cancelAnimationFrame(s.rafId);
    s.obs?.disconnect();
    if (!s.paintOwn) delete view.paintMeters;
    if (s.opts.live === true) view.setLive(false);

    const paint = stats(s.paint, 3);
    const mutTotal = s.mut.style + s.mut.class + s.mut.text + s.mut.child + s.mut.other;
    const report = {
      url: location.href,
      ua: navigator.userAgent,
      viewport: [innerWidth, innerHeight],
      dpr: devicePixelRatio,
      opts: s.opts,
      seconds: round(seconds),
      addrs: s.addrs,
      feedTicks: s.feedTicks,
      churnTicks: s.churnTicks,
      churnMs: stats(s.churn, 3),
      structure: s.structure,
      frames: s.frames,
      paintFps: round(s.frames / seconds),
      // share = the wall clock spent inside paintMeters, in percent.
      paintMs: { ...paint, share: round((paint.total / (seconds * 1000)) * 100) },
      raf: { frames: s.rafGaps.length, fps: round(s.rafGaps.length / seconds), ...stats(s.rafGaps) },
      mutations: { ...s.mut, total: mutTotal, perFrame: round(mutTotal / Math.max(1, s.frames), 1) },
      lag: stats(s.lag),
    };
    window.__urxBenchReport = report;
    return report;
  };

  window.__urxBench = {
    start,
    stop,
    // Exposed so a runner can put its own instruments (process CPU time, a profiler
    // recording) around exactly the sampled window.
    resetCounters,
    // Does a re-render leave the strip rack where the operator scrolled it? The render
    // path holds the offset by doing nothing — the clear and the refill are one task, so
    // the empty rack is never laid out — and the restored focus holds it with
    // preventScroll. Both are engine behaviour rather than app logic, and the engine that
    // ships on macOS is this one, not the Chromium the E2E suite runs. So the check rides
    // along with a WebKit bench run instead of living where it cannot fail.
    async scrollCheck() {
      const rack = view.stripsHost;
      const toEnd = async () => {
        rack.scrollLeft = rack.scrollWidth;
        await frame();
        return rack.scrollLeft;
      };
      document.activeElement?.blur?.();
      const plain = await toEnd();
      view.refresh();
      await frame();
      const keptPlain = rack.scrollLeft === plain;
      // Focus a control in the leftmost strip, then scroll it out of sight: restoring
      // focus onto an off-screen control is what moves the rack when the guard is gone.
      // The focus scrolls the control into view itself, and this engine applies that a
      // frame late — so let it land before scrolling away, or the phase measures a rack
      // already sitting at 0 and can never fail.
      rack.querySelector(".con-strip .con-fader")?.focus();
      await frame();
      const focused = await toEnd();
      view.refresh();
      await frame();
      const after = rack.scrollLeft;
      // Whether focus actually came back: if the rebuild dropped it, the offset held
      // for the wrong reason and the phase proves nothing.
      const refocused = document.activeElement?.className ?? null;
      document.activeElement?.blur?.();
      return {
        scrollable: plain > 0,
        kept: keptPlain,
        // null = the rack could not be scrolled far enough to put the focused control
        // off screen, or focus did not return, so this phase proves nothing.
        keptWithFocus: focused > 0 && refocused === "con-fader" ? after === focused : null,
        offsets: { plain, focused, after },
        refocused,
      };
    },
    // One measured run: let the loop warm up (the first frames re-render the view
    // and lift the lanes onto their layers), then sample and hand back the report.
    async run(opts = {}) {
      const seconds = opts.seconds ?? 20;
      const warmup = opts.warmup ?? 3;
      start(opts);
      await sleep(warmup * 1000);
      resetCounters();
      await sleep(seconds * 1000);
      return stop();
    },
    report: () => window.__urxBenchReport,
  };
  return "meter bench ready";
})();
