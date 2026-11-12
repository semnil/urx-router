# ローカルでの走らせ方

> English version: [../en/local-runs.md](../en/local-runs.md)

開発のマシンで、テスト・ビルド・1 回だけの評価を走らせるときの手順。コマンドそのもの、ポートの決まり、
プロセスを止めるときの決まり、dev アプリの起動の確かめ方は `CLAUDE.md`「Development」にある。この文書は、
その周りの、ときどきしか要らない手順を持つ。

## E2E の spec からライブ同期のセッションを始める

`e2e/tauri-stub.ts` は `LIVE_COMMANDS` を export している。セッションが、読み取りに加えて行う登録の一式で、
ライブ同期を ON にする spec は、これを `commands` に渡す。渡さないと、セッションが成立する前に、開始の処理が
中断する。

開始のボタンについて、2 つ。

- `#btn-live` は `#device-menu` の項目なので、spec は先に `#btn-device` をクリックする。
- 項目を選ぶとメニューは閉じ、項目は隠れたままになる。見えることを待つ形は、通らない。要素が付いているだけの
  状態で、属性を待つ:
  `page.waitForSelector('#btn-live[aria-checked="true"]', { state: "attached" })`。

## E2E のポートに残ったサーバーを見つける

ポート 4173 か 4174 に残ったサーバーが、次の走行に何をするかは、`CLAUDE.md`「Development」にある。残っているか、
どのバンドルを配っているかは、そのポートが配っているチャンクの名前を読み、ディスクのビルドの出力と比べる。

```sh
curl -s localhost:<port>/ | grep -o 'assets/main-[A-Za-z0-9_-]*\.js'
ls dist/assets/main-*.js
```

- `index.html` の入口は `/src/main.ts` なので、Vite が出すチャンクは `main-<hash>.js` になる。
- 結果が空でも、サーバーが無い証拠にはならない。別の接頭辞を探すパターンは、生きているサーバーに対しても
  何も返さない。
- ディスクのハッシュと違えば、そのポートは、このツリーが最後にビルドしたバンドルを配っていない。ポート 4174 の
  ビルドの出力は `dist-trace/`。

止める前に、誰のプロセスかを、見つけたのと同じコマンドの中で読む。listener は 2 つのコマンドの間に終わることが
あり、そうなると、誰のものだったかを言う手掛かりが残らない。

```sh
for p in $(lsof -tnP -iTCP:<port> -sTCP:LISTEN); do ps -o pid,ppid,lstart,command -p $p; lsof -a -p $p -d cwd -Fn | grep '^n'; done
```

4173 と 4174 の対は、E2E のサーバー (`pnpm e2e:serve`) のもの。`pnpm tauri dev` が待ち受けるのは 5173 だけ。
コマンドラインと作業ディレクトリから、自分の走行だと分かったときだけ、その PID を止める。

## worktree とほかのチェックアウトのカバレッジを比べる

`*.local.test.ts` のファイル (`src/core/control/urxf.local.test.ts`・
`src/core/control/dyn-time-stops.local.test.ts`) は、このリポジトリに含まれないサンプルのファイルを読み、
ファイルが無い場所では、そのケースを skip する。新しい worktree にはそのファイルが無いので、同じコミットでも、
そのケースが通るモジュールの行カバレッジは、ファイルがあるチェックアウトより低く出る。同じコミットの 2 回の
走行で数字が違うのは、入力のファイルの有無で、走行ごとに変わるスイートではない。

前後を比べるときは、両方を同じ条件で測る。両方にサンプルのファイルを置くか、両方とも置かない。

## `work/` の下の作業用のファイル

`.gitignore` は `work/` を無視しない。その直下に置いたファイルは、`git status` に `?? work/` と出る。

- その作業の後まで残さなくてよいファイル (例: プルリクエストの本文の下書き) は、リポジトリの外に置く。
- 残すファイルは、サブディレクトリ `work/<name>/` に置き、そのサブディレクトリの 1 行を、チェックアウトの
  `.git/info/exclude` に足す。

## `src/` のモジュールを、テストなしで 1 回だけ評価する

