#!/usr/bin/env python3
"""Validate a URX Router plan and turn it into a shareable ?plan= URL.

This mirrors the app exactly so that "the script says OK" implies "URX Router
loads the plan as authored":

- the document gate matches core/plan.ts `deserializeDocument` plus the model
  check the app runs right after it: a file refused there never reaches the
  routing check (notPlanFile / planVersionUnsupported / unknownModel), and a
  malformed wire, node-param value, name / colour / note, hidden-or-collapsed id
  or position is silently DROPPED rather than refused, so those are reported as
  warnings — the plan loads, just not as written,
- validation matches core/routing.ts `validatePlan` (noRule / singleInput /
  duplicate), and
- the URL encoding matches core/plan.ts `encodePlanParam` ("z" + URL-safe base64
  of the raw-deflated UTF-8 JSON, padding stripped), read back by `?plan=` on
  startup. Compression keeps full plans inside GitHub Pages' ~8 KB URL limit;
  the app also still decodes the legacy uncompressed base64 form.

Routing ground truth lives in scripts/models.json (extracted from the device
model). Only routes listed there are legal.

Usage:
  python plan_tool.py validate <plan.json>
  python plan_tool.py url <plan.json> [--base https://urx-router.semnil.com/]

Exit code is non-zero when the plan has hard validation problems, so the skill
can branch on it. Warnings (a dropped wire or value, a misplaced Ducker param,
raw-encoded params, a destructive effect selector, a contended insert-FX slot)
are advisory and never fail the plan — but they all mean something worth telling
the user.
"""

import argparse
import base64
import json
import math
import os
import re
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_PATH = os.path.join(HERE, "models.json")
DEFAULT_BASE = "https://urx-router.semnil.com/"
PLAN_FORMAT = "urx-router-plan"
PLAN_VERSION = 3

SINGLE_INPUT_KINDS = {"source", "patch", "key", "record"}
KNOWN_KINDS = {"source", "patch", "send", "sendSwitch", "key", "record"}


def load_models():
    with open(MODELS_PATH, encoding="utf-8") as fh:
        return json.load(fh)


def rule_index(model):
    """Map (from, to) -> rule kind, and the set of single-input destinations."""
    by_pair = {}
    for frm, to, kind, _fixed in model["rules"]:
        by_pair[(frm, to)] = kind
    return by_pair


def is_number(v):
    """A finite JSON number. Booleans are JSON numbers to Python, not to the app."""
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def wire_dropped(conn):
    """Why the app's loader would drop this wire, or None when it keeps it. It
    trusts only string from/to, a known kind and well-typed params; a dropped wire
    loads as if it had never been authored, so the routing silently misses it."""
    if not isinstance(conn.get("from"), str) or not isinstance(conn.get("to"), str):
        return "from / to must be strings"
    if conn.get("kind") not in KNOWN_KINDS:
        return f"unknown kind {conn.get('kind')!r}"
    params = conn.get("params")
    if params is None:
        return None
    if not isinstance(params, dict):
        return "params must be an object"
    for key in ("level", "pan"):
        if key in params and not is_number(params[key]):
            return f"{key} must be a number"
    if "tap" in params and params["tap"] not in ("pre", "post"):
        return 'tap must be "pre" or "post"'
    for key in ("on", "oscL", "oscR"):
        if key in params and not isinstance(params[key], bool):
            return f"{key} must be true or false"
    return None


def validate(plan, models):
    """Return (problems, warnings). problems are hard (block load); warnings are
    advisory. problems entries are (reason, from, to)."""
    problems = []
    warnings = []

    if not isinstance(plan, dict):
        return [("notPlanFile", "the document is not a JSON object", "")], warnings

    # Document gate: the app refuses these before it ever looks at the routing.
    if plan.get("format") != PLAN_FORMAT:
        problems.append(("notPlanFile", f"format {plan.get('format')!r} (expected {PLAN_FORMAT!r})", ""))
    version = plan.get("version")
    if is_number(version) and version > PLAN_VERSION:
        problems.append(("planVersionUnsupported", f"version {version} (this build reads {PLAN_VERSION})", ""))

    model_id = plan.get("modelId")
    if model_id not in models:
        problems.append(("unknownModel", str(model_id), ""))
        return problems, warnings
    model = models[model_id]
    by_pair = rule_index(model)
    nodes = model["nodes"]

    conns = plan.get("connections")
    if conns is not None and not isinstance(conns, list):
        warnings.append("connections is not an array — the app loads the plan with no wires at all")
    # The loader filters the wire list before the routing check runs, so a wire it
    # drops is warned about and then left out of the checks below, exactly as the
    # app sees it (a dropped wire is missing routing, not illegal routing).
    kept = []
    for c in conns if isinstance(conns, list) else []:
        dropped = wire_dropped(c) if isinstance(c, dict) else "a connections entry must be an object"
        if dropped is None:
            kept.append(c)
        else:
            label = f"{c.get('from')} -> {c.get('to')}" if isinstance(c, dict) else repr(c)
            warnings.append(f"connection {label}: the app drops this wire on load — {dropped}")

    incoming = {}
    for c in kept:
        incoming[c["to"]] = incoming.get(c["to"], 0) + 1

    seen = set()
    for c in kept:
        frm, to, kind = c["from"], c["to"], c["kind"]
        rule_kind = by_pair.get((frm, to))
        if rule_kind is None:
            problems.append(("noRule", frm, to))
        elif rule_kind in SINGLE_INPUT_KINDS and incoming.get(to, 0) > 1:
            problems.append(("singleInput", frm, to))
        elif kind != rule_kind:
            # Same from/to is legal, but the wrong kind misbehaves in the app even
            # though it would pass the app's structural check. Surface it so the
            # skill can correct the kind.
            warnings.append(f"connection {frm} -> {to}: kind {kind!r} should be {rule_kind!r}")
        key = (frm, to)
        if key in seen:
            problems.append(("duplicate", frm, to))
        seen.add(key)

    warnings.extend(collection_warnings(plan))
    warnings.extend(node_param_warnings(plan, nodes, model.get("channelPairs"), model.get("fxChannels")))
    problems.extend(insert_fx_pair_problems(plan, model.get("channelPairs"), model.get("insertFxParamSpace") or {}))

    return problems, warnings


