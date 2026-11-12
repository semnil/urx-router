# Decisions: device control

> English version: [../../en/decisions/device-control.md](../../en/decisions/device-control.md)

実機と話す層 (`src/core/control/` と `src-tauri/src/vd.rs`) について、閉じた判断を置く。使う経路、書かない設定、
実装しないものが対象になる。この層の仕組みは [architecture.md](../architecture.md) の「実機制御の接続」に、
今できないことは [known-issues.md](../known-issues.md) にある。この層の上で動くライブ同期とデバイス追従の判断は
[live-sync.md](live-sync.md) にある。下の「操作者」は、このプロジェクトの作業を指示し、決める人のこと。実機への
経路を足す前、この層が触らない設定を書く前、下の節が「実装しない」と挙げるものを実装する前に、ここを読む。

## The app reaches the unit through Device Center's official route

**決定 (操作者)。** 統合を優先する。アプリは、MIDI で実機を動かさず、実機を自分で開くこともしない。Yamaha の
Device Center が立てるローカルのブローカーへつなぎ、そのブローカー自身のプロトコルで話す。コードは、これを
vd プロトコルと呼ぶ。

**帰結。** Device Center が動いていて、実機がつながっていることが、制御の機能の前提になる
(architecture.md「実機制御の接続」)。

## The unit's USB MIDI port is not a control route

**決定。** 制御の層は、実機がコンピューターに見せる USB MIDI ポートを使わない。ユーザーガイドは、このポートを
実機の DAW Integration に割り当てている (「Using the Software Integration functions」)。上のプロトコルとは
別の系統で、`src/core/control/` の外にある。

外部 MIDI コントロール (architecture.md「外部 MIDI コントロール」) は、これとは別のもの。コントローラーの
メッセージがアプリに入ってきて、アプリ自身のコントロールを動かす。

## One route only: the port Device Center advertises for the session

