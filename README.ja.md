# URX Router

YAMAHA URX22 / URX44 / URX44V USB オーディオインターフェース用の **ルーティングプランニングツール**。

公式ブロックダイアグラムに基づき、入出力チャンネル・ミキサーバス・出力パッチをボックスとワイヤーで可視化し、
**接続可能な経路のみ** GUI から結線できるよう制約する。作成した計画は JSON で保存・読込でき、ダイアグラムを画像出力できる。

> For the English version, see [README.md](README.md).

## デモ

ブラウザだけで動作（インストール不要）: **<https://urx-router.semnil.com>**
（デモ版ではファイルの保存・読込と画像出力を無効化）。

![URX44V のルーティング計画をダークのスタジオラック調テーマで表示した URX Router](docs/assets/screenshot-ja.png)

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
```

計画 UI は純フロントエンドのため、Rust 未導入でも `pnpm dev` でブラウザ動作確認できる。
デスクトップビルド (`pnpm tauri dev` / `pnpm tauri build`) には [Rust](https://rustup.rs/) が必要。

## デバイス制御（試験的・URX44V のみ）

デスクトップ版は Device Center 稼働下で、接続中のインターフェースの現在のミキサー設定を計画に読み込める
（**デバイス → デバイスから取得**）。パラメータの対応は **URX44V でのみ実機検証済み**で、**URX44** は同一と仮定、
**URX22** はそこからの推測 — いずれも実機未検証。

## ドキュメント

英語ドキュメントは [docs/en/](docs/en/) に、日本語訳は [docs/ja/](docs/ja/) に配置する。

- [docs/ja/architecture.md](docs/ja/architecture.md) — アプリ構成と設計判断
- [docs/ja/device-model.md](docs/ja/device-model.md) — 装置のルーティングモデルと接続制約

## ライセンス

[MIT](LICENSE) © semnil

配布するデスクトップビルドには Tauri ランタイムほかオープンソースコンポーネントが同梱され、
それらのライセンス表示はビルドに含める ([docs/ja/architecture.md](docs/ja/architecture.md#サードパーティライセンス) を参照)。

## 商標について

YAMAHA、URX22、URX44、URX44V は Yamaha Corporation の商標です。本ツールは非公式・独立の
ツールであり、Yamaha とは提携・スポンサー・公認のいずれの関係もありません。
