# CLAUDE.md — urx-router

## 概要

YAMAHA URX22 / URX44 / URX44V 用ルーティングプランニングツール。公式ブロックダイアグラムに基づき、
入出力・ミキサーバス・出力パッチを SVG ノードグラフで可視化し、**接続可能な経路のみ**結線できるよう制約する。
計画は JSON で保存し画像出力する。実機への書込み・Live sync はデスクトップ版で常時有効 (vd プロトコル、`src/core/control/`)。

## 技術スタック

- Tauri 2 (デスクトップシェル, Windows 11 / Apple silicon macOS)
- TypeScript + Vite (フロントエンド)
- 描画は素の SVG。**ランタイム外部依存ゼロ** (npm パッケージ・CDN を runtime に持ち込まない)

## 構成

- `src/main.ts` — アプリエントリ。models/core/ui/i18n を配線
- `src/models/` — 機種定義。`build.ts` が機種パラメータから `DeviceModel` (nodes + 接続規則) を生成。`index.ts` が URX22/44/44V を登録。`initial-state.ts` の `defaultPlan` が新規プランの初期値を生成 (実機キャプチャ済み機種は工場初期値をシード。データは `initial-urx44v.ts` / `initial-urx22.ts`)
- `src/core/` — `routing.ts` 接続制約エンジン / `constraints.ts` サンプルレート依存の機能制限 (Phase 2 警告) / `plan.ts` 計画状態 + JSON / `levels.ts` 実機 level_gain の離散グリッド (設定可能な dB 値の正典 `LEVEL_STEPS_DB` + position/snap/step ヘルパー。フェーダー/Send レベルはこのグリッドにスナップし、刻みを等間隔で配置) / `storage.ts` 保存・読込・画像出力 (PNG/PDF、PDF は自前 FlateDecode) / `platform.ts` Tauri IPC ↔ ブラウザのランタイム橋渡し / `meters.ts` ライブレベルメーター (ノード id→broker メーターアドレス写像・dBFS デコード・最新値ストア。CONSOLE ビュー用) / `env.ts` ビルド時フラグ (`DEMO`: デモビルドで保存・画像出力を非表示)
  - `src/core/control/` — ライブ実機制御 (vd プロトコル)。書込み・Live sync はデスクトップで常時有効、`selftest.ts` の往復診断のみ `--experimental` 起動時
    - `vd.ts` 値エンコード / `translate.ts` plan→コマンド / `readback.ts` 実機→plan / `params.ts` 確定パラメータカタログ
    - `fx-effect.ts` FX チャンネルのエフェクト (Rev-X/Rev.R3/Mono Delay/Ping Pong) カタログ — 型選択+パラメーター配列の slot アドレッシングと raw↔表示エンコード
    - `insert-fx-effect.ts` インサート FX (Guitar Amp Classics/Pitch Fix/Compander-H/S/Multi-Band Comp) のエフェクトパラメーターカタログ — セレクタが束縛するエンジン配列 (Guitar 697/Pitch 701/Compander 689/出力 693) を slot アドレッシングで読み書き・raw↔表示は実機 LCD 較正値 (Compander は既存 COMP 系エンコード再利用、MBC/Pitch/Guitar は専用テーブル・SP Type/Amp Type/Scale 等の enum)
    - `client.ts` 書込みシーケンス+dry-run / `selftest.ts` 往復診断
    - `live.ts` 編集の実機即時反映 (snapshot 差分・debounce・snapshot と同時にアドレス→ノード索引を構築し `lookup` 公開)
    - `follow.ts` 実機側操作の盤面追従 (param notify 購読→`live.lookup` で分類: direct=ノードローカルスカラ (`params.ts` の `follow: "direct"`) を読み戻しなしで `applyDirect`・scoped=所有ノードのみ `applyNodeState` で読み戻し・未知/3 コントロール超は全体読み戻しへ昇格・アイドル時に保険の全体読み戻し)