def is_str(v):
    return isinstance(v, str)


def is_pos(p):
    return isinstance(p, dict) and is_number(p.get("x")) and is_number(p.get("y"))


# The collections the loader validates element by element. An element of the wrong
# type is dropped, exactly like a malformed wire: the plan loads and the entry is
# simply not there. Worth warning about because a generator that writes an object or
# a number here gets no error from the app at all. One row per collection — key,
# container, the word for that container, what an element must be, and why it went —
# so a new collection is a row rather than a fourth loop.
COLLECTIONS = (
    ("nodeNames", dict, "object", is_str, "the value must be a string"),
    ("nodeColors", dict, "object", is_str, "the value must be a string"),
    ("notes", dict, "object", is_str, "the value must be a string"),
    ("hidden", list, "array", is_str, "every element must be a node id string"),
    ("noteCollapsed", list, "array", is_str, "every element must be a node id string"),
    ("positions", dict, "object", is_pos, "both x and y must be finite numbers"),
)


def collection_warnings(plan):
    """The entries the app's loader drops from the element-validated collections. A
    collection that is not the right container at all falls back to empty, which loses
    every entry at once."""
    out = []
    for key, container, word, ok, why in COLLECTIONS:
        v = plan.get(key)
        if v is None:
            continue
        if not isinstance(v, container):
            out.append(f"{key} is not an {word} — the app loads the plan with no {key} at all")
            continue
        entries = v.items() if container is dict else enumerate(v)
        for label, el in entries:
            if not ok(el):
                out.append(f"{key}[{label}]: the app drops this on load — {why}")
    out.extend(name_warnings(plan))
    return out


# The unit's own CH SETTING name screen takes at most 8 CHARACTERS (`ch 1xxxx`), so
# the app cuts a longer name there. Nothing in the protocol enforces it — the broker
# stores a 20-character name and reads it back unchanged — which is why a generated
# name is worth warning about: it loads shortened, silently, and this is the one
# collection entry the loader rewrites instead of dropping.
NODE_NAME_MAX_CHARS = 8


def name_warnings(plan):
    """The names the app rewrites on load (and again on the way to the device).

    Two rewrites, in this order: cut to the bound, then strip TRAILING whitespace.
    A leading space survives — the unit right-aligns its stereo pair labels, so
    " 5/ 6" is the real name — and the order matters, since cutting can land on a
    space the trim then has to take.
    """
    out = []
    names = plan.get("nodeNames")
    if not isinstance(names, dict):
        return out
    for node_id, value in names.items():
        if not isinstance(value, str):
            continue
        size = len(value)
        if size > NODE_NAME_MAX_CHARS:
            out.append(
                f"nodeNames[{node_id}]: the app cuts this to {NODE_NAME_MAX_CHARS} characters on load "
                f"({size} given) — the unit's own name screen takes no more"
            )
        cut = value[:NODE_NAME_MAX_CHARS]
        if cut != cut.rstrip():
            out.append(
                f"nodeNames[{node_id}]: the app strips the trailing whitespace from this on load — "
                "the unit STORES a trailing space rather than padding it away, while every path that "
                "reads a name back trims one off, so a plan keeping one is re-sent on every sync"
            )
    return out