**決定 (2026-10-14、操作者)。** アプリは、Device Center がセッションごとに知らせるポートでつなぐ。ほかの経路は
使わない。前の WebSocket の経路 (`casket`) は、[#300](https://github.com/semnil/urx-router/pull/300) まで既定
だった。[#631](https://github.com/semnil/urx-router/pull/631) で、その依存と、起動フラグ
`--experimental --casket` と一緒に、アプリから消した。戻すこと、フォールバックとして残すことは、もう提案しない。

**理由。** アプリは、Device Center 自身のウィンドウや、ブローカーのほかのクライアントと並んで動くものとして
作っている。セッションごとのポートが、複数のクライアントを同時に相手にすることを前提にしている。それぞれの
変更の中身は、2 つの PR にある。

## Follow is classified per address, not per feature

**決定。** アプリがプランの値を押し戻すか、変化を実機に任せるかは、アドレスごとに決める。その
アドレスについて、実機がどう動くかを見て決める。2 つの場合と、その見分け方は、architecture.md
「アプリがモデル化するもの・実機に任せるもの」にある。

**起きたこと。** Insert FX の自動の ON を、1 つの機能として、「実機に任せる」側に分類したことがある。この機能は、
2 つの場合にまたがっていた。スロットがどのエンジンを指すかのポインタは実機に任せる側で、ON のスイッチは
プランの値で、実機が動かしたら押し戻す側だった。機能ごとに分類すると、こういう所で間違える。

## The rounding stays in the decoders

**決定。** `src/core/control/vd.ts` の `vdToGain` と `vdToEqFreq` は、`Math.round` を持ったままにする。外す案は
出て、却下した。代わりに、それぞれの関数の上のコメントが、不変条件を書いている。

**理由。** コードは、実機がヘッドアンプのゲインを整数の dB で、EQ のバンドの周波数を整数の Hz で持つことを
前提にしている。この前提のもとでは、丸めは、実機が返せる値を 1 つも変えない。プランと実機の間を行き来する
値は、既に動かない点にある。外す案が直そうとした「丸めの往復」は、欠陥ではない。

## Track Count is not written

**決定 (2026-08-10、操作者。もう一度は持ち出さない)。** microSD Rec の Track Count は、実機から読み、書かない。
known-issues.md の項目も残す。出した案は 3 つ:

1. ソフトウェアから届く 1 つの値だけを書く。
2. Track Count をプランから外し、実機が持つ読み取り専用の値にする。
3. 実装は今のままにして、文言を、実機の実際の動きに合わせる。

3 つ目を採った。

**却下した案。** 1 つ目。却下の理由が、この決定の中心になる。ソフトウェアから届くトラックの数は 2 トラック
だけなので、書込が片道になる。アプリから数を下げられるが、アプリからは上げ直せず、本体のパネルが要る。

**覆す条件。** ファームウェアの更新で、ソフトウェアから多いトラック数を書けるようになったとき。そのときは、
1 つ目の案がそのまま成り立つ。この制限は、ファームウェアを更新するたびに確かめ直す。

## What is left unimplemented

**決定。** 次のものは実装しない。理由は、それぞれの横に書く。

- **実機自身の画面に無い設定**: GEQ、出力のコンプレッサー、Sound Pad、Monitor 3–4、MIX 3–8、PEQ の 2 つ目の
  ブロック、オシレーターの Burst のほかに残っている on/off のパラメーター。
- **1-knob が ON の EQ の、バンドの値。** 実機がノブから計算し直すので、アプリは書かない (device-model.md
  「固定 (結線不可) の要素」)。
- **HDMI 入力の EQ についての警告。** 消してあり、戻さない。ブロックダイアグラムにもユーザーガイドにも根拠が
  無く、最初のリリースから、確かめないまま持ち越されていた。
- **1-knob が ON の間、実機がユーザーの PEQ を置いておく領域** (2026-08-10)。`params.ts` に無く、読みも書きも
  しない。自己診断の前後に本体の全体を掃引すると、この領域のアドレスが「復元されていない」と出る。これは
  この領域であって、アプリの欠陥ではない。これを覆うために、推測でアドレスをカタログに足すことはしない。

## An item without enough to go on is skipped

**決定 (操作者)。** 実機の画面にある設定のうち、根拠の足りないもの (制御のパラメーターの対応表に無く、値の
範囲も値の一覧も得られないもの) は、飛ばしてよい。推測で実装しない。

## The Ducker-bypass warning names the USB direct out only

**決定。** Ducker が ON で、USB のダイレクトアウトに結線したチャンネルは、警告を出す。同じチャンネルを
microSD Rec に結線しても、警告は出さない。ドライの信号を録ることは、正当な使い方だから。2026-10-12 に、
操作者が「microSD Rec にも出すべきでは」と問い直し、この理由を思い出して、対象外のままにした。もう一度は
持ち出さない。警告の文言、この理由の横に書かれていて成り立たなかった 2 つの理由、挙動を固定するテストは、
[#602](https://github.com/semnil/urx-router/pull/602) にある。

**却下した案。** 同じ迂回について、ワイヤやノードにバッジを付ける案と、Rec Point のヘルプの文を足す案。
今ある警告とヒントのスタイルで足りる。

## A stereo output's source is written on both sides

**決定。** 左のスロットと右のスロットを持つソースの選択は、両方に書く。

**起きたこと。** USB 出力のソースを、左のスロットにだけ書いていて、右のスロットに前の値が残った。その後、
ほかの左右の選択を点検し、正しいことを確かめた。リンクした種類は、両方の側に同じ値を書き、読み戻しは
最初の 1 つを読む。これは、作りとして正しい。

## The effect array slot the unit does not show is neither read nor written

**決定 (2026-09-10、操作者。もう一度は持ち出さない)。** FX チャンネルのエフェクトの配列のうち 1 つのスロットには、
実機自身のどの操作も届かない。実機のエフェクトの画面は、そのスロットを表示しない。このスロットは、読み取りも
書込も、アプリの対象から外す。行、読み値、MIDI の id、プランのフィールド、工場出荷時の値、送信、読み戻しは
[#481](https://github.com/semnil/urx-router/pull/481) で削除した。削除に合わせて保存形式の版を上げた理由も、
その PR にある。実機は、そこに持っている値を、そのまま持ち続ける。

**覆す条件。** ファームウェアの更新。ほかの理由では、このスロットを戻さない。

## The six unverified mappings left on the URX44 stay until a URX44 is at hand

**決定 (2026-10-17、操作者。もう一度は持ち出さない)。** `src/core/control/translate.ts` の
`UNVERIFIED_MAPPINGS` には 6 件が残っていて、6 件はそれぞれ URX44 だけについての推測になっている:
`dgain-source`、`jack-axis`、`stereo-block`、`input-ports`、`lcd-side`、`cue-flags`。今のまま残す。
決着の手順は、各エントリの `howToSettle` を、書いてあるとおりに使う。

**覆す条件。** URX44 の実機が手に入ったとき。
