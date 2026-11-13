# Decisions: quality audits

> English version: [../../en/decisions/quality-audits.md](../../en/decisions/quality-audits.md)

アプリ全体の監査と、堅牢性の監査から出た、閉じた判断を置く。所見をどの方式で直したか、どの挙動を今のまま
にするか、その理由を書く。下の「操作者」は、このプロジェクトの作業を指示し、決める人のこと。監査のレポートは、
このリポジトリに置かない。監査がここに残すのは、コードと、それを固定するテストと、この決定の記録。監査が
前に挙げたことへ直しを提案する前に、ここを読む。

## Fix methods the operator chose (2026-08-13 audit)

**決定。** 2026-08-13 のアプリ全体の監査の 5 つの主題は、操作者が直し方まで決めた。却下した方式は、
もう一度提案しない。

| 主題 | 採った方式 | 却下した方式 |
| --- | --- | --- |
| MIDI の learn が、アプリ自身のフィードバックのエコーを、操作として拾った | learn の間は、フィードバックを止める | エコーガードを消費させて、エコーを吸わせる |
| 同じアドレスで、absolute の束縛の後ろにある pickup の束縛が反応しなかった | UI が、同じアドレスの束縛の take-in モードをそろえる | エンジンの側のフォールバック |
| MIDI のウィンドウの capability が書いている分離を、アクセス制御が強制していなかった | アプリのコマンドの権限を生成し、device と file のコマンドをメインのウィンドウに限る | 記述だけを直す |
| `mobile` の設定の分岐が、コンパイルできなかった | mobile の属性とコメントを消し、この crate がデスクトップ専用であることを書く | `cfg(desktop)` のゲート |
| 本体そのものの動きで決まる 3 つの所見 | 先に実機で測ってから直した ([#364](https://github.com/semnil/urx-router/pull/364)) | — |

直しそのものは [#366](https://github.com/semnil/urx-router/pull/366) にある。

## Accepted behaviors the audit tests pin

**決定。** 下の挙動は、堅牢性の監査で見つかり、分かった上で、今のままにしている。`*.audit.test.ts` のケースが
固定しているものは、そのファイルの名前を横に書いた。その挙動を変えるときは、pin も書き換える
(`AGENTS.md`「Conventions」)。

- `src/core/constraints.ts` の `rateConstraints` は、サンプルレートを `> 96000` だけで分ける。表にあるレートか
  どうかは調べず、0 や負の値も断らない (`src/core/routing.audit.test.ts`)。
- ダッカーは、自分のホストのチャンネルをキーのソースに選べる。サイドチェーンの選び方として有効
  (`src/core/routing.audit.test.ts`)。
- `tagPortRef(0x7fffffff)` は、`PORT_REF_NONE` と同じ値になる。実際のポートの id は小さい数なので、その id は
  出てこない。`src/core/control/passthrough.audit.test.ts` のケースが、この衝突を記録している。
- 工場出荷の状態の取り込みは、固定の MIX → STEREO の配線 2 本を欠く。`ensureFixedConnections` が補う
  (`src/models/initial-state.audit.test.ts`)。
- `src-tauri/src/vd.rs` のログは `eprintln!` だけ。
- `src/i18n/ja.ts` の 4 つの文字列は英語: PHONES Level・CUE Interrupt・Delay Time・Frame rate。本体の画面から
  取ったラベルは、本体が書くとおりにする、という決まりに沿っていて、訳し直さない。

## Robustness decisions

監査の所見を直すときに決めたこと。それぞれ、決めておかないと戻ってくる提案を閉じている。

- **保存していない変更があるままウィンドウを閉じるときのガードは、置かない。** 保存・PNG の書き出し・PDF の
  書き出しは、失敗したコマンドを黙って落とさず、ダイアログで知らせる。変更のある文書を閉じるときのガードは、
  それと一緒に検討して、足さなかった。
- **ライブ同期の開始のときの読み戻しの見せ方は、今のまま。** 読めなかったノードは、未読のノードのバッジで
  もう見えているので、そこには足さない。セッションの途中で失敗した読みは、ライブ同期を止めて、ダイアログで
  知らせる (`src/main.ts` の `assertReadComplete`)。
- **メッセージ `liveFollowedPartial` は、消したままにする。** 読みがそろっているかを 1 か所で確かめるように
  してから、そのメッセージを出す経路が無くなり、消した。同じ文言を戻さない。
- **使っていない値の export は un-export し、使っていない型の export は残す。** `export` のキーワードを外し、
  値は残す。型は API の返り値の型なので残す。呼ぶ側は、型の名前を書かずに形に頼るので、名前で探しても
  使う側は見つからない。使っていない export は、モジュールの export を並べて、使われている回数を数えて見つける。
- **`FxParamDesc` と `InsertFxParamDesc` は、2 つの型のままにする。** `key`、`format` が受けるコンテキスト、
  `mirror` が違うので、完全には 1 つにできない。部分的にまとめても、増える結合に対して得るものが小さいと
  判断した。
- **MIDI のシェルのエラーのうち、訳すのは `midi-port-not-found` だけ** (`error.midiPortNotFound`。`src/ui/midi.ts` の
  `midiErrorStatus` を通る。`connectFailureStatus` と対になる関数)。MIDI のエラーは別の IPC の面から届き、
  device のエラーと共通の通り道が無い。`midi-output-not-open` は、送信が失敗した所で落とされて、表示されない
  ので、メッセージを持たない。
- **CONSOLE の `meterReadCell()` は、メーターのあるストリップにだけ作る。** 一度、どのストリップにもセルと
  キャプションを作って、メーターの無い所で捨てる退行を入れたことがある。
- **`tsconfig.e2e.json` には、それを走らせるものが要る。** `typecheck:e2e` のスクリプトと `ci.yml` のステップが
  無いと、E2E のソースは、走行が緑のまま、コンパイラに調べられない。
- **テーマの `localStorage` のガードは、呼び出す場所ごとの今の書き方に合わせる。** 共通のヘルパーにするのは、
  この問題には大きすぎると判断した。
- **メーターのテストの `reading` ヘルパーの 2 つの写しは、そのままにする。** `tapFor` の型が、2 つが気付かれずに
  ずれることを防いでいる。重複を消す提案は、もうしない。
- **厳しい content security policy の確かめ方。** PNG と PDF の書き出しは、操作者が動いているアプリで確かめた。
  ライセンスのダイアログは、表示を見て確かめた。デモは、本物の `build:demo` のバンドルを `vite preview` で配り、
  Playwright で動かして (共有・ダウンロード・`?plan=` の往復を含む)、コンソールにエラーが無いことを確かめた。

## Rapid-repeat guards

**決定。** 「Check now」を続けて押すと、更新の確認が「Checking…」のまま戻らなくなった。これをきっかけに、
1 回目がまだ走っている間の 2 回目の押下が何をするかを、コントロールごとに監査した。結果は `src/main.ts` の
2 つの仕組みで、2 つを保つ。

- **ファイルのフローではない操作** (PNG・PDF・共有 URL・ライセンスのダイアログ・FOLLOW USB のバッジ・
  ライブ同期の開始) は、それぞれが自分用の `singleFlight` を持つ (`src/app/flow-latch.ts`)。
- **プランと設定ファイルのフロー** (新規・開く・保存・最近使ったファイル・ドロップしたファイル・設定ファイルの
  取り込み・機種の選択) は、1 つのラッチ `fileFlow` を共有する。これらの入口をまたいで、同時に走るフローは
  1 つになる。どの 2 つを続けて押しても、破棄の確認やファイルのダイアログが重ならない。

**今のままにしたもの。**

- Fetch・Write・Compare・セルフテストは、2 回目の押下が走行を取り消す。これが仕様。
- 設定のトグルと CONSOLE のコントロールは、同期の処理か、続けて操作することを前提にしたもの。
- 読み込みに失敗した「最近使ったファイル」は、一覧から自動で消し、ステータス行で知らせる
  (`status.recentRemoved`)。保存していない変更を破棄する確認は、今までどおり読み込みの前に出て、取り消すと
  何も起きない。

**却下した案。**

- **新規・開く・保存の自分用のラッチと、`liveActivating` のフラグを戻す。** 上の 2 つの仕組みに置き換えた。
  「開く」は `openPlanFrom` を通り、読みが何も返さないことが、ダイアログの取り消しを表す。
- **読み込みに失敗した「最近使ったファイル」を消す前に尋ねる。** 一度、尋ねる形に変えてから、自動で消す形に
  決めた。

**前提。** 更新の確認は、自分で時間切れを設定する (`src/core/platform.ts` の `UPDATE_CHECK_TIMEOUT_MS`)。updater の
プラグインの確認には、既定の時間切れが無い。設定してあるので、応答が失われたときは、確認が待ったままに
ならず、失敗の状態で終わる。

**MIDI ポートを続けて素早く切り替える操作。** MIDI ウィンドウの 2 つのポートの選択にも、同じ問いを当てた。
1 つ目のポートを開いている途中で、2 つ目・3 つ目の選択が何をするか、である。

- **開く・閉じるの順は、今のままにする。** ポートの選択は向き (入力・出力) ごとに 1 件ずつ走り
  (`src/ui/midi.ts` の `queuePort`)、順番が来る前に後の選択で置き換えられたものは飛ばされる。
  `src/ui/midi.test.ts` が、スタブのシェルに対してこれを固定している。1 つ目を開いている途中での 3 連続の
  選択 — A・B・C、A・B・A、ポート・なし・ポート (「runs … as the first choice and the last, one open at a
  time」) — と、開く処理の完了順を交差させた入力と出力の同時切り替え (「ends each direction on its own
  last choice when both are switched at once」) である。どれも、同時に開いている途中のものは 1 つだけで、
  置き換えられた選択はシェルに届かず、最後の選択が、開いていて・表示されていて・保存されている。
- **その待ち行列の外側にあった 3 件の欠陥を直した** (操作者の決定、2026-11-13)。どれにも、直す前は
  落ちていたテストがある。
  - こちら側の記録とシェルが持つポートの突き合わせ (`reconcileOpenPorts`) は、開く処理に追い越された
    答えは捨てていたが、閉じる処理に追い越された答えは捨てていなかった。答えが届く前に「なし」を選ぶと、
    その答えで選択が戻り、出力側では、閉じたポートに向けてフィードバックを送っていた。閉じる処理も、
    開く処理と同じように数える。`src/ui/midi.test.ts`: 「keeps None when it is chosen while the shell's
    answer about open ports is on its way」「keeps the output at None the same way, and sends nothing at
    the port it closed」。`e2e/midi.spec.ts`: 「None chosen while the shell is being asked survives the
    answer」。
  - ポートの選択の保存は、その時点で開いているものから両方の向きのエントリを書き直していた。そのため、
    このセッションがもう一方の向きのポートを開いていないと、そのエントリが消えた。向きごとに自分の
    エントリだけを書くようにし、「なし」は、選んだ向きのエントリを消す。`src/ui/midi-feedback.test.ts`:
    「keeps a saved input whose restore failed when an output is chosen」「keeps a saved input still being
    restored when an output is chosen meanwhile」「keeps the stored output it gave up on when an input is
    chosen afterwards」「stores None for the direction it was chosen on, and leaves the other entry」。
  - 操作者が別のポートに乗り換えたあとで前のポートを開く処理が失敗すると、その失敗がステータス行に
    出ていた。文言にポート名が入らず、乗り換え先のポートが開いたあとも残った。失敗を出すのは、その
    ポートがその向きの最新の選択である間だけにした (操作者の決定、2026-11-13)。`src/ui/midi.test.ts`:
    「says nothing about a failed input open the operator has already chosen away from」、出力側の同じ
    テスト、「still says a failed open that is the latest choice, after an earlier one was replaced」。
- **却下した案: その失敗を出しておき、後のポートが開いたときに消す。** 次のポートが開くまでの間、
  操作者が離れたポートの失敗が、ステータス行に出たままになる。
- **確かめきれていないこと: ページが送った 2 つのコマンドを、シェルがその順で受け取るか。**
  待ち行列が順番を付けるのは、ページが送る側である。上のテストはどれも、シェルの位置にスタブを置いて
  おり、ポートの Rust 側 (`src-tauri/src/midi.rs`) には、それ自体のテストが無い。順について分かって
  いるのは次のとおり。MIDI のコマンドはすべて同期コマンドで、シェルは同期コマンドを、webview が渡して
  きた順に 1 つずつ処理する。ページが 1 つ目の応答を待たずに 2 つの要求を出したとき、webview がそれを
  出した順でシェルに渡すことは、Tauri の文書では保証されていない。macOS の webview (WKWebView) では、
  出した順で渡る。Windows の webview (WebView2) では未確認である。
- **分かっていて、ガードを置いていないこと: 2 つのコマンドが処理される順で結果が変わる場所が 3 つ
  ある。** 1 つ目と 2 つ目は、シェルが 2 つのコマンドを送った順と逆に処理したときだけ誤る。3 つ目は、
  送った順のまま処理されたときに誤る。
  - 閉じる処理は、ポートの待ち行列の中で応答を待たない。「なし」は閉じるコマンドを送り、待ち行列は
    そのまま次へ進む (`applyInputPort`・`closeOutput`)。そのため、その閉じるコマンドと、同じ向きの次の
    開くコマンドが、同時に飛んでいることがある。逆の順で処理されると、シェルは新しいポートを開いた
    あとでそれを閉じ、ページはそのポートを開いていると表示し続ける。
  - 閉じるコマンドのあとに、開いているポートの問い合わせ (`refreshPorts` が走らせる
    `reconcileOpenPorts`) が続く場合。閉じる処理は送った時点で数えるので、そのあとに送った問い合わせの
    答えは捨てられない。逆の順で処理されると、答えは閉じている途中のポートの名前を返し、ページは
    その選択を戻してしまう。
  - 止まった出力の見切り (`abandonOutput`) は、閉じるコマンドを待ち行列の外から送る。その時点で次の
    出力を開くコマンドが飛んでいると、閉じるコマンドはその開く処理のあとにシェルへ届き、開いたばかりの
    ポートを閉じる。ページは、そのポートを開いていると表示する。これはコードを読んで見つけたもので、
    再現はしていない。

## Abort on failure is the operator's decision

**決定。** device のリンクでは、失敗した操作は、その操作の全体を中断する。決まりと恒久の例外は
[architecture.md](../architecture.md)「失敗時の中断」と `AGENTS.md`「Conventions」にある。これは操作者が決めた。
操作が失敗した後は、次の操作が頼る状態が分からなくなるので、どの操作も中断を基本にする、という決定。中断の
範囲を「厳しすぎる」として緩める提案は、設計の調整ではなく、この決定を覆す提案になる。

**経緯。** この決まりに向けて直したときに分かったこと:

- **先に、当てる範囲を決めた。** device のリンクは中断する。それ以外 (MIDI・保存領域) は、救えるものを救う。
  線を引かずにどの経路も厳しくすると、`localStorage` の容量切れや、後始末そのものまで、中断の理由になる。
- **「読めなかったものを書く」が、一番説明の付かない方針だった。** `diffPlan` は、読みが失敗したコマンドを
  差分に残していた。今の値を確かめられなかったパラメータを、たった今、当てにならないと分かったリンクを
  通して書くことになる。
- **1 つの決まりが、5 か所に手で書かれていた。** 綴りが 5 つ、メッセージが 3 つ、レポートの形が 2 つあった。
  `assertReadComplete` に集めた。
- **キューに入れるだけのコマンドを await しても、失敗は分からない。** 購読のコマンドは、シェルが要求をキューに
  入れた時点で戻っていたので、await しても、ブローカーが登録を断ったことを捕まえられなかった。今は、
  自分の返事でそれを知らせる。
- **読みの失敗を、書き込みの失敗として知らせない。** `formatWriteReport` は、何も書いていないのに、書き込みの
  失敗の数を出していた。`formatReadbackReport` は、前から、読みを正しく書いていた。

## Where the audit-derived tests live

unit の pin である `*.audit.test.ts` のほかに、監査は 3 つの spec に E2E のケースを残した。

| spec | 見ているもの |
| --- | --- |
| `e2e/chrome.spec.ts` | テーマ、言語、永続化、ズームの後のヒット判定 |
| `e2e/viewstate.spec.ts` | GRAPH か CONSOLE で行った編集が、もう一方のビューに出ること |
| `e2e/audit.spec.ts` | 機種を切り替えたときの選択のリセット、GRAPH と CONSOLE の間で EQ がそろうこと、send のレベルのグリッドの境界、言語を切り替えたときの再ローカライズ |

## What a robustness audit re-reads

core の堅牢性の監査は、ほかに何を見るかに関わらず、毎回これを確かめ直す。

- 3 つの機種それぞれで、ノードの id が重ならないこと。規則の向きが対称であること。
- 機種ごとの固定の配線の数。既定のプランが、指摘なしで検証を通ること。
- スキルの書き出しが、同じ入力で同じ結果になること。
- direct-follow が `translate` の逆変換であること。
- 14-bit の CC、learn の状態機械、device のロックの契約。
- `sanitizeMappings` が、前に保存したマッピングを読めること。
- 英語と日本語のカタログが、同じキーを持つこと。
- 電源の LED、SENDS のラック、不正な `?plan=` の扱い。
