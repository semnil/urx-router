// Open the browser dev app's reset URL so it clears its localStorage (theme /
// model / meter points / consent gate / recent files / inspector sections) and
// boots clean. Requires `pnpm dev` to be running. Zero-dependency.
//   pnpm reset:storage
// The desktop app uses the launch flag instead: `pnpm tauri dev -- -- --reset-storage`.

import { spawn } from "node:child_process";

const url = process.env.URX_DEV_URL ?? "http://localhost:5173/?reset";
const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";

console.log(`opening ${url} (clears localStorage on load)`);
spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
