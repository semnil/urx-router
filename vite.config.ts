import { defineConfig } from "vite";
import { resolve } from "node:path";

// Relative base so the built assets load inside the Tauri webview as well as a browser.
export default defineConfig(({ mode }) => {
  const e2eCoverage = process.env.E2E_COVERAGE === "1";
  return {
    base: "./",
    clearScreen: false,
    server: {
      port: 5173,
      strictPort: true,
    },
    build: {
      target: "es2022",
      sourcemap: true,
      // Native V8 coverage is remapped through this source map. Minification does
      // not change shipped behaviour, but it coalesces generated ranges enough to
      // make branch/function locations imprecise, so only the coverage bundle keeps
      // the production code unminified. Ordinary E2E and release builds stay exact.
      minify: e2eCoverage ? false : undefined,
      rollupOptions: {
        // Two entries: the app, and the MIDI control window (a second OS window, so a
        // second document). The demo build has no MIDI at all — the whole feature is
        // desktop-only — so it would ship an orphan page to GitHub Pages.
        input: {
          main: resolve(import.meta.dirname, "index.html"),
          ...(mode === "demo" || process.env.VITE_DEMO ? {} : { midi: resolve(import.meta.dirname, "midi.html") }),
        } as Record<string, string>,
      },
    },
  };
});