- `src/ui/` — `graph.ts` SVG ノードグラフ (スタジオラック調・ダーク/ライトテーマ) / `inspector.ts` 選択要素 / `console.ts` CONSOLE ビュー (ミキサー型レベル一覧。GRAPH/CONSOLE タブで切替・同一 plan の別ビュー・フェーダー/MUTE/EQ 編集は `markChanged` 経由でグラフと同じ live 同期・send-on-fader・ライブメーターは Live sync 中のみ ~10Hz) / `glyph.ts` `∞` グリフを `.glyph-inf` span でラップし mono フォントの x-height 縮小を補正 (console 読み値・inspector 値で共有) / `consent.ts` 初回起動の同意ゲート (全画面 inert モーダル・免責文・`localStorage` 永続・拒否でアプリ終了・デスクトップのみ) / `load-report.ts` プラン読込失敗 (`?plan=` デコード失敗・ルーティング検証失敗) のコピー可能レポートモーダル
- `src/i18n/` — アプリ UI の i18n。`en.ts` 基準・`ja.ts` 翻訳、ランタイム言語切替 (`core/*` は言語非依存)
- `src-tauri/` — Rust シェル。webview ホスト + tauri-plugin-dialog + ファイル IO コマンド (read/write_text, write_binary) + 実機制御コマンド (`vd_connect/vd_info/vd_set/vd_get/vd_disconnect`、メーター購読 `vd_meters_subscribe/vd_meters_unsubscribe` と実機側変更購読 `vd_params_subscribe/vd_params_unsubscribe` は Tauri Channel で配信、`--experimental` ゲート: `experimental_enabled`/`self_test_requested` は self-test 専用)。インストーラーの同意ページは `bundle.licenseFile` (`LICENSE.txt` = 免責+商標+MIT)、同意ゲートの拒否時終了に `process:allow-exit` 権限
- `docs/en/` + `docs/ja/` — `device-model.md` (ルーティング規則の根拠) / `architecture.md` (アーキテクチャ) / `known-issues.md` (実機反映できない制限の一覧。英日両方を維持)
- `reference/` — 一次情報 PDF (ブロックダイアグラム・ユーザーガイド) と `.local/` の逆解析済み vd プロトコルダンプ (`vd-protocol.md`/`vd-params.md` 等、`control/` の根拠)。**別のプライベートリポジトリで管理し、この公開リポジトリからは README も含めディレクトリ全体を除外** (`.gitignore` の `/reference/`)
- `scripts/gen-icon.mjs` — 外部依存ゼロのアプリアイコン生成器 (`node scripts/gen-icon.mjs` → `pnpm tauri icon scripts/app-icon.png`)

## 開発

```sh
pnpm install
pnpm dev          # ブラウザ http://localhost:5173 (Rust 不要)
pnpm tauri dev    # デスクトップ起動 (Rust 必須。未導入なら rustup)
pnpm build        # tsc --noEmit + vite build
pnpm build:demo   # ブラウザデモビルド (VITE_DEMO=1。保存・画像出力を除外)
pnpm test         # vitest (core: routing/constraints/plan/levels/meters, control: vd/translate/readback/live/follow/fx, models)
pnpm test:e2e     # Playwright E2E (e2e/*.spec.ts: routing/hide/notes/multiselect/bustype/signaltype/insertfx 等)。CI は post-merge で実行
pnpm clean        # Vite キャッシュ (node_modules/.vite) + dist + Cargo target を削除
pnpm reset:storage # dev アプリ (ブラウザ) の localStorage をクリア = ?reset URL を開く
```

dev アプリの localStorage (テーマ/機種/メーターポイント/同意ゲート/最近のファイル/インスペクタ開閉) をリセットする手段: ブラウザは `http://localhost:5173/?reset` (または `#reset`) を開く (`pnpm reset:storage` が開く・起動時に同期クリアしフラグを URL から除去)、デスクトップは `pnpm tauri dev -- -- --reset-storage` 起動 (Rust が `--reset-storage` を読み frontend が clear+reload・`reset_storage_requested` コマンド)。両入口とも `src/main.ts` の reset routine に集約。

