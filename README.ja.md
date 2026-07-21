# URX Router

YAMAHA URX22 / URX44 / URX44V USB オーディオインターフェース用の
**ルーティングプランナー 兼 非公式ミキサーコントローラー（読込 / 書込 / ライブ同期）**。

公式ブロックダイアグラムに基づき、入出力チャンネル・ミキサーバス・出力パッチをボックスとワイヤーで可視化し、
**接続可能な経路のみ** GUI から結線できるよう制約する。作成した計画は JSON で保存・読込でき、ダイアグラムを画像出力できる。

URX シリーズに dspMixFx は存在しない — dspMixFx が対応するのは UR-C / URX-C 系で、URX22 / URX44 / URX44V は
対象外。標準構成でフルミキサーを編集できるのは本体のタッチスクリーンだけで、公式の Stream Deck プラグインが
扱えるのはレベルの段階増減・ミュート・各ブロックの ON/OFF といったワンタッチ操作、Cubase / Nuendo / MixKey の
連携画面は各ソフトの起動中しか使えない。URX Router はこの空白を埋め、DAW の有無に関わらず PC からミキサー全体を読み書き・
ライブ同期できる — [デバイス制御](#デバイス制御) を参照。

> 背景 — このツールが存在する理由と開発の経緯を[開発記](https://blog.semnil.com/post-1348.html)にまとめた。

> For the English version, see [README.md](README.md).

## デモ

ブラウザだけで動作（インストール不要）: **<https://urx-router.semnil.com>**
（デモ版は保存ダイアログと画像出力に非対応。代わりに **計画 JSON をウィンドウにドロップして開く**、
計画の共有 URL 生成、デスクトップ版で開ける計画 JSON のダウンロードに対応）。

![URX44V のルーティング計画をダークのスタジオラック調テーマで表示した URX Router](docs/assets/screenshot-ja.png)

## ダウンロード

デスクトップ版（Windows 11 / Apple silicon macOS）は無料。最新のインストーラーは
[GitHub リリース](https://github.com/semnil/urx-router/releases/latest)、または
[BOOTH](https://semnil.booth.pm/items/8590010) / [Gumroad](https://semniluser.gumroad.com/l/urx-router)
から入手できる。デスクトップ版は自動更新に対応する。

## デバイス制御

デスクトップ版は Device Center（Yamaha の TOOLS for MGX / URX に同梱）稼働下で、接続中のインターフェースの
現在のミキサー設定を計画に**読み込み**（**デバイス → デバイスから取得**）、計画を実機へ**書き込める**（**デバイス →
デバイスへ書き込み** / 編集を逐次反映する **ライブ同期**）。パラメータの対応は **URX44V でのみ実機検証済み**で、
**URX44** は同一と仮定、**URX22** はそこからの推測 — いずれも実機未検証。書き込みは実機の現在の設定を上書きする
（[免責事項](#免責事項)を参照）。外部 MIDI コントローラーをコンソールのコントロールに割り当てることもできる
（**デバイス → MIDI コントロール**）。`--experimental` を付けると、これに加えて破壊・復元方式のセルフテスト診断が有効になる。

コンソールビューは同じ計画をミキサー面として表示する — ストリップごとのフェーダー・ミュート・EQ・
ダイナミクス・センド。ここでの編集も同様に実機へライブ同期され、ライブ同期中はライブメーターが動作する。

![URX44V をストリップごとのフェーダー・ダイナミクス・EQ・センドを持つミキサー面として表示した URX Router のコンソールビュー](docs/assets/screenshot-console-ja.png)

## Claude Code スキル

本リポジトリは [Claude Code](https://claude.com/claude-code) 用スキル
**urx-routing-planner** も公開しています。「マイク 1 を配信ミックスと FX1 のリバーブに送りたい」
のような自然言語の依頼を、検証済みの URX Router プラン JSON とデモへの `?plan=` ディープリンクに
変換します。実現可否は同梱の機種別ルート表から回答し、制御プロトコルの詳細は一切不要です。

このリポジトリのマーケットプレイスからプラグインとして導入できます:

```text
/plugin marketplace add semnil/urx-router
/plugin install urx-routing-planner@urx-router
```

スキルのルーティングデータはアプリと同じ機種定義（`src/models/`）から生成されるため、アプリと常に
一致します（`UPDATE_SKILL` の項目は [CLAUDE.md](CLAUDE.md) を参照）。

## 技術スタック

- **Tauri 2** (デスクトップシェル / Windows 11・Apple silicon macOS)
- **TypeScript + Vite** (フロントエンド、ランタイム外部依存ゼロ)
- 描画は素の SVG (ノードグラフライブラリ非依存)
- 英語を基本とし日本語ローカライズに対応した UI。実行中に切り替え可能
- スタジオラック調 UI / ダーク・ライトの 2 テーマ切替 (OS のカラースキームに追従、既定はダーク)
  ([docs/ja/architecture.md](docs/ja/architecture.md#表示テーマ))

## 開発

```sh
pnpm install
pnpm dev            # ブラウザで http://localhost:5173 (Rust 不要)
pnpm tauri dev      # デスクトップアプリとして起動 (Rust ツールチェーン必須)
pnpm build:demo     # ブラウザデモ版をビルド (VITE_DEMO=1: 保存ダイアログ・画像出力なし)
pnpm preview        # デモ版を http://localhost:4173 で配信 — 公開デモと同じビルド
```

計画 UI は純フロントエンドのため、Rust 未導入でも `pnpm dev` でブラウザ動作確認できる。
デスクトップビルド (`pnpm tauri dev` / `pnpm tauri build`) には [Rust](https://rustup.rs/) が必要。
`pnpm dev` は通常ビルド。機能を絞った **デモ版**（<https://urx-router.semnil.com> と同じもの）を
ローカルで見るには `pnpm build:demo` の後に `pnpm preview` を実行する。

全コマンド一覧（単体/E2E テスト・整形・キャッシュ削除）と開発上の注意は [CLAUDE.md](CLAUDE.md) にある。

既定では非表示の実機セルフテスト診断を有効にするには `--experimental` を付けて起動する:

```sh
pnpm tauri dev -- -- --experimental          # 開発
open -a 'URX Router' --args --experimental    # ビルド済みアプリ (macOS)
urx-router.exe --experimental                 # ビルド済みアプリ (Windows)
```

アプリの永続 UI 状態 (テーマ・機種・メーターポイント・同意ゲート・最近のファイル・インスペクタ開閉) を
クリアするには、ブラウザ版はリセット URL を開くか、デスクトップ版は起動フラグを付ける:

```sh
pnpm reset:storage                            # ブラウザ: http://localhost:5173/?reset を開く
pnpm tauri dev -- -- --reset-storage          # デスクトップ: webview の localStorage をクリア
```

## 免責事項

URX Router は、公式ドキュメントではなく独立した解析で判明した制御プロトコルでハードウェアと通信する。
書き込む各パラメータは接続中の実機に対して検証済みだが、ハードウェアへのデータ送信には常に一定のリスクが伴う。
**計画を実機に書き込むと、その時点のミキサー設定が上書きされる** — 残したい設定はあらかじめ
本体のシーン保存機能で保存しておくこと。

URX Router を使用することで、このリスクを受諾したものとする。本ソフトウェアは「現状のまま」提供され、
いかなる保証も伴わず、作者はその使用により生じたハードウェアの損傷・設定の喪失その他の損害について
一切の責任を負わない。デスクトップ版インストーラーは、この注意書きを[ライセンス](LICENSE)とともに表示し、
インストール前に同意を求める。

## ドキュメント

英語ドキュメントは [docs/en/](docs/en/) に、日本語訳は [docs/ja/](docs/ja/) に配置する。

- [docs/ja/architecture.md](docs/ja/architecture.md) — アプリ構成と設計判断
- [docs/ja/device-model.md](docs/ja/device-model.md) — 装置のルーティングモデルと接続制約
- [docs/ja/console-sends.md](docs/ja/console-sends.md) — CONSOLE ビューのストリップ内センドラック設計
- [docs/ja/known-issues.md](docs/ja/known-issues.md) — 現時点の制限事項

## ライセンス

[MIT](LICENSE) © semnil

配布するデスクトップビルドには Tauri ランタイムほかオープンソースコンポーネントが同梱され、
それらのライセンス表示はビルドに含める ([docs/ja/architecture.md](docs/ja/architecture.md#サードパーティライセンス) を参照)。

## 謝辞

URX22 のメーターマッピングは [@takashyx](https://github.com/takashyx) 氏が実機で検証してくださいました
([#173](https://github.com/semnil/urx-router/pull/173))。URX44V 以外の機種で初めて確定したメーターマッピングです。

## 商標について

YAMAHA、URX22、URX44、URX44V は Yamaha Corporation の商標です。本ツールは非公式・独立の
ツールであり、Yamaha とは提携・スポンサー・公認のいずれの関係もありません。