# Node-param sections carrying the DEVICE's own internal units — what the app
# captures when it reads a unit, not a scale a value can be authored on. A
# hand-written number lands wherever that raw value sits on the device curve;
# recommend leaving them out (the device keeps its own value) or dialing the effect
# in on the unit and fetching. Routing and human-readable scalars are unaffected.
#
# `fxEffect` is NOT in this table: it writes the selector and every slot of the resolved
# type whenever the section is present, so a partial omission preserves nothing there.
# Its own advisory is emitted below.
#
# For the two that ARE here, this tool does NOT say whether omitting a key keeps the
# unit's value, and the omission is the point. What it carries is routing plus the
# insert-FX param space (`insertFxParamSpace`), and no model of the write path beyond it,
# and the answer depends on things only that path knows: whether the
# channel is in the mode that sends SSMCS at all, which effect family the selector names
# (a slot keyed under another family is never sent), what the loader normalizes a bare
# slot number into, and which slots the unit recomputes for itself. A conditional version
# of this advice was written and reverted — three of its branches contradicted the app
# they described, because reproducing those conditions here is a second implementation of
# the emitter that drifts from it silently. Say what is true without one: verify on the
# device, or dial it in on the unit and fetch the plan back.
RAW_PARAM_KEYS = {
    "ssmcs": "SSMCS channel strip (raw curve values)",
    "insertFxParams": "insert-FX engine parameters (raw slot values)",
}
RAW_ADVICE = (
    "verify on the device, or have the user dial it in on the unit and fetch the plan back. "
    "Omitting a key is NOT a way to keep the unit's value — the app completes a loaded document "
    "from the model's factory values, so an omitted key goes out like any other"
)


# Effect type selectors. Writing one makes the device refill that effect's whole
# parameter array with the new type's factory defaults, and selecting the previous
# type back only refills it with that type's defaults — the user's values are gone.
# Author one only when the user asked to change the effect.
SELECTOR_KEYS = {
    "insertFx": "selecting an insert effect",
    "fxEffect.type": "selecting an FX type",
}


# Ducker settings live on the ducker node itself (kind "ducker", e.g.
# out.ducker1), not on the channel it ducks; a channel id carrying them loads
# without complaint but has no effect.
DUCKER_KEYS = ("duckerOn", "ducker")


# Insert-FX resource slots. The user guide's Effect list column "Number of
# simultaneous uses" reads 1 slot per FAMILY, device-wide: the four guitar amps
# share one slot across the MONO IN channels, Pitch Fix another, the two
# companders a third ("cannot be inserted into two mono channels"), and on the
# output side the Multi-Band Compressor and the companders share a single slot
# across every MIX / STEREO output. Two nodes selecting into one slot is a plan
# the device cannot run; the app warns about it on load.
# Input effects belong to the MONO IN channels only (stereo channels have no
# insert FX, so an insertFx there claims nothing); the output table applies to the
# STEREO master and the two MIX buses. The compander values (1793 / 1794) appear
# in both tables and land in a different slot depending on which side they are on.
INSERT_FX_SLOTS = {
    256: "guitar amp",
    257: "guitar amp",
    258: "guitar amp",
    259: "guitar amp",
    512: "Pitch Fix",
    1793: "compander",
    1794: "compander",
}
OUTPUT_INSERT_FX_SLOTS = {1792: "output dynamics", 1793: "output dynamics", 1794: "output dynamics"}
OUTPUT_INSERT_FX_NODES = ("bus.stereo", "bus.mix1", "bus.mix2")
STEREO_CHANNEL_RE = re.compile(r"^ch_\d+_\d+$")
# The comp/EQ order that routes a channel through the SSMCS strip (params.ts COMP_EQ_SSMCS).
COMP_EQ_SSMCS = 1


def insert_fx_slot(node_id, params, nodes):
    """The device-wide 1-of slot this node's insert-FX selection claims, or None
    when it claims nothing (No Effect, an off-menu value, or a node with no insert
    FX at all)."""
    value = params.get("insertFx")
    if not is_number(value):
        return None
    if node_id in OUTPUT_INSERT_FX_NODES:
        return OUTPUT_INSERT_FX_SLOTS.get(value)
    if nodes.get(node_id, {}).get("kind") == "channel" and not STEREO_CHANNEL_RE.match(node_id):
        return INSERT_FX_SLOTS.get(value)
    return None


FACTORY_INSERT_FX = -1
FACTORY_INSERT_FX_ON = False


def pair_of(node_id, pairs):
    """The MONO IN pair `node_id` belongs to, primary first, or None. The pairs come from
    the bundled model data, so this tool does not carry a second copy of which channels
    pair with which."""
    for pair in pairs or []:
        if isinstance(pair, list) and len(pair) == 2 and node_id in pair:
            return pair
    return None


def pair_is_linked(node_id, pairs, node_params):
    """True when `node_id` is on a MONO IN pair whose Signal Type is STEREO. The flag lives
    on the pair's primary, so it is read there whichever member is asked."""
    pair = pair_of(node_id, pairs)
    if pair is None:
        return False
    primary = node_params.get(pair[0])
    return isinstance(primary, dict) and primary.get("stereoLink") is True


