# CLAUDE.md — urx-router

## 概要

YAMAHA URX22 / URX44 / URX44V 用ルーティングプランニングツール。公式ブロックダイアグラムに基づき、
入出力・ミキサーバス・出力パッチを SVG ノードグラフで可視化し、**接続可能な経路のみ**結線できるよう制約する。
計画は JSON で保存し画像出力する。実機反映は将来。

## 技術スタック

- Tauri 2 (デスクトップシェル, Windows 11 / Apple silicon macOS)
- TypeScript + Vite (フロントエンド)
- 描画は素の SVG。**ランタイム外部依存ゼロ** (npm パッケージ・CDN を runtime に持ち込まない)

## 構成

- `src/main.ts` — アプリエントリ。models/core/ui/i18n を配線
- `src/models/` — 機種定義。`build.ts` が機種パラメータから `DeviceModel` (nodes + 接続規則) を生成。`index.ts` が URX22/44/44V を登録。`initial-state.ts` の `defaultPlan` が新規プランの初期値を生成 (実機キャプチャ済み機種は工場初期値をシード。データは `initial-urx44v.ts` / `initial-urx22.ts`)
- `src/core/` — `routing.ts` 接続制約エンジン / `constraints.ts` サンプルレート依存の機能制限 (Phase 2 警告) / `plan.ts` 計画状態 + JSON / `storage.ts` 保存・読込・画像出力 (PNG/PDF、PDF は自前 FlateDecode) / `platform.ts` Tauri IPC ↔ ブラウザのランタイム橋渡し / `env.ts` ビルド時フラグ (`DEMO`: デモビルドで保存・画像出力を非表示) / `control/` ライブ実機制御 (vd プロトコル: `vd.ts` 値エンコード・`translate.ts` plan→コマンド・`readback.ts` 実機→plan・`params.ts` 確定パラメータカタログ・`client.ts` 書込みシーケンス+dry-run・`selftest.ts` 往復診断・`live.ts` 編集の実機即時反映 (snapshot 差分・debounce)。`--experimental` 起動時のみ有効)
- `src/ui/` — `graph.ts` SVG ノードグラフ (スタジオラック調・ダーク/ライトテーマ) / `inspector.ts` 選択要素
- `src/i18n/` — アプリ UI の i18n。`en.ts` 基準・`ja.ts` 翻訳、ランタイム言語切替 (`core/*` は言語非依存)
- `src-tauri/` — Rust シェル。webview ホスト + tauri-plugin-dialog + ファイル IO コマンド (read/write_text, write_binary) + 実機制御コマンド (`vd_connect/vd_info/vd_set/vd_get/vd_disconnect`、`--experimental` ゲート: `experimental_enabled`/`self_test_requested`)
- `docs/en/` + `docs/ja/` — `device-model.md` (ルーティング規則の根拠) / `architecture.md` (英日両方を維持)
- `reference/` — 一次情報 PDF (ブロックダイアグラム・ユーザーガイド) と `.local/` の逆解析済み vd プロトコルダンプ (`vd-protocol.md`/`vd-params.md` 等、`control/` の根拠)。**別のプライベートリポジトリで管理し、この公開リポジトリからは README も含めディレクトリ全体を除外** (`.gitignore` の `/reference/`)
- `scripts/gen-icon.mjs` — 外部依存ゼロのアプリアイコン生成器 (`node scripts/gen-icon.mjs` → `pnpm tauri icon scripts/app-icon.png`)

## 開発

```sh
pnpm install
pnpm dev          # ブラウザ http://localhost:5173 (Rust 不要)
pnpm tauri dev    # デスクトップ起動 (Rust 必須。未導入なら rustup)
pnpm build        # tsc --noEmit + vite build
pnpm build:demo   # ブラウザデモビルド (VITE_DEMO=1。保存・画像出力を除外)
pnpm test         # vitest (core: routing/constraints/plan, models)
pnpm test:e2e     # Playwright E2E (e2e/*.spec.ts: routing/hide/notes/multiselect/bustype/signaltype 等)。CI は post-merge で実行
```

このマシン (Mac) では node/pnpm は nodenv (`~/.anyenv/envs/nodenv/shims`) 経由。非対話シェルでは PATH 未ロード。

CI は 4 ワークフロー: PR は build + unit (`ci.yml`)、E2E と third-party ライセンス生成は post-merge (`post-merge.yml`)、ブラウザデモは `vX.Y.Z` リリースタグ push で GitHub Pages へ自動デプロイ (`pages.yml`)、デスクトップインストーラーも tag push (`release.yml`)。

## 規約

- コード識別子・コメントは英語。コメントは振る舞いの説明のみ。diff は最小化
- ドキュメントは日本語、図は Mermaid 記法
- **ルーティング規則を変える際は `docs/{en,ja}/device-model.md` と `src/models/` を必ず一致させる** (公式ブロックダイアグラムが一次情報)
- テーマ配色は `src/style.css` の CSS 変数 (`:root` / `[data-theme="light"]`) と `src/ui/graph.ts` の `PALETTES` を一致させる
- 装置固有値・実機 UDID・制御プロトコル実値はコード/ドキュメントに書かない (プレースホルダ + git 管理外)
- ライブ実機制御 (`src/core/control/`) は `--experimental` 起動時のみ有効。確定パラメータ (broker dump 照合済み) のみ書込み、推測アドレスは `params.ts` に載せない
- コミット: **メッセージは件名・本文とも全文英語** (Conventional Commits)。**PR の title/body も全文英語** (リポジトリ既定言語に合わせる)。グローバル CLAUDE.md の「日本語本文」規約はこのプロジェクトでは適用しない。意味単位で分割。push/PR は指示があってから

## 一次情報

- ブロックダイアグラム V1.2 (`MWEM-B0`): <https://usa.yamaha.com/files/download/other_assets/5/2927055/URX44V_URX44_URX22_Block_Diagram_En_B0.pdf>
- ユーザーガイド (HTML): <https://manual.yamaha.com/audio/music_audio_production/urx44_urx22/ug/en-US/>
- 公式制御ソフト: TOOLS for MGX / URX (将来の制御解析対象)
