# Applying a plan to the hardware

URX Router does the protocol work; the plan is the only thing that crosses the
boundary. There are two surfaces: the **browser demo** (a viewer — visualize the
routing, no device write) and the **desktop app** (full file IO + device write /
Live sync). Present both to the user and let them choose.

## 1. Visualize the routing (browser demo, no hardware)

Encode the plan into a deep link and open it:

```sh
python scripts/plan_tool.py url plan.json
# -> https://urx-router.semnil.com/?plan=z<base64url of raw-deflated JSON>
```

Opening that URL loads the plan straight into the viewer and draws the node
graph. If the plan has routing problems the viewer shows a copyable report
instead of loading (see the self-correction loop in SKILL.md).

Note: the public demo serves the compressed `z` links this tool emits. What they
need is a current browser — `DecompressionStream("deflate-raw")`, i.e. Safari
16.4+ or any current Chrome / Edge / Firefox — and a desktop build from v1.2.0 on
(older ones report a `z` link as malformed). For a local checkout, `pnpm dev`
serves it at `http://localhost:5173/?plan=…`. Pass `--base` to point at a
different host.

## 2. Write to the device (desktop app)

The desktop app reflects a plan to a connected URX. Steps for the user:

1. **Prerequisites:** Yamaha's Device Center (broker) is running and the URX is
   connected over USB. On first launch the app shows a one-time consent gate
   (device writes overwrite the mixer; the protocol was reverse-engineered) —
   accept it to continue.
2. **Open the plan:** save the skill's plan JSON to a file, then in the desktop
   app use **File → Open** and pick it. The graph and CONSOLE views populate.
3. **Reflect to hardware**, via the **Device** menu:
   - **Write to device** — a one-shot push. It reports how many settings differ
     and overwrites the device's current settings with the plan. It asks first
     when the unit's firmware is not the version the app was tested with, and when
     the unit runs a different sample rate than the plan (re-clocking it interrupts
     audio, so the user can also write at the device's own rate instead).
   - **Live sync** — a continuous toggle: further edits reflect to the device as
     you make them (and the board follows the device's own knob/LCD moves).
4. **Fetch from device** goes the other way — it reads the device's current state
   back into a plan, useful as a starting point to edit.
5. **Scope** (Preferences → *Device read / write* → *Scope*) governs Fetch, Write
   and Live sync alike. The default *All supported* covers the whole plan;
   *Scene only* leaves the URX's device-wide settings untouched — monitor, phones,
   output patches, streaming, oscillator and the sample rate. So a plan whose point
   is an output patch (a bus to USB MAIN, say) does not reach the unit until the
   scope is *All supported*.

Only parameters confirmed against the device are written. The raw-encoded advanced
effects (SSMCS / FX / insert FX, see plan-schema.md) are written in the device's
own internal units, and writing an effect **selector** resets that effect's
parameters on the unit — have the user check those on the device.

The browser demo never writes to hardware — device control is desktop-only.
