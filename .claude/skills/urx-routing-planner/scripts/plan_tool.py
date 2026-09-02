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
PLAN_VERSION = 2

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
    warnings.extend(node_param_warnings(plan, nodes))
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
RAW_PARAM_KEYS = {
    "ssmcs": "SSMCS channel strip (raw curve values)",
    "fxEffect": "FX bus effect parameters (raw per-effect slot values)",
    "insertFxParams": "insert-FX engine parameters (raw slot values)",
}


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


def dropped_values(value, path, out):
    """Collect the node-param values the app's loader drops (path, why). Every leaf
    it keeps is a boolean or a finite number, and one malformed element drops the
    whole array — a dropped value silently falls back to the device default."""
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


def node_param_warnings(plan, nodes):
    """Everything the app would quietly change about the plan's node params: values
    it drops on load, Ducker settings on the wrong node, the params that need care
    on real hardware (raw units, effect selectors), and insert-FX slots two nodes
    claim at once.

    NOT covered: an FX effect value outside the range the app can write. The app
    bounds one on load (or drops it, when the leaf is not a finite number, so the
    selected type's own default applies) and reports the count, and this tool
    cannot see it — the
    windows live in the app's effect catalogue and the data bundled here carries
    routing only. Exporting those windows beside models.json is what would settle
    it."""
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
        dropped_values(params, node_id, dropped)
        for path, why in dropped:
            out.append(f"node param {path}: the app drops this value on load — {why}")
        if any(k in params for k in DUCKER_KEYS) and nodes.get(node_id, {}).get("kind") != "ducker":
            duckers = ", ".join(i for i, n in nodes.items() if n.get("kind") == "ducker")
            out.append(
                f"node {node_id}: duckerOn/ducker have no effect here — set them on the channel's own ducker node ({duckers})"
            )
        if "insertFx" in params:
            out.append(f"node {node_id}: {SELECTOR_KEYS['insertFx']} resets that effect's parameters on the device")
        slot = insert_fx_slot(node_id, params, nodes)
        if slot:
            slot_holders.setdefault(slot, []).append(node_id)
        if isinstance(params.get("fxEffect"), dict) and "type" in params["fxEffect"]:
            out.append(f"node {node_id}: {SELECTOR_KEYS['fxEffect.type']} resets that effect's parameters on the device")
        for key, note in RAW_PARAM_KEYS.items():
            if key not in params:
                continue
            # fxEffect's on / level are plain values and its type is warned about
            # above; only the raw `params` map belongs to this class.
            if key == "fxEffect":
                fx = params.get("fxEffect") or {}
                if not isinstance(fx, dict) or not fx.get("params"):
                    continue
            out.append(f"node {node_id}: {note} — verify on the device or omit to keep its current value")
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
