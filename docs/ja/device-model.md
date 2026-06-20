# 装置ルーティングモデル

> English version: [../en/device-model.md](../en/device-model.md)

本ツールが扱う YAMAHA URX シリーズのルーティング構造と接続制約を定義する。
これは GUI 上で「接続可能な経路のみ結線できる」制約 (constraint engine) の根拠であり、
コード (`src/models/`) のデータ定義はこのドキュメントと一致させる。

## 出典

- 公式ブロックダイアグラム: `USB AUDIO INTERFACE URX44V URX44 URX22 V1.2 Block Diagram`
  (Yamaha Corporation, 2025、ファイル ID `MWEM-B0`)。
  URL: <https://usa.yamaha.com/files/download/other_assets/5/2927055/URX44V_URX44_URX22_Block_Diagram_En_B0.pdf>
- 公式ユーザーガイド (HTML): <https://manual.yamaha.com/audio/music_audio_production/urx44_urx22/ug/en-US/>

> 著作物のため PDF 自体はリポジトリに含めない。構造を本ドキュメントに自分の表現で再構成する。

## 機種パラメータ

| 項目 | URX22 | URX44 | URX44V |
| --- | --- | --- | --- |
| モノ入力チャンネル | CH1–2 | CH1–4 | CH1–4 |
| ステレオ入力チャンネル | CH3/4, 5/6, 7/8, 9/10 | CH5/6, 7/8, 9/10, 11/12 | CH5/6, 7/8, 9/10, 11/12 |
| MIC/LINE combo 入力 | 2 (1 は Hi-Z) | 4 (3/4 は Hi-Z) | 4 (3/4 は Hi-Z) |
| MIC IN (front mini) | あり (MIC/LINE 1 入力に内部結線) | 同左 | 同左 |
| AUX IN | あり | あり | あり |
| アナログ出力 | MAIN OUT | MAIN OUT + LINE OUT | MAIN OUT + LINE OUT |
| USB ポート | MAIN(32bit) + SUB(16bit) | MAIN + SUB | MAIN + SUB |
| USB DAW 録音 ch | 10 | 12 | 12 |
| microSD 録音 | なし | あり (最大16track) | あり |
| HDMI | なし | なし | IN / THRU (8→2 down-mix) |
| MIX Bus | STEREO + MIX1 + MIX2 | 同左 | 同左 |
| FX Bus | FX1 + FX2 | 同左 | 同左 |

## 信号フロー概略

```mermaid
flowchart LR
  subgraph IN[入力ソース]
    ML[MIC/LINE 1/2, 3/4]
    AUX[AUX IN]
    SD[microSD Playback]
    UMA[USB MAIN A/B/C]
    UDAW[USB DAW 1/2 … 11/12]
    USUB[USB SUB]
    HDMI[HDMI down-mix]
  end

  subgraph CH[ミキサーチャンネル]
    MONO["モノ CH<br/>Φ→HPF→GATE→COMP→EQ→INS FX"]
    ST["ステレオ CH<br/>EQ→INS FX→DUCKER"]
  end

  subgraph BUS[Bus]
    STEREO[STEREO MAIN]
    MIX1[MIX 1]
    MIX2[MIX 2]
    FX1[FX 1]
    FX2[FX 2]
    STREAM[STREAMING]
    MON[MONITOR 1-2]
  end

  subgraph OUT[出力]
    MAIN[MAIN OUT]
    LINE[LINE OUT]
    USBOUT[USB MAIN OUT A/B/C - SUB]
    SDREC[microSD Rec]
    DUCK[Ducker 1-4 Source]
  end

  IN --> CH
  MONO --> STEREO & MIX1 & MIX2 & FX1 & FX2
  ST --> STEREO & MIX1 & MIX2 & FX1 & FX2
  FX1 & FX2 --> STEREO & MIX1 & MIX2
  MIX1 & MIX2 -->|TO ST| STEREO
  STEREO & MIX1 & MIX2 --> STREAM & MON
  STEREO & MIX1 & MIX2 & STREAM --> MAIN & LINE & USBOUT & SDREC
  MONO & ST & STEREO & MIX1 & MIX2 -->|key| DUCK
```

## 接続の決定点 (constraint engine の根拠)