`node_modules/.bin` には `esbuild` があり、`tsx` と `vite-node` は無い。関数を 1 回だけ評価するとき (例: 計算した値を
期待の値と比べる) は、小さい入口のファイルをバンドルして走らせる。

```sh
node_modules/.bin/esbuild <entry>.ts --bundle --platform=node --format=esm --outfile=<out>.mjs
node <out>.mjs
```

- リポジトリの外に置いた入口のファイルは、import を自分の場所から解く。`./src/...` は `Could not resolve` で
  落ちる。リポジトリの絶対パスで import する。
- 呼ぶ前に、export のシグネチャを読む。例えば `src/core/eq-response.ts` の `bandResponse` は、周波数を受ける
  関数を返す。周波数の配列は受けない。

## 新しい worktree の最初のビルド

`src-tauri/tauri.conf.json` は、`src-tauri/THIRD_PARTY_LICENSES.html` をリソースとして同梱する。このファイルは git が無視する。
新しい worktree にはこのファイルが無く、最初のビルドは、ビルドスクリプトの `resource path ... doesn't exist` で
落ちる。`pnpm tauri dev` でも、`cargo check` と `cargo test` だけでも、同じように落ちる。

- 配布物を作らないなら、ファイルの中身は読まれない。ほかのチェックアウトのファイルを写すか、CI のジョブと同じ形で
  空のファイルを書く: `echo "" > src-tauri/THIRD_PARTY_LICENSES.html`。
- 本物を作るときは、`src-tauri/` で `cargo about generate` を、`.github/workflows/licenses.yml` が渡している引数で流す。
- worktree の `pnpm tauri dev` のコマンドを人に渡す前に、このファイルがあることを確かめる。

## コミットごとに、単独で緑かを確かめる

変更を複数のコミットに分けたときは、コミットごとに、使い捨ての detached の worktree で確かめる。

```sh
git worktree add --detach <dir> <sha>
```

- `node scripts/check-md-tables.mjs` と `node scripts/check-assets-index.mjs` は依存を持たないので、
  `pnpm install` なしで、そこで走る。
- 終わったら `git worktree remove --force <dir>` で消し、`git worktree list` で消えたことを確かめる。
- git のチェックアウトではないディレクトリへ、コミットを展開しない (`git archive`・`git checkout-index`)。
  `scripts/check-assets-index.mjs` は、無視されるパスを `git check-ignore` に尋ねる。リポジトリの外では、その
  問いに答えが無く、検査は実際には無い指摘を出す。
- コミットは SHA で名指す。`HEAD~2` のような相対の指定は、コマンドを走らせたチェックアウトの HEAD から解かれる。
  シェルが別の worktree にいると、別のコミットになる。

## 確かめるためにデスクトップアプリを起動する

コマンドは、README の dev の行 (`pnpm tauri dev`。experimental の機能を出すときは、後ろに
`-- -- --experimental` を付ける)。

- **ログインのプロファイルを読んでいないサブシェルの `PATH` には、Node も Cargo も無い。** Node の版を
  切り替える道具の shims、Cargo のバイナリ、パッケージマネージャーのディレクトリを、前に足す。
- **SIM ビューが、シミュレーターのフォントを名指す `Failed to resolve import` で読めないとき**は、シミュレーターが
  `node_modules` につながっていない。CLAUDE.md「Development」の準備のコマンド (submodule、その後に
  インストール) を走らせる。追跡しているファイルは変わらない。
- **アプリが上がったかどうか**は、ログではなく、プロセスで答える。CLAUDE.md「Development」の
  「The dev app being up is a process, not a log line」。
- **アプリは、submodule が指すコミットのシミュレーターを動かす。** シミュレーターのリポジトリでまだ
  マージされていない変更は、アプリに入っていない。見たことを報告するときに、そう書く。
- **ウィンドウを閉じると、コマンドは終了コード 0 で終わる。**
- **止めるときは、自分が起動した `pnpm`・`vite`・アプリのプロセスだけを止める。** コマンドの文字列を
  読んでから止める。同じマシンで、別のセッションの `vite` が動いていることがある。
