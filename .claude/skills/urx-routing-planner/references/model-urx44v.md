# URX44V (URX44V) — routing reference

Ground truth extracted from the URX Router device model. Use the exact node ids
and `from`/`to` refs below; only routes listed here are legal.

## Nodes

### input

| id | label | ports |
|---|---|---|
| `in.micline_1_2` | MIC/LINE 1/2 | out (out) |
| `in.micline_3_4` | MIC/LINE 3/4 | out (out) |
| `in.aux` | AUX IN | out (out) |
| `in.sdplay` | microSD Playback | out (out) |
| `in.usbmain_a` | USB MAIN A | out (out) |
| `in.usbmain_b` | USB MAIN B | out (out) |
| `in.usbmain_c` | USB MAIN C | out (out) |
| `in.usbdaw_1_2` | USB DAW 1/2 | out (out) |
| `in.usbdaw_3_4` | USB DAW 3/4 | out (out) |
| `in.usbdaw_5_6` | USB DAW 5/6 | out (out) |
| `in.usbdaw_7_8` | USB DAW 7/8 | out (out) |
| `in.usbdaw_9_10` | USB DAW 9/10 | out (out) |
| `in.usbdaw_11_12` | USB DAW 11/12 | out (out) |
| `in.usbsub` | USB SUB | out (out) |
| `in.hdmi` | HDMI (down-mix) | out (out) |
| `bus.osc` | OSCILLATOR | out (out) |

### channel

| id | label | ports |
|---|---|---|
| `ch1` | CH 1 | in (in), out (out) |
| `ch2` | CH 2 | in (in), out (out) |
| `ch3` | CH 3 | in (in), out (out) |
| `ch4` | CH 4 | in (in), out (out) |
| `ch_5_6` | CH 5/6 | in (in), out (out) |
| `ch_7_8` | CH 7/8 | in (in), out (out) |
| `ch_9_10` | CH 9/10 | in (in), out (out) |
| `ch_11_12` | CH 11/12 | in (in), out (out) |

### bus

| id | label | ports |
|---|---|---|
| `bus.stereo` | STEREO (MAIN) | in (in), out (out) |
| `bus.mix1` | MIX 1 | in (in), out (out) |
| `bus.mix2` | MIX 2 | in (in), out (out) |
| `bus.fx1` | FX 1 | in (in), out (out) |
| `bus.fx2` | FX 2 | in (in), out (out) |
| `bus.stream` | STREAMING | in (in), out (out) |

### output

| id | label | ports |
|---|---|---|
| `bus.mon1` | MONITOR 1 | in (in), out (out) |
| `bus.mon2` | MONITOR 2 | in (in), out (out) |
| `out.main` | MAIN OUT | in (in) |
| `out.line` | LINE OUT | in (in) |
| `out.usbmain_a` | USB MAIN OUT A | in (in) |
| `out.usbmain_b` | USB MAIN OUT B | in (in) |
| `out.usbmain_c` | USB MAIN OUT C | in (in) |
| `out.usbsub` | USB SUB OUT | in (in) |
| `out.sdrec` | microSD Rec | in (in) |
| `out.sdrec.t1` | Track 1/2 | in (in) |
| `out.sdrec.t2` | Track 3/4 | in (in) |
| `out.sdrec.t3` | Track 5/6 | in (in) |
| `out.sdrec.t4` | Track 7/8 | in (in) |
| `out.sdrec.t5` | Track 9/10 | in (in) |
| `out.sdrec.t6` | Track 11/12 | in (in) |
| `out.sdrec.t7` | Track 13/14 | in (in) |
| `out.sdrec.t8` | Track 15/16 | in (in) |

### ducker

| id | label | ports |
|---|---|---|
| `out.ducker1` | Ducker CH 5/6 · Source | in (in) |
| `out.ducker2` | Ducker CH 7/8 · Source | in (in) |
| `out.ducker3` | Ducker CH 9/10 · Source | in (in) |
| `out.ducker4` | Ducker CH 11/12 · Source | in (in) |

## Legal routes

Each row is a legal wire from -> to with its kind. fixed wires are structural:
they always exist (seeded into every plan) and cannot be removed; you may set
their params (level/pan/on) but not delete them.

### kind: `source`
_input source select (single-input: at most one wire into the destination)_

