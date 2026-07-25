# Security Policy

> 日本語版は [SECURITY.ja.md](SECURITY.ja.md) を参照してください.

URX Router is a desktop application and a browser demo. There is no server component, no
account system, and no telemetry: the only network access a desktop build makes on its own is
the update check against GitHub releases. Preferences and the recent-plans list live in the
webview's `localStorage`, and plans are files you choose.

## Supported versions

Only the latest release is supported. Desktop builds auto-update through the Tauri updater,
and fixes ship as a new release rather than as a backport.

## Reporting a vulnerability

Report it privately through GitHub —
**[Security → Report a vulnerability](https://github.com/semnil/urx-router/security/advisories/new)**.
Please do not open a public issue for a security problem.

Helpful details:

- Which build (desktop Windows, desktop macOS, or the browser demo) and which version
  (shown at the bottom of the Preferences modal, behind the toolbar gear)
- What an attacker gains, and the steps to reproduce it
- Any plan JSON, `?plan=` link, or file needed to reproduce — attach it rather than pasting
  device values into the report

This is a single-maintainer project, so handling is best effort: expect a first reply within
about a week. You will be credited in the advisory unless you prefer otherwise.

## In scope

- Code execution, or file reads/writes outside the paths a user picked, reachable from a
  crafted plan JSON, a `?plan=` deep link, a dropped file, or a settings-file import
- Misuse of the Tauri IPC boundary from web content
- Injection through content the app renders as DOM — the third-party licenses modal, the
  plan load-failure report, or names read back from a device
- The update path accepting an artifact that is not this project's signed build
- Secrets or signing material exposed in the repository, in CI, or in a release artifact
- The browser demo at <https://urx-router.semnil.com>

## Out of scope

- **Destructive device writes.** Writing a plan overwrites the connected unit's current mixer
  settings, and Live sync mirrors every edit as you make it. That is what the tool is for, not
  a flaw — see the [disclaimer](README.md#disclaimer), the first-launch consent gate, and the
  license shown by the installer.
- Driving hardware over a control protocol determined by independent analysis, as such
- Diagnostics gated behind the `--experimental` launch flag
- Vulnerabilities in the device firmware, in the units themselves, or in Yamaha's software —
  report those to Yamaha
- Findings that require an attacker who already executes code as your user: the app trusts the
  local machine, including `localStorage`, the plan files you open, and the MIDI ports you select
- Resource exhaustion from an intentionally oversized plan file
- Scanner output with no demonstrated impact
