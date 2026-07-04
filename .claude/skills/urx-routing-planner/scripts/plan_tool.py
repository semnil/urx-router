#!/usr/bin/env python3
"""Validate a URX Router plan and turn it into a shareable ?plan= URL.

This mirrors the app exactly so that "the script says OK" implies "URX Router
loads it without the validation modal":

- validation matches core/routing.ts `validatePlan` (noRule / singleInput /
  duplicate), and
- the URL encoding matches core/plan.ts `encodePlanParam` (URL-safe base64 of the
  UTF-8 JSON, padding stripped), read back by `?plan=` on startup.

Routing ground truth lives in scripts/models.json (extracted from the device
model). Only routes listed there are legal.

Usage:
  python plan_tool.py validate <plan.json>
  python plan_tool.py url <plan.json> [--base https://urx-router.semnil.com/]

Exit code is non-zero when the plan has hard validation problems, so the skill
can branch on it. Stability warnings (raw-encoded advanced params) are advisory
and never fail the plan.
"""

import argparse
import base64
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MODELS_PATH = os.path.join(HERE, "models.json")
DEFAULT_BASE = "https://urx-router.semnil.com/"

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


def validate(plan, models):
    """Return (problems, warnings). problems are hard (block load); warnings are
    advisory. problems entries are (reason, from, to)."""
    problems = []
    warnings = []

    model_id = plan.get("modelId")
    if model_id not in models:
        problems.append(("unknownModel", str(model_id), ""))
        return problems, warnings
    model = models[model_id]
    by_pair = rule_index(model)
    nodes = model["nodes"]

    conns = plan.get("connections", [])
    incoming = {}
    for c in conns:
        incoming[c.get("to")] = incoming.get(c.get("to"), 0) + 1

    seen = set()
    for c in conns:
        frm, to, kind = c.get("from"), c.get("to"), c.get("kind")
        rule_kind = by_pair.get((frm, to))
        if rule_kind is None:
            problems.append(("noRule", frm, to))
        elif rule_kind in SINGLE_INPUT_KINDS and incoming.get(to, 0) > 1:
            problems.append(("singleInput", frm, to))
        else:
            # Same from/to is legal, but the wrong kind misbehaves in the app even
            # though it would pass the app's structural check. Surface it so the
            # skill can correct the kind.
            if kind not in KNOWN_KINDS:
                warnings.append(f"connection {frm} -> {to}: unknown kind {kind!r} (use {rule_kind!r})")
            elif kind != rule_kind:
                warnings.append(f"connection {frm} -> {to}: kind {kind!r} should be {rule_kind!r}")
        key = (frm, to)
        if key in seen:
            problems.append(("duplicate", frm, to))
        seen.add(key)

    warnings.extend(stability_warnings(plan, nodes))
    return problems, warnings


# Node-param sections whose on-wire values are RAW broker integers whose encoding
# is not publicly verified. Authoring exact values risks landing on the wrong
# device setting; recommend leaving them out (the device keeps its own value) or
# verifying on hardware. Routing and human-readable scalars are unaffected.
RAW_PARAM_KEYS = {
    "ssmcs": "SSMCS channel strip (raw curve values; encoding not public)",
    "fxEffect": "FX bus effect parameters (raw per-effect values)",
    "insertFxParams": "insert-FX engine parameters (raw slot values)",
}


# Ducker settings live on the ducker node itself (kind "ducker", e.g.
# out.ducker1), not on the channel it ducks; a channel id carrying them loads
# without complaint but has no effect.
DUCKER_KEYS = ("duckerOn", "ducker")


def stability_warnings(plan, nodes):
    out = []
    for node_id, params in (plan.get("nodeParams") or {}).items():
        if not isinstance(params, dict):
            continue
        if any(k in params for k in DUCKER_KEYS) and nodes.get(node_id, {}).get("kind") != "ducker":
            duckers = ", ".join(i for i, n in nodes.items() if n.get("kind") == "ducker")
            out.append(
                f"node {node_id}: duckerOn/ducker have no effect here — set them on the channel's own ducker node ({duckers})"
            )
        for key, note in RAW_PARAM_KEYS.items():
            if key not in params:
                continue
            # fxEffect.type / on / level are stable; only its raw `params` map is not.
            if key == "fxEffect":
                fx = params.get("fxEffect") or {}
                if not isinstance(fx, dict) or not fx.get("params"):
                    continue
            out.append(f"node {node_id}: {note} — verify on the device or omit to keep its current value")
    return out


def format_report(plan, problems):
    lines = [
        "URX Router plan validation failed",
        f"model: {plan.get('modelId')}",
        f"problems: {len(problems)}",
        "",
    ]
    lines += [f"[{reason}] {frm} -> {to}" for reason, frm, to in problems]
    return "\n".join(lines)


def encode_plan_param(plan):
    raw = json.dumps(plan, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


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
