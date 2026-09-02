# URX Router plan JSON — schema

A plan is the public, versioned document URX Router saves and loads. It carries
only the user's routing/parameter choices — no control-protocol detail. The app
translates a plan into device commands itself, so authoring a plan never requires
any private protocol knowledge.

## Top-level shape

```json
{
  "format": "urx-router-plan",
  "version": 2,
  "modelId": "URX44V",
  "sampleRate": 48000,
  "connections": [ ... ],
  "nodeParams": { "ch1": { ... } },
  "nodeNames": { "ch1": "Lead Vox" },
  "nodeColors": { "ch1": "#4a78c0" },
  "positions": { "ch1": { "x": 120, "y": 80 } },
  "hidden": [],
  "notes": {},
  "noteCollapsed": []
}
```

Only `format`, `version`, `modelId`, and `connections` are required. Everything
else defaults when omitted (the loader fills sensible values), so a minimal plan
is just those four keys plus the wires you want. Prefer minimal plans: omit
`positions` (the app auto-arranges) and any param you are not deliberately
setting.

- `format` — always the string `"urx-router-plan"`. Anything else and the app
  refuses the document before it looks at the routing.
- `version` — always `2` for a plan written today. A document tagged newer than
  the app's version is refused; an older one is migrated forward on load, and an
  absent one reads as current.
- `modelId` — `"URX22"`, `"URX44"`, or `"URX44V"`. Any other string is refused.
- `sampleRate` — Hz, one of `44100, 48000, 88200, 96000, 176400, 192000`
  (default `48000`). Some features (insert FX, FX2, stereo-channel EQ) warn/disable
  above 96 kHz — the app shows those notes; the plan still loads.
- `scope` — **never author it**; it appears only on a plan the user saved
  scene-scoped (Preferences → *Plan files* → *Save scope*, which also applies to
  the share URL and the JSON download). Such a document carries `"scope": "scene"`
  and deliberately omits `sampleRate` plus everything the URX keeps outside a
  scene: the output / USB / microSD patches (`patch` and `record` wires), the
  monitor and streaming source selects, the oscillator bus assigns, the monitor /
  oscillator node params, the streaming delay and the microSD track count. So a
  user-supplied scene plan is not missing its output patches — they are out of
  scope. Opening one keeps the current plan's values for all of that (the scene-
  recall semantic), and only when the model matches. Emit full plans yourself.

## connections

Each wire is one object:

```json
{ "from": "ch1:out", "to": "bus.mix1:in", "kind": "send", "params": { "level": -6, "pan": 0 } }
```

- `from` / `to` — `"nodeId:portId"` refs. Use the exact ids from the model
  reference (`references/model-<id>.md`). Outputs use port `out`, inputs `in`.
- `kind` — must equal the kind the model declares for that route. The model
  reference groups every legal route by kind; copy it from there. Kinds:
  - `source` — input → channel select (single-input).
  - `patch` — bus → physical/USB output select (single-input).
  - `record` — channel/bus → microSD record-track select (single-input).
  - `key` — channel/bus → ducker side-chain select (single-input).
  - `send` — channel/FX → bus summing send (many allowed; carries level/pan/tap).
  - `sendSwitch` — ON/OFF assign into a bus, no level/pan (e.g. MIX → STEREO
    "TO ST", oscillator assigns).
- `params` (optional) — per-wire values, see below.

**Single-input rule:** a `source`/`patch`/`record`/`key` destination accepts at
most one incoming wire. Two wires into the same `:in` of that kind is the
`singleInput` validation error.

**Fixed sends:** the model reference marks some `send`/`sendSwitch` routes
`(fixed)` — the channel/FX main paths into STEREO, the CH→MIX/FX sends, and
MIX→STEREO. They are always present (the app seeds them into every plan) and
cannot be removed; you only set their `params` (e.g. raise a send `level`, or
turn a `sendSwitch` `on`). A fixed wire you leave out keeps the app's seed: unity
for a channel's main path into STEREO, `-96.5` (off / -∞) for every other fixed
send, and off for MIX→STEREO. **Listing one is not the same as leaving it out** —
a listed wire with no `level` writes 0 dB (unity), so list a fixed send only with
the params you mean.

