# CLAUDE.md — urx-router

## Overview

Routing planning tool for the YAMAHA URX22 / URX44 / URX44V. Based on the official block diagram,
it visualizes inputs/outputs, mixer buses, and output patches as an SVG node graph, constrained so that
**only connectable routes** can be wired. Plans are saved as JSON and exported as images. Device writes
and Live sync are always enabled in the desktop build (vd protocol, `src/core/control/`).

## Tech stack

- Tauri 2 (desktop shell; Windows 11 / Apple silicon macOS)
- TypeScript + Vite (frontend)
- Rendering is plain SVG. **Zero runtime external dependencies** (no npm packages or CDNs in the runtime)

## Structure

- `src/main.ts` — app entry. Wires models/core/ui/i18n together
- `src/models/` — device definitions. `build.ts` generates a `DeviceModel` (nodes + connection rules) from device parameters. `index.ts` registers URX22/44/44V. `defaultPlan` in `initial-state.ts` produces the initial values for a new plan (models captured from real hardware are seeded with factory defaults; data in `initial-urx44v.ts` / `initial-urx22.ts`)
- `src/core/` — `routing.ts` connection constraint engine / `constraints.ts` sample-rate-dependent feature limits (warnings + 176.4/192 kHz forces stereo CH EQ OFF, `channelEqUnavailable`) and Ducker bypass detection (`channelDuckerOn` = PRE-send notes, `duckerBypassWarnings` = pre-fader tap warnings for USB direct outs; microSD Rec intentionally excluded) / `plan.ts` plan state + JSON / `levels.ts` the device's discrete level_gain grid (`LEVEL_STEPS_DB`, the canonical list of settable dB values, plus position/snap/step helpers. Faders and send levels snap to this grid, with the steps laid out at even spacing) / `storage.ts` save/load/image export (PNG/PDF; PDF via home-grown FlateDecode) / `platform.ts` runtime bridge between Tauri IPC and the browser / `meters.ts` live level meters (node id → broker meter address mapping, dBFS decoding, latest-value store; for the CONSOLE view) / `env.ts` build-time flags (`DEMO`: demo builds hide save/image export)
  - `src/core/midi/` — external MIDI control (desktop only). `message.ts` decode/encode of CC/note/pitch bend / `mapping.ts` free-mapping model (address, takeover mode absolute/pickup/relative, relative encodings) + persistence validation / `controls.ts` catalog of fixed control ids (`node/param[@send target]`) for every CONSOLE control — normalized (0..1) get/set snapping to the same grids as the console; device locks (FIXED bus sends, Pan Link send pan, rate-restricted stereo CH EQ) reject writes / `engine.ts` incoming-message application (14-bit CC pairs; toggles have a per-mapping button behavior = toggle (edge) / momentary (state), momentary meaning the value is the state directly, for Stream Deck-style alternating 127/0 senders), MIDI-learn state machine, feedback (diff against a sent cache + 300 ms echo suppression while receiving)
  - `src/core/control/` — live device control (vd protocol). Writes and Live sync are always enabled on desktop; only the round-trip diagnostics in `selftest.ts` require an `--experimental` launch
    - `vd.ts` value encoding / `translate.ts` plan→commands / `readback.ts` device→plan / `params.ts` catalog of confirmed parameters
    - `fx-effect.ts` catalog of FX-channel effects (Rev-X/Rev.R3/Mono Delay/Ping Pong) — slot addressing of the type selector + parameter arrays, and raw↔display encoding
    - `insert-fx-effect.ts` effect parameter catalog for insert FX (Guitar Amp Classics/Pitch Fix/Compander-H/S/Multi-Band Comp) — reads/writes the engine arrays bound by the selector (Guitar 697 / Pitch 701 / Compander 689 / output 693) via slot addressing; raw↔display uses values calibrated against the device LCD (Compander reuses the existing COMP-family encodings; MBC/Pitch/Guitar have dedicated tables and enums for SP Type/Amp Type/Scale etc.)
    - `firmware.ts` validated System firmware version gate (matches against `SUPPORTED_SYSTEM_FIRMWARE` and warns before read/write/live-sync on a version mismatch; an empty version skips the check)
    - `client.ts` write sequence + dry-run / `selftest.ts` round-trip diagnostics
    - `live.ts` immediate device reflection of edits (snapshot diff, debounce; builds the address→node index alongside the snapshot and exposes it as `lookup`)
    - `follow.ts` board follow of device-side operations (subscribes to param notify → classifies via `live.lookup`: direct = node-local scalars (`follow: "direct"` in `params.ts`) applied with `applyDirect` without readback; scoped = readback of the owning node only via `applyNodeState`; unknown params or more than 3 controls escalate to a full readback; a safety full readback runs when idle)
