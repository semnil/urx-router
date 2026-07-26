// Runner for the CONSOLE meter bench (scripts/meter-bench.mjs). Serves a tree with
// its own dev server, opens it in Playwright WebKit (the engine the desktop build
// renders in) and runs one measured pass over a synthetic meter feed, bracketed by
// the browser processes' CPU time. Each run also carries the scroll-retention check,
// which needs this engine: Chromium honours focus({ preventScroll }) and WKWebView
// does not, so the E2E suite cannot fail on it.
//
// The point is comparability: pointing --tree at a git worktree of an older commit
// runs the same bench, the same feed and the same viewport against that revision,
// so a change in the numbers is a change in the code and nothing else. A tree whose
// Console does not yet publish the dev handle is patched with that one line for the
// duration of the run and restored afterwards. `--browser chromium` swaps the engine
// (WebView2's, for a Windows comparison) — useful on its own, but it breaks that
// comparability, so revisions are only ever compared within one engine.
//
//   node scripts/meter-bench-run.mjs --seconds 20
//   node scripts/meter-bench-run.mjs --tree /tmp/urx-ba7bb2b --port 5191 --label baseline
import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, webkit } from "@playwright/test";
import { createServer } from "vite";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..");

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf("--" + name);
  return i === -1 ? dflt : argv[i + 1];
};
const has = (name) => argv.includes("--" + name);
// Bench-side options are left undefined unless asked for, so their defaults live in
// scripts/meter-bench.mjs alone (it applies them with ??) and cannot drift from what
// a hand-driven Web Inspector run does.
const num = (name) => (flag(name) === undefined ? undefined : Number(flag(name)));

const opts = {
  tree: resolve(flag("tree", REPO)),
  port: Number(flag("port", 5199)),
  seconds: Number(flag("seconds", 20)),
  warmup: Number(flag("warmup", 3)),
  model: flag("model", "URX44V"),
  browser: flag("browser", "webkit"),
  viewport: flag("viewport", "1600x1000"),
  label: flag("label", ""),
  json: flag("json", ""),
  headed: has("headed"),
  view: flag("view", "console"), // graph measures the same app with the console's loop off
  bench: {
    feed: flag("feed"), // sweep | static | silent | none
    hz: num("hz"),
    live: flag("live") === undefined ? undefined : flag("live") === "true",
    observe: flag("observe") === undefined ? undefined : flag("observe") === "true",
    churn: num("churn"), // rebuilds/s, standing in for device follow
    churnTarget: flag("churn-target"), // strip | view
  },
};
const [vw, vh] = opts.viewport.split("x").map(Number);

// The dev-only handle the bench reaches the view through. A tree from before it
// existed gets the same line inserted at the same place for the run.
const HOOK = `    if (import.meta.env.DEV) (window as unknown as { __urxConsole?: Console }).__urxConsole = this;\n`;
const CONSOLE_TS = join(opts.tree, "src/ui/console.ts");
let restoreConsole = null;

function injectHook() {
  const src = readFileSync(CONSOLE_TS, "utf8");
  if (src.includes("__urxConsole")) return false;
  const anchor = "    this.build();\n  }";
  if (!src.includes(anchor)) throw new Error(`cannot find the Console constructor anchor in ${CONSOLE_TS}`);
  restoreConsole = src;
  writeFileSync(CONSOLE_TS, src.replace(anchor, "    this.build();\n" + HOOK + "  }"));
  return true;
}

