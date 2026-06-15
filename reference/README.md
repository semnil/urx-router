# reference — local copies of primary sources

> 日本語版: [README.ja.md](README.ja.md)

Local copies of the official Yamaha materials used as the basis for this project's routing model.

> **Copyright**: each PDF is copyrighted by Yamaha Corporation. To avoid redistribution, the PDF
> files themselves are **excluded from git** (`reference/*.pdf` is ignored in `.gitignore`); only
> this manifest is tracked. The file name, URL, and SHA-256 are recorded so they can be re-fetched
> from the source URL. For the structure reconstructed from the PDFs, see
> [`../docs/en/device-model.md`](../docs/en/device-model.md).

## Files

| File | Contents | Source URL | SHA-256 |
| --- | --- | --- | --- |
| `URX44V_URX44_URX22_Block_Diagram_En_B0.pdf` | Official block diagram V1.2 (`MWEM-B0`). Primary source for routing constraints | <https://usa.yamaha.com/files/download/other_assets/5/2927055/URX44V_URX44_URX22_Block_Diagram_En_B0.pdf> | `8adf9ede866a4b9e75db4b55f831eb6803e12411cd684d92fca3f1619228b7a4` |
| `URX44V_44_22_user_guide_En_C0.pdf` | Official user guide (`C0`) | <https://usa.yamaha.com/files/download/other_assets/8/2926848/URX44V_44_22_user_guide_En_C0.pdf> | `c201d4611e740a66a7093cfe2ae07d29813535e965b0d735b0a7ad8fdf6cb33a` |

## Related links (referenced while collecting)

- HTML user guide: <https://manual.yamaha.com/audio/music_audio_production/urx44_urx22/ug/en-US/>
- Download page (URX44): <https://usa.yamaha.com/products/music_production/interfaces/urx/urx44/downloads.html>
- Official control software **TOOLS for MGX / URX** (the future control-protocol analysis target)

## Re-fetching

```sh
curl -L -o reference/URX44V_URX44_URX22_Block_Diagram_En_B0.pdf \
  "https://usa.yamaha.com/files/download/other_assets/5/2927055/URX44V_URX44_URX22_Block_Diagram_En_B0.pdf"
curl -L -o reference/URX44V_44_22_user_guide_En_C0.pdf \
  "https://usa.yamaha.com/files/download/other_assets/8/2926848/URX44V_44_22_user_guide_En_C0.pdf"
```

## Reading it (macOS, without poppler)

The block diagram is a vector PDF. Where poppler (`pdftoppm`) is not installed, rasterize one page
with the built-in macOS QuickLook and crop it block by block.

```sh
qlmanage -t -s 8000 -o /tmp/bd reference/URX44V_URX44_URX22_Block_Diagram_En_B0.pdf
```

Crop regions of the PNG with Python (PIL) `Image.crop`. Even tiny labels — MIX "TO ST", DUCKER — are legible this way.