- `src/ui/` — `graph.ts` SVG node graph (studio-rack styling, dark/light themes) / `inspector.ts` selected-element editor / `console.ts` CONSOLE view (mixer-style level overview. Switched via the GRAPH/CONSOLE tabs; an alternate view of the same plan; fader/MUTE/EQ edits go through `markChanged` for the same live sync as the graph; send-on-fader; live meters only during Live sync, ~10 Hz) / `glyph.ts` wraps the `∞` glyph in a `.glyph-inf` span to compensate the reduced x-height of mono fonts (shared by console readouts and inspector values) / `consent.ts` first-launch consent gate (fullscreen inert modal, disclaimer text, persisted in `localStorage`, declining exits the app; desktop only) / `load-report.ts` copyable report modal for plan load failures (`?plan=` decode failures, routing validation failures) / `licenses.ts` third-party license modal (the bundled cargo-about page in a sandboxed frame; File menu, desktop only) / `midi.ts` MIDI settings panel (Device menu → non-modal; port selection / learn / assignment list; persisted per model under `urx-midi`; wires the console arming hooks and the feedback into `markChanged`/follow application) / `dom.ts` shared DOM builder (`el`)
- `src/i18n/` — i18n for the app UI. `en.ts` is the baseline, `ja.ts` the translation; runtime language switching (`core/*` is language-independent)
- `src-tauri/` — Rust shell. Webview host + tauri-plugin-dialog + file IO commands (read/write_text, write_binary; `third_party_licenses` reads the cargo-about notice bundled via `bundle.resources`, shown from File → "Third-party licenses") + device control commands (`vd_connect/vd_info/vd_set/vd_get/vd_set_str/vd_get_str/vd_disconnect`; meter subscription `vd_meters_subscribe/vd_meters_unsubscribe`, device-side change subscription `vd_params_subscribe/vd_params_unsubscribe`, and link-loss events `vd_watch_link` are delivered over Tauri Channels; `--experimental` gate: `experimental_enabled`/`self_test_requested` are self-test only) + MIDI bridge commands (`midi_list_inputs/outputs`; `midi_open_input` delivers received bursts over a Tauri Channel; `midi_close_input`; `midi_open_output/midi_close_output`; `midi_send`. Uses midir; synchronous commands since they only touch local OS APIs). The installer's consent page is `bundle.licenseFile` (`LICENSE.txt` = disclaimer + trademarks + MIT); exiting on consent-gate rejection requires the `process:allow-exit` permission
- `docs/en/` + `docs/ja/` — `device-model.md` (grounding for the routing rules) / `architecture.md` (architecture) / `known-issues.md` (list of limitations that cannot be reflected on the device. Keep English and Japanese in sync)
- `reference/` — primary-source PDFs (block diagram, user guide) and reverse-engineered vd protocol dumps under `.local/` (`vd-protocol.md`/`vd-params.md` etc.; the grounding for `control/`). **Managed in a separate private repository; the entire directory, README included, is excluded from this public repository** (`/reference/` in `.gitignore`)
- `scripts/gen-icon.mjs` — zero-dependency app icon generator (`node scripts/gen-icon.mjs` → `pnpm tauri icon scripts/app-icon.png`)

## Development

```sh
pnpm install
pnpm dev          # browser http://localhost:5173 (no Rust required)
pnpm tauri dev    # desktop app (Rust required; install via rustup if missing)
pnpm build        # tsc --noEmit + vite build
pnpm build:demo   # browser demo build (VITE_DEMO=1; excludes save/image export)
pnpm test         # vitest (core: routing/constraints/plan/levels/meters/midi, control: vd/translate/readback/live/follow/fx/insert-fx/firmware etc., models)
pnpm test:e2e     # Playwright E2E (e2e/*.spec.ts: routing/hide/notes/multiselect/bustype/signaltype/insertfx/midi etc.). CI runs this post-merge
pnpm clean        # remove the Vite cache (node_modules/.vite) + dist + Cargo target
pnpm reset:storage # clear the dev app's (browser) localStorage = opens the ?reset URL
```

