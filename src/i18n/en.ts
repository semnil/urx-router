// English is the base language and the source of truth for the message shape.
// Every other catalog (see ja.ts) must satisfy the derived Messages type, so
// adding a key here makes TypeScript require a translation everywhere.

// Every leaf below is marked with the kind of string it is, and `Messages` is derived
// from those marks. This is what makes the choice explicit at the moment a key is added:
// an unmarked string widens to `string` and trips the assertion at the foot of the file.
//
//   dev()   a control reproduced from one of the unit's own screens. The unit shows English
//           on those screens whichever of its three display languages is selected (read off
//           the hardware with its Language set to Japanese), so every catalogue repeats the
//           same characters — the literal type below is what forces that.
//   fixed() identical in every language for a reason that is not the device. Most are on the
//           CONSOLE strip: the group separators, which are set in vertical writing mode where
//           a full-width glyph widens the column and so moves the rack's geometry, and the two
//           readout captions beside them, which follow the separators so that the strip does not
//           carry one translated word among English ones. The guitar amp's Modulation is the
//           same reason away from the strip: it names a group rather than reproducing a screen,
//           and it sits in a row of controls the unit itself names in English.
//   tr()    this app's own copy. Each language supplies its own wording.
//
// Which of the three a new key takes is a judgement the author has to make and a reviewer has
// to check: nothing here can tell that a device row was marked tr() by mistake.

declare const TRANSLATABLE: unique symbol;
export type Translatable = string & { readonly [TRANSLATABLE]: true };

const dev = <T extends string>(s: T): T => s;
const fixed = <T extends string>(s: T): T => s;
const tr = (s: string): Translatable => s as Translatable;

