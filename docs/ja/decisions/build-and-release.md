# Decisions: build, release, CI and distribution

> English version: [../../en/decisions/build-and-release.md](../../en/decisions/build-and-release.md)

アプリのビルド・検査・出荷について、閉じた判断を置く。何を決めたか、理由、却下した案、覆す条件を書く。
ビルドとワークフローの今の動きは [architecture.md](../architecture.md)「ビルドと配布」と各ワークフローの
ヘッダーにある。この文書は、そこに無い理由だけを持つ。

## Native dialogs go through tauri-plugin-dialog

**決定。** 開く・保存・メッセージのダイアログは、公式の `tauri-plugin-dialog` を呼ぶ。フロントは npm
パッケージを足さず、`src/core/platform.ts` からプラグインのコマンドを直接呼ぶ。選んだファイルの読み書きは
シェル自身のファイル用コマンドのままにして、プラグインのファイルの scope を設定しなくて済むようにしている。

**却下した案。** `rfd` クレートの上に手で書いたダイアログ。形は 2 つあった。非同期のファイルダイアログを
async の Tauri コマンドから待つ形は、macOS で完了しなかった。同期のダイアログをメインスレッドで走らせる
形は、1 回目は動き、2 回目で固まった。どちらも症状は同じで、「開く」「保存」で何も起きなかった。

## The release is dispatched on the tag without a personal access token

