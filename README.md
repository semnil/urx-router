# URX Router

A **routing planning tool** for the YAMAHA URX22 / URX44 / URX44V USB audio interfaces.

Based on the official block diagram, it visualizes input/output channels, mixer buses, and
output patches as boxes and wires, and constrains the GUI so that **only physically routable
paths** can be wired. Plans are saved/loaded as JSON, and the diagram can be exported as an image.

> 日本語版は [README.ja.md](README.ja.md) を参照してください.

## Live demo

Runs entirely in your browser — no install required: **<https://urx-router.semnil.com>**
(file save/load and image export are disabled in the demo build).

![URX Router showing a URX44V routing plan in the dark studio-rack theme](docs/assets/screenshot-en.png)

## Tech stack

- **Tauri 2** (desktop shell / Windows 11 and Apple silicon macOS)
- **TypeScript + Vite** (frontend, zero runtime third-party dependencies)
- Rendering is plain SVG (no node-graph library)
- English-first UI with Japanese localization, switchable at runtime
- Studio-rack aesthetic with dark and light themes (follows your OS color scheme, dark by default)
  ([docs/en/architecture.md](docs/en/architecture.md#display-themes))

## Development

```sh
pnpm install
pnpm dev            # browser at http://localhost:5173 (Rust not required)
pnpm tauri dev      # launch as a desktop app (Rust toolchain required)
```

Because the planning UI is pure frontend, you can verify behavior in a browser with `pnpm dev`
even without Rust installed. Desktop builds (`pnpm tauri dev` / `pnpm tauri build`) require
[Rust](https://rustup.rs/).

## Device control (experimental, URX44V only)

Desktop builds can read the connected interface's current mixer settings into the plan
(**Device → Fetch from device**), with the Device Center software running. The parameter
mapping is verified on hardware **only for URX44V**; **URX44** is assumed identical and
**URX22** is inferred from it — neither is verified on hardware yet.

## Documentation

English documentation lives under [docs/en/](docs/en/); the Japanese translation is under
[docs/ja/](docs/ja/).

- [docs/en/architecture.md](docs/en/architecture.md) — application structure and design decisions
- [docs/en/device-model.md](docs/en/device-model.md) — the device routing model and connection constraints

## License

[MIT](LICENSE) © semnil

Distributed desktop builds bundle the Tauri runtime and other open-source
components; their license notices are included in the build (see
[docs/en/architecture.md](docs/en/architecture.md#third-party-licenses)).

## Trademark notice

YAMAHA, URX22, URX44, and URX44V are trademarks of Yamaha Corporation. This is an
unofficial, independent tool and is not affiliated with, sponsored by, or endorsed
by Yamaha.