export const en = {
  // The macOS application menu (desktop only). Only the two items this app owns are
  // here; everything else in that bar is AppKit's and stays in its own wording.
  appMenu: {
    undo: tr("Undo"),
    redo: tr("Redo"),
  },
  toolbar: {
    model: tr("Model"),
    rate: tr("Rate"),
    new: tr("New"),
    file: tr("File"),
    open: tr("Open"),
    openSettings: tr("Import settings file (experimental)"),
    save: tr("Save"),
    exportPng: tr("Export PNG"),
    exportPdf: tr("Export PDF"),
    viewGraph: tr("Graph"),
    viewConsole: tr("Console"),
    viewGraphHint: tr("Node-graph routing view"),
    viewConsoleHint: tr("Mixer-style level overview"),
    view: tr("View"),
    viewHint: tr("Layout and display options"),
    arrange: tr("Arrange"),
    hideUnused: tr("Hide unused"),
    showOffSends: tr("Show off sends"),
    hideOffSends: tr("Hide off sends"),
    hideOffSendsHint: tr("Hide the sends parked at -∞ or switched off, so only live routing shows"),
    labelsModel: tr("Default labels"),
    labelsDevice: tr("Device names"),
    labelsHint: tr("Canvas labels: the planner's channel names (CH 1) or the names set on the device (ch 1)"),
    device: tr("Device"),
    fetchDevice: tr("Fetch from device"),
    fetchCancel: tr("Cancel fetch"),
    writeDevice: tr("Write to device"),
    writeCancel: tr("Cancel write"),
    compare: tr("Compare with device (experimental)"),
    compareCancel: tr("Cancel compare"),
    selfTest: tr("Self-test (experimental)"),
    selfTestCancel: tr("Cancel self-test"),
    liveSync: tr("Live sync"),
    liveSyncHint: tr("Mirror every edit to the connected device in real time"),
    liveTag: tr("LIVE"),
    desktopApp: tr("Desktop app"),
    desktopAppHint: tr("Get the desktop app — save/load plans, export images, and control the device live"),
    // Demo-only sharing: the demo has no file IO, so the plan travels as a
    // ?plan= URL or as a JSON download the desktop app opens.
    shareUrl: tr("Share URL"),
    shareUrlHint: tr("Copy a shareable link to this plan (also placed in the address bar)"),
    downloadJson: tr("Download JSON"),
    downloadJsonHint: tr("Download this plan as JSON — the desktop app opens it"),
    followUsb: dev("FOLLOW USB"),
    followUsbOnHint: tr(
      "The device is taking its clock from the USB host, so the rate above cannot be changed on the device. Click to turn Follow USB off.",
    ),
    followUsbOffHint: tr(
      "The device is holding its own clock, so the rate above is the one it runs at. Click to hand the clock back to the USB host.",
    ),
    followUsbUnknownHint: tr(
      "Whether the device is taking its clock from the USB host has not been read yet, so the rate above may not be the one it runs at. Click to read it from the device.",
    ),
  },
  console: {
    mute: tr("MUTE"),
    // Accessible name suffix for the scribble power LED (the node master on/off):
    // "<strip> on/off". Announced with aria-pressed; not shown on screen.
    power: tr("on/off"),
    eq: dev("EQ"),
    pre: dev("PRE"),
    // Per-strip SENDS rack: header label, the SEND PAN popover header, and the
    // hover tooltip on the PRE button (mirrors cueFull's tooltip mechanism).
    sends: dev("SENDS"),
    sendPan: tr("SEND PAN"),
    preHint: tr("Pre-fader send"),
    cue: tr("C.INT"),
    // Full name of the C.INT chip (kept distinct from the device's plain CUE).
    cueFull: dev("Cue Interrupt"),
    mono: dev("MONO"),
    // Strip group separators (this one and the group* keys below). They are set in
    // vertical writing mode, where a full-width glyph changes the column's width, so
    // a translated label moves the rack's layout; kept in English in every language.
    master: fixed("MASTER"),
    meterPoint: tr("METER POINT"),
    meterPointHint: tr("Only taps the device meters are listed."),
    // Readout captions: the set fader level vs the live signal meter. Both are `fixed` for
    // the surface's sake rather than the device's — every label on a strip is English here,
    // the separators above because a full-width glyph moves the rack's geometry, and the
    // rest so that one katakana word does not stand alone among them. The tuning screens'
    // heading is the same item and IS translated (「メーター」, after the user guide): it sits
    // in a modal that is Japanese throughout, where the reverse argument applies.
    readFader: fixed("FADER"),
    readMeter: fixed("METER"),
    groupInputs: fixed("INPUTS"),
    groupBus: fixed("BUS / FX"),
    groupMon: fixed("MONITOR"),
    // The INS FX chip's own popover: the type list, then the bypass switch and the
    // launcher under it. The heading and the switch are the device's words, taken from
    // the Inspector row that names the same two things.
    insFxType: dev("EFFECT TYPE"),
    // Why an entry cannot be picked, said in the width of a list row. The Inspector's
    // sentences (`insFxRateLockedAt` / `insFxSlotLocked`) are the same two facts said
    // at the width of a panel; these are what fits beside a name, and the row's title
    // carries the sentence for anyone who hovers it.
    insFxInUse: tr("in use"),
    insFxMax: (maxRate: string): string => `max ${maxRate}`,
    // What the popover's first entry does, beside a name that reads like a value.
    // Without it "No Effect" is one more type to pick rather than the way out.
    insFxRemove: tr("release"),
    // Why the switch and the launcher under the list are inert while the strip holds
    // nothing. Both are about an effect, and the list above them is where one comes
    // from — said once, on whichever of the two is hovered.
    insFxPickFirst: tr("Choose an effect above first."),
  },
  // SETUP > GENERAL on the unit. Section and control names stay in English in the
  // Japanese user guide too, so they are not translated in either language — only
  // the explanatory notes are. Keeping the unit's own wording is what lets an
  // operator map a row here onto the menu on the hardware.
  deviceSetup: {
    menuItem: tr("Device setup"),
    title: tr("Device setup"),
    close: tr("Close"),
    apply: tr("Apply to device"),
    pending: (n: number): string => `${n} unapplied change${n === 1 ? "" : "s"}`,
    standingNote: tr("Changes are not written until you apply them, and are not part of the plan file."),
    onlyOn: (models: string): string => `${models} only`,
    languageSection: dev("Language"),
    displayLanguage: tr("Display language"),
    languageNote: tr(
      "The value sticks, but the unit's own screen may not repaint in the new language until you switch Language on the unit once.",
    ),
    brightnessSection: dev("Brightness"),
    screen: dev("Screen"),
    powerSection: dev("Power Management"),
    autoPowerOff: dev("Auto Power Off"),
    enable: dev("Enable"),
    time: dev("Time"),
    minutes: (n: number): string => `${n} min`,
    dateTimeSection: dev("Date/Time"),
    timeZone: dev("Time Zone"),
    displayFormat: dev("Display Format"),
    date: dev("Date"),
    clockNote: tr(
      "The unit's clock stamps microSD recordings. It can only be set on the unit itself — it does not follow the clock of a computer connected over USB.",
    ),
    timeZoneNote: tr(
      "The city list is reproduced from partial observation of the unit, so an entry may name the wrong city. Check the unit after applying.",
    ),
    noDateTime: tr("The URX22 has no Date/Time menu — it has no microSD recorder for the clock to stamp."),
    peripheralSection: dev("Peripheral"),
    usbMain: dev("USB Main"),
    usbSuppression: dev("Generic Driver Audio Channel Suppression"),
    usbNote: tr(
      "Limits the channels offered to a host on a generic driver, such as an iPad or iPhone. 2 Channels restricts it to 2 in / 2 out.",
    ),
    hdmi: dev("HDMI"),
    hdcp: dev("HDCP"),
    hdmiChannels: dev("Input Audio Channels"),
    hdmiNote: tr(
      "2 Channels is always two channels (48 kHz max). Multi Channels supports up to 192 kHz / 8 channels, down-mixed to stereo inside the mixer.",
    ),
    hdmiOnly: tr("HDMI is fitted to the URX44V only."),
    knobsSection: dev("User Defined Knobs"),
    bank: (n: number): string => `BANK ${n}`,
    function: dev("Function"),
    param1: dev("Parameter 1"),
    param2: dev("Parameter 2"),
    knobsNote: tr("Banks match the unit's own bank switching."),
    unset: tr("—"),
  },
  midi: {
    menuItem: tr("MIDI control"),
    title: tr("MIDI CONTROL"),
    // Section headings in the MIDI window, which has room for them.
    ports: tr("Ports"),
    input: tr("Input"),
    output: tr("Output"),
    portNone: tr("None"),
    learn: tr("Learn"),
    // The assignment table's column heads.
    colControl: tr("Control"),
    colAddr: tr("Address"),
    colOption: tr("Behavior"),
    hintIdle: tr(
      "Turn on Learn, click a control on the console or a tuning screen, then move a control on your MIDI device.",
    ),
    hintLearn: tr("Click a control on the console or a tuning screen to arm it for binding."),
    hintArmed: (control: string): string => `Move a MIDI control to bind ${control}…`,
    mappings: tr("Assignments"),
    noMappings: tr("No assignments yet."),
    remove: tr("Remove assignment"),
    // Shown on a row that shares its MIDI control with an earlier assignment
    // (a gang): they move together, and feedback follows the first-assigned.
    linked: tr("Linked"),
    linkedHint: tr(
      "Shares one MIDI control with the first assignment for this address; they move together, and MIDI feedback follows that first assignment.",
    ),
    mode: { absolute: tr("Absolute"), pickup: tr("Pickup") },
    // Named after the SENDER's button type (the controller-side setting the
    // user reads, e.g. Stream Deck): a momentary button (value on press, 0 on
    // release) wants edge handling, a toggle button (alternating 127/0) wants
    // value-follows-state. Stored values stay "edge" / "state" for persistence
    // compatibility.
    buttonMode: { edge: tr("Momentary"), state: tr("Toggle") },
    // Names the setting a select controls: its tooltip, half of its aria-label,
    // and the heading over that vocabulary in the legend under the table.
    modeTitle: tr("Take-in mode"),
    buttonModeTitle: tr("Button behavior"),
    // One-line behavior notes, printed in that legend for every vocabulary the
    // list uses (a native dropdown cannot annotate its own options).
    modeDesc: {
      absolute: tr(
        "Applies the received value as-is. Jumps when the physical control and the on-screen value disagree.",
      ),
      pickup: tr(
        "Ignored until the physical control reaches or crosses the on-screen value — no jumps, but inert until it catches up.",
      ),
    },
    buttonModeDesc: {
      edge: tr(
        "For push / momentary buttons: flips once on each press; the release (0) is ignored — and it still flips every press even if the button sends only an on-value and never a release.",
      ),
      state: tr(
        "For toggle buttons that alternate 127/0 per press (e.g. Stream Deck toggles): the value is the state — 64 and above = on, below = off. A momentary button gives hold-to-enable.",
      ),
    },
    bound: (control: string, addr: string): string => `Assigned ${addr} to ${control}`,
    windowError: (message: string): string => `Could not open the MIDI control window: ${message}`,
    inputError: (message: string): string => `MIDI input error: ${message}`,
    outputError: (message: string): string => `MIDI output error: ${message}`,
    // Feedback gave up on a port that kept refusing messages (ui/midi.ts,
    // FEEDBACK_FAIL_PASSES). Said once — nothing repeats after it.
    outputStalled: tr(
      "MIDI feedback stopped — the output port kept refusing messages. Reconnect the controller and choose the port again.",
    ),
    // Control labels reuse the console strip wording (chips / knob captions).
    param: {
      level: dev("Level"),
      mute: dev("MUTE"),
      chOn: dev("ON"),
      pan: dev("PAN/BAL"),
      tap: dev("PRE"),
      gain: dev("GAIN"),
      phonesLevel: dev("PHONES"),
      oscOn: dev("ON"),
      cueInterrupt: dev("C.INT"),
      mono: dev("MONO"),
      gateOn: dev("GATE"),
      compOn: dev("COMP"),
      eqOn: dev("EQ"),
      phantom: dev("+48"),
      phase: dev("φ"),
      phaseL: dev("φL"),
      phaseR: dev("φR"),
      hpf: dev("HPF"),
      hiZ: dev("Hi-Z"),
      duckerOn: dev("DUCKER"),
      // The channel tuning screens' parameters. The scope beside them says which
      // processor they belong to, so these are the knob names alone.
      threshold: dev("Threshold"),
      range: dev("Range"),
      attack: dev("Attack"),
      hold: dev("Hold"),
      decay: dev("Decay"),
      ratio: dev("Ratio"),
      release: dev("Release"),
      autoMakeup: dev("Auto Makeup"),
      oneKnob: dev("1-Knob"),
      oneKnobLevel: dev("1-Knob Level"),
      freq: dev("Freq"),
      q: dev("Q"),
      bandOn: dev("Band ON"),
      ssmcsOn: dev("SSMCS"),
      compDrive: dev("Comp Drive"),
      morphing: dev("Morphing"),
      outGain: dev("Out Gain"),
      sideChain: dev("Side Chain"),
    },
    // A param whose console caption does not fit a processor scope. `gain` is the
    // only one: the console shouts GAIN because that is what its knob caption says,
    // while a tuning screen prints "Gain" beside "Threshold" and "Ratio". The
    // console's own wording is deliberate and stays as it is; this is the same
    // parameter read on a different surface.
    scopedParam: { gain: tr("Gain") } as Record<string, Translatable>,
    // The id's third component, printed between the node and the param. A send
    // target reads as a signal path ("→ MIX 1"); a processor or band is a stage of
    // this node, so it reads as one more step of its name.
    scope: {
      gate: tr("GATE"),
      comp: tr("COMP"),
      eq: tr("EQ 1-Knob"),
      "eq.low": tr("EQ LOW"),
      "eq.lowMid": tr("EQ LOW-MID"),
      "eq.highMid": tr("EQ HIGH-MID"),
      "eq.high": tr("EQ HIGH"),
      ssmcs: tr("SSMCS"),
      "ssmcs.comp": tr("SSMCS COMP"),
      "ssmcs.sc": tr("SSMCS Side Chain"),
      "ssmcs.eq.low": tr("SSMCS EQ LOW"),
      "ssmcs.eq.mid": tr("SSMCS EQ MID"),
      "ssmcs.eq.high": tr("SSMCS EQ HIGH"),
    } as Record<string, Translatable>,
  },
  inspector: {
    title: tr("Inspector"),
    close: tr("Close"),
    hint: tr(
      "Drag nodes to place them, then drag from an output port (right) to an " +
        "input port (left) to connect. Connectable ports are highlighted in green " +
        "while connecting. A channel's direct outs and recordings start at the Rec " +
        "Point tap on its top edge instead. Click the pen on a node to add a note, " +
        "then click the note to edit it.",
    ),
    type: tr("Type"),
    name: dev("Name"),
    color: dev("Color"),
    recPoint: dev("Rec Point"),
    inputsFrom: (n: number): string => `Inputs (${n})`,
    outputsTo: (n: number): string => `Outputs (${n})`,
    routing: tr("Routing"),
    connection: tr("Connection"),
    from: tr("From"),
    to: tr("To"),
    parameters: tr("Parameters"),
    inputSection: tr("Input"),
    level: dev("Level"),
    pan: dev("Pan"),
    balance: dev("Balance"),
    prePost: tr("Pre/Post"),
    prePostLcdOnly: tr("CH → FX send Pre/Post is set on the device only (not writable from software)."),
    eqRateLocked: tr("Stereo channel EQ is disabled at 176.4 / 192 kHz — forced off."),
    insFxRateLocked: tr("Insert FX is unavailable above 96 kHz — forced off."),
    // The effect the node HOLDS, named with its own ceiling: the ceilings differ per
    // effect (Pitch Fix stops at 48 kHz where the amps and companders reach 96), so the
    // sentence above can only be said of a value this app's own table does not carry.
    insFxRateLockedAt: (effect: string, maxRate: string): string =>
      `${effect} is unavailable above ${maxRate} — forced off.`,
    insFxSlotLocked: tr("Every insert effect is in use — each occupies one device-wide slot."),
    // The FX2 bus itself, which the rate removes rather than merely disabling something on
    // it: its own strip and every send aimed at it. The graph dims the node; this is what
    // the CONSOLE says in its place.
    fx2RateLocked: tr("The FX2 bus is unavailable above 96 kHz."),
    channelOn: tr("Channel"),
    sendOn: tr("Send"),
    toSt: dev("TO ST"),
    hpf: dev("HPF"),
    hpfFreq: dev("HPF Freq"),
    phantom: dev("+48V"),
    phase: tr("Ø"),
    clipSafe: dev("Clip Safe"),
    hiZ: dev("Hi-Z"),
    insertFx: dev("Insert FX"),
    // The selector's own row, inside a section already headed "Insert FX". Naming the row
    // the same thing as the section over it says nothing twice; what the row picks is the
    // TYPE. The device's word, so it is not translated.
    insertFxType: dev("EFFECT TYPE"),
    insertFxOn: dev("Insert FX ON"),
    compEqType: dev("COMP/EQ Type"),
    eqOn: dev("EQ"),
    compOn: dev("COMP"),
    gateOn: dev("GATE"),
    eqOneKnob: dev("1-knob"),
    eqOneKnobType: dev("1-knob Type"),
    eqOneKnobLevel: dev("1-knob Level"),
    bandOn: dev("Band"),
    filterType: dev("Type"),
    frequency: dev("Freq"),
    q: dev("Q"),
    eqGain: dev("Gain"),
    fineTag: tr("FINE"),
    fineHint: tr("Fine adjustment — hold Shift"),
    fineHintLatch: tr("Fine adjustment — press Shift to toggle"),
    eqBand: { low: dev("LOW"), lowMid: dev("LOW MID"), highMid: dev("HIGH MID"), high: dev("HIGH") },
    dyn: {
      threshold: dev("Threshold"),
      range: dev("Range"),
      attack: dev("Attack"),
      hold: dev("Hold"),
      decay: dev("Decay"),
      ratio: dev("Ratio"),
      gain: dev("Gain"),
      release: dev("Release"),
      knee: dev("Knee"),
    },
    autoMakeup: dev("Auto Makeup"),
    oneKnob: dev("1-Knob"),
    oneKnobLevel: dev("1-Knob Level"),
    ssmcs: {
      title: dev("SSMCS"),
      sweetSpotData: dev("Sweet Spot Data"),
      compDrive: dev("Comp Drive"),
      morphing: dev("Morphing"),
      outGain: dev("Out Gain"),
      sideChain: dev("Side Chain"),
      bands: { low: dev("LOW"), mid: dev("MID"), high: dev("HIGH") },
    },
    fxEffect: {
      title: dev("FX Effect"),
      effectType: dev("EFFECT TYPE"),
      effectOn: dev("Effect"),
      level: dev("Mix"),
      params: {
        reverbTime: dev("Reverb Time"),
        initialDelay: dev("Initial Delay"),
        decay: dev("Decay"),
        roomSize: dev("Room Size"),
        diffusion: dev("Diffusion"),
        density: dev("Density"),
        hpf: dev("HPF"),
        lpf: dev("LPF"),
        hiRatio: dev("Hi Ratio"),
        lowRatio: dev("Low Ratio"),
        lowFreq: dev("Low Freq"),
        feedback: dev("Feedback Gain"),
        erRevDelay: dev("ER/Rev Delay"),
        erRevBalance: dev("ER/Rev Balance"),
        delayTime: dev("Delay"),
        sync: dev("Sync"),
        bpm: dev("BPM"),
        note: dev("Note"),
      },
    },
    insertFxEffect: {
      title: dev("Insert Effect"),
      bandLow: dev("Low"),
      bandMid: dev("Mid"),
      bandHigh: dev("High"),
      oneKnob: dev("1-Knob"),
      scale: dev("Scale"),
      // The twelve semitone buttons. Absolute, named from C — the unit stores them that
      // way whatever the Key is.
      scaleNotes: tr("Notes"),
      scaleChromatic: dev("Chromatic"),
      scaleMajor: dev("Major"),
      scaleCustom: dev("Custom"),
      scaleSingle: dev("Single"),
      scaleNaturalMinor: dev("Natural Minor"),
      scaleHarmonicMinor: dev("Harmonic Minor"),
      scaleMelodicMinor: dev("Melodic Minor"),
      scalePentatonic: dev("Pentatonic"),
      midiControlDeviceOnly: tr(
        "From Setting on, the notes the correction aims at arrive on the unit's own USB-MIDI port — so switching it on clears the note mask and sets the Scale to Custom, and the two stay the unit's until it is switched back off.",
      ),
      params: {
        bypass: dev("Bypass"),
        threshold: dev("Threshold"),
        ratio: dev("Ratio"),
        attack: dev("Attack"),
        release: dev("Release"),
        outGain: dev("Out Gain"),
        width: dev("Width"),
        gain: dev("Gain"),
        volume: dev("Volume"),
        bass: dev("Bass"),
        middle: dev("Middle"),
        treble: dev("Treble"),
        presence: dev("Presence"),
        output: dev("Output"),
        spType: dev("SP Type"),
        micPosition: dev("Mic Position"),
        gate: dev("Gate"),
        gateLevel: dev("Gate Level"),
        blend: dev("Blend"),
        distortion: dev("Distortion"),
        mod: fixed("Modulation"),
        modSpeed: dev("Speed"),
        modDepth: dev("Depth"),
        type: dev("Type"),
        ampType: dev("Amp Type"),
        master: dev("Master"),
        coarse: dev("Coarse"),
        fine: dev("Fine"),
        formant: dev("Formant"),
        correction: dev("Correction"),
        mix: dev("Mix"),
        key: dev("Key"),
        speed: dev("Speed"),
        tolerance: dev("Tolerance"),
        limitLow: dev("Limit Low"),
        limitHigh: dev("Limit High"),
        midiControl: dev("MIDI Control"),
        oneKnobOn: dev("1-Knob"),
        oneKnobLevel: dev("1-Knob Level"),
        xoverLowMid: dev("L-M Xover"),
        xoverMidHigh: dev("M-H Xover"),
      },
    },
    duckerOn: dev("Ducker"),
    gainAnalog: dev("A.Gain"),
    gainDigital: dev("D.Gain"),
    oscOn: dev("Oscillator"),
    oscLevel: dev("Level"),
    oscMode: dev("Mode"),
    oscWidth: dev("Width"),
    oscInterval: dev("Interval"),
    oscAssignL: dev("Assign L"),
    oscAssignR: dev("Assign R"),
    delayTitle: dev("DELAY"),
    delayOn: dev("DELAY"),
    delayFrameRate: dev("Frame rate"),
    delayTime: dev("Delay Time"),
    monitorOn: dev("Monitor"),
    cueInterrupt: dev("CUE Interrupt"),
    mono: dev("MONO"),
    phonesLevel: dev("PHONES Level"),
    on: dev("ON"),
    off: dev("OFF"),
    notReadFromDevice: tr("Not read from the device — showing the plan default."),
    selectionOnly: tr("Selection only — no send parameters."),
    directOutTap: tr(
      "Direct out — tapped at the channel Rec Point, before the fader and Ducker. Route via a STEREO or MIX bus to include them.",
    ),
    sdRecTap: tr(
      "Records this channel at its Rec Point (pre-fader by default). Change the channel's Rec Point to pick the recorded stage.",
    ),
    duckerKeyTap: tr(
      "Ducker key — tapped at the source channel's Rec Point, before its fader and Ducker, so that channel's fader / mute do not change the trigger. Key from a STEREO or MIX bus to trigger post-fader.",
    ),
    patchNoMono: tr("Only MONITOR 1 / 2 carry MONO. Patch this output from a MONITOR bus to switch it to mono."),
    patchViaMonitor: tr(
      "This output follows the MONITOR bus's MONO switch — set it on the MONITOR node. CUE Interrupt is on the same path, so while it is on, engaging CUE replaces what this output carries.",
    ),
    monoPhonesShared: tr(
      "MONO is on. This MONITOR's PHONES is tapped after it, so those headphones carry the same mono sum — use the other MONITOR to keep one path stereo.",
    ),
    monoUnavailable: tr("Unavailable — via MONITOR"),
    monoVia: (state: string, monitor: string): string => `${state}, from ${monitor}`,
    fixedConnection: tr("Fixed connection — always enabled, cannot be removed."),
    duckerPreSend: tr(
      "This channel's Ducker is on, but this PRE (pre-fader) send taps ahead of it, so the send is not ducked. Switch to POST to include the duck.",
    ),
    busType: dev("BUS Type"),
    panLink: dev("Pan Link"),
    busFixedLevel: tr("Send level is fixed (BUS Type: FIXED)."),
    panLinked: tr("Pan follows the source channel PAN (Pan Link)."),
    sdRecTrackCount: dev("Track Count"),
    sdRecTrackCountLive: tr(
      "Track Count is set on the device only — the broker exposes just one of its eight settings.",
    ),
    sdRecTrackCountRate: (ceiling: number): string =>
      `This sample rate allows ${ceiling} tracks. Lowering the rate again does not raise the recorder back — the way back is the unit's own microSD screen, RECORDER menu, [Track Count].`,
    signalType: dev("Signal Type"),
    panBal: dev("PAN / BAL"),
    deleteConnection: tr("Delete this connection"),
    hideNode: tr("Hide this node"),
    notesPlaceholder: tr("Add a note inside this node… (shown on the canvas and in exports)"),
    recentPlans: tr("Recent plans"),
    none: tr("-"),
    connKind: {
      source: tr("Input source select (single)"),
      patch: tr("Output patch (single)"),
      key: tr("Ducker key source (single)"),
      send: tr("Bus send (summing)"),
      sendSwitch: tr("Bus send (ON/OFF switch)"),
      record: tr("SD Rec source select (single)"),
    },
    nodeKind: {
      input: tr("Input source"),
      channel: tr("Mixer channel"),
      bus: tr("Bus"),
      output: tr("Output"),
      ducker: tr("Ducker"),
    },
    legend: {
      signals: tr("Connection types"),
      nodes: tr("Nodes"),
      source: tr("Source select"),
      send: tr("Bus send"),
      patch: tr("Output / Rec select"),
      pre: tr("Pre-fader send"),
      recPoint: tr("Rec Point tap"),
    },
  },
  // Dynamics tuning screens (GATE / COMP). The LANE captions carry the device's own tap
  // vocabulary and stay English in every language, like the CONSOLE meter-point badges that
  // name the same points. The heading over them does not — see `readouts`.
  dynTuning: {
    close: tr("Close"),
    display: tr("Display"),
    parameters: tr("Parameters"),
    // The lane captions. Every rack is one pair — what goes into the processor and what comes
    // out — so the caption names the POSITION and the tile below names the tap, instead of
    // both naming the tap and neither saying which end it is. The unit's own dynamics screens
    // meter the same pair: the user guide calls the item "Input/output meter" / 「入出力メーター」,
    // and "Input meter" / 「インプットメーター」 and "Output meter" / 「アウトプットメーター」 where
    // it names the halves (D0). Latin in every language, like the tap names they replaced.
    laneIn: fixed("Input"),
    laneOut: fixed("Output"),
    // The tiles under this heading are the taps' meters as numbers, and the word is the user
    // guide's: it names the item in both languages — "Channel meter" / "チャンネルメーター",
    // "stereo meter" / "ステレオメーター", "LEVEL meter" / "LEVELメーター" (D0, Channel view
    // and Dedicated channel screen). Translated rather than fixed, because the guide's own
    // Japanese is katakana; the unit has no screen printing METER, so there is nothing to
    // match letter for letter. The guide qualifies it per screen (LEVEL メーター, チャンネル
    // メーター) and this heading does not: one word covers every tap the tiles carry, and a
    // qualifier would have to be picked per surface and would cost width on all of them.
    readouts: tr("METER"),
    peakPrefix: tr("pk"),
    noReading: tr("—"),
    driven: tr("Device-driven"),
    gate: {
      title: dev("Gate"),
      open: tr("Gate screen"),
      tapIn: dev("Pre Gate"),
      tapGr: dev("Gate GR"),
      tapOut: dev("Pre Comp"),
      curveHint: tr("Drag the curve's knee to set the threshold."),
    },
    comp: {
      title: dev("Comp"),
      open: tr("Comp screen"),
      tapIn: dev("Pre Comp"),
      tapGr: dev("Comp GR"),
      tapOut: dev("Pre EQ"),
      // The second sentence is the whole of what two rejected visual aids were built to
      // say. Measured on a URX44V: a 50 ms burst 11 dB over the corner takes 10 dB of
      // reduction at Attack 0.09 ms and none at 80 ms, while the SETTLED reduction for the
      // same level moves 3 dB across that range — so the curve is right and the signal is
      // what does not reach it. Release is named beside Attack because it widens the same
      // gap and only Attack was swept.
      curveHint: tr(
        "The curve is what the sliders do to the signal, the dot the live level. Attack and Release decide how close it gets.",
      ),
    },
    eq: {
      title: dev("EQ"),
      open: tr("EQ screen"),
      unusedByType: tr("Unused by this type"),
      fixedBand: tr("Fixed on this band"),
      oneKnobDrives: tr(
        "The device computes all four bands from the 1-knob level. The curve follows it only while Live sync is up.",
      ),
      plotHint: tr("The curve is the EQ's response; each marker shows a band's frequency."),
    },
    // The morphing strip's three faces share one title and one launcher label; the
    // segment beside the title names the face. Its COMP face reuses the COMP screen's
    // tap names, hint and Knee row, and its EQ face the 4-band screen's plot hint and
    // band-bar heading — the same device points, said once.
    ssmcs: {
      open: tr("SSMCS screen"),
      faceMain: fixed("Main"),
      faceComp: fixed("Comp"),
      faceEq: fixed("EQ"),
      tapOut: dev("Pre Ins FX"),
      mainHint: tr(
        "Comp Drive moves the compressor's curve. Sweet Spot Data and Morphing move both, only while Live sync is up.",
      ),
      scHint: tr(
        "The side-chain filter changes what the compressor reacts to, not the audio. The curve is the reduction it buys, so it dips where the compressor will clamp down hardest.",
      ),
    },
    ducker: {
      title: dev("Ducker"),
      open: tr("Ducker screen"),
      tapKey: (label: string): string => `Key · ${label}`,
      noKey: tr("Key · none"),
      tapIn: dev("Pre Ducker"),
      tapGr: dev("Ducker GR"),
      tapOut: dev("Post"),
      hint: tr("The diagonals are times, not the shape of the change. Key is one bar even in stereo: L and R, summed."),
    },
    // One screen for four effect families: the title names the effect the node holds,
    // since the selector that picked it is on another surface. Two output taps, because
    // an insert effect sits before the fader on a channel and after it on a bus.
    insfx: {
      title: dev("INS FX"),
      open: tr("Insert FX screen"),
      tapIn: dev("Pre Ins FX"),
      tapOut: dev("Pre Fader"),
      tapOutBus: dev("Post"),
      tapGr: dev("Ins FX GR"),
      // The multi-band compressor's first face: what the three bands share, against the
      // three that are one band each. `fixed()` because it is this app's own word for that
      // face rather than a row read off the unit, and one translated segment among four
      // would read as a different control.
      faceMain: fixed("Main"),
      // Speed and Depth on the Clean amp: the selector beside them decides whether they
      // reach anything.
      vibOnly: tr("Vib only"),
      bypassed: tr("Bypassed — the values are kept and edited here, but nothing they are set to reaches the signal."),
      // The companders' plot, and theirs alone: the amps and Pitch Fix carry no curve.
      // Named for what the shape IS, because this block does three things at once and a
      // reader who only sees the compressor half misreads the fall at the bottom as a
      // fault. The reduction is not mentioned: it is drawn the same way, in the same
      // place, as on every other screen that has one.
      curveHint: tr(
        "Below the window the level is pushed further down, above the threshold it is held back, and past 0 dB it stops. The dot is the live level.",
      ),
      // The multi-band compressor's two figures. MAIN's is a STEP and not a filter — the
      // unit's slopes are derivable from nothing the app holds — which is the one thing a
      // reader cannot tell from looking at it, so it is what the line says.
      mbcMainHint: tr(
        "Where the crossovers split the spectrum and what each band is mixed back at. The step is the two settings, not the unit's filter slopes.",
      ),
      mbcBandHint: tr(
        "This band alone: held back above its own threshold, then its make-up added. The reduction is the unit's reading for this band.",
      ),
      // Shown in place of the line above while this band's own Bypass is on. The figure is
      // a straight line there, so what this adds is why: the values below it are kept and
      // still edited, and neither of them is in the signal.
      mbcBandBypassed: tr(
        "This band is bypassed: it passes through at unity, with neither its compression nor its make-up. The values below are kept and still edited here.",
      ),
      // Shown in place of the line above while the unit is driving the panel. It says who
      // owns the values rather than what they do, because that is what changed.
      mbcOneKnob: tr(
        "1-Knob is on: the unit is setting every value here from its own level, and nothing edited here is sent to it.",
      ),
      // The pill on a row the unit has taken over — Pitch Fix's Scale and its twelve notes
      // while MIDI Control is not Off, which is when the notes the correction aims at come
      // from a port of the unit's own. It says WHO owns the row, on the panel, rather than
      // only in the tooltip beside it, which is a hover away.
      deviceOnlyTag: tr("Set on the device"),
    },
  },
  shelf: {
    title: tr("Hidden"),
    showAll: tr("Show all"),
    restore: (label: string): string => `Show ${label}`,
  },
  selbar: {
    title: tr(" selected"),
    hide: (n: number): string => `Hide ${n}`,
    clear: tr("Clear"),
  },
  tooltip: {
    addNote: tr("Add a note"),
    collapseNote: tr("Minimize note"),
    expandNote: tr("Expand note"),
    recPointTap: tr("Rec Point tap — before the fader and Ducker. Drag from here to a USB output or microSD Rec."),
  },
  warning: {
    title: tr("Sample-rate notes"),
    insFx: tr("Insert FX (MONO IN channels, MIX, STEREO) unavailable above 96 kHz."),
    stereoEq: tr("Stereo channel (CH 5/6–11/12) EQ unavailable at 176.4 / 192 kHz."),
    fx2: tr("FX2 bus unavailable above 96 kHz."),
    duckerTitle: tr("Ducker not on direct out"),
    duckerBypass: (label: string): string =>
      `${label} — Ducker is on, but the USB / SD direct out taps before it. Route via a STEREO or MIX bus to include it.`,
  },
  status: {
    loaded: (model: string): string => `Loaded ${model} — drag to place and connect`,
    switchedModel: (model: string): string => `Switched to ${model}`,
    sampleRate: (rate: string): string => `Sample rate: ${rate}`,
    followUsbOn: tr("Follow USB on — the device now clocks from the USB host"),
    followUsbOff: tr("Follow USB off — the device now holds its own clock"),
    newPlan: tr("Created a new plan"),
    planLoaded: tr("Plan loaded"),
    paramsBounded: (count: number): string =>
      `${count} stored ${count === 1 ? "value was" : "values were"} outside what this app can write, and now read as the nearest value it can send`,
    paramsDropped: (count: number): string =>
      `${count} stored ${count === 1 ? "value was" : "values were"} not a value this app can write, and now read as the effect's own default`,
    recentRemoved: (name: string): string => `Removed ${name} from the recent plans`,
    planSaved: tr("Plan saved"),
    savedTo: (name: string): string => `Saved to ${name}`,
    openedFrom: (name: string): string => `Opened ${name}`,
    shareUrlCopied: tr("Share URL copied to the clipboard"),
    shareUrlInBar: tr("Couldn't copy to the clipboard — copy the share URL from the address bar"),
    shareUrlError: (message: string): string => `Share URL could not be generated: ${message}`,
    planDownloaded: tr("Plan JSON downloaded"),
    canceled: tr("Canceled"),
    pngExported: tr("PNG exported"),
    pdfExported: tr("PDF exported"),
    arranged: tr("Arranged to the default layout"),
    busyDeviceRead: tr("Reading from the device — try that again when it finishes"),
    deviceLinkBusy: tr("Another device operation is holding the connection — try that again when it finishes"),
    fetchConnecting: tr("Connecting to the device…"),
    fetchedDevice: (model: string, n: number): string => `Fetched ${n} setting${n === 1 ? "" : "s"} from ${model}`,
    fetchedUnread: (model: string, n: number, unread: number): string =>
      `Fetched ${n} from ${model}; ${unread} node${unread === 1 ? "" : "s"} not read`,
    fetchPartial: (n: number, failed: number, unread: number): string =>
      `Fetched ${n}, ${failed} failed` + (unread ? `, ${unread} node${unread === 1 ? "" : "s"} not read` : ""),
    settingsImported: (name: string, n: number): string => `Imported ${n} setting${n === 1 ? "" : "s"} from ${name}`,
    settingsPartial: (n: number, failed: number, unread: number): string =>
      `Imported ${n}, ${failed} failed` + (unread ? `, ${unread} node${unread === 1 ? "" : "s"} not read` : ""),
    settingsError: (message: string): string => `Settings file could not be imported: ${message}`,
    dropUnsupported: (name: string): string => `${name} cannot be opened here — drop a plan (.json)`,
    dropUnsupportedSettings: (name: string): string =>
      `${name} cannot be opened here — drop a plan (.json) or a settings file (.urxf)`,
    dropMultiple: tr("Drop one file at a time"),
    fetchError: (message: string): string => `Device fetch failed: ${message}`,
    compareConnecting: tr("Comparing with the device…"),
    compareMatch: (compared: number, ms: number): string => `All ${compared} settings read match the device (${ms} ms)`,
    compareDiff: (differ: number, compared: number, ms: number): string =>
      `${differ} of ${compared} settings read differ from the device (${ms} ms)`,
    comparePartial: (differ: number, compared: number, failed: number, ms: number): string =>
      `${differ} of ${compared} differ, ${failed} could not be read (${ms} ms)`,
    compareError: (message: string): string => `Device compare failed: ${message}`,
    writeConnecting: tr("Connecting to the device…"),
    writeNoChanges: tr("Device already matches the plan — nothing to write"),
    written: (n: number): string => `Wrote ${n} setting${n === 1 ? "" : "s"} to the device`,
    writePartial: (n: number, failed: number): string => `Wrote ${n}, ${failed} failed`,
    writeStopped: (n: number, notSent: number): string =>
      `Write stopped after a failure: ${n} sent, ${notSent} not sent`,
    writeResidual: (n: number): string => `Wrote, but ${n} param${n === 1 ? "" : "s"} did not take (see console)`,
    writeReadFailed: (n: number): string =>
      `Write canceled: ${n} setting${n === 1 ? "" : "s"} could not be read from the device`,
    writeError: (message: string): string => `Device write failed: ${message}`,
    deviceSetupReading: tr("Reading the device's settings…"),
    deviceSetupRead: tr("Read the device's settings"),
    deviceSetupApplying: tr("Applying settings to the device…"),
    deviceSetupApplied: (n: number): string => `Applied ${n} setting${n === 1 ? "" : "s"} to the device`,
    selfTestRunning: tr("Running device self-test… do not disconnect (use the menu again to cancel)"),
    selfTestRefused: tr(
      "Self-test did not start — some parameters it would have to restore could not be read first. The device was not touched.",
    ),
    selfTestCancelled: tr("Self-test canceled — device left silent; fetch again to restore your state"),
    selfTestPass: (n: number): string => `Self-test passed: ${n} params written and read back identically`,
    selfTestFail: (n: number): string => `Self-test FAILED: ${n} param${n === 1 ? "" : "s"} did not match after write`,
    // "did not match after write" is a claim about the device, and a run that stopped
    // partway has none to make: the loop never finished converging them.
    selfTestIncomplete: (n: number): string =>
      `Self-test did not complete: ${n} param${n === 1 ? "" : "s"} still differed when the run stopped — see the report`,
    selfTestRestoreFail: tr("Self-test: device may not be restored — fetch again to check"),
    selfTestUnverified: (confirmed: number, refuted: number, untestable: number): string =>
      `Self-test guesses: ${confirmed} confirmed, ${refuted} refuted, ${untestable} untestable`,
    selfTestError: (message: string): string => `Self-test error: ${message}`,
    liveConnecting: tr("Connecting for live sync…"),
    liveOn: (model: string, n: number): string => `Live sync on · ${model} · ${n} setting${n === 1 ? "" : "s"} read`,
    liveOff: tr("Live sync off"),
    liveSynced: (n: number): string => `→ device (${n})`,
    liveFollowing: tr("← device…"),
    liveFollowed: (n: number): string => `← device (${n})`,
    liveHeld: (read: number, held: number): string =>
      `← device (${read}) · ${held} kept and re-sent (the unit's own sample rate cannot run them)`,
    sharedSetting: (dropped: string, kept: string, more: number): string =>
      `${dropped} shares device settings with ${kept}${more > 0 ? ` (+${more} more)` : ""} — only ${kept}'s values reach the device`,
    liveError: (message: string): string => `Live sync stopped: ${message}`,
    linkLogFailed: (message: string): string => `Link ledger could not be written: ${message}`,
    connected: tr("Connected"),
    connectionDeleted: tr("Connection deleted"),
    fixedConnection: tr("Fixed connection — cannot be removed"),
    noteMinimized: tr("Note minimized"),
    noteExpanded: tr("Note expanded"),
    hidUnused: (n: number): string => `Hid ${n} unused node${n === 1 ? "" : "s"}`,
    noneToHide: tr("No unused nodes to hide"),
    hidNode: (label: string): string => `Hid ${label}`,
    hidSelected: (n: number): string => `Hid ${n} node${n === 1 ? "" : "s"}`,
    shownNode: (label: string): string => `Showing ${label}`,
    shownAll: tr("Showing all nodes"),
    pathTraced: (label: string, n: number): string =>
      `Tracing the signal path into ${label} — ${n} node${n === 1 ? "" : "s"}`,
    pathNone: (label: string): string => `No live signal path feeds ${label}`,
    undone: tr("Undone"),
    undoneNode: (label: string): string => `Undid the change to ${label}`,
    redone: tr("Redone"),
    redoneNode: (label: string): string => `Redid the change to ${label}`,
    nothingToUndo: tr("Nothing to undo"),
    nothingToRedo: tr("Nothing to redo"),
    undoBusyDrag: tr("Finish the current drag before undoing"),
    undoDeviceBusy: tr("Busy with the device — undo is unavailable until it finishes"),
    undoModal: tr("Close the open dialog before undoing"),
    undoRateLive: tr("The sample rate follows the device while Live sync is on — it cannot be undone here"),
    undoRateLiveMixed: tr(
      "This step also changes the sample rate, which follows the device while Live sync is on — the whole step is held back, not lost; it works again with Live sync off",
    ),
    midiBusy: tr("Busy with the device or a file — incoming MIDI is ignored until it finishes"),
    themeDark: tr("Switched to dark mode"),
    themeLight: tr("Switched to light mode"),
    themeAuto: tr("Following the system theme"),
    language: (name: string): string => `Language: ${name}`,
    loadError: (message: string): string => `Load error: ${message}`,
    saveError: (message: string): string => `Save error: ${message}`,
    exportError: (message: string): string => `Export error: ${message}`,
    updateDownloading: tr("Downloading update… the app will restart"),
  },
  confirm: {
    discard: tr("You have unsaved changes. Discard them?"),
    deviceSetupDiscard: tr("The device setup screen has changes you have not applied. Discard them?"),
    update: (version: string): string => `Version ${version} is available. Update now?`,
    switchModel: (device: string, ui: string): string =>
      `The connected device is ${device}, but ${ui} is selected. Switch to ${device} (replacing the current plan) and fetch?`,
    write: (n: number): string =>
      `Write ${n} change${n === 1 ? "" : "s"} to the device? This overwrites the device's current settings.`,
    firmwareMismatch: (device: string, supported: string): string =>
      `The connected device's firmware (${device}) differs from the version this app was tested with (${supported}). It may not work correctly. Continue anyway?`,
    selfTest: tr(
      "Run the device self-test? It briefly overwrites every parameter to verify writes, then restores the original state. Outputs stay muted throughout (faders floored, oscillator and phantom off).",
    ),
    selfTestExport: tr(
      "This model has unconfirmed parameter mappings. Save the self-test report so it can be sent back to confirm them?",
    ),
    selfTestFailExport: tr(
      "The self-test found problems. Save a report listing every parameter that did not match and every read or write that failed?",
    ),
    deviceErrorExport: tr("Some parameters could not be read or written. Save a report listing each failure?"),
    // Nothing FAILED here: the read worked and the merge declined to overwrite what
    // was edited while it ran. Saying "could not be read or written" would report the
    // merge working as a fault, right after a success on the status line.
    deviceUnappliedExport: tr(
      "Some device values were not applied, because they were edited here while the read was running. Save a report listing them?",
    ),
    importSettings: (name: string, model: string): string =>
      `Import ${name} onto the current ${model} plan? A settings file does not say which unit it came from, so check that ${model} is the right model. Layout, hidden nodes, and notes are kept — the file carries no editing state.`,
    reclock: (deviceRate: string, planRate: string): string =>
      `The device is running at ${deviceRate} and the plan is set to ${planRate}. Writing re-clocks the device and renegotiates the USB stream, interrupting audio for a moment. The computer follows the device's new rate. Continue?`,
    followUsbOn: tr(
      "Turn Follow USB on? The device hands its clock back to the computer. If the computer is running a different rate, the device re-clocks to it immediately, which can interrupt audio; if the rates already match, nothing changes.",
    ),
    trackCountDrop: (from: number, to: number): string =>
      `The microSD recorder is set to ${from} tracks and this rate allows ${to}, so the unit lowers it. Nothing this app can write raises it again — the way back is the unit's own microSD screen, RECORDER menu, [Track Count].`,
    trackCountMayDrop: tr(
      "Above 48 kHz the unit also lowers the microSD recorder's Track Count to what the rate allows, and nothing this app can write raises it again — the way back is the unit's own microSD screen, RECORDER menu, [Track Count].",
    ),
    writeRetry: (sent: number, notSent: number): string =>
      `The write stopped after a failure: ${sent} setting${sent === 1 ? "" : "s"} reached the device and ${notSent} did not. Try again? Only what still differs will be sent.`,
  },
  consent: {
    title: tr("Before you start"),
    body: [
      tr(
        "URX Router can write settings to a connected YAMAHA URX-series interface, overwriting its current mixer settings. The control protocol was determined by independent analysis, not official documentation, so sending data to hardware always carries some risk.",
      ),
      tr("Parameter mappings are verified on hardware only for the URX44V; URX44 and URX22 are not verified yet."),
      tr(
        "The software is provided “as is”, without warranty of any kind, and the authors are not liable for any damage to hardware, loss of settings, or other loss arising from its use.",
      ),
    ],
    accept: tr("By continuing, you accept this risk."),
    agree: tr("Agree and continue"),
    quit: tr("Quit"),
  },
  rateChoice: {
    title: tr("The device is following its USB host"),
    intro: (planRate: string, deviceRate: string): string =>
      `The plan is set to ${planRate}, but the device is running at ${deviceRate} and Follow USB is on, so it takes its clock from the computer. Writing ${planRate} now would re-clock the device and then revert to ${deviceRate} a moment later.`,
    hiRateNote: (limits: string): string =>
      `${limits} Those settings stay out of this write, but the plan keeps them — lowering the rate writes them again.`,
    /** Named for its ARM, not positioned next to it: the three buttons wrap onto a second
     *  row on a narrow window, so anything that reads as "the note above the buttons"
     *  reads as true of the arm that costs nothing too. */
    trackCountDrop: (from: number, to: number): string =>
      `Turning Follow USB off and writing the plan's rate lowers the microSD recorder: it is set to ${from} tracks and that rate allows ${to}. Nothing this app can write raises it again — the way back is the unit's own microSD screen, RECORDER menu, [Track Count].`,
    adopt: (deviceRate: string): string => `Write at ${deviceRate}`,
    release: (planRate: string): string => `Turn Follow USB off and write at ${planRate}`,
    cancel: tr("Cancel"),
  },
  loadReport: {
    title: tr("Plan could not be loaded"),
    intro: tr(
      "The plan in this link has problems and was not loaded. Copy the report below and give it back to the tool that generated the plan so it can be fixed, then reload.",
    ),
    copy: tr("Copy"),
    copied: tr("Copied"),
    close: tr("Close"),
    slotTitle: tr("Plan has an insert-FX slot conflict"),
    slotIntro: tr(
      "Two nodes in this plan claim the same device-wide insert-FX slot. The app's own screens cannot author that, but a device readback does not check it, so a plan saved from the device can carry one — which is why this is a warning and not a refusal. Load it and resolve the conflict here, or close and fix it where the plan came from.",
    ),
    loadAnyway: tr("Load anyway"),
  },
  compareReport: {
    title: tr("Device comparison"),
    intro: tr(
      "Read-only — nothing was written. Every parameter the tool round-trips was read from the device and compared with the plan; the summary counts them and the full log lists each one, so a match can be verified rather than trusted. Use it to check an imported settings file against the hardware — connect the unit the file came from and compare.",
    ),
  },
  // The link ledger (status bar, experimental builds). Names what the app asked of the
  // broker, in the operator's terms rather than the protocol's.
  //
  // One vocabulary, used by both surfaces: the status bar prints a SUBSET of these rows
  // and prints them with these words. It used to carry its own shorter set — `cmd` for
  // the row called `Sent` — and a reader had no way to know the two were one number.
  //
  // "Subscriptions", not "Re-subscribes": the count includes the session's FIRST
  // registration of each set, so calling it a re-subscription made a healthy session
  // open at 2 and read as churn. The churn itself is the registration-frames row,
  // which counts each address and so distinguishes a first registration (no unregist)
  // from a replacement.
  linkStats: {
    title: tr("Device Center link"),
    row: {
      up: tr("Link up"),
      sent: tr("Sent"),
      subscriptions: tr("Subscriptions"),
      frames: tr("Registration frames"),
      reads: tr("Full reads"),
      noanswer: tr("No answer"),
      log: tr("Log"),
    },
    set: tr("set"),
    get: tr("get"),
    params: tr("params"),
    meters: tr("meters"),
    regist: tr("regist"),
    unregist: tr("unregist"),
    // What the pair means, not what it is: the left figure is the session's total, this
    // one is the CURRENT consecutive run and the session ends when it reaches the
    // limit. "stall 2/3" said neither of those.
    stall: (n: number, limit: number): string => `${n}/${limit} to cutoff`,
    noLog: tr("not written yet"),
    copy: tr("Copy"),
    copied: tr("Link ledger copied to the clipboard"),
    copyFailed: tr("Couldn't copy to the clipboard — read the ledger from the panel"),
  },
  licenses: {
    title: tr("Third-party licenses"),
    close: tr("Close"),
    error: (message: string): string => `Could not load the license notice: ${message}`,
    familyMeta: (crates: number, texts: number): string =>
      `${crates} ${crates === 1 ? "crate" : "crates"} · ${texts} ${texts === 1 ? "text" : "texts"}`,
  },
  prefs: {
    title: tr("Preferences"),
    close: tr("Close"),
    desktopOnly: tr("Desktop app only"),
    uiSection: tr("Language & theme"),
    language: tr("Language"),
    theme: tr("Theme"),
    themeAuto: tr("Auto"),
    themeDark: tr("Dark"),
    themeLight: tr("Light"),
    uiNote: tr("Auto follows the OS appearance."),
    deviceSection: tr("Device read / write"),
    scope: tr("Scope"),
    scopeAll: tr("All supported"),
    scopeScene: tr("Scene only"),
    deviceNote: tr("One scope for Fetch from device, Write to device, and Live sync. Locked while Live sync is on."),
    sceneNote: tr(
      "Scene only leaves the URX's device-wide settings untouched: monitor, phones, output patches, streaming, oscillator, and the sample rate.",
    ),
    diagNote: tr("Compare and self-test always cover everything."),
    planSection: tr("Plan files"),
    saveScope: tr("Save scope"),
    planFull: tr("Full plan"),
    planNote: tr("Opening a scene-scoped plan keeps the current values of everything outside the scene."),
    planNoteShare: tr("Applies to the share URL and the JSON download."),
    versionSection: tr("Application version"),
    updateLaunch: tr("Check at launch"),
    updateNow: tr("Check now"),
    checking: tr("Checking…"),
    upToDate: tr("Already up to date."),
    updateAvailable: (version: string): string => `Version ${version} is available.`,
    updateCheckFailed: tr("Update check failed."),
    warnSection: tr("Warnings"),
    warnFirmware: tr("Untested firmware"),
    warnRate: tr("Sample-rate limits"),
    warnDucker: tr("Ducker bypass"),
    warnNote: tr("OFF hides that class of warnings. Device behavior is unchanged."),
    controlsSection: tr("Controls"),
    wheel: tr("Wheel step"),
    wheelOption: (steps: number): string => (steps === 1 ? "1 step per notch" : `${steps} steps per notch`),
    fine: tr("Fine-tuning"),
    fineHold: tr("Hold Shift"),
    fineLatch: tr("Latch"),
    controlsNote: tr("Latch flips fine-tuning on each Shift press instead of holding."),
    sleepSection: tr("Computer sleep"),
    preventSleep: tr("Prevent sleep while live"),
    sleepNote: tr(
      "ON keeps this computer and its display awake for as long as Live sync is running, so watching the meters does not end in a sleeping machine. The idle screen lock is held off with them; outside a session the computer sleeps and locks as usual.",
    ),
    sleepFailed: (message: string): string => `Could not change the sleep setting: ${message}`,
    filesSection: tr("Files & export"),
    exportScale: tr("Export scale"),
    exportNote: tr("PNG / PDF resolution, as a multiple of the graph's 1:1 size (zoom independent)."),
    exportBg: tr("Export background"),
    exportBgActive: tr("Active theme"),
    exportBgDark: tr("Dark"),
    exportBgLight: tr("Light"),
    recent: tr("Recent plans"),
    clearRecent: tr("Clear list"),
  },
  dropzone: {
    plan: tr("Drop a plan (.json) to open it"),
    planOrSettings: tr("Drop a plan (.json) or a URX settings file (.urxf)"),
  },
  filter: {
    plan: tr("URX Router plan"),
    settings: tr("URX settings file"),
    png: tr("PNG image"),
    pdf: tr("PDF document"),
    report: tr("Self-test report"),
    errorReport: tr("Device error report"),
  },
  error: {
    trackCountReread: (message: string): string =>
      `The settings were written, but the microSD recorder's Track Count could not be read back afterwards: ${message}. The unit lowers it by itself when the rate cannot carry it, so what the panel shows may be the value from before the change — read the device to find out.`,
    deviceSetupRead: (message: string): string => `Could not read the device's settings: ${message}`,
    deviceSetupWrite: (message: string): string => `Could not apply the settings: ${message}`,
    noRule: tr("This route cannot be connected"),
    duplicate: tr("Already connected"),
    singleInput: tr("This input accepts only one source (remove the existing connection first)"),
    cannotConnect: tr("Cannot connect"),
    // What a failure that described itself as nothing is reported as. `errorText`
    // substitutes it so an empty description cannot reach the operator as an empty
    // dialog, or as a frame with nothing after its colon. A lower-case fragment
    // like the shell codes below, since most of its uses are framed.
    noReason: tr("the failure reported no reason"),
    recPointRequired: tr("Connect USB outputs and microSD Rec from the Rec Point tap — the jack on top of the channel"),
    recPointTargets: tr(
      "The Rec Point tap reaches only USB outputs and microSD Rec — use the channel's output for the rest",
    ),
    /**
     * Stable error codes raised outside the UI layer — the Rust shell (lib.rs file
     * IO, vd.rs broker link, midi.rs bridge, keepawake.rs) and core's export path —
     * resolved by `errorText` in i18n/index.ts. A code either stands alone or is
     * followed by ": " and a technical detail (an address, a URI, an OS message),
     * which the entry takes as its argument. Most of these are embedded after a
     * "<action> failed: " frame, so they read as lower-case fragments.
     */
    shell: {
      brokerUnreachable: tr("Device Center isn't running. Start it, connect the URX, then try again."),
      noDevice: tr("Device Center is running, but no URX is connected. Connect the unit, then try again."),
      controlWorkerGone: tr(
        "The control connection was interrupted. Reconnect, and restart the app if it keeps happening.",
      ),
      deviceLost: tr("the device link dropped (USB unplugged or Device Center quit)"),
      brokerClosed: tr("Device Center closed the control connection. Start it again, then retry."),
      brokerNoVdpPort: (detail: string): string =>
        `Device Center answered but did not offer a control port (${detail}). Restart Device Center, then try again.`,
      notConnected: tr("not connected to the device"),
      brokerTimeout: (detail: string): string => `Device Center did not answer in time (${detail})`,
      brokerUnresponsive: tr(
        "Device Center stopped answering, so the operation was stopped. Restart Device Center, then try again.",
      ),
      brokerRejected: (detail: string): string => `the device refused the write (${detail})`,
      brokerBadResponse: (detail: string): string => `Device Center sent an unexpected response (${detail})`,
      brokerIo: (detail: string): string => `the connection to Device Center failed (${detail})`,
      fileNotFound: tr("the file no longer exists at that path"),
      fileDenied: tr("access to the file was denied"),
      fileIo: (detail: string): string => `the file could not be read or written (${detail})`,
      fileBadExtension: (detail: string): string => `unsupported file extension (this action takes: ${detail})`,
      pngEncode: tr("the image could not be encoded as PNG"),
      canvasUnavailable: tr("the drawing canvas is unavailable, so the image could not be rendered"),
      midiPortNotFound: tr("That MIDI port is no longer available. Reconnect the device and pick it again."),
      midiOutputNotOpen: tr("no MIDI output port is open"),
      midiInitFailed: (detail: string): string => `the MIDI subsystem could not be started (${detail})`,
      midiOpenFailed: (detail: string): string => `the MIDI port could not be opened (${detail})`,
      midiSendFailed: (detail: string): string => `the MIDI message could not be sent (${detail})`,
      keepAwakeFailed: (detail: string): string => `the OS refused it (${detail})`,
      keepAwakeUnsupported: tr("keeping the computer awake is not supported on this platform"),
    },
    firmwareUnread: tr(
      "The device's firmware version could not be read, so this build cannot check that its parameter mappings apply to your unit. Reconnect and try again.",
    ),
    liveReadIncomplete: (n: number): string =>
      `${n} setting${n === 1 ? "" : "s"} could not be read, so the device's state is not fully known. Live sync needs a complete read to start.`,
    liveFollowStopped: tr(
      "Device follow stopped while the session was starting, so a change made on the device would not reach the plan. Live sync was not started.",
    ),
    followReadHeld: (cause: string, n: number): string =>
      `${cause}; ${n} setting${n === 1 ? "" : "s"} the unit cleared are still held in the plan`,
    followReadIncomplete: (n: number): string =>
      `${n} setting${n === 1 ? "" : "s"} could not be read back after a change on the device, so the plan no longer matches it. Fetch again to resync.`,
    clockUnread: (message: string): string =>
      `The device's sample rate and Follow USB state could not be read (${message}), so there is no way to tell whether the plan's rate would stick. Nothing was written.`,
    followUsbWrite: (message: string): string =>
      `Follow USB could not be turned off (${message}). Nothing was written.`,
    unknownModel: (model: string): string => `Unknown model: ${model}`,
    modelMismatch: (device: string, ui: string): string =>
      `The connected device is ${device}, but ${ui} is selected. Open or switch to the matching plan before writing.`,
    notWhileLive: tr(
      "Stop Live sync first — importing replaces every setting at once, which a live session cannot follow.",
    ),
    notPlanFile: tr("This is not a URX Router plan file"),
    urxf: {
      notUrxf: tr("This is not a URX settings file"),
      truncated: tr("The settings file is truncated or has an unexpected record"),
      badBlock: tr("The settings file's block structure is not readable"),
      badDescriptor: tr("The settings file describes a parameter this build cannot decode"),
      lengthMismatch: tr("The settings file's parameter table and values do not match (the file looks corrupt)"),
      noCurrent: tr("The settings file holds no current settings (only stored scenes)"),
    },
    missingModel: tr("The plan file has no modelId"),
    badPlanUrl: tr("The plan link is malformed (could not be decoded)"),
    planUrlUnsupported: tr(
      "This browser doesn't support compressed plan links — use a recent Chrome / Edge / Firefox, or Safari 16.4+",
    ),
    planVersionUnsupported: tr("This plan was saved by a newer version of URX Router — update the app to open it"),
  },
};

// A leaf that was added without dev() / fixed() / tr() widens to `string`, which is the
// only way `string extends T` holds — every marked leaf is either a literal or branded.
type UnmarkedLeaf<T> = T extends (...a: never[]) => unknown
  ? never
  : T extends string
    ? string extends T
      ? true
      : never
    : T extends readonly unknown[]
      ? UnmarkedLeaf<T[number]>
      : { [K in keyof T]: UnmarkedLeaf<T[K]> }[keyof T];

const _everyLeafIsMarked: UnmarkedLeaf<typeof en> extends never
  ? true
  : "an unmarked string leaf was added to en.ts — wrap it in dev(), fixed() or tr()" = true;
void _everyLeafIsMarked;

// The brand is dropped here, so a translation is an ordinary string; dev() / fixed() keep
// their literal type through the mapping, which is what pins those keys across catalogues.
type Unbrand<T> = T extends Translatable
  ? string
  : T extends (...a: never[]) => unknown
    ? T
    : T extends object
      ? { [K in keyof T]: Unbrand<T[K]> }
      : T;

export type Messages = Unbrand<typeof en>;