ルーティングは自由結線ではなく、装置内の固定信号路に対する **限られた決定点** で構成される。
各決定点は「接続元の集合」と「受け口の多重度」を持つ。本ツールはこれを `RoutingRule` として表現する。

接続種別 (`kind`):

- `source` — 受け口は **1 本のみ** (セレクタ)。チャンネルの入力ソース選択、Bus のソース選択。
- `patch` — 受け口は **1 本のみ** (出力パッチ / Signal Assign)。
- `key` — 受け口は **1 本のみ** (Ducker のサイドチェイントリガ選択)。`source` と同じセレクタだが、
  モノペアのソースミラーリングを持たないため独立した種別とする (後述 §10)。
- `send` — 受け口は **複数可** (Bus はミックス加算)。レベル/パン/PRE-POST を持つ。チャンネル/FX から Bus への Send。
  ただし固定の主フェーダー経路 (CH/FX リターン → STEREO) は LEVEL/PAN のみで **PRE/POST を持たない** (後述 §2)。
- `sendSwitch` — 受け口は **複数可** だが **ON/OFF のみ** (個別のレベル/パンを持たない Send)。MIX→STEREO の「TO ST」Send。

> `source` / `patch` / `key` の受け口は選択ワイヤを 2 本受け付けない (ソースは 1 本のみ)。
> `key` のワイヤはキャンバス上で `source` と同じ青のセレクタ色で描画される。

### 1. チャンネル入力ソース (`source`, 受け口 1 本)

各ミキサーチャンネルは以下から入力ソースを 1 つ選択する。MIC/LINE と USB DAW は実機の入力選択が
2ch ペア単位 (1/2, 3/4 / 1/2…11/12) のため、それぞれ 1 つのソースノードで表す。front mini ジャックは
MIC/LINE 1 入力に内部結線され、独立したソース選択肢としては存在しない。

| 選択肢 | URX22 | URX44 | URX44V |
| --- | --- | --- | --- |
| MIC/LINE 1/2 | ✓ | ✓ | ✓ |
| MIC/LINE 3/4 | — | ✓ | ✓ |
| AUX IN | ✓ | ✓ | ✓ |
| microSD Playback | — | ✓ | ✓ |
| USB MAIN A / B / C | ✓ | ✓ | ✓ |
| USB DAW 1/2 … N | ✓ (…9/10) | ✓ (…11/12) | ✓ (…11/12) |
| USB SUB | ✓ | ✓ | ✓ |
| HDMI (down-mix) | — | — | ✓ |

> URX44V では全チャンネル (CH1–4, 5/6, 7/8, 9/10, 11/12) が USB MAIN A/B/C・USB DAW 各ペア・USB SUB を
> 入力ソースとして選択可能 (実機確認済み)。
>
> **モノ CH のペア連動**: CH1–4 は CH1/2・CH3/4 がペアを成し、片方の入力ソースを確定するともう片方も同じ
> ソースに確定する (例: CH1 で MIC/LINE 1/2 を選ぶと CH2 も MIC/LINE 1/2 になる)。本ツールは同一ソースノードを
> 両 CH へ結線して表現する (L/R は CH の位置で暗黙的に決まる)。
>
> **All Input / All USB DAW はソースではない**: INPUT 画面の `[All Input]` / `[All USB DAW]` ボタンは
> 一括設定アクションで、1 タップで全チャンネルの入力ソースを固定テーブルに従って書き換える
> (All Input → CH1/2 = MIC/LINE 1/2・CH3/4 = MIC/LINE 3/4・CH5/6 = AUX IN / All USB DAW → CHn/n+1 =
> USB DAW n/n+1)。チャンネルごとに選択するソースではないため、ソースノードとしては扱わない。

### 2. チャンネル → Bus send (`send`, 受け口 複数可)

各チャンネル出力は以下の Bus へ Send できる (MIX / FX Send は ON/LEVEL、PRE/POST、PAN/BAL を持つ)。
LEVEL は共通の **level_gain** スケール **-∞ … +10.00 dB** (UG p155・スライダー最下=-∞ off、1 ステップ上が
-96.0 dB)。全フェーダー/Send/モニターが共有する。PAN/BAL は実機スケール **L63 – C – R63** (UG は C を
中央=nominal と記載・L63/R63 がハードパン端)。PRE/POST は **その Send を STEREO 主フェーダー
(= CH → STEREO のレベル) より前 (PRE) で取るか後 (POST) で取るか**を示す。
基準である STEREO Send 自身は PRE/POST を持たない。

