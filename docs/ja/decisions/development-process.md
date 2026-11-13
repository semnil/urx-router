# Decisions: the development process

> English version: [../../en/decisions/development-process.md](../../en/decisions/development-process.md)

このリポジトリの作業の進め方について、閉じた判断を置く。一時のファイル、指示ファイル、リリースの PR、見積もり、
PR の前に走らせるもの、の 5 つで、それぞれ、決めるもとになった出来事を添える。決まりそのものは `AGENTS.md`
「Development」と「Conventions」にある。この文書は、そこに無い理由を持つ。下の「操作者」は、このプロジェクトの
作業を指示し、決める人のこと。

## `work/` stays out of `.gitignore`

**決定 (2026-09-04)。** `work/` は `.gitignore` に足さない。代わりに、中身を消す。操作者が決めたことで、
この行を足す提案は、もう一度はしない。一時のファイルの置き場は [local-runs.md](../local-runs.md) の
「`work/` の下の作業用のファイル」にある。

## The instruction file is tracked as `AGENTS.md`

**決定 (2026-11-13)。** プロジェクトの指示は、追跡する 1 つのファイル `AGENTS.md` に置く。その横に `CLAUDE.md` は
置かない。操作者が決めた。これは、`/AGENTS.md` を `.gitignore` に入れた 2026-08-21 の項目を開け直したもの。
当時の `AGENTS.md` は、別の道具のために `CLAUDE.md` をマシンごとに写したもので、追跡すると 1 つの規則が 2 つの
文になった。ファイルが 1 つなら文は 1 つなので、無視の行を消した。

## Release pull requests

**決定。** リリースの PR は、版だけを変える。本文は、前のリリースの PR から写し、数値は、新しい範囲で取り
直す。測定の一式と本文の形は、直近のリリースの PR
[#752](https://github.com/semnil/urx-router/pull/752) にある。

その測定のうち 2 つが、リリースの種別と、本文に書くことを決める。

- **patch か minor かは、PR の題でなく、コミットから読む。**
  `git log --no-merges --format=%s v<前の版>..origin/main` から `feat` を探す。ある範囲では、題は修正・
  文書・依存の更新に見えて、まとめの PR の中に `feat` のコミットが 2 件あった。
- **`PLAN_VERSION` を、範囲の前後で比べる** (`git diff v<前の版>..HEAD -- src/core/plan.ts`)。動いていれば、
  新しい版が保存したプランは前の版で開けないので、本文にそう書く。動いていなければ、プランは両方向に
  開ける、と書く。

**実害の記録。** 1.12.0 のリリース ([#486](https://github.com/semnil/urx-router/pull/486)) は、1 行の差分
だった。そのレビューには、差分に加えて、公開までの経路と、リリースが出荷するマージの範囲を読ませた。
見つかったのは、差分の外のことだった。`PLAN_VERSION` が範囲の中で上がっていて、1.12.0 が保存したプランは、
1.11.0 で `planVersionUnsupported` として拒否される。本文は、それを書いていなかった。指摘を採る前に、前の
タグから、前の値を読んだ。それからは、この比較を測定の 1 つにしていて、レビューが気付くのを待たない。

## Estimating a change to a shared path

**決定。** いくつもの機能が通る経路 (MIDI のエンジンの apply、書込の漏斗の mirror) への変更は、1 回の修正
として見積もらない。最初の修正が、それまで届かなかった状態を、届くものにすることがある。

**実害の記録。** 1 つの仕組み (MIDI の gang) に、外部のレビューから、変更の要求が 4 回続けて来た
([#457](https://github.com/semnil/urx-router/pull/457)、
[#458](https://github.com/semnil/urx-router/pull/458)、
[#459](https://github.com/semnil/urx-router/pull/459)、
[#460](https://github.com/semnil/urx-router/pull/460))。却下したものは無い。4 回の指摘は、測ると再現し、
実在の欠陥だった。順に並べると、層になっている。ミラーを足す。gang の書込の順が結果を決めるようになる。
ロックを外す向きだけが直る。ロックが成立する向きが残る。ミラーで等価なものを畳む。畳み込みがアドレスの
境界を越える。このうち 3 つは、直前の修正が作った。ミラーの追加が順序への依存を作り、畳み込みが境界
越えを作り、ミラーの識別子だけを鍵にした版は、1 回も畳んでいなかった。結合の欠陥を、結合を足して直して
いるときは、その手当てが次の結合になっていないかを見る。

## What to run before a pull request

**決定。** `AGENTS.md`「Conventions」の 2 つの決まりは、下の出来事から来た。パネルに行やトグルを足す変更は、
PR の前に `pnpm test:e2e:app` の全体を走らせる。レースのハーネスが固定している挙動を変える変更は、それを
名指すレースの spec を走らせる。

**実害の記録。**

- インスペクタに行を足し、PR の前の E2E は、3 つの spec のファイルだけを走らせた。別のファイル
  `e2e/nodeoff.spec.ts` は、インスペクタの最初のトグルが Channel ON であることに頼っていて、必須のチェックを
  落とした ([#609](https://github.com/semnil/urx-router/pull/609))。
- 同じ PR で、マージの指示に auto-merge で応じ、その直後に、パッチの未到達の行を埋めるかどうかを操作者に
  挙げた。答えが来たときには、PR はマージされていて、テストは別の PR になった
  ([#610](https://github.com/semnil/urx-router/pull/610))。開いたままの問いは、auto-merge を入れる前に
  決着させるか、マージを待つ。
- レースのハーネスが固定している挙動を変える変更を、開発機でレースを走らせずに出したことが 2 回あり、
  CI のレースのジョブが赤になった。ケースが何を固定していたかは
  [#611](https://github.com/semnil/urx-router/pull/611) と
  [#678](https://github.com/semnil/urx-router/pull/678) にある。