### connection params (ConnParams)

- `level` — fader/send level in **dB**. Real range about `-96 … +10`, on a fixed
  grid (…, -6, -5, -4, -3.2, -2, -1.2, -0.4, 0, 0.4, 1.2, 2, …). The off / -∞ notch
  is `-96.5`. **Prefer a real grid value — a loaded plan is NOT snapped.** The app
  snaps what its own controls author, but a level arriving in a plan document only
  has to be a finite number, so an off-grid `-15.0` is kept as written. It is
  written to the unit exactly (`-15.0` dB) and the unit keeps it — measured. What
  diverges is the SCREEN: the fader has no detent there, so it shows the nearest
  one, and the first touch of that control snaps the value onto the grid. Emit a
  grid value and the plan, the display and the unit all say the same thing.
- `pan` — `-63` (hard left) … `0` (center) … `+63` (hard right). Sends default to
  center.
- `tap` — `"pre"` or `"post"` (default post). Only MIX/FX sends carry a tap. Note:
  CH→FX taps are read-only on the device (the app shows the field but cannot write
  PRE there); CH→MIX and FX→MIX taps are writable.
- `on` — `true`/`false` for fixed sends and `sendSwitch` assigns (e.g. enable
  MIX→STEREO). Absent = on, except MIX→STEREO which ships off.
- `oscL` / `oscR` — oscillator assign: which of the destination's L/R channels are
  on. Stereo buses use both; mono FX buses use `oscL`.

## nodeParams

Per-node settings, keyed by node id. All fields optional; an absent field keeps
the device default. The full set:

**Stable, human-readable (author these freely):**
- `on` — channel / STEREO master / FX channel / MONITOR on. `false` = muted.
- `hpf` (bool), `hpfFreq` (Hz, 40–120, default 80).
- `gain` — head-amp input gain in dB (-8 … +70), analog mic channels.
- `phantom`, `phase`, `phaseL`, `phaseR`, `clipSafe`, `hiZ` (bool).
- `level` — a node-level fader in dB (e.g. monitor level).
- `pan` — output-bus master balance (STEREO / MIX), `-63` … `0` … `+63`. Absent =
  center. Distinct from a send's `pan`, which is a connection param.
- `eqOn` (bool); `eqBands` — array of up to 4 `{ on, type, freq, q, gain }`
  (freq Hz, q 0.50–16.00, gain ±18 dB; `type` is the filter-type enum on the
  LOW/HIGH bands only).
- `eqOneKnob` — `{ on, type, level }` (type 0 Intensity / 1 Vocal / 2 Loudness;
  level 0–100). When on, the device drives the 4 bands, so do not also set
  `eqBands`.
- `gate` — `{ threshold, range (dB), attack, hold, decay (ms) }`; `gateOn` (bool).
- `comp` — `{ threshold, ratio, knee (0/1/2), gain, attack, release,
  autoMakeup, oneKnob, oneKnobLevel }`; `compOn` (bool).
- `ducker` — `{ threshold, range (dB), attack, decay (ms) }`; `duckerOn` (bool).
  Set these under the **ducker node's id** (`out.ducker1` …, kind `ducker` in
  the model reference), never under the channel it ducks — a channel id
  carrying `duckerOn` loads but has no effect. The `key` wire only picks the
  trigger; the ducked signal is always the ducker's own channel.
- `compEqType` — 0 COMP→EQ, 1 SSMCS.
- `recPoint` — channel record/direct-out tap (enum; absent = PRE FADER).
- `stereoLink` — stereo-link a MONO IN pair (set on the odd/primary channel).
- `panBal` — 0 PAN / 1 BAL for a linked pair.
- `busType` — MIX 1/2: 0 VARI / 1 FIXED. `panLink` (bool, VARI only).
- `osc` — `{ on, level (-96…0 dB), mode (0 Sine/1 Pink/2 Burst), freq (Hz),
  width, interval (s) }`.
