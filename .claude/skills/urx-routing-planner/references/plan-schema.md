# URX Router plan JSON — schema

A plan is the public, versioned document URX Router saves and loads. It carries
only the user's routing/parameter choices — no control-protocol detail. The app
translates a plan into device commands itself, so authoring a plan never requires
any private protocol knowledge.

## Top-level shape

```json
{
  "format": "urx-router-plan",
  "version": 1,
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

- `format` — always the string `"urx-router-plan"`.
- `version` — always `1`.
- `modelId` — `"URX22"`, `"URX44"`, or `"URX44V"`.
- `sampleRate` — Hz, one of `44100, 48000, 88200, 96000, 176400, 192000`
  (default `48000`). Some features (FX2, insert FX, HDMI EQ) warn/disable at high
  rates — the app shows those notes; the plan still loads.

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
turn a `sendSwitch` `on`). You do not need to list a fixed wire just to keep it,
but listing it with params is how you set its level/pan/on.

### connection params (ConnParams)

- `level` — fader/send level in **dB**. Real range about `-96 … +10`; the app
  snaps to a fixed grid (…, -6, -5, -4, -3.2, -2, -1.2, -0.4, 0, 0.4, 1.2, 2, …).
  The off / -∞ notch is `-96.5`. Pick a nearby grid value; the app snaps anyway.
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
- `insertFx` — insert-effect selector enum (-1 = none). Selecting one is stable.
- `sdRecTrackCount` — even 2–16. **Read-only on the device** (the front panel
  sets it); the app reads it back but never writes it. It only gates how many
  record-track slots show.

**Raw-encoded — author with caution (see warnings):**
- `ssmcs` — the SSMCS channel-strip values are RAW broker integers on a non-public
  curve.
- `fxEffect.params` — FX bus per-effect parameters are raw (its `type`, `on`,
  `level` are stable, but the `params` map is raw).
- `insertFxParams` — insert-FX engine values are raw slot integers.

For these three, the numeric encoding is **not publicly verified**. Setting exact
values risks landing on the wrong device setting. Prefer to omit them (the device
keeps its own value) or set only the stable selector and have the user verify on
hardware. `scripts/plan_tool.py` emits a WARNING whenever a plan carries these.

## nodeNames / nodeColors / notes

- `nodeNames` — display/CH-SETTING name override per node id (string).
- `nodeColors` — hex accent color per node id (e.g. `"#4a78c0"`).
- `notes` — free-text annotation per node id; `noteCollapsed` lists ids shown
  minimized.
- `hidden` — node ids collapsed off the canvas.
- `positions` — `{ x, y }` per node id. Omit to let the app auto-arrange.
