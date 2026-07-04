---
name: urx-routing-planner
description: >-
  Use this skill ANY time the user mentions a YAMAHA URX22, URX44, or URX44V
  (also written urx22 / urx44 / urx44v) in the context of audio signal flow —
  routing, patching, mixes, sends, channels, buses, USB outputs, DAW tracks,
  headphones, monitor mix, streaming mix, FX/reverb sends, pre/post-fader, AUX,
  mic inputs, duckers, or microSD recording. This includes: feasibility questions
  ("can the URX… / is it possible to… / how do I…"), setup/design requests
  ("build me a routing plan", "I want to send X to Y"), troubleshooting a routing
  idea, and any vague "I just got a URX, how do I…" question. Works in any
  language (English, Japanese, etc.). The skill answers feasibility from a bundled
  per-model route table, and for settled requests emits a validated URX Router
  plan JSON plus a ?plan= deep link. Do NOT use for other Yamaha consoles (TF,
  QL), other interfaces (Focusrite, MOTU), Voicemeeter, DAW routing, modular
  synths, or generic audio-routing theory questions that don't mention a URX
  model.
---

# URX routing planner

Turn a plain-language routing request into a **valid URX Router plan** for the
URX22 / URX44 / URX44V. A plan is a small JSON document of node connections and
parameters. URX Router (the app) translates the plan into device commands itself,
so you never need any control-protocol detail — you only need to author legal
routing using public information, all of which is bundled here.

What you produce, in order of usefulness:
1. the **plan JSON**,
2. a **`?plan=` deep link** that opens the plan in the browser viewer to see the
   node graph, and
3. **steps to write it to the hardware** (desktop app).

## How to use it: feasibility first, then a plan

This skill serves two needs, often in the same conversation. Read the user's
intent and don't rush to a plan.