- `cueInterrupt`, `mono` (bool, monitor buses); `phonesLevel` (0.0–10.0).
- `delay` — STREAMING bus: `{ on, time (ms, 1–1000), frameRate (enum 0–7) }`.
- `insertFx` — insert-effect selector enum (-1 = none). **Writing a selector is
  destructive and cannot be undone:** the device refills that effect engine's
  whole parameter array with the new type's factory defaults, and selecting the
  previous type back only refills it with *that* type's defaults — whatever the
  user had set is gone. The engine is shared working area, so it can also discard
  settings belonging to another channel using it. Author `insertFx` only when the
  user asked to change the insert effect; omit it to leave the unit's effect
  alone. `fxEffect.type` below carries the same rule.
  **One slot per effect family, device-wide** (user guide Effect list, "Number of
  simultaneous uses: 1 slot"): the four guitar amps share one slot across the MONO
  IN channels, Pitch Fix another, the two companders a third, and the Multi-Band
  Compressor and companders share one slot across all MIX / STEREO outputs. Two
  nodes selecting into the same slot is a plan the unit cannot run — the app warns
  on load and `plan_tool.py` warns too. Stereo input channels have no insert FX at
  all, so an `insertFx` on one is ignored.
- `insertFxOn` — insert-effect ON/OFF (bypass), `true`/`false`. The device
  re-engages it whenever an effect is (re)selected; it only applies (and is only
  written) while an effect is selected.
- `sdRecTrackCount` — even 2–16. **Never written to the device**: a write does
  reach the unit, but the broker refuses every value above two tracks, so the app
  reads it back and emits nothing. Set it on the unit's front panel. In a plan it
  only gates how many record-track slots show.

**Raw-encoded — author with caution (see warnings):**
- `ssmcs` — the SSMCS channel-strip values are RAW broker integers on a non-public
  curve.
- `fxEffect` — the FX bus effect. Its `type` (the EFFECT TYPE selector), `on` and
  `level` (0–100) are plain values, but the `params` map holds raw per-effect
  values keyed by the device's array slot.
- `insertFxParams` — insert-FX engine values are raw slot integers. Two switches in
  here decide whether OTHER slots are written at all, so a plan carrying one of them
  is asking for more than the switch. The Multi-Band Compressor's 1-Knob On (slot 6):
  while it is on, the app stops writing every slot of the effect except Out Gain —
  Threshold, Ratio, Gain and Attack in all three bands (8-11, 13-16, 18-21), the
  Release (25) and both crossovers (23, 24) — because a change to 1-Knob Level
  (slot 7) recomputes the first nine and pins the other six back to fixed values.
  Pitch Fix's MIDI Control (slots 34 and 35, two bits for three
  modes): while it is anything but Off, the app stops writing the Scale (slot 16) and
  the twelve note-mask slots (22–33), because switching the mode on clears that mask
  on the unit. In both cases the skipped slots are dropped from the write silently
  and the app's tuning screen locks the same rows.

  Either switch also makes the app READ the node back after writing it, because the
  unit recomputes the skipped slots when the switch moves. So a plan carrying one of
  them does not keep whatever it said about those slots: after it is applied, they
  hold what the unit derived. Authoring band values beside a 1-Knob On is doubly
  pointless — they are not written, and the plan's copy of them is replaced.

These three are the device's own internal units — what URX Router captures when it
reads a unit, not a scale you can author a value on. A hand-written number lands
wherever that raw value happens to sit on the device's curve, so have the user dial
the effect in on the device and fetch it back rather than authoring one.

**For `ssmcs` and `insertFxParams`, omitting a key keeps the unit's value**, because
only the keys a plan carries are written. **For `fxEffect` it does not** — see the
paragraph below — so the two must not be followed as one instruction.
`scripts/plan_tool.py` emits a WARNING whenever a plan carries any of the three, and
the FX one carries its own advice for that reason.