def sanitized(node_params, node_id, key):
    """One member's stored value AFTER the app's load-time sanitiser, or None where the key
    is absent or the app drops it. The app keeps a leaf that is a boolean or a finite number
    and drops everything else, so `null` and an omitted key are the same thing to the write
    — comparing the raw JSON instead makes them differ."""
    carried = node_params.get(node_id)
    if not isinstance(carried, dict) or key not in carried:
        return None
    value = carried[key]
    if isinstance(value, bool) or is_number(value):
        return value
    return None


def insert_fx_wire_state(node_params, node_id, param_space):
    """The insert-FX state a write would leave on the unit for one member of a pair, in the
    terms the WIRE sees — the same projection `insertFxWireState` makes in the app, so the
    two agree about which documents differ in a way that matters.

    Stored values answer the wrong question: an off-menu selector and No Effect reach the
    unit as one value, `true` and `1` are one bypass, and a bypass beside No Effect is never
    sent at all. `None` for the engine values means the selector carries no family, which is
    what No Effect is.
    """
    stored = sanitized(node_params, node_id, "insertFx")
    selector = stored if stored in INSERT_FX_SLOTS or stored == FACTORY_INSERT_FX else FACTORY_INSERT_FX
    if stored is None:
        selector = FACTORY_INSERT_FX
    on = sanitized(node_params, node_id, "insertFxOn")
    if on is None:
        on = FACTORY_INSERT_FX_ON
    # `bool(1) is True`, which is the point: the app sends `np.insertFxOn ? 1 : 0`, so every
    # truthy value is one bypass. Python's own `==` would also call `True == 1`, but it calls
    # `1 == 1.0` and `False == 0` too, and none of those is the question being asked.
    wire_on = None if selector == FACTORY_INSERT_FX else bool(on)
    return selector, wire_on, insert_fx_pair_params(node_params, node_id, selector, param_space)


def sanitized_params(params):
    """The engine map as the app's LOADER leaves it: a leaf that is neither a boolean nor a
    finite number is dropped from the document before anything reads it.

    Everything below has to run on this rather than on the raw JSON, and each of the two
    reasons is a way the raw map answers a question the app never asks. A dropped key cannot
    hide the bare key the app would have fallen through to (`{"pitch:16": null, "16": 5}` is
    5 to the app), and it cannot gate anything either (`"pitch:34": "on"` is not a MIDI
    Control that is on — it is a key the loader removed, so the unit drives nothing and the
    Scale is written after all).
    """
    if not isinstance(params, dict):
        return {}
    return {str(k): v for k, v in params.items() if isinstance(v, bool) or is_number(v)}


def insert_fx_slot_value(params, family, slot):
    """One engine slot's value, the way the app reads it: the family-qualified key first, the
    bare slot number second. The loader re-keys a bare slot under the selected family, so the
    two name one value and the qualified one wins. Expects a SANITISED map."""
    for key in (f"{family}:{slot}", str(slot)):
        if key in params:
            return params[key]
    return None


def insert_fx_pair_params(node_params, node_id, selector, param_space):
    """The engine commands a write would send for one member, as (name, slot, value) rows.

    This is the app's own emit rule (`pushInsertFxEffectCommands`), reproduced from the data
    `insertFxParamSpace` carries. Every clause of it decides whether two documents differ in
    a way the unit can tell apart, so leaving one out makes this checker refuse a plan the
    app loads:

    - the value is read under the FAMILY's namespace, bare key second;
    - a value that is not a finite number is not sent at all — a boolean included, since
      `Number.isFinite(true)` is false in the app;
    - what IS sent is the value bounded to that slot's own range, so two numbers past the
      same end arrive as one;
    - a slot the unit drives itself is skipped while its gate is on (Pitch Fix clears the
      Scale and the note mask when MIDI Control is switched on, and re-sending the plan's
      copy would put them back);
    - a driver slot goes out under its own command name.

    The emit's mirrored slots are left out: a mirror repeats a value this tuple already
    carries, at a slot the FAMILY decides, so it falls the same way on both members of a pair
    and can move no verdict here.

    "Nothing is sent" has ONE spelling — the empty tuple — whether the selector carries no
    family, the document omits the map, the map is empty, or nothing in it survives. Two
    spellings made an omitted map differ from an empty one, which is a pair the app loads.
    """
    space = param_space.get(str(selector)) if isinstance(param_space, dict) else None
    if not isinstance(space, dict):
        return ()
    family = space.get("family")
    slots = space.get("slots")
    if not isinstance(family, str) or not isinstance(slots, list):
        return ()
    carried = node_params.get(node_id)
    params = sanitized_params(carried.get("insertFxParams") if isinstance(carried, dict) else None)

    driven = set()
    gate_spec = space.get("driven")
    if isinstance(gate_spec, dict):
        gate = insert_fx_slot_value(params, family, gate_spec.get("gate"))
        # The app reads the gate as a bare truthiness with 0 for an absent one, so a boolean
        # gates exactly as a 1 does.
        if gate:
            driven = {s for s in gate_spec.get("slots") or []}

    out = []
    for spec in slots:
        if not isinstance(spec, dict):
            continue
        slot = spec.get("slot")
        if slot in driven:
            continue
        value = insert_fx_slot_value(params, family, slot)
        # `Number.isFinite` in the app, which a boolean is not — and `is_number` already
        # draws that line for the same reason, so it is asked rather than re-stated.
        if not is_number(value):
            continue
        raw = min(max(value, spec.get("rawMin")), spec.get("rawMax"))
        name = "INSERT_FX_DRIVER" if spec.get("driver") else "INSERT_FX_EFFECT"
        out.append((name, slot, raw))
    return tuple(out)


