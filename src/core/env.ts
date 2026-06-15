// Build-time flags. The demo build (vite build --mode demo, see .env.demo) drops
// file persistence and image export from the UI — the GitHub Pages alpha is a
// viewer only, with no native file IO.
export const DEMO = import.meta.env.VITE_DEMO === "1";