**`fxEffect` is the exception to "omit the raws and the unit keeps its values", and
it is all-or-nothing.** Omitting the whole section writes nothing for that channel —
that silence is how a plan leaves an FX channel as the unit has it. Including the
section in ANY form authors the whole channel: the EFFECT TYPE selector is emitted
whether or not the section names a type (an absent one resolves to the channel's
factory type), and every parameter slot goes with it at that type's defaults. So
`{ "level": 80 }` writes the selector and resets the array, and omitting only
`fxEffect.params` does not preserve anything. There is no partial FX write, because
a type write refills the array regardless. `plan_tool.py` warns on the section's
presence for that reason, not only on a `type` written into it.

## nodeNames / nodeColors / notes

- `nodeNames` — display/CH-SETTING name override per node id (string).
- `nodeColors` — hex accent color per node id (e.g. `"#4a78c0"`).
- `notes` — free-text annotation per node id; `noteCollapsed` lists ids shown
  minimized.
- `hidden` — node ids collapsed off the canvas.
- `positions` — `{ x, y }` per node id. Omit to let the app auto-arrange.

All six are validated element by element on load and a non-conforming entry is
DROPPED, not refused: the value of a `nodeNames` / `nodeColors` / `notes` entry
must be a string, every element of `hidden` / `noteCollapsed` must be a node id
string, and a `positions` entry needs both `x` and `y` as finite numbers. A
collection that is not the right container at all (an array where an object is
expected, say) falls back to empty and loses every entry. Nothing is reported to
the user when this happens, so `plan_tool.py validate` warns about each one.

**One entry is rewritten rather than dropped by the deserializer**, and the loader
rewrites a second class after it. Everything under a node's `fxEffect` that the
write path cannot send is repaired before the document opens, and the counts are
reported on the status line — one sentence for the values moved, another for the
values removed:

| What the document holds | What the load does |
| --- | --- |
| a finite number outside its parameter's own window | bounded to the nearest value the app can send |
| a leaf that is not a finite number (a boolean, an object) | DROPPED, so the selected type's own default applies |
| `type` the channel's menu does not offer | DROPPED — a menu has no nearest member, and the app resolves an absent type to the channel's default |
| `params` that is not an object | DROPPED whole; every parameter goes with it |
| `fxEffect` that is not an object | DROPPED whole; the channel keeps whatever the unit holds |

The last two matter because the sanitiser keeps a boolean and a non-empty object
under any key, so an unreadable effect object survives the load and every reader
below treats it as absent.

An **empty** `fxEffect` (`{}`) is removed by the sanitiser before any of that, and
warned about for the same reason the rows above are: the document does not survive
as written. It is not a harmless difference — a document keeping it would author the
whole channel at the factory defaults, while the loaded plan leaves the channel
alone. If you meant the defaults, write them; if you meant to leave the unit's FX
as it is, omit the section.

**`plan_tool.py validate` warns about every row that needs no effect catalogue** —
the non-numeric leaf, the non-object `params`, the non-object `fxEffect` — and
CANNOT see the two that do: a finite number outside its window, and a `type` no
channel offers. Those windows and menus live in the app's effect catalogue, and the
data bundled with this skill carries routing only. Settling it means exporting them
alongside `models.json`; until then a plan this tool calls clean can still have an
FX value the app will bound on load. `scripts/plan-tool.test.mjs` in the repository
holds both halves — the agreement and the two blind spots — by running this tool and
the app's own loader over the same documents.

A `nodeNames` value longer than
**8 characters** is CUT to that length — the unit's own CH SETTING name screen
takes no more (`ch 1xxxx`), and a longer name also draws a node label across its
neighbours on the canvas. Counted in characters, not bytes, so a Japanese name
also gets 8. Nothing in the protocol enforces this (the broker stores a
20-character name and reads it back unchanged), and nothing is reported here
either, so `plan_tool.py validate` warns about each name it would shorten; emit a
name within the bound rather than relying on the cut.

The same rewrite drops **trailing** whitespace, after the cut rather than before
it (so a name cut onto a space does not keep one). A leading space is kept — the
unit's own stereo pair labels are right-aligned, so `" 5/ 6"` is the real name.
This one is worth emitting correctly rather than leaving to the load: the unit
stores a trailing space instead of padding it away, while every path that reads a
name back trims one off, so a plan that keeps one never matches the device and the
name is re-sent on every sync.