def insert_fx_pair_problems(plan, pairs, param_space):
    """A STEREO-linked pair whose two members disagree about their one insert effect.

    The unit keeps ONE selector, one bypass and one engine for a linked pair and mirrors a
    write to either member onto the other, so a document giving the two members different
    WRITTEN states describes no state the unit can be in: the app emits both, the unit keeps
    whichever landed last, and its converging write re-sends them to its round limit and
    gives up. The app refuses such a document, so this is a problem rather than a warning.
    """
    out = []
    node_params = plan.get("nodeParams")
    if not isinstance(node_params, dict):
        return out
    for pair in pairs or []:
        if not (isinstance(pair, list) and len(pair) == 2):
            continue
        primary = node_params.get(pair[0])
        if not (isinstance(primary, dict) and primary.get("stereoLink") is True):
            continue
        a = insert_fx_wire_state(node_params, pair[0], param_space)
        b = insert_fx_wire_state(node_params, pair[1], param_space)
        keys = [k for k, x, y in zip(("insertFx", "insertFxOn", "insertFxParams"), a, b) if x != y]
        if keys:
            out.append(("insertFxPair", f"{pair[0]} / {pair[1]}: {', '.join(keys)}", ""))
    return out


def fx_admitted(spec, value):
    """The nearest value an FX control admits, which is the value the write will send.

    The admitted set is the CONTROL's, not a window: a toggle takes 0 and 1 with no bounds
    written down, a select takes its option values, and only a slider has a range. Bounding
    everything against a range instead left 2 on a two-state control and a value past a
    menu's last option on the menu — the app's own note on `paramRangeProblems`.

    Rounded first, by the same rule every control there uses, so a value halfway between two
    settings resolves the same way whichever control holds it. That rule is JavaScript's
    `Math.round`, which is floor(x + 0.5) at every x — a HALF goes to +infinity, so -2.5 is
    -2 and not -3. Written with a sign branch it rounds away from zero on the negative side,
    which the three keys with a negative rawMin (the two delay feedbacks and Rev-R3's) then
    disagree with the app about at every half-integer.
    """
    v = int(math.floor(value + 0.5))
    control = spec.get("control")
    if control == "toggle":
        return 0 if v <= 0 else 1
    if control == "select":
        options = sorted(spec.get("options") or [])
        if not options:
            return v
        # The TOP is answered before any distance is measured, as the app does: every
        # distance from a far-outside value is the same double, so a nearest-of search would
        # keep whichever option it started with.
        if v >= options[-1]:
            return options[-1]
        return min(options, key=lambda o: (abs(o - v), o))
    lo, hi = spec.get("rawMin"), spec.get("rawMax")
    if lo is not None and v < lo:
        return lo
    if hi is not None and v > hi:
        return hi
    return v


def fx_catalogue_warnings(node_id, fx, channel, out, bounded):
    """The two FX repairs that need the channel's own catalogue: a `type` its menu does not
    offer, which the app DROPS (a menu has no nearest member to move to), and a finite number
    outside what its control admits, which the app BOUNDS.

    Both come from `fxChannels` in models.json, generated from the app's catalogue — the two
    questions this tool could not answer before it carried them.

    They go to DIFFERENT lists because the app does different things with them, and the
    sentence each is printed under says which: a dropped value is gone and the effect runs on
    its own default, while a bounded one is still sent — as the bound. Printed under one
    heading, every bound announced itself as a deletion."""
    if not isinstance(channel, dict) or not isinstance(fx, dict):
        return
    types = channel.get("types")
    if isinstance(types, list) and "type" in fx and is_number(fx["type"]) and fx["type"] not in types:
        out.append((f"{node_id}.fxEffect.type", f"{fx['type']!r} is not a type this channel offers"))
    params = fx.get("params")
    specs = channel.get("params")
    if not isinstance(params, dict) or not isinstance(specs, dict):
        return
    for key, raw in params.items():
        spec = specs.get(key)
        if not isinstance(spec, dict) or not is_number(raw):
            continue
        admitted = fx_admitted(spec, raw)
        if admitted != raw:
            bounded.append((f"{node_id}.fxEffect.params.{key}", f"{raw!r} is bounded to {admitted!r}"))