- **-> `bus.mon1:in`**: `bus.stereo:out`, `bus.mix1:out`, `bus.mix2:out`
- **-> `bus.mon2:in`**: `bus.stereo:out`, `bus.mix1:out`, `bus.mix2:out`
- **-> `bus.stream:in`**: `bus.stereo:out`, `bus.mix1:out`, `bus.mix2:out`
- **-> `ch1:in`**: `in.micline_1_2:out`, `in.micline_3_4:out`, `in.aux:out`, `in.sdplay:out`, `in.usbmain_a:out`, `in.usbmain_b:out`, `in.usbmain_c:out`, `in.usbdaw_1_2:out`, `in.usbdaw_3_4:out`, `in.usbdaw_5_6:out`, `in.usbdaw_7_8:out`, `in.usbdaw_9_10:out`, `in.usbdaw_11_12:out`, `in.usbsub:out`, `in.hdmi:out`
- **-> `ch2:in`**: `in.micline_1_2:out`, `in.micline_3_4:out`, `in.aux:out`, `in.sdplay:out`, `in.usbmain_a:out`, `in.usbmain_b:out`, `in.usbmain_c:out`, `in.usbdaw_1_2:out`, `in.usbdaw_3_4:out`, `in.usbdaw_5_6:out`, `in.usbdaw_7_8:out`, `in.usbdaw_9_10:out`, `in.usbdaw_11_12:out`, `in.usbsub:out`, `in.hdmi:out`
- **-> `ch3:in`**: `in.micline_1_2:out`, `in.micline_3_4:out`, `in.aux:out`, `in.sdplay:out`, `in.usbmain_a:out`, `in.usbmain_b:out`, `in.usbmain_c:out`, `in.usbdaw_1_2:out`, `in.usbdaw_3_4:out`, `in.usbdaw_5_6:out`, `in.usbdaw_7_8:out`, `in.usbdaw_9_10:out`, `in.usbdaw_11_12:out`, `in.usbsub:out`, `in.hdmi:out`
- **-> `ch4:in`**: `in.micline_1_2:out`, `in.micline_3_4:out`, `in.aux:out`, `in.sdplay:out`, `in.usbmain_a:out`, `in.usbmain_b:out`, `in.usbmain_c:out`, `in.usbdaw_1_2:out`, `in.usbdaw_3_4:out`, `in.usbdaw_5_6:out`, `in.usbdaw_7_8:out`, `in.usbdaw_9_10:out`, `in.usbdaw_11_12:out`, `in.usbsub:out`, `in.hdmi:out`
- **-> `ch_11_12:in`**: `in.micline_1_2:out`, `in.micline_3_4:out`, `in.aux:out`, `in.sdplay:out`, `in.usbmain_a:out`, `in.usbmain_b:out`, `in.usbmain_c:out`, `in.usbdaw_1_2:out`, `in.usbdaw_3_4:out`, `in.usbdaw_5_6:out`, `in.usbdaw_7_8:out`, `in.usbdaw_9_10:out`, `in.usbdaw_11_12:out`, `in.usbsub:out`, `in.hdmi:out`
- **-> `ch_5_6:in`**: `in.micline_1_2:out`, `in.micline_3_4:out`, `in.aux:out`, `in.sdplay:out`, `in.usbmain_a:out`, `in.usbmain_b:out`, `in.usbmain_c:out`, `in.usbdaw_1_2:out`, `in.usbdaw_3_4:out`, `in.usbdaw_5_6:out`, `in.usbdaw_7_8:out`, `in.usbdaw_9_10:out`, `in.usbdaw_11_12:out`, `in.usbsub:out`, `in.hdmi:out`
- **-> `ch_7_8:in`**: `in.micline_1_2:out`, `in.micline_3_4:out`, `in.aux:out`, `in.sdplay:out`, `in.usbmain_a:out`, `in.usbmain_b:out`, `in.usbmain_c:out`, `in.usbdaw_1_2:out`, `in.usbdaw_3_4:out`, `in.usbdaw_5_6:out`, `in.usbdaw_7_8:out`, `in.usbdaw_9_10:out`, `in.usbdaw_11_12:out`, `in.usbsub:out`, `in.hdmi:out`
- **-> `ch_9_10:in`**: `in.micline_1_2:out`, `in.micline_3_4:out`, `in.aux:out`, `in.sdplay:out`, `in.usbmain_a:out`, `in.usbmain_b:out`, `in.usbmain_c:out`, `in.usbdaw_1_2:out`, `in.usbdaw_3_4:out`, `in.usbdaw_5_6:out`, `in.usbdaw_7_8:out`, `in.usbdaw_9_10:out`, `in.usbdaw_11_12:out`, `in.usbsub:out`, `in.hdmi:out`

### kind: `patch`
_output patch select (single-input)_

