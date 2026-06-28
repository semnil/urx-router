# Applying a plan to the hardware

URX Router does the protocol work; the plan is the only thing that crosses the
boundary. There are two surfaces: the **browser demo** (a viewer — visualize the
routing, no device write) and the **desktop app** (full file IO + device write /
Live sync). Present both to the user and let them choose.

## 1. Visualize the routing (browser demo, no hardware)

Encode the plan into a deep link and open it:

```sh
python scripts/plan_tool.py url plan.json
# -> https://urx-router.semnil.com/?plan=<base64url>
```

Opening that URL loads the plan straight into the viewer and draws the node
graph. If the plan has routing problems the viewer shows a copyable report
instead of loading (see the self-correction loop in SKILL.md).

Note: the `?plan=` deep link requires a URX Router build that supports it (the
release that added URL plan loading onward). The public demo reflects it after
that release ships; for a local checkout, `pnpm dev` serves it at
`http://localhost:5173/?plan=…`. Pass `--base` to point at a different host.

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
     and overwrites the device's current settings with the plan.
   - **Live sync** — a continuous toggle: further edits reflect to the device as
     you make them (and the board follows the device's own knob/LCD moves).
4. **Fetch from device** goes the other way — it reads the device's current state
   back into a plan, useful as a starting point to edit.

Only parameters confirmed against the device are written; the raw-encoded
advanced effects (SSMCS / FX / insert FX, see plan-schema.md) may not match, so
have the user verify those on the unit.

The browser demo never writes to hardware — device control is desktop-only.