How to reset the dev app's localStorage (theme/model/meter point/consent gate/recent files/inspector open state): in the browser, open `http://localhost:5173/?reset` (or `#reset`) (`pnpm reset:storage` opens it; cleared synchronously at startup, then the flag is stripped from the URL); on desktop, launch with `pnpm tauri dev -- -- --reset-storage` (Rust reads `--reset-storage` and the frontend clears + reloads; `reset_storage_requested` command). Both entry points funnel into the reset routine in `src/main.ts`.

On this machine (Mac), node/pnpm go through nodenv (`~/.anyenv/envs/nodenv/shims`). The PATH is not loaded in non-interactive shells.

If `pnpm tauri dev` keeps showing a stale version or UI, discard the build caches with `pnpm clean` and restart (the version is embedded at build time via `tauri.conf.json`→`../package.json`, so it easily sticks in the Vite cache). The webview's persistent data (the consent gate in `localStorage`, etc.) lives outside the app and is not covered by `pnpm clean`; on macOS delete `~/Library/WebKit/<productName or identifier>/` manually.

CI is 4 workflows: PRs run build + unit tests (`ci.yml`); E2E and third-party license generation run post-merge (`post-merge.yml`); the browser demo auto-deploys to GitHub Pages on `vX.Y.Z` release tag push (`pages.yml`); desktop installers also build on tag push (`release.yml`).

## Conventions

- Code identifiers and comments in English. Comments describe behavior only. Minimize diffs
- Documentation is maintained in Japanese and English (`docs/{ja,en}`); diagrams use Mermaid notation
- **When changing routing rules, keep `docs/{en,ja}/device-model.md` and `src/models/` in sync** (the official block diagram is the primary source). After changing `src/models/`, also regenerate the data bundled with the `urx-routing-planner` skill (`scripts/models.json` + `references/model-*.md`) via `UPDATE_SKILL=1 pnpm test skill-export` and commit it (generator: `src/models/skill-export.ts`; drift is caught in CI by `skill-export.test.ts`). **Semantic constraints that do not appear in the route table (signal-flow ordering = pre/post-fader, duckers, etc.) are absent from the generated data, so `skill-export` does not carry them**. When the tool starts handling a new constraint of this kind, hand-update the feasibility notes in `.claude/skills/urx-routing-planner/SKILL.md` (example: channel → USB/SD direct outs tap at the Rec Point = pre-fader/pre-ducker)
- Keep the theme palettes in sync between the CSS variables in `src/style.css` (`:root` / `[data-theme="light"]`) and `PALETTES` in `src/ui/graph.ts`
- Do not write machine-specific values, real device UDIDs, or real control-protocol values in code/documentation (placeholders + files outside git). Values the application needs to work correctly (device parameters, routing rules, the level_gain grid, addresses/encodings of confirmed broker params, etc.) are exempt from this rule and may be written in `docs/` and `src/`
- Device writes and Live sync (`src/core/control/`) are always enabled in the desktop build (consent to the risk of destructive writes is covered by the first-launch gate in `src/ui/consent.ts` and the installer license). Only the self-test round-trip diagnostics require an `--experimental` launch. Write only confirmed parameters (verified against broker dumps); never add speculative addresses to `params.ts`
- **When adding features or changing the UI, add E2E coverage to `e2e/*.spec.ts` and pass `pnpm test:e2e` locally before opening a PR** (the post-merge CI run is a regression net for already-merged code; it does not waive adding tests or verifying beforehand)
- Commits: **subject and body entirely in English** (Conventional Commits). **PR title/body entirely in English as well** (matching the repository's default language). The global CLAUDE.md rule about Japanese bodies does not apply to this project. Split commits by semantic unit. push/PR only when instructed

## Primary sources

- Block diagram (`MWEM-C0`): <https://usa.yamaha.com/files/download/other_assets/5/2927055/urx44v_44_22_block_diagram_en_c0.pdf>
- User guide (HTML): <https://manual.yamaha.com/audio/music_audio_production/urx44_urx22/ug/en-US/>
- Official control software: TOOLS for MGX / URX (future target for control analysis)
