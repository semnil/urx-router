# Decisions: the CONSOLE

> English version: [../../en/decisions/console.md](../../en/decisions/console.md)

CONSOLE ビューについて、閉じた判断と、その周りで起きたことを置く。ビューの仕組みは
[console-sends.md](../console-sends.md) と [architecture.md](../architecture.md)「CONSOLE ビュー (ミキサー型レベル一覧)」にある。
この文書は、そこに無い経緯を持つ。下の「操作者」は、このプロジェクトの作業を指示し、決める人のこと。

## Controls a rate ceiling stops were still live on the CONSOLE

**起きたこと (2026-08-29)。** インスペクタの上にある 3 本の警告は、サンプルレートが実機に掛ける上限を名指して
いた。一方で、ストリップの側では、その上限に掛かるコントロールを操作できた。操作者が指摘し、ビューを端から
見直して、4 か所が見つかった。

- INS FX の面には、ツールチップだけが付いていた。
- その横の開示 (`▸` / `+`) は、そのまま操作できた。
- `F2` の Send の列の 3 つのコントロールは、実機が動かしていないバスへ書けた。
- `.con-sl.readonly` の CSS の規則が無かった。クラスと `aria-disabled` は付いていたので、スクリーンリーダーには
  無効で、目には有効に見えた。

**決定。** 扱いは、console-sends.md の「レート上限がコントロールに何をするか」と「レートがバスごと落とした列」の
とおり。面は残して読み取り専用にし、理由を添える。上限で開く先が無くなった開示は、描かない。述語は
`nodeRateDisabled` の 1 つにして、グラフの `disabledNodes` と CONSOLE が同じものを使う。前は別々だったので、
グラフがノードを減光しているのに、CONSOLE がその Send を操作できる状態になっていた。

**幅のテストの仕方。** 開示を描かなくしたときに、横の面の幅が変わったことがある。描いた結果の寸法を見る
テストでは、これを捕まえられない。行に隠しのプレースホルダがあると、伸びる面も、幅を宣言した面も、同じ幅に
なる。そのため、テストは宣言の側、つまり面の `flex-grow` と `flex-basis` を読む (`e2e/ratewarning.spec.ts`)。