**Feasibility / capability questions.** When the user asks whether something is
possible ("can the URX44V do X?", "is there a way to route Y?", "would Z work?"),
you do **not** need to produce a plan. Answer from the model reference, which is
the authoritative list of what the hardware can route: if a matching legal route
exists it's possible — name it; if not, say it's not supported and offer the
nearest legal alternative. A grounded yes/no with the concrete route (or the
reason there isn't one) is the deliverable. Because the signal flow is
one-directional (input → channel → bus → output), the common "not possible" cases
are requests that fight it — channel → channel, output → channel, or two sources
into one single-input selector.

**One caveat the route table can't show — direct outs are pre-fader/pre-Ducker.**
A channel wired straight to a USB output (`out.usbmain_*` / `out.usbsub`) or a
microSD Rec track is tapped at the channel's **Rec Point**, which sits before the
fader and the Ducker. So a legal channel → USB/SD route carries the *dry* channel:
the fader, pan, and Ducker are **not** included. When the user wants a ducked or
faded signal on a USB output (a common streaming ask — "why isn't my ducking on the
USB feed?"), route the channel to a **STEREO or MIX bus** and patch that bus to the
USB output instead (a bus is post-Ducker). Channel → USB/SD direct is right only
when the dry channel is wanted (e.g. a clean per-channel feed to a DAW, or a dry
recording). Flag this whenever a request pairs a Ducker (or a specific fader level)
with a channel → USB direct out.

**Building a plan.** Emit the plan JSON only once the requirements are settled.
Vague requests usually leave gaps that change the routing — which model, which
physical input, mono vs stereo, where the signal should end up, pre/post, levels.
Don't guess past a gap that changes the wiring: ask one short, specific
clarifying question, converge, then build and validate. It's fine to assume a
sensible default (e.g. "post-fader, unity") and proceed — but state the
assumption rather than burying it.

A typical arc: vague idea → feasibility check (possible? on which model?) →
clarify the few details that matter → emit the validated plan + deep link. Move
to the plan as soon as the routing is unambiguous; don't over-interrogate.

## The model: nodes and wires

A URX is modeled as **nodes** (inputs, channels, buses, outputs) connected by
**wires**. A wire is `{ from, to, kind }` where `from`/`to` are `"nodeId:portId"`
refs (outputs use port `out`, inputs use `in`). Only routes the device actually
supports are legal — these are enumerated per model in the references.

Signal flows: **input → channel → bus → output**. A typical chain:
`in.micline_1_2:out → ch1:in` (source), then `ch1:out → bus.stereo:in` (send),
then `bus.stereo:out → out.main:in` (patch).

**A Ducker is its own node, not a channel parameter.** Each stereo channel's
Ducker is a separate node permanently attached to that channel — the label in
the model reference names the pairing (e.g. URX44V `out.ducker1` = "Ducker CH
5/6"; on the URX22 `out.ducker1` is CH 3/4). Two consequences:

- Enable and tune it in `nodeParams` under the **ducker's own id**:
  `"out.ducker1": { "duckerOn": true, "ducker": { … } }`. Putting `duckerOn` on
  the channel id (`"ch_5_6": { "duckerOn": true }`) loads without complaint but
  does nothing — the validator warns about it.
- The `key` wire into `out.duckerN:in` selects only the **trigger** (what makes
  it duck). What gets ducked is always the channel the ducker is attached to;
  a ducker cannot be re-aimed at another channel.

## Workflow

This is the plan-building path. For a pure feasibility question, you may stop
after step 2 with a grounded answer (see "feasibility first" above) and skip the
rest unless the user wants the plan built.

**1. Identify the model and settle the request.** URX22, URX44, or URX44V — the
node sets differ (URX44V adds STREAMING; URX22 is smaller). If the model or any
routing-changing detail is unclear, clarify before building (see "feasibility
first, then a plan"). Default to URX44V only if the user clearly has one.

**2. Read the model reference.** Open `references/model-<id>.md` (e.g.
`references/model-urx44v.md`). It lists every node id and every legal route
grouped by kind — this is also your feasibility oracle: a route that isn't listed
isn't possible on that model. **Author only routes that appear there**, copying
the exact `from`/`to` refs and the route's `kind`. Read `references/plan-schema.md`
for the JSON shape and parameter ranges.

**3. Map the request to wires.** For each thing the user wants routed, find the
matching legal route and add a connection. Set parameters the user asked for
(`level` in dB, `pan`, send `tap`, channel `on`, HA `gain`, HPF, etc.). Keep the
plan minimal — omit `positions` (the app auto-arranges) and any parameter you are
not deliberately setting. Remember:
   - **Single-input** destinations (`source`/`patch`/`record`/`key`) take one
     wire only.
   - **Fixed sends** (marked `(fixed)` in the reference: CH/FX → STEREO, CH →
     MIX/FX, MIX → STEREO) always exist. You don't list them to keep them; you
     list them with `params` to set level/pan or turn them `on`.
   - Use the right `kind` for the route — `send` into a bus, `source` into a
     channel, `patch` into an output, etc.

**4. Validate.** Write the plan to a file and run the bundled validator, which
mirrors the app's own check exactly:

```sh
python scripts/plan_tool.py validate plan.json
```

It prints `OK` (the app will load it without complaint) or a problem report. It
also prints `WARNING:` lines to stderr for wrong-`kind` wires, for Ducker params
placed on a non-ducker node (move them to the channel's `out.duckerN` id), and
for raw-encoded params (see step 6).

**5. Self-correct from the report.** If validation fails, the report lists each
illegal wire in the same format the app's viewer shows — so a report pasted back
by the user is directly actionable:

```
URX Router plan validation failed
model: URX44V
problems: 1

[noRule] ch1:out -> ch2:in
```

Reason codes:
   - `noRule` — that `from -> to` is not a legal route. Re-check the model
     reference; you likely used a wrong node id or an unsupported path.
   - `singleInput` — more than one wire into a single-input destination. Remove
     the extra(s); a channel/output/ducker/record slot takes one source.
   - `duplicate` — the same `from -> to` is listed twice. Drop the repeat.

Fix and re-validate until `OK`.

**6. Flag unstable parameters.** If the plan sets `ssmcs`, `fxEffect.params`, or
`insertFxParams` (raw broker-encoded values whose encoding is not publicly
verified), the validator warns. Surface this to the user: those exact values may
not land correctly on the device, so prefer omitting them (the unit keeps its own
value) or have the user verify on hardware. Routing and the human-readable params
(levels, pan, gain, HPF, mute, EQ in dB/Hz) are unaffected.

**7. Deliver.** Present the plan JSON, then the deep link:

```sh
python scripts/plan_tool.py url plan.json
```

and the apply options. See `references/device-apply.md` for the full hardware
write / Live sync procedure. Lead with the link (instant visual check, no
hardware) and note that device writes are desktop-only.

## Output format

**Feasibility answer** (when the user only asked whether something is possible):

1. A clear **Possible / Not possible / Partly possible** verdict for each thing
   asked.
2. The **evidence**: the concrete legal route(s) that make it possible (e.g.
   "`bus.mix1:out -> out.usbmain_a:in`, a patch"), or, when not possible, why
   (which rule is missing) and the **nearest legal alternative**.
3. An offer to build the plan if they want it.

**Plan delivery** (when the request is settled), in this order:

1. A short plain-language summary of the routing you built (what feeds what).
2. The **plan JSON** in a code block.
3. The **`?plan=` deep link**.
4. **Apply options**: open the link to visualize; or open the JSON in the desktop
   URX Router and use Device → Write to device / Live sync (point to
   `references/device-apply.md`).
5. Any **stability warnings** from step 6.

## Output language

Write your reply to the user in the **user's language** — if they ask in
Japanese, answer in Japanese (summaries, feasibility verdicts, apply steps, and
warnings). The bundled references are in English, but that is only your source
material; translate the explanation for the user.

Keep these **verbatim**, regardless of language, because they are identifiers the
app and tooling parse, not prose:

- node ids and `from`/`to` refs (`ch1`, `bus.mix1:out`, `out.usbmain_a:in`),
- the plan JSON — all keys and string values (`"kind": "send"`, `"modelId"`),
  except `nodeNames`, which is a user-facing label and may be in any language
  (e.g. `"ch1": "ボーカル"`) and round-trips fine as UTF-8,
- the `?plan=` deep link,
- the validator's reason codes (`noRule`, `singleInput`, `duplicate`).

The desktop app's menu labels follow whatever UI language the user has selected,
so name a menu in the user's language and you may add the English label in
parentheses if it helps them find it.

## Worked examples

### Mic to the main mix with reverb

Request: "On my URX44V, take mic 1 into channel 1, name it Lead Vox, high-pass
it, send it to the main mix at -3 dB, and also feed FX1 for reverb."

```json
{
  "format": "urx-router-plan",
  "version": 1,
  "modelId": "URX44V",
  "connections": [
    { "from": "in.micline_1_2:out", "to": "ch1:in", "kind": "source" },
    { "from": "ch1:out", "to": "bus.stereo:in", "kind": "send", "params": { "level": -3 } },
    { "from": "ch1:out", "to": "bus.fx1:in", "kind": "send", "params": { "level": -6 } }
  ],
  "nodeParams": {
    "ch1": { "on": true, "hpf": true, "gain": 24 }
  },
  "nodeNames": { "ch1": "Lead Vox" }
}
```

`ch1 → bus.stereo` and `ch1 → bus.fx1` are fixed sends; listing them with
`params` sets their levels. Validate, then emit the link.

### Duck game audio under a mic (Ducker on)

Request: "URX44V: my mic is MIC/LINE 1 into channel 1, and my PC's game sound
comes back on USB MAIN A into channel 5/6. Duck the game sound while I talk,
and give my streaming app the ducked mix on USB MAIN A."

```json
{
  "format": "urx-router-plan",
  "version": 1,
  "modelId": "URX44V",
  "connections": [
    { "from": "in.micline_1_2:out", "to": "ch1:in", "kind": "source" },
    { "from": "in.usbmain_a:out", "to": "ch_5_6:in", "kind": "source" },
    { "from": "ch1:out", "to": "out.ducker1:in", "kind": "key" },
    { "from": "ch1:out", "to": "bus.mix1:in", "kind": "send", "params": { "level": 0 } },
    { "from": "ch_5_6:out", "to": "bus.mix1:in", "kind": "send", "params": { "level": 0 } },
    { "from": "bus.mix1:out", "to": "out.usbmain_a:in", "kind": "patch" }
  ],
  "nodeParams": {
    "out.ducker1": { "duckerOn": true, "ducker": { "threshold": -40, "range": -24 } }
  },
  "nodeNames": { "ch1": "Mic", "ch_5_6": "Game" }
}
```

Everything Ducker lives on `out.ducker1`, the Ducker node attached to CH 5/6:
the mic keys it via the `key` wire, and `duckerOn` / `ducker` sit under
`"out.ducker1"` in `nodeParams` (a `duckerOn` under `"ch_5_6"` would do
nothing). The ducked game audio reaches USB through `bus.mix1`, which is
post-Ducker; wiring `ch_5_6:out → out.usbmain_a:in` directly would tap
pre-fader/pre-Ducker and defeat the ducking (see the caveat above).

## Boundaries

- **Routing + parameters only.** This skill never touches the control protocol;
  the app owns that. Everything here is from the public device model.
- **Self-contained.** All model data is in `scripts/models.json` and
  `references/model-*.md`; the skill works without the URX Router repo.
- **Don't invent ids or routes.** If a request needs a path not in the model
  reference, tell the user it isn't supported on that model rather than inventing
  a wire (it would fail validation anyway).

## Reference files

- `references/plan-schema.md` — plan JSON shape, all params, value ranges.
- `references/model-urx22.md` / `model-urx44.md` / `model-urx44v.md` — node ids
  and every legal route for that model.
- `references/device-apply.md` — visualize via deep link; write to hardware.
- `scripts/plan_tool.py` — validate a plan / emit a `?plan=` URL.
- `scripts/models.json` — machine-readable model data used by the script.