def fx_effect_warnings(node_id, fx, out):
    """Collect everything the app removes from one node's fxEffect (path, why).

    Two stages remove a value and this owns both, because at this path they mean the
    same thing to the author. The document sanitiser drops a leaf that is neither a
    boolean nor a finite number; the load-time repair then drops what SURVIVED that and
    still is not a value the write path can send — a boolean or an object under a key
    that holds a number, an effect object or a parameter map that is not an object. The
    effect then runs on its own factory default and the app says so on the status line.

    The other two repairs — a `type` the channel's menu does not offer, and a finite number
    outside what its control admits — need the channel's own catalogue and are reported by
    `fx_catalogue_warnings`, from the `fxChannels` entry models.json carries."""
    if not isinstance(fx, dict):
        out.append((f"{node_id}.fxEffect", f"{fx!r} is not an object, which drops the whole effect"))
        return
    # An empty group sanitizes to nothing and the key is removed, which is not a harmless
    # difference: the document as written authors the whole channel at the factory defaults,
    # while the loaded plan leaves the channel alone.
    if not fx:
        out.append(
            (
                f"{node_id}.fxEffect",
                "an empty effect object carries nothing and the app removes the key, "
                "which lands where omitting the section lands — the channel's factory effect, "
                "supplied by the loader and sent by the write",
            )
        )
        return
    # `on` is the one field read as a flag, so a number works there by truthiness.
    if "on" in fx and not isinstance(fx["on"], bool) and not is_number(fx["on"]):
        out.append((f"{node_id}.fxEffect.on", f"{fx['on']!r} is neither a boolean nor a finite number"))
    # Array slot 2 is not a field of this section: no control of the unit's own reaches it, so
    # the app neither reads it nor writes it. A document naming it loses the key at the load,
    # whatever its value, so the removal is reported here rather than the value being checked
    # — a warning about the window would say the value is wrong, and it is the KEY that is.
    if "level" in fx:
        out.append(
            (
                f"{node_id}.fxEffect.level",
                "array slot 2 is not a parameter this app carries — no control of the unit's "
                "own reaches it, so the app neither reads it nor writes it and the load removes "
                "the key. The unit keeps whatever it holds at that address",
            )
        )
    if "type" in fx and not is_number(fx["type"]):
        out.append((f"{node_id}.fxEffect.type", f"{fx['type']!r} is not a finite number"))
    params = fx.get("params")
    if params is None and "params" not in fx:
        return
    if not isinstance(params, dict):
        out.append((f"{node_id}.fxEffect.params", f"{params!r} is not an object, which drops every parameter"))
        return
    for k, v in params.items():
        # NOT recursed into: a parameter is one number, so an object here is a malformed
        # parameter rather than a group whose leaves could be read one at a time.
        if not is_number(v):
            out.append((f"{node_id}.fxEffect.params.{k}", f"{v!r} is not a finite number"))


# The two node-param paths that hold a SCALAR and nothing else: the insert-FX bypass, and
# every engine slot under it. The general walk below recurses into a container because the
# nested groups are containers (`gate` is a record, `eqBands` an array), so it would read a
# finite leaf INSIDE one as a value the app keeps. The app does not: the load-time repair
# removes a container from either of these outright, and an author who is not told watches
# the setting disappear after this tool said the document was clean.
def scalar_only_drops(node_id, params, out):
    """Report the scalar-only paths the load-time repair removes."""
    on = params.get("insertFxOn")
    if "insertFxOn" in params and not (isinstance(on, bool) or is_number(on)):
        out.append((f"{node_id}.insertFxOn", f"{on!r} is not a boolean or a finite number"))
    if "insertFxParams" not in params:
        return
    slots = params.get("insertFxParams")
    # The map itself first: an engine map that is not a map is dropped whole, and reporting
    # only its slots would say nothing at all about a document that made it a string — which
    # is what holding the whole field out of the general walk had cost.
    if not isinstance(slots, dict):
        out.append((f"{node_id}.insertFxParams", f"{slots!r} is not an object of engine slots"))
        return
    for slot, raw in slots.items():
        if not (isinstance(raw, bool) or is_number(raw)):
            out.append((f"{node_id}.insertFxParams.{slot}", f"{raw!r} is not a boolean or a finite number"))