- STEREO (TO ST) — **固定**: チャンネルの主フェーダー経路。ブロックダイアグラムでは破線の SEND ブロックの
  *外側*にあり、常に結線され付け替え・削除はできない (`fixed` Send)。本ツールは全計画に初期接続済みで
  シードし、LEVEL/PAN のみ編集可能 (**PRE/POST は持たない** — この経路が PRE/POST の基準点のため)。
- MIX 1 / MIX 2 (PRE/POST あり)
- FX 1 / FX 2 (PRE/POST あり)

> **BUS Type (MIX 1 / MIX 2、CH SETTING)。** 各 MIX Bus は VARI (Send ごとに可変レベル。既定でツールが
> モデル化する挙動) か FIXED (固定レベル — その Bus への Send は調整可能な LEVEL を持たない)。**Pan Link**
> (VARI 時のみ) は各 Send の PAN を送り元チャンネルの PAN に追従させ、個別 PAN を編集不可にする。MIX Bus
> ノードに保持し、接続パネルは FIXED で LEVEL、Pan Link で PAN を隠し、短い注記を表示する。

> 盤面上では PRE の MIX/FX Send を **破線＋ソース直後の琥珀色「PRE」タップマーカー**で表示し、接続を選択せずに
> 視認できる。POST (既定) は実線・無印。画像出力 (PNG/PDF) にも反映される。

### 3. Bus 間 (`send` / `sendSwitch`)

- FX 1 / FX 2 リターン → STEREO / MIX 1 / MIX 2 (`send`。**リターン → STEREO** は FX の主経路で
  同様に**固定** = 常時結線・削除不可・**PRE/POST なし**。初期レベルは **-∞ (オフ)** でシードし、上げるまで
  主ミックスに加算されない。MIX 1/2 への Send は任意で PRE/POST あり)
- OSCILLATOR → STEREO / MIX 1–2 / FX 1–2 (`sendSwitch`、加算 Send ではなく ON/OFF
  アサイン。オシレーターは単一のグローバルレベルを持つ。ステレオ宛先はワイヤに独立 L/R
  (`oscL` / `oscR`) を保持し、FX バスはモノ)
- MIX 1 / MIX 2 → STEREO (`sendSwitch`、ブロックダイアグラムの MIX 1–2 OUT 内「TO ST」。ON/OFF のみで独立した LEVEL/PAN は持たない)

> **Post Fader Send for FX (DAW Integration メニュー、V1.2 以降)。** 各 FX Bus は MIX Bus から
> **post-fader** で追加供給できる (FX 1 ← MIX n、FX 2 ← MIX n)。対応 DAW ソフト接続時のみ表示される。
> FX Bus ノードのセレクタ (— / MIX 1 / MIX 2、既定は none) としてモデル化し、描画ワイヤではなく
> デバイスのドロップダウンを再現する。

### 4. ストリーミング / モニタソース (`source`, 受け口 1 本)

- STREAMING 入力ソース ← STEREO OUT / MIX 1 OUT / MIX 2 OUT (DELAY あり)
- MONITOR 1–2 ソース ← STEREO OUT / MIX 1 OUT / MIX 2 OUT (MONO)

STREAMING チャンネルは **DELAY** を持つ (DELAY 画面、STREAMING チャンネル専用)。on/off、**Delay Time**
(1.00 … 1000.00 ms、0.01 ms 刻み)、**Frame rate** セレクタ (24 / 25 / 29.97D / 29.97 / 30D / 30 / 60 /
120) で構成される。遅延量は単一の時間値で、Frame rate はその時間をフレーム数で表示する際の換算にのみ影響し、
遅延そのものは変えない。結線ではなくストリーミングバスノード (インスペクタの DELAY セクション) で編集する。

### 5. 出力パッチ (`patch`, 受け口 1 本)

アナログ出力 (MAIN / LINE) のソース選択。

| 出力 | 選択可能ソース | URX22 | URX44/44V |
| --- | --- | --- | --- |
| MAIN OUT | STEREO / MIX1 / MIX2 / STREAM / MONITOR1 / MONITOR2 | ✓ | ✓ |
| LINE OUT | 同上 | — | ✓ |

