# Decisions: the urx-routing-planner skill

> English version: [../../en/decisions/routing-planner-skill.md](../../en/decisions/routing-planner-skill.md)

`.claude/skills/urx-routing-planner/` に同梱しているスキルと、その 2 つのマニフェストについて、閉じた判断を
置く。スキルをアプリとそろえておく規則は `AGENTS.md`「Conventions」にある。この文書は、それぞれがどこで
決まったかを指す。

## The 2026-07-26 drift audit

スキルの手書きのファイルがアプリより古くなっていたことを見つけた監査と、手書きのファイルをアプリと一緒に
直す 6 つの契機: [#215](https://github.com/semnil/urx-router/pull/215)。

**背景になった実害。** スキルは、チャンネルを USB の出力へ直接つなぐ配線に、取り出し口がフェーダーの前に
あることを知らないまま「可能」と答えていた。ルートの表はそれを表せず、表せるのは手書きの注記だけである。

## The manifests are bumped per pull request

- 2 つのマニフェストは `version` を持ち、リポジトリの中にそれを読むものが無い。スキルを変える変更で、
  両方を上げる: [#258](https://github.com/semnil/urx-router/pull/258)。
- この義務の単位は PR で、コミットではない: [#486](https://github.com/semnil/urx-router/pull/486)。
  [#518](https://github.com/semnil/urx-router/pull/518) でも同じ形で閉じた。

## The plan validator is held to the app

`plan_tool.py` とアプリ自身のローダーを同じ文書に通し、2 つの判定が一致することを求める。ツールに要る
規則は、カタログから生成して渡す: [#482](https://github.com/semnil/urx-router/pull/482) と
[#484](https://github.com/semnil/urx-router/pull/484)。
