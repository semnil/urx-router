# Decisions: languages of the UI and the documents

> English version: [../../en/decisions/localization-and-documents.md](../../en/decisions/localization-and-documents.md)

文字列や文書をどの言語で書くかについて、閉じた判断を置く。規則そのものは `CLAUDE.md`「Conventions」と
[architecture.md](../architecture.md)「多言語対応 (i18n)」にある。この文書は、その周りで決めたことと、
却下した案を持つ。

## Cross-links keep two forms

**決定 (2026-10-20)。** 各文書は、先頭の数行でもう一方の言語の文書を指す。その指し方の文言は、今使っている
2 つの形のままにする。ルート直下の文書は README の形 (`> 日本語版は […] を参照してください.` と
`> For the English version, see […].`)。`docs/` の下の文書は短い形 (`> 日本語版: […]` と
`> English version: […]`)。

**却下した案。** `docs/` の下の 12 本を README の形に書き換える。

## English as the base language: what was rewritten and what stays

**決定 (2026-10-20)。** このリポジトリの基本の言語は英語
([#699](https://github.com/semnil/urx-router/pull/699))。前からあった文は、次のようにそろえた。

- 日本語を含んでいた既存の PR 40 件のうち、7 件を書き換えた (#92・#144・#248・#553・#665・#676・#697)。
  残りの 33 件の日本語はデータなので、書かれたまま残す: 変更の題材になっている UI の文字列、日本語の文書の
  見出し、実行のログ、テストの入力、英訳つきで引用された発言。
- 書き換えた本文は、日本語の語を残して、英訳を括弧で添える。英文の中で地の文として使っていた日本語の語は、
  英語に置き換えた。
- v0.9.0 のリリースノートの 1 行を、#92 の新しいタイトルに合わせた。
- `src/i18n/ja.ts` のコメントを英語にした ([#700](https://github.com/semnil/urx-router/pull/700))。

**英語と日本語の併記のまま残すもの。** issue を作る画面の文言を持つ `.github/ISSUE_TEMPLATE/config.yml`。

## Rows from the unit's own screens

**決定 (2026-08-13)。** `src/i18n/en.ts` の `midi.param` の下の行は、どれも `dev()` のまま、実機の綴りで
持つ (決めた日の時点で 34 行)。このうち `PAN/BAL`・`C.INT`・`GAIN`・`PRE` は、このアプリ自身のチップの語
だが、同じ扱いにする。

**理由。** MIDI ウィンドウは、実機がコントローラーに割り当てさせる対象を並べる面である。実機と同じ綴りの
行は、アプリのほかの面と同じ綴りの行より、実機と読み合わせやすい。同じパラメーターを調整画面では訳す
`scopedParam.gain` は、前からある 1 つの例外として残す。

**同じ日に決着したこと。** 実機は、FX と insert FX のパラメーターの行を日本語では表示しない。これらの行の
`dev()` の宣言は正しい。ある行が実機のものかどうかの決め方は、architecture.md「多言語対応 (i18n)」の
用語の統一にある。

## Surfaces left in English

**決定 (2026-11-12)。** 次の 7 つの面は、アプリの言語が何でも英語で出る。直さない制限として、ここに記録する。

| 面 | 場所 | 英語である理由 |
| --- | --- | --- |
| 生成されるレポートの本文 (write・compare・self-test) | `src/core/control/` | 診断のためのもので、訳した文より安定したコードのほうが多くを伝える (architecture.md「エラーコード」) |
| 表示の切り替えの、支援技術向けのラベル (`View`) | `index.html` | 今のままにした |
| レベルフェーダーの読み上げの値 (`off (-∞)` と、pre-fader の send の前に付く `PRE, `) | `src/ui/console.ts` | 今のままにした |
| `--prepare-modified` で起動したときのステータスの行 | `src/main.ts` | 今のままにした |
| Pitch Fix の MIDI Control の 3 つのモード (`Off`・`Setting`・`Real Time`) | `src/ui/insert-fx-screen.ts` | 実機の画面の語 |
| macOS の確認ダイアログのボタン (`OK`・`Cancel`) | ダイアログのライブラリ | macOS ではライブラリが英語で書く。Windows ではシステムのボタンで、OS の言語に従う |
| macOS のメニューバーの既定の項目 | メニューのライブラリ | ライブラリが英語で書く。Windows にはメニューバーが無い |

「今のままにした」の 3 つには、理由の記録が無い。知った上で、そのままにしている。

## The audio send is written send

**決定。** 日本語の文 (ソースのコメント・UI の文字列・文書) では、オーディオの send を `send` と書き、
日本語の名詞の「送り」を使わない (例: 「OFF send を隠す」)。"send" を動詞として使うところは、
「Send できる」と書き、動詞を訳さない。

**当たらないもの。** レイアウトの行の進みを言う「縦送り」は別の語で、そのままにする。前からある大文字の
`Send` は残してよく、2 つの綴りが混ざってよい。

**経緯。** この規則は、先にソースのコメントと UI の文字列に当てていた。ここに書くことと、日本語の文書にも
当てることは、2026-11-12 に決めた。

## The README's acknowledgement stays

**決定 (2026-11-12、操作者)。** README の「謝辞」の節は、今のまま残す。この節は、URX22 のメーターの対応を
実機で検証した PR の作者を、GitHub のハンドルとリンクで挙げている。貢献への謝辞なので、ほかの所でこれらの
文書が従っている書き方 (外部の人は役割で書く) は、ここには当てない。

## The README's comparison paragraph and store links stay

**決定 (2026-11-12、操作者)。** `README.md` と `README.ja.md` の次の 2 つも、製品の説明として、今のまま残す。

- 冒頭の近くにある、URX シリーズ向けのほかのソフトウェア (メーカーのミキサーエディタ、公式の Stream Deck
  プラグイン、DAW の連携画面) と並べて、URX Router の位置を述べる段落。
- GitHub のリリースのページと並べて書いてある、インストーラーを置いている 2 つのストアのページへのリンク。

これらの文書は、ほかの所では、ほかの製品との比較とストアのページを書かない。README は、このアプリが何のための
もので、どこで手に入るかを読む場所なので、この 2 つは README に残す。

**比較の書き方。** ほかの道具がそれぞれ何を扱うかを書き、URX Router を「この種の唯一の道具」とは書かない。
その形の言い切りは、時間がたつと成り立たなくなりうる。「この空白を埋める」という書き方は、それに依らない。