> PHONES 1 / 2 / front は MONITOR 1 / MONITOR 2 / MONITOR 1 への **1 対 1 固定結線**で
> ソース選択を持たないため、DAW Rec と同様に**編集対象ノードとして表現しない**
> (ユーザーガイド: 「Monitor 1、2 の信号は PHONES 1、2 から出力されます」)。

### 6. USB OUT Signal Assign (`patch`, 受け口 1 本)

| 出力 | 選択可能ソース |
| --- | --- |
| USB MAIN OUT A / B / C | STEREO OUT / STREAM OUT / MIX1 OUT / MIX2 OUT / CH 1–N OUT |
| USB SUB OUT | 同上 |

### 7. DAW Rec Signal Assign (固定、ノード非表示)

- CH n OUT → USB DAW OUT n の **1 対 1 固定結線** (ブロックダイアグラムにソース選択 box は無い)
- ルーティングを変更できないため、**編集対象ノードとしては表現しない** (`USB DAW OUT` ノードは持たない)
- N = 10 (URX22) / 12 (URX44, URX44V)

### 8. SD Rec Signal Assign (`sendSwitch`, 受け口 1 本、URX44 / URX44V のみ)

- microSD Rec 1/2 … 15/16 ← STEREO OUT / MIX 1–2 OUT / CH 1–N OUT (最大16track)
- **ON/OFF の録音ソース割当**であり加算 Send ではない: RECORDER メニュー (Track Count + Source 選択 +
  読取専用のレベルメーター) もブロックダイアグラム ("SD Rec Signal Assign") も**ソース毎の
  level / pan / PRE-POST を持たない**。録音されるタップ位置はチャンネルの **Rec Point**。
- microSD 再生は 2track (ステレオ)。本モデルでは入力ソース `microSD Playback` 1 個として表す。

> **録音トラック数の根拠**: URX44V は microSD へ **最大16トラック録音 / 2トラック再生**
> (Yamaha 公式 URX44V 製品スペック)。URX44 も microSD 録音に対応する。
> DAW 録音は USB 経由で **1–12 が個別チャンネル**として扱える (実機確認済み)。

> **v0.1 の簡略化**: microSD Rec は本来トラックスロット単位だが、v0.1 ではノード過多を避けるため
> 1 つのグループノードとして複数ソースを受ける (各ソースを `sendSwitch` 割当) 表現に簡略化している。
> スロット単位の割当 UI は Phase 2 で対応する。

### 9. HDMI THRU (固定パススルー、ノード非表示、URX44V のみ)

- HDMI 入力 (Audio 2ch + Video) → HDMI THRU の **1 対 1 固定結線**。ソース選択を伴わないため、
  DAW Rec と同様に**編集対象ノードとして表現しない**。
- HDMI 入力自体はチャンネルの選択可能な入力ソースとして残る。

### 10. Ducker キーソース (`key`, 受け口 1 本)

- Ducker 1–4 Source ← CH 1–N OUT / STEREO OUT / MIX 1 OUT / MIX 2 OUT (サイドチェーンのトリガ選択)
- 各 Ducker は 1 つのステレオチャンネルに搭載されるため、Ducker 1–4 は機種のステレオペアに順番に対応する: URX22 = CH 3/4・5/6・7/8・9/10、URX44 / URX44V = CH 5/6・7/8・9/10・11/12。盤面のノードラベルは単に `Ducker` とし、搭載先ペアは副題 (`CH 5/6 · Source`) に表示する。1–4 の序数はブロックダイアグラム上の列挙であり、ぶら下げ位置で搭載先 CH が分かるためノードには重ねて表示しない。
- 表示上、Ducker は独立した出力ではなく搭載先チャンネルに属するため、専用種別 `ducker` のノードとして対応ステレオチャンネルの真下にぶら下げて描く (配置・移動・非表示の挙動は [architecture.md](architecture.md) 参照)。

## 固定 (結線不可) の要素

- チャンネルストリップの処理順 (Φ → HPF → GATE → COMP → EQ → INS FX) は固定。
  チャンネルの **Rec Point** (録音 / ダイレクトアウトのタップ) はこのチェーン上の段を選ぶ:
  MONO IN は PRE GATE / PRE COMP / PRE EQ / PRE INS FX / PRE FADER、ST IN (EQ のみ) は
  PRE EQ / PRE FADER。既定は PRE FADER。配線ではなくチャンネルごとのパラメータとして保持する。
