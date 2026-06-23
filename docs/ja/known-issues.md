# 既知の問題

現時点の制限事項の一覧。ルーティング規則の詳細は [device-model.md](device-model.md) を参照。

## CH → FX send の PRE/POST は実機へ反映できない

チャンネルから **FX 1 / FX 2** への send の PRE/POST は、プランナー上では自由に
編集でき (プランが意図する値を保持します)、software から URX へは書き込めません
(この設定は本体の操作パネル (LCD) からのみ変更できます)。そのため Live sync 接続中は
コントロールが読み取り専用 (disabled・マウスオーバーで注記) になり、値は実機の状態を
表示します (readback が最新に保ちます)。これはインスペクタの PRE/POST トグルと
CONSOLE ビューの PRE ボタンの両方に適用されます。オフライン (純粋なプランナー) では
編集可能なままです。

**CH → MIX** および **FX チャンネル → MIX** send の PRE/POST は従来どおり実機へ
反映できます。

> 背景: CH → FX send の PRE/POST は本体の操作パネルでのみ設定でき (broker が
> software からの書き込みを拒否する)、アプリは値を readback するため Live 中は
> 常に実機の真の値を表示します。

## CH SETTING の Icon は非対応

実機の CH SETTING には名前・色と並んで **Icon** の設定項目がありますが、プランナーでは
意図的に非対応としています。mono チャンネル (CH1–4) は実機がアイコンを broker に公開
しないため制御できず、stereo チャンネルとバスのみ公開する非対称な機能になってしまうため
です。名前 (`nodeNames`) と色 (`nodeColors`) は全ノードで読み書きできるため対応して
います。
