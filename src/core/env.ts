// Build-time flags. The demo build (vite build --mode demo, see .env.demo) drops
// file persistence and image export from the UI — the GitHub Pages alpha is a
// viewer only, with no native file IO.
export const DEMO = import.meta.env.VITE_DEMO === "1";

// The trace build (vite build --mode trace, see .env.trace) adds one read-only probe
// over the module state the race harness cannot otherwise reach: which plan key each
// writer touched, and what the live snapshot holds. Everything else the harness needs
// is answerable from the IPC the fake device sees, so this is deliberately narrow.
//
// It is a build flag rather than `import.meta.env.DEV` because the E2E suite serves a
// PRODUCTION build on purpose (playwright.config.ts explains why), and an
// instrumented tier running a dev bundle would be testing a different bundle. A plain
// build leaves this unset, so the shipped app carries no probe — guarded in ci.yml
// beside __urxConsole and __urxKeyProbe.
export const TRACE = import.meta.env.VITE_TRACE === "1";
