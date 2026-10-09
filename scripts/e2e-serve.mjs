// Build and serve one of the two E2E bundles, with the port taken from the
// environment so several checkouts can serve at once. `playwright.config.ts`
// reads the same two variables for its URLs, so the server and the tests cannot
// disagree about where the app is: the config passes nothing down, it just runs
// this through the package script and both sides resolve the port the same way.
//
//   node scripts/e2e-serve.mjs           # the ordinary bundle,  E2E_PORT       (4173)
//   node scripts/e2e-serve.mjs --trace   # the trace bundle,     E2E_TRACE_PORT (4174)
//
// Uses Vite's Node API rather than spawning the CLI: no shell quoting, no
// per-platform binary resolution, and `strictPort` surfaces here as a thrown
// error instead of a child exit code. Holding the port is the point — a run that
// silently slid to another port would leave Playwright polling the one it was
// told about, and a run that quietly REUSED a server another checkout started
// would test that checkout's bundle. Both fail loudly instead.
import { createServer } from "node:http";
import { build, preview } from "vite";

const TRACE = process.argv.includes("--trace");
const DEFAULT_PORT = TRACE ? 4174 : 4173;
const VAR = TRACE ? "E2E_TRACE_PORT" : "E2E_PORT";

const raw = process.env[VAR];
const port = raw === undefined || raw === "" ? DEFAULT_PORT : Number(raw);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`${VAR}="${raw}" is not a port number`);
  process.exit(1);
}

// The trace bundle is a production build carrying the plan-ledger probe
// (VITE_TRACE via .env.trace), kept out of dist/ so the two can coexist.
const outDir = TRACE ? "dist-trace" : "dist";
const mode = TRACE ? "trace" : undefined;

await build({ mode, build: { outDir } });

const server = await preview({ mode, build: { outDir }, preview: { port, strictPort: true } });
console.log(`${outDir} on ${server.resolvedUrls?.local?.[0] ?? `http://localhost:${port}/`}`);

// `localhost` binds ONE loopback, and the browser, which resolves it to both, retries
// on the other when its connect to the first fails. The same app is served on the
// other loopback too, so that retry reaches a server. Where that loopback does not
// exist the twin is skipped; anything else holding the port fails the run, like the
// preview's own strictPort.
const twin = await serveOnOtherLoopback(server, port);

/** @returns {Promise<import("node:http").Server | null>} */
async function serveOnOtherLoopback(served, port) {
  const bound = served.httpServer.address();
  if (bound === null || typeof bound === "string") return null;
  const host = bound.family === "IPv6" ? "127.0.0.1" : "::1";
  const other = createServer(served.middlewares);
  return new Promise((resolve, reject) => {
    other.once("error", (e) => {
      if (e.code === "EADDRNOTAVAIL" || e.code === "EAFNOSUPPORT") resolve(null);
      else reject(e);
    });
    other.listen(port, host, () => {
      console.log(`${outDir} also on http://${host.includes(":") ? `[${host}]` : host}:${port}/`);
      resolve(other);
    });
  });
}

// Playwright stops the web server by signalling this process; close the preview
// so the port is free for the next run rather than left held by an orphan.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.httpServer.close();
    twin?.close();
    process.exit(0);
  });
}