このマシン (Mac) では node/pnpm は nodenv (`~/.anyenv/envs/nodenv/shims`) 経由。非対話シェルでは PATH 未ロード。

`pnpm tauri dev` でバージョン表示や UI が古いまま固着する場合は `pnpm clean` でビルドキャッシュを破棄して再起動する (version は `tauri.conf.json`→`../package.json` をビルド時に埋め込むため Vite キャッシュに固着しやすい)。webview の永続データ (`localStorage` の同意ゲート等) はアプリ外なので `pnpm clean` の対象外で、macOS では `~/Library/WebKit/<productName または identifier>/` を手動削除する。

CI は 4 ワークフロー: PR は build + unit (`ci.yml`)、E2E と third-party ライセンス生成は post-merge (`post-merge.yml`)、ブラウザデモは `vX.Y.Z` リリースタグ push で GitHub Pages へ自動デプロイ (`pages.yml`)、デスクトップインストーラーも tag push (`release.yml`)。

## 規約

- コード識別子・コメントは英語。コメントは振る舞いの説明のみ。diff は最小化
- ドキュメントは日本語、図は Mermaid 記法
- **ルーティング規則を変える際は `docs/{en,ja}/device-model.md` と `src/models/` を必ず一致させる** (公式ブロックダイアグラムが一次情報)。`src/models/` を変えたら `urx-routing-planner` スキルの同梱データ (`scripts/models.json` + `references/model-*.md`) も `UPDATE_SKILL=1 pnpm test skill-export` で再生成してコミットする (生成器は `src/models/skill-export.ts`、ドリフトは `skill-export.test.ts` が CI で検知)
- テーマ配色は `src/style.css` の CSS 変数 (`:root` / `[data-theme="light"]`) と `src/ui/graph.ts` の `PALETTES` を一致させる
- 装置固有値・実機 UDID・制御プロトコル実値はコード/ドキュメントに書かない (プレースホルダ + git 管理外)。ただしアプリケーションの動作要件に関わる値 (機種パラメータ・ルーティング規則・level_gain グリッド・確定済み broker param のアドレス/エンコード等、アプリが正しく動くために本文・コードに必要な値) はこの規約の対象外で、`docs/` や `src/` に記述してよい
- 実機への書込み・Live sync (`src/core/control/`) はデスクトップ版で常時有効 (破壊リスクの同意は `src/ui/consent.ts` の初回起動ゲートとインストーラーライセンスで担保)。self-test 往復診断のみ `--experimental` 起動時。確定パラメータ (broker dump 照合済み) のみ書込み、推測アドレスは `params.ts` に載せない
- **機能追加・UI 変更時は `e2e/*.spec.ts` に E2E を追加し、PR 作成前にローカルで `pnpm test:e2e` を通すこと** (CI の post-merge 実行は通過済みコードのリグレッション網であり、追加・事前確認を免除しない)
- コミット: **メッセージは件名・本文とも全文英語** (Conventional Commits)。**PR の title/body も全文英語** (リポジトリ既定言語に合わせる)。グローバル CLAUDE.md の「日本語本文」規約はこのプロジェクトでは適用しない。意味単位で分割。push/PR は指示があってから

## 一次情報

- ブロックダイアグラム V1.2 (`MWEM-B0`): <https://usa.yamaha.com/files/download/other_assets/5/2927055/URX44V_URX44_URX22_Block_Diagram_En_B0.pdf>
- ユーザーガイド (HTML): <https://manual.yamaha.com/audio/music_audio_production/urx44_urx22/ug/en-US/>
- 公式制御ソフト: TOOLS for MGX / URX (将来の制御解析対象)
