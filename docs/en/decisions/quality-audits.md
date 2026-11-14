# Decisions: quality audits

> 日本語版: [../../ja/decisions/quality-audits.md](../../ja/decisions/quality-audits.md)

Closed decisions that came out of the whole-application and robustness audits: which way a finding
was fixed, which behaviors are kept as they are, and why. "The operator" below is the person who
directs this project's work and decides for it. An audit's report is not kept in this repository;
what an audit leaves here is the code, the tests that pin it, and these decisions. Read this
before proposing a fix for something an audit has already raised.

## Fix methods the operator chose (2026-08-13 audit)

**Decision.** For five subjects of the 2026-08-13 whole-application audit the operator chose the
way to fix them as well. The methods turned down are not proposed again.

| Subject | Chosen | Turned down |
| --- | --- | --- |
| MIDI learn captured the app's own feedback echo as the gesture | Feedback stops while learn is on | Using up the echo guard to absorb the echo |
| A pickup binding behind an absolute one on the same address did not respond | The UI gives every binding of one address the same take-in mode | A fallback inside the engine |
| The MIDI window's capability described a separation the access control did not enforce | Permissions are generated for the app's commands, and the device and file commands are limited to the main window | Correcting the description only |
| The `mobile` configuration branch could not be compiled | The mobile attribute and its comment are removed, and the crate is stated to be desktop-only | A `cfg(desktop)` gate |
| Three findings that turned on what the unit itself does | Measured on the hardware first, then fixed ([#364](https://github.com/semnil/urx-router/pull/364)) | — |

The fixes themselves are in [#366](https://github.com/semnil/urx-router/pull/366).

## Accepted behaviors the audit tests pin

**Decision.** The behaviors below were found in a robustness audit, are known, and are left as
they are. Where an `*.audit.test.ts` case pins one, the file is named beside it, and a change to
that behavior rewrites the pin (`AGENTS.md` "Conventions").

- `rateConstraints` in `src/core/constraints.ts` classifies a sample rate by `> 96000` alone. It
  does not check that the rate is one of the table's, nor reject zero or a negative value
  (`src/core/routing.audit.test.ts`).
- A ducker may take its own host channel as its key source. That is a valid side-chain choice
  (`src/core/routing.audit.test.ts`).
- `tagPortRef(0x7fffffff)` produces the same value as `PORT_REF_NONE`. Real port ids are all small,
  so that id does not occur; the case in `src/core/control/passthrough.audit.test.ts` records the
  collision.
- The factory capture lacks the two fixed MIX → STEREO wires. `ensureFixedConnections` supplies
  them (`src/models/initial-state.audit.test.ts`).
- `src-tauri/src/vd.rs` logs through `eprintln!` only.
- Four strings in `src/i18n/ja.ts` are English: PHONES Level, CUE Interrupt, Delay Time and
  Frame rate. They follow the rule that a label taken from the unit's own screen stays as the unit
  writes it, and are not translated again.

## Robustness decisions

Decisions taken while fixing audit findings. Each one closes a proposal that would otherwise come
back.

- **No guard on closing the window with unsaved changes.** Save, PNG export and PDF export report
  a failed command in a dialog instead of failing in silence; a guard on closing a modified
  document was considered with them and not added.
- **The readback at the start of Live sync keeps its present display.** A node that could not be
  read is already shown through the unread-node badge, so nothing further is added there. A read
  that fails during the session stops Live sync and is reported in a dialog (`assertReadComplete`
  in `src/main.ts`).
- **The message `liveFollowedPartial` stays removed.** Once the completeness of a read was checked
  in one place, no path showed that message any more, and it was deleted. The same wording is not
  brought back.
- **An unused export of a value is un-exported, and an unused export of a type is kept.** The
  `export` keyword is removed and the value stays. A type is kept because it is the return type of
  an API: callers rely on its shape without writing its name, so searching for the name finds no
  user. Unused exports are found by listing a module's exports and counting their uses.
- **`FxParamDesc` and `InsertFxParamDesc` stay two types.** Their `key`, the context `format`
  takes, and `mirror` differ, so they cannot be merged completely, and a partial merge was judged
  low in value for the coupling it adds.
- **Of the MIDI shell's errors, only `midi-port-not-found` is localized** (`error.midiPortNotFound`,
  through `midiErrorStatus` in `src/ui/midi.ts`, the counterpart of `connectFailureStatus`). MIDI
  errors arrive on their own IPC surface and share no single point with the device errors.
  `midi-output-not-open` is dropped where sending fails and is never shown, so it has no message.
- **`meterReadCell()` in the CONSOLE is built only for a strip that has a meter.** A regression
  once built the cell and its caption for every strip and threw them away where there was no meter.
- **`tsconfig.e2e.json` needs something that runs it.** Without the `typecheck:e2e` script and its
  step in `ci.yml`, the E2E sources would go unchecked by the compiler while every run stayed green.
- **The theme's `localStorage` guard follows the convention each call site already uses.** A shared
  helper for it was judged more than the problem needs.
- **The two copies of the `reading` helper in the meter tests stay.** The `tapFor` type keeps them
  from drifting apart unnoticed, so removing the duplication is not proposed again.
- **How the strict content security policy was checked.** PNG and PDF export were confirmed by the
  operator in the running app, the licenses dialog by looking at it, and the demo by serving the
  real `build:demo` bundle with `vite preview` and driving it with Playwright — sharing, downloading
  and a `?plan=` round trip included — with no error in the console.

## Rapid-repeat guards

**Decision.** Every control was audited for what a second press does while the first is still
running, after pressing "Check now" repeatedly left the update check on "Checking…" for good. The
result is two mechanisms in `src/main.ts`, and both stay:

- **Actions that are not a file flow** — PNG, PDF, the share URL, the licenses dialog, the FOLLOW
  USB badge, starting Live sync — each own a private `singleFlight` (`src/app/flow-latch.ts`).
- **Plan and settings file flows** — New, Open, Save, a recent file, a dropped file, a settings
  file import and the model selector — share one latch, `fileFlow`, so that one flow runs at a
  time across every one of those entries. Pressing any two of them in quick succession does not
  stack a discard confirmation or a file dialog.

**Kept as they were.**

- For Fetch, Write, Compare and the self-test, a second press cancels the run. That is the
  specified behavior.
- Preference toggles and the CONSOLE's controls are synchronous, or are meant to be operated
  continuously.
- A recent file that fails to load is removed from the list automatically, with a notice in the
  status line (`status.recentRemoved`). The confirmation for discarding unsaved changes still comes
  before the load, and cancelling it does nothing.

**Turned down.**

- **Bringing back the private latches of New, Open and Save, or the `liveActivating` flag.** They
  were replaced by the two mechanisms above. Open goes through `openPlanFrom`, where a read that
  returns nothing means the dialog was cancelled.
- **Asking before a recent file that fails to load is removed.** The list was changed to ask once,
  and then settled on automatic removal.

**Premise.** The update check sets its own timeout (`UPDATE_CHECK_TIMEOUT_MS` in
`src/core/platform.ts`), because the updater plugin's check has no default one; with it, a lost
response ends in the failed state instead of leaving the check pending.

**Switching a MIDI port in quick succession.** The same question was asked of the MIDI window's
two port selects: what a second and a third choice do while the first port is still being opened.

- **The order of opens and closes is kept as it is.** Port choices run one at a time per direction
  (`queuePort` in `src/ui/midi.ts`), and a choice that a later one has replaced before its turn is
  skipped. `src/ui/midi.test.ts` holds this against a stubbed shell: a run of three with the first
  open still in flight — A, B, C; A, B, A; a port, None, a port ("runs … as the first choice and the
  last, one open at a time") — and the input and the output switched together with their opens
  finishing crossed ("ends each direction on its own last choice when both are switched at once").
  In each, one open is in flight at a time, the replaced choice never reaches the shell, and the
  last choice is the one that is open, shown and stored.
- **Three defects beside that queue were fixed** (the operator's decision, 2026-11-13). Each has a
  test that failed before its fix.
  - The comparison of this side's record with the ports the shell holds (`reconcileOpenPorts`)
    discarded an answer that an open had overtaken, and not one that a close had. "None" chosen
    while the answer was on its way was put back by it, and on the output side feedback was then
    sent to the port that had been closed. A close now counts the way an open does.
    `src/ui/midi.test.ts`: "keeps None when it is chosen while the shell's answer about open ports
    is on its way", "keeps the output at None the same way, and sends nothing at the port it
    closed". `e2e/midi.spec.ts`: "None chosen while the shell is being asked survives the answer".
  - Storing a port choice rewrote the entries of both directions from what was open at that moment,
    so the entry of the other direction was erased whenever this session did not hold its port.
    Each direction now writes its own entry only, and "None" removes the entry of the direction it
    was chosen on. `src/ui/midi-feedback.test.ts`: "keeps a saved input whose restore failed when
    an output is chosen", "keeps a saved input still being restored when an output is chosen
    meanwhile", "keeps the stored output it gave up on when an input is chosen afterwards", "stores
    None for the direction it was chosen on, and leaves the other entry".
  - A port whose open failed after the operator had already chosen another one still had its
    failure put on the status line, in wording that names no port, and it stayed there once the
    other port was open. A failure is now reported only while its port is the latest choice for
    that direction (the operator's decision, 2026-11-13). `src/ui/midi.test.ts`: "says nothing
    about a failed input open the operator has already chosen away from", the same for the output,
    and "still says a failed open that is the latest choice, after an earlier one was replaced".
- **Turned down: reporting that failure and taking it down when a later port opens.** The line
  would still show a failure for a port the operator had left, for as long as the next open takes.
- **Not established: that the shell takes two commands in the order the page sent them.** The
  queue orders what the page sends, every test above stands a stub where the shell is, and the Rust
  side of the ports (`src-tauri/src/midi.rs`) has no test of its own. What is known about the order
  is this. The MIDI commands are all synchronous, and the shell enters synchronous commands one at
  a time, in the order the webview hands them over. That the webview hands two requests over in the
  order the page issued them, when the page does not await the first, is not guaranteed by Tauri's
  documentation. It holds in the macOS webview (WKWebView). The Windows webview
  (WebView2) is unconfirmed.
- **Known and left unguarded: three places where the result depends on the order two commands
  are taken in.** The first two go wrong only if the shell takes the two commands in the reverse
  of the order sent; the third goes wrong in the order sent.
  - A close is not awaited inside the port queue. "None" sends the close and the queue moves on
    (`applyInputPort`, `closeOutput`), so that close and the next open of the same direction can be
    in flight together. Taken in reverse, the shell opens the new port and then closes it, and the
    page goes on showing it as open.
  - A close followed by the question about open ports (`reconcileOpenPorts`, which `refreshPorts`
    runs). The close is counted when it is sent, so a question sent after it is not discarded.
    Taken in reverse, the answer still names the port being closed and the page puts it back.
  - Giving up a stalled output (`abandonOutput`) sends its close from outside the queue. If the
    open of the next output is in flight at that moment, the close reaches the shell after that
    open and closes the port it has just opened, while the page shows it as open. This one was
    found by reading the code and has not been reproduced.

## Abort on failure is the operator's decision

**Decision.** On the device link, a failed operation aborts the whole operation. The rule and its
permanent exceptions are in [architecture.md](../architecture.md) "Aborting on failure" and in
`AGENTS.md` "Conventions". It was set by the operator: after an operation fails, the state the next
one would rely on is no longer known, so every operation is aborted by default. A proposal to
loosen how far the abort reaches because it looks too strict is therefore a proposal to overturn
that decision, not a design adjustment.

**History.** What fixing toward that rule showed:

- **The scope was decided first.** The device link aborts; everything else — MIDI, storage —
  salvages what can be salvaged. Making every path strict without drawing that line would have
  turned a full `localStorage` quota, and the teardown itself, into reasons to abort.
- **Writing what could not be read was the hardest policy to defend.** `diffPlan` used to keep a
  command whose read had failed in the diff, which writes a parameter whose present value could
  not be confirmed, over the link that had just shown itself unreliable.
- **One rule had been written by hand in five places**, with five spellings, three messages and
  two report shapes. It was gathered into `assertReadComplete`.
- **Awaiting a command that only queues does not report its failure.** The subscription commands
  returned once the shell had queued the request, so awaiting them could not catch the broker
  refusing the registration. They report it now through a reply of their own.
- **A failed read is not reported as a failed write.** `formatWriteReport` printed a count of
  write failures when nothing had been written; `formatReadbackReport` already described reads
  correctly.

## Two limits of the device link are recorded, not fixed

**Decision (2026-11-12, the operator).** The robustness audit left open how `src-tauri/src/vd.rs`
handles a late reply and how it latches a device loss. The operator decided that `drain_late_reply`
would be fixed first if the reply to a request named that request, and that otherwise these two
would be recorded here as known limitations. A reply to a request as the app sends it, without an
id, carries the verb (`method`) and the `uri` of that request, and its `data`; nothing in it names
the request, neither a number nor an id. Whether the broker would return an id that a request
carried has not been tried. The two stay as they are.

- **A late reply can be dropped, but not identified.** A command that runs out its deadline
  (`do_set`, `do_get_value`) can still have its reply on the way. When two requests with the same
  verb go to the same address, nothing in their replies says which request each one answers, so a
  late reply can be taken as the answer to the next such request. `drain_late_reply` makes that less
  likely: after the deadline it reads until it has looked at `DRAIN_FRAMES` frames, or until
  `DRAIN_QUIET` has passed and a read finds nothing, and drops the first reply that matches the verb
  and the address of the command that gave up. A reply that arrives after the drain has given up
  still answers the next command with that verb on that address. With requests sent as they are
  now, nothing in a reply ties it to its request, so matching replies cannot close that gap.
- **A device loss is latched through the text of an error.** The broker's only sign of a lost unit
  is a `/vd/synchronize` frame whose `sync_status` is no longer `online`. `synchronize_lost` turns
  that frame into an error whose code is `device-lost`, and on the command paths `Health::guard`
  latches the session on an error that begins with `DEVICE_LOST_PREFIX`. The latch rests on a string
  the app writes and then reads back: a reader that met that frame and reported it under another
  code would leave the session unlatched.

**Reopen when.** For the late reply: the broker is found to return, in its reply, an id that the
request carried. For the device loss: the broker publishes a message of its own when a unit is lost,
or the app carries a device loss as a typed error instead of a string — both the text and the check
are the app's own (`synchronize_lost` writes it, `Health::guard` reads it), so this needs no change
on the broker's side.

## Where the audit-derived tests live

Besides the `*.audit.test.ts` unit pins, the audits left E2E cases in three specs:

| Spec | What it covers |
| --- | --- |
| `e2e/chrome.spec.ts` | theme, language, persistence, and hit-testing after a zoom |
| `e2e/viewstate.spec.ts` | an edit made in GRAPH or CONSOLE showing in the other view |
| `e2e/audit.spec.ts` | the selection reset on a model switch, the EQ staying in step between GRAPH and CONSOLE, the send level's grid boundaries, and re-localization on a language switch |

## What a robustness audit re-reads

A robustness audit of the core checks these again each time, whatever else it looks at:

- node ids are unique in each of the three models, and the rules are symmetric in direction;
- each model's count of fixed wires, and the default plan validating with no finding;
- the skill export is deterministic;
- direct-follow is the inverse of `translate`;
- 14-bit CC, the learn state machine, and the contract of the device lock;
- `sanitizeMappings` still reads older saved mappings;
- the English and Japanese catalogs carry the same keys;
- the power LED, the SENDS rack, and the handling of an invalid `?plan=`.