def dropped_values(value, path, out):
    """Collect the node-param values the app's loader drops (path, why). Every leaf
    it keeps is a boolean or a finite number, and one malformed element drops the
    whole array — a dropped value silently falls back to the device default.

    The `fxEffect` subtree is NOT walked here: a boolean and a non-empty object survive
    this stage and are removed by the load-time repair instead, so one owner reports
    both (fx_effect_warnings). `insertFxOn` and the engine slots are left out for the same
    reason and reported by `scalar_only_drops`."""
    if isinstance(value, dict):
        for k, v in value.items():
            dropped_values(v, f"{path}.{k}", out)
    elif isinstance(value, list):
        if all(isinstance(el, dict) for el in value):
            for i, el in enumerate(value):
                dropped_values(el, f"{path}[{i}]", out)
        else:
            out.append((path, "an array element is not an object, which drops the whole array"))
    elif not isinstance(value, bool) and not is_number(value):
        out.append((path, f"{value!r} is neither a boolean nor a finite number"))


def node_param_warnings(plan, nodes, pairs, fx_channels):
    """Everything the app would quietly change about the plan's node params: values
    it drops on load, Ducker settings on the wrong node, the params that need care
    on real hardware (raw units, effect selectors), and insert-FX slots two nodes
    claim at once.

    A finite FX value outside what its control admits, and a `type` the channel's menu does
    not offer, are covered too — by `fx_catalogue_warnings`, which reads the `fxChannels`
    entry models.json carries. What needs no catalogue at all is a value that is not a number,
    which is fx_effect_warnings."""
    out = []
    slot_holders = {}
    node_params = plan.get("nodeParams")
    if node_params is not None and not isinstance(node_params, dict):
        return ["nodeParams is not an object — the app loads the plan with no node params at all"]
    for node_id, params in (node_params or {}).items():
        if not isinstance(params, dict):
            out.append(f"node {node_id}: the app drops this node's params on load — nodeParams entries must be objects")
            continue
        dropped = []
        # `insertFxOn` and `insertFxParams` are held out of the general walk and reported by
        # their own rule: it keeps a container, theirs does not.
        walked = {k: v for k, v in params.items() if k not in ("fxEffect", "insertFxOn", "insertFxParams")}
        dropped_values(walked, node_id, dropped)
        scalar_only_drops(node_id, params, dropped)
        bounded = []
        if "fxEffect" in params:
            fx_effect_warnings(node_id, params["fxEffect"], dropped)
            fx_catalogue_warnings(node_id, params["fxEffect"], (fx_channels or {}).get(node_id), dropped, bounded)
        for path, why in dropped:
            out.append(f"node param {path}: the app drops this value on load — {why}")
        for path, why in bounded:
            out.append(f"node param {path}: the app bounds this value on load — {why}")
        if any(k in params for k in DUCKER_KEYS) and nodes.get(node_id, {}).get("kind") != "ducker":
            duckers = ", ".join(i for i, n in nodes.items() if n.get("kind") == "ducker")
            out.append(
                f"node {node_id}: duckerOn/ducker have no effect here — set them on the channel's own ducker node ({duckers})"
            )
        if "insertFx" in params:
            out.append(f"node {node_id}: {SELECTOR_KEYS['insertFx']} resets that effect's parameters on the device")
        slot = insert_fx_slot(node_id, params, nodes)
        if slot:
            held = slot_holders.setdefault(slot, [])
            # A STEREO-linked pair holds one insert effect between its two channels — the unit
            # mirrors the selector across them and both point at one engine — so the pair claims
            # the slot once, as the app's own census counts it. Without this the tool reports the
            # document plan-schema.md tells an author to write (the same effect on both members)
            # as a collision the app does not raise.
            pair = pair_of(node_id, pairs)
            partner = None
            if pair is not None and pair_is_linked(node_id, pairs, node_params or {}):
                candidate = pair[1] if pair[0] == node_id else pair[0]
                if insert_fx_wire_state(node_params or {}, candidate, {})[0] == insert_fx_wire_state(node_params or {}, node_id, {})[0]:
                    partner = candidate
            if partner is None or partner not in held:
                held.append(node_id)
        # The section's PRESENCE, not the `type` key: the selector is emitted whether or not
        # the document names a type (an absent one resolves to the channel's factory type),
        # and every parameter slot goes with it. There is no partial FX write, so a plan
        # carrying `{"on": true}` resets the effect exactly as one naming a type does. Leaving
        # the whole section out does not keep the unit's effect either — the app completes a
        # document from the model's factory values and sends that — so the only plan that keeps
        # it is one carrying the unit's own values, which is what this line has to say. Paired
        # with the raw-values advice it used to draw, an author was told to omit
        # `fxEffect.params`, which keeps the section, writes the selector, and resets what they
        # meant to preserve.
        if isinstance(params.get("fxEffect"), dict) and params["fxEffect"]:
            named = "type" in params["fxEffect"]
            out.append(
                f"node {node_id}: {SELECTOR_KEYS['fxEffect.type']} resets that effect's parameters on the device"
                + ("" if named else " — the selector is written even though this plan names no type")
                + ". The EFFECT TYPE and every parameter slot go out whenever this section is present, so "
                "omitting fxEffect.params keeps nothing — and neither does omitting the whole section, since "
                "the app fills in the channel's factory effect and writes that"
            )
        for key, note in RAW_PARAM_KEYS.items():
            if key in params:
                out.append(f"node {node_id}: {note} — {RAW_ADVICE}")
    # The same irreversible writes, reached from the other side. A document that says nothing
    # about a selector is completed from the model's factory values, so the selector goes out
    # and what the unit holds is replaced. Silence used to be the way to leave a channel alone;
    # it is not one any more, and an author who is not told reads the absence as safety. Three
    # keys carry that: an FX channel's effect, an insert-FX selector (whose factory value is No
    # Effect, so an omitted one CLEARS the unit's insert effect), and an SSMCS strip — the last
    # only where the document itself puts the channel in that comp/EQ order, since the factory
    # order sends no SSMCS at all.
    written = {i: p for i, p in (node_params or {}).items() if isinstance(p, dict)}

    def takes_insert_fx(node_id):
        if node_id in OUTPUT_INSERT_FX_NODES:
            return True
        return nodes.get(node_id, {}).get("kind") == "channel" and not STEREO_CHANNEL_RE.match(node_id)

    # Each of these asks whether the document carries a value the app can USE, not whether the
    # key is present: the loader completes what it drops, so a key holding the wrong kind of
    # thing lands in the same place as one that was never written, and an author told the
    # opposite by its presence reads the absence of a warning as safety. `is_number` is the
    # file's own guard for this (insert_fx_slot), and it is what keeps `true` out of the SSMCS
    # comparison below — Python reads `True == 1` as true, while the app's own `===` does not.
    def usable(node_id, key, kind):
        value = written.get(node_id, {}).get(key)
        return bool(value) and isinstance(value, dict) if kind == "map" else is_number(value)

    for ids, note in (
        (
            [i for i in nodes if i.startswith("bus.fx") and not usable(i, "fxEffect", "map")],
            "carry no usable fxEffect, so the app fills in each channel's factory effect and the "
            "write sends it",
        ),
        (
            [i for i in nodes if takes_insert_fx(i) and not usable(i, "insertFx", "number")],
            "carry no usable insertFx, so the app fills in the factory value (No Effect) and the "
            "write clears whatever insert effect the unit is holding",
        ),
        (
            [
                i
                for i in nodes
                if is_number(written.get(i, {}).get("compEqType"))
                and written.get(i, {}).get("compEqType") == COMP_EQ_SSMCS
                and not usable(i, "ssmcs", "map")
            ],
            "select the SSMCS comp/EQ order and carry no usable ssmcs, so the app fills in the "
            "factory strip and the write sends it over whatever the unit has dialled in",
        ),
    ):
        if ids:
            out.append(
                f"{', '.join(ids)}: {note} — whatever the unit holds there is replaced. To keep the "
                "unit's values, carry them in the plan (fetch the plan back from the unit)"
            )
    for slot, ids in slot_holders.items():
        if len(ids) > 1:
            out.append(
                f"insert FX: {', '.join(ids)} select into the one device-wide {slot} slot — "
                "the unit runs only one at a time, so the app warns on load; give the effect to a single node"
            )
    return out


