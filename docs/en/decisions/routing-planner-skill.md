# Decisions: the urx-routing-planner skill

> 日本語版: [../../ja/decisions/routing-planner-skill.md](../../ja/decisions/routing-planner-skill.md)

Closed decisions about the skill bundled under `.claude/skills/urx-routing-planner/` and its two
manifests. The rules for keeping the skill in step with the app are in `CLAUDE.md` "Conventions";
this document points at where each of them was decided.

## The 2026-07-26 drift audit

The audit that found the skill's hand-written files behind the app, and the six occasions on which
they have to change with it: [#215](https://github.com/semnil/urx-router/pull/215).

**Incident behind it.** The skill had answered "possible" for a channel wired straight to a USB
output without knowing that the tap sits before the fader. The route table cannot say that; the
hand-written notes are the one place that can.

## The manifests are bumped per pull request

- Both manifests carry a `version` that nothing in the repository reads, and both are bumped in the
  change that alters the skill: [#258](https://github.com/semnil/urx-router/pull/258).
- The unit of that obligation is the pull request, not the commit:
  [#486](https://github.com/semnil/urx-router/pull/486), closed the same way in
  [#518](https://github.com/semnil/urx-router/pull/518).

## The plan validator is held to the app

`plan_tool.py` and the app's own loader are run over the same documents and have to agree,
and the rules the tool needs are generated from the catalog:
[#482](https://github.com/semnil/urx-router/pull/482) and
[#484](https://github.com/semnil/urx-router/pull/484).