- MONO IN は **COMP/EQ Type** (CH SETTING) で COMP→EQ と **SSMCS** (Sweet Spot Morphing Channel Strip)
  を排他に切り替える。SSMCS は COMP / 4-band EQ を専用のモーフィング処理に置き換える:
  **Sweet Spot Data** プリセット (汎用 6 + アーティスト/用途 28 = 34) を 1 つ選び、**Comp Drive** /
  **Morphing** / **Out Gain** で追い込む。内部のコンプは Attack / Release / Ratio / Knee と
  サイドチェインフィルタ (Q / Freq / Gain) を持ち、EQ は **3 バンド (Low シェルフ / Mid ピーキング /
  High シェルフ)** で 4-band PEQ とは別物。ST IN は SSMCS を持たない (常に EQ のみ)。
  インスペクタは Type に応じて COMP/EQ セクションを SSMCS セクションへ差し替え、SSMCS Main
  セクションは GATE と COMP の間に置く。SSMCS と COMP→EQ は実機上で別バンクのため、Type 切替時は
  対象バンクの工場初期状態をシードする: SSMCS は COMP/EQ を ON にし全値を実機初期値にリセット、
  COMP→EQ は COMP OFF / EQ ON に戻す (COMP→EQ 側の値は維持)。初期値は実機 MONO IN の
  SSMCS バンク (既定 "01 Basic" プリセット適用) を読み取った値。
- モノ CH とステレオ CH の構成は固定 (機種で本数のみ変化)。MONO IN ペア (CH1/2, CH3/4) は
  **Signal Type** (CH SETTING) を持つ: STEREO は隣接 2 ch をリンク、MONO × 2 は独立 (既定)。
  ツールは 2 ノードを維持しフラグをペアの primary (奇数 ch) に保持する (1 ノードに統合しない)。
  リンク時はペア間に ♥ タイを描く。STEREO は **PAN / BAL** モードを追加。モード切替時 (および STEREO
  化時) に、ペア両 ch の**全 bus send** (STEREO / MIX 1–2 / FX 1–2) の pan を初期化する: PAN は奇数 ch を
  左 (L63 = −63)・偶数 ch を右 (R63 = +63) にハードパン、BAL は両方中央 (C = 0) にし Send pan は
  ネイティブのステレオ ch 同様 BALANCE 表示になる。これ以外の全パラメータ自動ミラーは実機挙動だが自動適用しない。
- **CH n → STEREO と FX 1/2 リターン → STEREO は固定の Send** (主フェーダー / リターンの経路)。
  常時結線され初期接続済みで表示し、削除不可。上記の要素と異なり LEVEL/PAN を編集できるため、
  (表示ノード間の) 配線として描画する。固定なのは経路のみ。
- PHONES 1/2/front は MONITOR Bus への 1 対 1 固定結線 (ソース選択なし、ノード非表示)。PHONES は
  対応する MONITOR バスと同一信号だが独立した **PHONES Level** (単位なしの 0.0 … 10.0 スケール、
  モニタフェーダーとは別) を持ち、MONITOR 1 / 2 ノードで編集する (PHONES 1 ↔ MONITOR 1、
  PHONES 2 ↔ MONITOR 2)。
- CUE Bus (ソロ/モニタ割り込み) は **表現しない**: ルーティングが電源 OFF で削除され、
  保存する計画として永続的な割当を保持できないため。

## サンプルレート依存の制約

| 制約 | 条件 |
| --- | --- |
| INS FX 利用不可 | サンプルレート 96 kHz 超 |
| FX2 利用不可 | サンプルレート 96 kHz 超 |
| HDMI EQ 利用不可 | サンプルレート 176.4 / 192 kHz |
| HDMI down-mix EQ | 入力が 2ch のときのみ有効 |

> Phase 2 ではこれらを **警告** として表示する (インスペクタの注記 + 該当ノードの減光・破線表示)。
> 結線自体の禁止には用いない。サンプルレートは計画ごとに設定し、計画 JSON に保存する。
> 結線の厳密化は将来の実機反映で行う。