- **-> `out.line:in`**: `bus.stereo:out`, `bus.mix1:out`, `bus.mix2:out`, `bus.stream:out`, `bus.mon1:out`, `bus.mon2:out`
- **-> `out.main:in`**: `bus.stereo:out`, `bus.mix1:out`, `bus.mix2:out`, `bus.stream:out`, `bus.mon1:out`, `bus.mon2:out`
- **-> `out.usbmain_a:in`**: `bus.stereo:out`, `bus.stream:out`, `bus.mix1:out`, `bus.mix2:out`, `ch1:out`, `ch2:out`, `ch3:out`, `ch4:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`
- **-> `out.usbmain_b:in`**: `bus.stereo:out`, `bus.stream:out`, `bus.mix1:out`, `bus.mix2:out`, `ch1:out`, `ch2:out`, `ch3:out`, `ch4:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`
- **-> `out.usbmain_c:in`**: `bus.stereo:out`, `bus.stream:out`, `bus.mix1:out`, `bus.mix2:out`, `ch1:out`, `ch2:out`, `ch3:out`, `ch4:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`
- **-> `out.usbsub:in`**: `bus.stereo:out`, `bus.stream:out`, `bus.mix1:out`, `bus.mix2:out`, `ch1:out`, `ch2:out`, `ch3:out`, `ch4:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`

### kind: `key`
_ducker side-chain key select (single-input)_

- **-> `out.ducker1:in`**: `ch1:out`, `ch2:out`, `ch3:out`, `ch4:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`, `bus.stereo:out`, `bus.mix1:out`, `bus.mix2:out`
- **-> `out.ducker2:in`**: `ch1:out`, `ch2:out`, `ch3:out`, `ch4:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`, `bus.stereo:out`, `bus.mix1:out`, `bus.mix2:out`
- **-> `out.ducker3:in`**: `ch1:out`, `ch2:out`, `ch3:out`, `ch4:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`, `bus.stereo:out`, `bus.mix1:out`, `bus.mix2:out`
- **-> `out.ducker4:in`**: `ch1:out`, `ch2:out`, `ch3:out`, `ch4:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`, `bus.stereo:out`, `bus.mix1:out`, `bus.mix2:out`

### kind: `record`
_microSD record-track source select (single-input)_

- **-> `out.sdrec.t1:in`**: `ch1:out`, `ch3:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`, `bus.stereo:out`, `bus.mix1:out`, `bus.mix2:out`
- **-> `out.sdrec.t2:in`**: `ch1:out`, `ch3:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`, `bus.stereo:out`, `bus.mix1:out`, `bus.mix2:out`
- **-> `out.sdrec.t3:in`**: `ch1:out`, `ch3:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`, `bus.stereo:out`, `bus.mix1:out`, `bus.mix2:out`
- **-> `out.sdrec.t4:in`**: `ch1:out`, `ch3:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`, `bus.stereo:out`, `bus.mix1:out`, `bus.mix2:out`
- **-> `out.sdrec.t5:in`**: `ch1:out`, `ch3:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`, `bus.stereo:out`, `bus.mix1:out`, `bus.mix2:out`
- **-> `out.sdrec.t6:in`**: `ch1:out`, `ch3:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`, `bus.stereo:out`, `bus.mix1:out`, `bus.mix2:out`
- **-> `out.sdrec.t7:in`**: `ch1:out`, `ch3:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`, `bus.stereo:out`, `bus.mix1:out`, `bus.mix2:out`
- **-> `out.sdrec.t8:in`**: `ch1:out`, `ch3:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`, `bus.stereo:out`, `bus.mix1:out`, `bus.mix2:out`

### kind: `send`
_summing send into a bus (many sources allowed; carries level/pan/tap)_

- **-> `bus.fx1:in`** *(fixed)*: `ch1:out`, `ch2:out`, `ch3:out`, `ch4:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`
- **-> `bus.fx2:in`** *(fixed)*: `ch1:out`, `ch2:out`, `ch3:out`, `ch4:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`
- **-> `bus.mix1:in`** *(fixed)*: `ch1:out`, `ch2:out`, `ch3:out`, `ch4:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`, `bus.fx1:out`, `bus.fx2:out`
- **-> `bus.mix2:in`** *(fixed)*: `ch1:out`, `ch2:out`, `ch3:out`, `ch4:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`, `bus.fx1:out`, `bus.fx2:out`
- **-> `bus.stereo:in`** *(fixed)*: `ch1:out`, `ch2:out`, `ch3:out`, `ch4:out`, `ch_5_6:out`, `ch_7_8:out`, `ch_9_10:out`, `ch_11_12:out`, `bus.fx1:out`, `bus.fx2:out`

### kind: `sendSwitch`
_ON/OFF assign into a bus (no level/pan)_

- **-> `bus.fx1:in`**: `bus.osc:out`
- **-> `bus.fx2:in`**: `bus.osc:out`
- **-> `bus.mix1:in`**: `bus.osc:out`
- **-> `bus.mix2:in`**: `bus.osc:out`
- **-> `bus.stereo:in`** *(fixed)*: `bus.mix1:out`, `bus.mix2:out`, `bus.osc:out`