**決定。** `tag-release.yml` は `gh workflow run --ref <tag>` で `release.yml` を起動し、`release.yml` は
渡された ref の種類で、その run が何かを決める。仕組みは `CLAUDE.md`「Development」にある。入れた変更は
[#235](https://github.com/semnil/urx-router/pull/235)。

**理由。** リポジトリ自身のトークンで push したタグは、ワークフローを起こさない。dispatch の形にしたのは、
personal access token を増やさずに済むため。

**覆す条件。** この経路を作り直す提案は、personal access token 無しで成り立つことを先に満たす。

## No .git-blame-ignore-revs

**決定 (2026-08-16)。** リポジトリに `.git-blame-ignore-revs` を置かない。ファイルを再インデントした
コミットについて、ほかの手当てもしない。

**理由。** きっかけは、`scripts/check-assets-index.mjs` を入口のガードで囲んだときに、再インデントで
ファイルの blame の大半がその 1 コミットに寄ったこと (行数は
[#398](https://github.com/semnil/urx-router/pull/398) にある)。このファイルは理由をコードの横のコメントで
持っているので、blame に頼る度合いが低い。

## The message catalogs stay out of the coverage set

**決定 (2026-08-13)。** `src/i18n/en.ts` と `src/i18n/ja.ts` をカバレッジの対象から外す
([#362](https://github.com/semnil/urx-router/pull/362))。理由は `vitest.config.ts` のコメントにある。

**却下した案。** 2 つのカタログのフォーマッタを 1 つずつ呼ぶテスト。提案する前に走らせてあり、204 個の
フォーマッタは、例外を出さない・空でない文字列を返す・引数が出力に現れる・引数を変えると出力が変わる、の
4 点を満たした。未検証の案ではなく、コストを比べた上で除外を選んだ。

**今のままにしたもの。** 除外は 3 か所 (`vitest.config.ts`・`e2e/coverage-options.ts`・`.github/codecov.yml`) に
手で書いてあり、3 つをそろえる仕組みは無い。

**覆す条件。** 4 つ目のカタログが入るとき。それまでは、3 か所を守るガードは割に合わないと判断した。

## What the pull request template carries

テンプレートがどのチェックボックスを持つか、フォーマッタの実行がそこに無い理由:
[#238](https://github.com/semnil/urx-router/pull/238)。[#653](https://github.com/semnil/urx-router/pull/653) で改訂した。

## The demo deploys when the draft is published

**決定。** `pages.yml` は、人が draft のリリースを公開したときにデモを配る
([#283](https://github.com/semnil/urx-router/pull/283))。仕組みは `CLAUDE.md`「Development」にある。
次の 3 つは検討して、足さなかった: プレリリースを外すこと、新しいリリースの後で古いリリースが公開される
場合の防ぎ、同じリリースがもう一度公開されたときの配り直し。

**覆す条件。** この 3 つのどれかで実害が出たとき。

**実害の記録。** この変更の前、v1.6.3 の Pages の run は deploy の途中で取り消され、復旧は `main` への
dispatch で行った。そのため公開のデモはタグより先のコミットから作られていて、「デモはリリースに追従する」は
成り立っていなかった。

## A hand-dispatched Pages deploy is an exception

**決定。** `pages.yml` を `main` で手で dispatch することは、デモを配備するふだんの手段ではない。例外として
行ったことがあり、そのときは、アプリの部分について `main` と最新のリリースが同じだった。2026-10-10 には、
操作者の指示で 1 回行った。そのときの `main` は、v1.14.0 に、`index.html` に書くデモのリンクプレビュー画像の
寸法の修正 ([#561](https://github.com/semnil/urx-router/pull/561)) を足したものだった。

**dispatch の前に。** `git diff <リリースのタグ> origin/main` を読み、アプリの部分が両方で同じときに dispatch する。

## The release build's cache: what was left out

リリースのキャッシュを `main` で温めること、リリース経路の信頼性を優先して cargo-about のビルド済みの
バイナリを使わないこと: [#217](https://github.com/semnil/urx-router/pull/217)。

**却下した案。**

- `src-tauri/**` が変わったときだけ温める。キャッシュのエントリは 1 週間読まれないと消え、タグはどの
  マージの後にも来る。
- 置き場だけのライセンスファイルを `touch` で作る。Windows のランナーの既定のシェルに `touch` が無い。
- `dist` を作り物にして pnpm のステップを減らす。そのステップが温める pnpm のキャッシュは、リリースも読む。
- 2 つのワークフローの共通のステップを composite action にする。matrix はジョブの単位で畳めないので、
  間接参照が 1 つ増えるだけで、何も減らない。

## The vd commands are async fn with spawn_blocking

**決定。** ワーカーの返事を待つ `vd_*` コマンドは `async fn` にして、送信と待ちを
`tauri::async_runtime::spawn_blocking` の中で走らせる。`vd_disconnect` のように何も待たないコマンドは
同期のまま。理由 (同期のコマンドはウィンドウ自身のスレッドで走るので、待つたびに UI が固まった) は
`src-tauri/src/lib.rs` のコメントにある。

**却下した案。**

- コマンドごとに繰り返す `spawn_blocking` の行を、ジェネリックなヘルパーに畳む。型の境界が、置き換える
  行より読みにくい。
- ワーカーを tokio にする。非同期の返事の通り道には、リンクの WebSocket クライアントの載せ替えも要り、
  固まる問題に対して大きすぎる。

## The first-run consent gate runs after every declaration

**決定。** `void boot()` は `src/main.ts` の最後の文で、モジュールのどの宣言よりも後に置く。

**実害の記録。** `void boot()` が、同意のキーの名前を持つ定数の宣言より前で走っていたことがある。
デスクトップ版では、ゲートがその定数を初期化の前に読んで例外になり、`boot` は誰にも受け取られないまま
reject して、ゲートが出ず、アプリは同意なしで動き続けた。ブラウザでは、ゲートは定数に触る前に戻るので、
型検査・ビルド・ブラウザのテストはどれも通った。同意済みのプロファイルと見分けられたのは、同意のフラグが
webview のストレージに無かったことによる。

## The format check verifies and never writes

**決定 (2026-08-11)。** `format.yml` は整形を検査して、差分があれば失敗する。PR のブランチへは push
しない。コミットの前に `pnpm format` を走らせることは必須。規則は `CLAUDE.md`「Conventions」に、理由は
ワークフローのヘッダーにある。

**却下した案。** 必須チェックと一緒に、自動の整形コミットの push を残す形。2 つあった: personal access
token か GitHub App のトークンで push してワークフローを起こす形と、今のまま残して、起きたときに PR を
閉じて開き直して復旧する形。

**経緯。** それまでは、同じリポジトリの PR にワークフローが整形のコミットを push していた。リポジトリ自身の
トークンでの push はワークフローを起こさないので、そのコミットは check run を 1 つも持たない head になる。
必須のコンテキストが全部 "Expected" のまま残って PR はマージできず、症状からは直し方が分からなかった。
1 回起きた。

**`printWidth` は 120。** 候補の 3 つの幅を、既存のコードを最初に整形したときの差分の大きさで比べた:
100・110・120 で +4361・+2789・+2009 行。コードはもともと長い行が多く、120 が一番動かなかった。

## Coverage is uploaded once every report exists

**決定 (2026-11-09)。** `codecov/project` を必須チェックにし、送信は最後の `coverage` ジョブ 1 つに集め、
Codecov には全部がそろうまで報告を待たせる ([#754](https://github.com/semnil/urx-router/pull/754))。
送信の失敗は、PR ではジョブを赤にし、`main` への push では通す (送信の失敗でリリースを止めないため)。
`codecov/patch` は必須にしない。

**却下した案。**

- `codecov/project` を ruleset に足す代わりに、`coverage` ジョブが Codecov の結果を待って、自分の status
  として写す形。
- E2E の 3 つのシャードを 1 回の送信にまとめる形。4 本のままにして、シャードの名前を Codecov に残す。

**今のままにしたもの (2026-11-09)。** レビューの指摘 2 件に「今のまま」と答えた。

- 再実行で同じレポートが 2 回送られ、レポートが 1 つ欠けたままでも数が満たされうる。送信をレポートごとに
  分けているのは、unit と E2E の flag を分けるのに要るため。PR では、CI が失敗している間 Codecov は報告
  しないので、これに届くのは `main` で手で再実行したときだけ。
- レポートの artifact の保存は 1 日。これは 1 つの run の中の受け渡しで、保管ではない。1 日を過ぎた後の
  復旧は、全部のジョブの再実行で、レポートを作り直す。

## Windows jobs in ci.yml

**決定 (2026-10-26)。** `ci.yml` は unit テスト・`cargo test`・Chromium の E2E を Windows でも走らせ、
この 3 つのジョブを必須にする。調整画面の注記のレイアウトのテストは、文字そのものが占める領域で判定し、CSS は
変えない。変更は [#730](https://github.com/semnil/urx-router/pull/730) と
[#731](https://github.com/semnil/urx-router/pull/731)。

**決定 (2026-10-26): Prettier は LF のまま。** 改行が CRLF の checkout は、テストの側で受ける: checkout を
読むテストは改行をそろえて読み、テストが自分で作る一時リポジトリは `core.autocrlf=false` を自分で置く。

**却下した案。** Prettier の `endOfLine: auto`。CRLF で commit されたファイルを、format のチェックが
通すようになる。

## Windows ships NSIS only

MSI をやめた理由: [#221](https://github.com/semnil/urx-router/pull/221) と、
[architecture.md](../architecture.md)「ビルドと配布」。

**受け入れた代償。** `src-tauri/LICENSE.txt` は、ルートの `LICENSE` が持つ MIT の本文を重ねて持つ。
インストーラーが読めるファイルは 1 つで、2 つを合成できない。数行の変わらない文のために生成のステップを
足すより、重複のほうが安い。

## External fetches in CI

**決定。** E2E のジョブは公式の Playwright のイメージで走らせ、取得はやり直さない。どちらも、理由と一緒に
`.github/actions/install-browsers/action.yml` のヘッダーにある。

**却下した案。** apt が取ってくる `.deb` のキャッシュ。apt のアーカイブのディレクトリを残して戻すには、
両方の側で権限つきの準備が要る。Playwright は apt を自分で呼ぶので、オプションを渡せない。壊れやすい CI の
ステップは、後で人の手を食う。

## Dependabot: what merges on its own, and the branches it leaves

どの更新が自動でマージされるかは、[architecture.md](../architecture.md)「ビルドと配布」と
`.github/workflows/dependabot-auto-merge.yml` のヘッダーにある。

**決定 (2026-11-09)。** 自動でマージされた Dependabot の PR が残したブランチは、手で消す。自動化しない。

**理由。** リポジトリの「マージしたらブランチを消す」設定は、マージが人に帰属するときにだけ効く、と
前提している。ワークフローのトークンが自動マージを有効にしたとき、Dependabot が自分でブランチを消す
場合と消さない場合があり、2 つを分ける条件は見つからなかった。

**却下した案。**

- 定期実行のワークフローが、リポジトリのトークンでそういうブランチを消す。
- 自動マージを personal access token で有効にする。マージが `main` で `ci.yml`・`docs.yml`・
  `post-merge.yml` を起こすようになる。

## The recorded macOS platform version is declared in the repository

**決定 (2026-08-16)。** バイナリが記録する版は、`src-tauri/.cargo/config.toml` の `-platform_version`
リンク引数が宣言する ([#399](https://github.com/semnil/urx-router/pull/399)、
[#400](https://github.com/semnil/urx-router/pull/400))。cargo はこれを、リリースのビルドにも、`--target` を
付けないホストのビルドにも当てるので、1 か所の書き換えで両方が動く。

**却下した案。**

- CI で `DEVELOPER_DIR` を固定する。開発のビルドに届かない。
- 版を宣言して、比べるだけにする。バイナリの中身は何も変わらない。

## Ubuntu jobs name ubuntu-26.04

Ubuntu のジョブが `ubuntu-latest` ではなくイメージの版を名指す理由:
[#526](https://github.com/semnil/urx-router/pull/526) と
[#540](https://github.com/semnil/urx-router/pull/540)。

## The version lives in package.json alone

リリースの経路は、版の桁数を前提にしていない: [#405](https://github.com/semnil/urx-router/pull/405)。

**記録 (v1.13.0、2026-09-25)。** `package.json` の版は、バンドルが版を書く場所のすべてに届く。公開した
資産の名前、アップデーターのマニフェストの版、アプリの `Info.plist` の `CFBundleShortVersionString` と
`CFBundleVersion`、Windows のインストーラーの `FileVersion` と `ProductVersion` が、どれも 1.13.0 だった。
版上げのたびに、これを確かめ直す必要は無い。