function restoreHook() {
  if (restoreConsole === null) return;
  writeFileSync(CONSOLE_TS, restoreConsole);
  restoreConsole = null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cumulative CPU seconds per pid for the browser's own processes (the web content
// and GPU processes included — on this engine the meters' cost lands there, not in
// the JS the page times itself). macOS `ps` reports a decayed average for %cpu, so
// the delta of the cumulative time over a known window is the honest figure.
function cpuTime() {
  const out = execFileSync("ps", ["-A", "-o", "pid=,time=,command="], { encoding: "utf8" });
  const by = new Map();
  for (const line of out.split("\n")) {
    if (!line.includes("ms-playwright")) continue;
    const m = line.trim().match(/^(\d+)\s+([\d:.]+)\s+(.*)$/);
    if (!m) continue;
    const parts = m[2].split(":").map(Number);
    const secs = parts.reduce((a, b) => a * 60 + b, 0);
    by.set(m[1], { secs, cmd: m[3] });
  }
  return by;
}

function cpuShare(before, after, wallMs) {
  let total = 0;
  for (const [pid, now] of after) {
    const was = before.get(pid);
    if (was) total += now.secs - was.secs;
  }
  return { cpuSeconds: Math.round(total * 100) / 100, percent: Math.round((total / (wallMs / 1000)) * 1000) / 10 };
}

function gitHead(tree) {
  return new Promise((res) => {
    const p = spawn("git", ["-C", tree, "rev-parse", "--short", "HEAD"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.on("close", () => res(out.trim() || "unknown"));
  });
}

const url = `http://127.0.0.1:${opts.port}/`;
let server = null;
let browser = null;

process.on("SIGINT", () => {
  restoreHook();
  process.exit(130);
});

try {
  const patched = injectHook();
  // Server boot and browser launch are independent until the first navigation, and
  // a cold engine launch is the slower of the two.
  [server, browser] = await Promise.all([
    // Bound to the loopback address explicitly: vite's default host resolves to the
    // IPv6 loopback here, which Playwright's WebKit build does not reach.
    createServer({
      root: opts.tree,
      configFile: join(opts.tree, "vite.config.ts"),
      server: { port: opts.port, strictPort: true, host: "127.0.0.1" },
      logLevel: "warn",
    }).then((s) => s.listen()),
    (opts.browser === "chromium" ? chromium : webkit).launch({ headless: !opts.headed }),
  ]);

  const page = await browser.newPage({ viewport: { width: vw, height: vh } });
  await page.addInitScript((model) => {
    localStorage.setItem("urx-lang", "en");
    localStorage.setItem("urx-theme", "dark");
    localStorage.setItem("urx-model", model);
  }, opts.model);
  await page.goto(url);
  if (opts.view === "graph") {
    await page.click("#btn-view-graph");
    await page.waitForSelector("#graph-host svg");
  } else {
    await page.click("#btn-view-console");
    await page.waitForSelector(".con-strip");
  }

  await page.evaluate(readFileSync(join(REPO, "scripts/meter-bench.mjs"), "utf8"));
  const scroll = opts.view === "graph" ? null : await page.evaluate(() => window.__urxBench.scrollCheck());
  // The measured window is opened here rather than inside the page's own run(), so
  // the browser's CPU time is read at exactly the sample boundaries.
  await page.evaluate((o) => window.__urxBench.start(o), opts.bench);
  await sleep(opts.warmup * 1000);
  await page.evaluate(() => window.__urxBench.resetCounters());
  const cpu0 = cpuTime();
  const wall0 = Date.now();
  await sleep(opts.seconds * 1000);
  const cpu = cpuShare(cpu0, cpuTime(), Date.now() - wall0);
  const report = await page.evaluate(() => window.__urxBench.stop());

  const out = {
    label: opts.label || opts.tree,
    tree: opts.tree,
    commit: await gitHead(opts.tree),
    patchedHook: patched,
    browser: opts.browser,
    headed: opts.headed,
    cpu,
    scroll,
    ...report,
  };
  const s = out.structure;
  console.log(
    [
      `${out.label} @ ${out.commit}`,
      `  strips ${s.visibleStrips}/${s.strips} on screen  lanes ${s.visibleLanes}/${s.lanes}  live lanes ${s.liveLanes}  console DOM ${s.hostNodes}`,
      `  browser CPU ${out.cpu.percent}% of one core (${out.cpu.cpuSeconds}s over ${out.seconds}s)`,
      `  paint ${out.paintFps} fps  ${out.paintMs.avg} ms/frame (p95 ${out.paintMs.p95}, ${out.paintMs.share}% of wall)`,
      out.churnTicks
        ? `  rebuilds ${out.churnTicks}  ${out.churnMs.avg} ms each (p95 ${out.churnMs.p95}, max ${out.churnMs.max})`
        : "",
      `  DOM mutations ${out.mutations.perFrame}/frame (style ${out.mutations.style}, class ${out.mutations.class}, text ${out.mutations.text})`,
      `  frame gap p50 ${out.raf.p50} ms / p95 ${out.raf.p95} ms   event-loop lag p50 ${out.lag.p50} / p95 ${out.lag.p95} ms`,
      scroll && (!scroll.kept || scroll.keptWithFocus === false)
        ? `  SCROLL NOT HELD across a re-render: ${JSON.stringify(scroll)}`
        : "",
      scroll && (!scroll.scrollable || scroll.keptWithFocus === null)
        ? `  scroll check inconclusive (the rack does not overflow at ${vw}px): ${JSON.stringify(scroll.offsets)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n"),
  );
  if (opts.json) writeFileSync(opts.json, JSON.stringify(out, null, 2));
} finally {
  restoreHook();
  await browser?.close();
  await server?.close();
}
