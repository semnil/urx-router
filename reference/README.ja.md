# reference — 一次情報のローカルコピー

> English version: [README.md](README.md)

本プロジェクトのルーティングモデルの根拠とした Yamaha 公式資料のローカルコピーを置く。

> **著作権**: 各 PDF は Yamaha Corporation の著作物。再配布を避けるため PDF 本体は **git 管理外**
> (`.gitignore` で `reference/*.pdf` を除外)。本マニフェストのみ追跡する。
> 入手元 URL から再取得できるよう、ファイル名・URL・SHA-256 を記録する。
> PDF から再構成した構造は [`../docs/ja/device-model.md`](../docs/ja/device-model.md) を参照。

## ファイル

| ファイル | 内容 | 入手元 URL | SHA-256 |
| --- | --- | --- | --- |
| `URX44V_URX44_URX22_Block_Diagram_En_B0.pdf` | 公式ブロックダイアグラム V1.2 (`MWEM-B0`)。ルーティング制約の一次情報 | <https://usa.yamaha.com/files/download/other_assets/5/2927055/URX44V_URX44_URX22_Block_Diagram_En_B0.pdf> | `8adf9ede866a4b9e75db4b55f831eb6803e12411cd684d92fca3f1619228b7a4` |
| `URX44V_44_22_user_guide_En_C0.pdf` | 公式ユーザーガイド (`C0`) | <https://usa.yamaha.com/files/download/other_assets/8/2926848/URX44V_44_22_user_guide_En_C0.pdf> | `c201d4611e740a66a7093cfe2ae07d29813535e965b0d735b0a7ad8fdf6cb33a` |

## 関連リンク (収集時に参照)

- HTML 版ユーザーガイド: <https://manual.yamaha.com/audio/music_audio_production/urx44_urx22/ug/en-US/>
- ダウンロードページ (URX44): <https://usa.yamaha.com/products/music_production/interfaces/urx/urx44/downloads.html>
- 公式制御ソフト **TOOLS for MGX / URX** (将来の制御解析対象)

## 再取得

```sh
curl -L -o reference/URX44V_URX44_URX22_Block_Diagram_En_B0.pdf \
  "https://usa.yamaha.com/files/download/other_assets/5/2927055/URX44V_URX44_URX22_Block_Diagram_En_B0.pdf"
curl -L -o reference/URX44V_44_22_user_guide_En_C0.pdf \
  "https://usa.yamaha.com/files/download/other_assets/8/2926848/URX44V_44_22_user_guide_En_C0.pdf"
```

## 読み取り (macOS, poppler なし)

ブロックダイアグラムはベクタ PDF。poppler (`pdftoppm`) 未導入の環境では macOS 標準の QuickLook で
PNG 化してからブロック単位に切り出して読む。

```sh
qlmanage -t -s 8000 -o /tmp/bd reference/URX44V_URX44_URX22_Block_Diagram_En_B0.pdf
```

生成された PNG を Python (PIL) の `Image.crop` で領域ごとに切り出して確認する。MIX「TO ST」・DUCKER など微小ラベルもこの手順で判読できる。
