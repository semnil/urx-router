import { defineConfig } from "vite";

// Relative base so the built assets load inside the Tauri webview as well as a browser.
export default defineConfig({
  base: "./",
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
