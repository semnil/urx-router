# 既知の問題

現時点の制限事項の一覧。ルーティング規則の詳細は [device-model.md](device-model.md) を参照。

## CH → FX send の PRE/POST は実機へ反映できない

チャンネルから **FX 1 / FX 2** への send の PRE/POST は、プランナー上では自由に
編集でき (プランが意図する値を保持します)、software から URX へは書き込めません
(この設定は本体の操作パネル (LCD) からのみ変更できます)。そのため Live sync 接続中は
トグルが読み取り専用 (disabled・マウスオーバーで注記) になり、値は実機の状態を
表示します (readback が最新に保ちます)。オフライン (純粋なプランナー) では
トグルは編集可能なままです。

**CH → MIX** および **FX チャンネル → MIX** send の PRE/POST は従来どおり実機へ
反映できます。

> 背景: CH → FX send の PRE/POST は本体の操作パネルでのみ設定でき (broker が
> software からの書き込みを拒否する)、アプリは値を readback するため Live 中は
> 常に実機の真の値を表示します。