def format_report(plan, problems):
    lines = [
        "URX Router plan validation failed",
        f"model: {plan.get('modelId') if isinstance(plan, dict) else None}",
        f"problems: {len(problems)}",
        "",
    ]
    # Routing problems name both endpoints; a document-level one (the format tag,
    # the version, the model) has no wire to point at, so it prints on its own.
    lines += [f"[{reason}] {frm} -> {to}" if to else f"[{reason}] {frm}" for reason, frm, to in problems]
    return "\n".join(lines)


def encode_plan_param(plan):
    raw = json.dumps(plan, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    co = zlib.compressobj(9, zlib.DEFLATED, -15)  # raw deflate = CompressionStream "deflate-raw"
    deflated = co.compress(raw) + co.flush()
    return "z" + base64.urlsafe_b64encode(deflated).rstrip(b"=").decode("ascii")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Validate / encode a URX Router plan.")
    sub = ap.add_subparsers(dest="cmd", required=True)
    pv = sub.add_parser("validate", help="check a plan against the routing rules")
    pv.add_argument("plan")
    pu = sub.add_parser("url", help="validate, then emit a ?plan= deep link")
    pu.add_argument("plan")
    pu.add_argument("--base", default=DEFAULT_BASE, help="demo base URL")
    args = ap.parse_args(argv)

    with open(args.plan, encoding="utf-8") as fh:
        plan = json.load(fh)
    models = load_models()
    problems, warnings = validate(plan, models)

    for w in warnings:
        print(f"WARNING: {w}", file=sys.stderr)

    if problems:
        print(format_report(plan, problems))
        return 1

    if args.cmd == "validate":
        print("OK" + (f" ({len(warnings)} warning(s))" if warnings else ""))
        return 0

    base = args.base if args.base.endswith("/") else args.base + "/"
    print(f"{base}?plan={encode_plan_param(plan)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
