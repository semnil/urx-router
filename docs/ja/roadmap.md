# ロードマップ

> English version: [../en/roadmap.md](../en/roadmap.md)

```mermaid
flowchart LR
  P1[Phase 1<br/>オフライン計画ツール] --> P2[Phase 2<br/>出力・ネイティブ統合]
```

## Phase 1 — オフライン計画ツール (完了)

実機非接続。3 機種すべてに対応。

- [x] 装置ルーティングモデル定義 (URX22 / URX44 / URX44V)
- [x] 接続制約エンジン (`source` / `patch` / `send` の多重度判定)
- [x] SVG ノードグラフ: ノード描画・ドラッグ移動・結線・不正経路の抑止
- [x] 未接続ノードの非表示シェルフ (収納・復帰、計画に永続化) ([architecture.md](architecture.md#未接続ノードの非表示))
- [x] 選択要素のインスペクタ (結線パラメータ表示)
- [x] JSON 保存 / 読込
- [x] PNG 出力
- [x] 自動整列
- [x] スタジオラック調 UI / ダーク・ライトテーマ切替 ([architecture.md](architecture.md#表示テーマ))
- [x] 多言語対応 (英語基本 + 日本語、実行時切替) ([architecture.md](architecture.md#多言語対応-i18n))
- [x] アプリアイコン (外部依存ゼロのジェネレータ `scripts/gen-icon.mjs` → `pnpm tauri icon`)

## Phase 2 — 出力とネイティブ統合 (現在)

- [x] PDF 出力 (依存ゼロ。`CompressionStream` で FlateDecode 画像を手書き PDF に埋め込み)
- [x] Tauri ネイティブのファイルダイアログ (保存先選択 / 最近使った計画。ブラウザではダウンロード/ファイル選択にフォールバック)
- [x] 結線パラメータ編集 (level / pan / pre-post) の UI (送りのみ。[device-model.md](device-model.md) §2)
- [x] サンプルレート設定と FX 無効化の警告表示 (96 kHz 超で INS FX / FX2、HDMI EQ を警告)
- [x] リリース workflow (`.github/workflows/release.yml`: `vX.Y.Z` タグ push で macOS `.dmg` / Windows `.msi`/`.exe` を `tauri-action` でビルドし draft Release に添付。[architecture.md](architecture.md#ビルドと配布))
- [x] ブラウザデモの GitHub Pages 配信 (`pnpm build:demo` + `.github/workflows/pages.yml`。保存 / 読込と PNG / PDF を非表示) ([architecture.md](architecture.md#ブラウザデモ-github-pages))
- [x] 署名・公証 (workflow は `MACOS_SIGNING_*` / `MACOS_NOTARIZATION_*` secret に対応済み。リポジトリ secret 設定済み)
- [x] 自動アップデート (updater プラグイン: 起動時にチェック → 確認ダイアログ → ダウンロード → 再起動。GitHub Releases の `latest.json` を参照。要署名鍵 secret。[architecture.md](architecture.md#自動アップデート))
