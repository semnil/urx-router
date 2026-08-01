// Keyboard-driven measurement harness. Dev builds only.
//
// Some behavior can only be established in the real desktop webview: whether a chord
// reaches the page at all, whether WebKit's own text-field undo fires, what a native
// menu click actually does. Driving that from outside means synthesizing pointer
// coordinates into a window other windows overlap, which is unreliable and can land a
// click in someone else's editor. These bindings take the pointer out of the loop —
// every step is a function key, and every result is printed to the status bar, which a
// screenshot reads without devtools.
//
// | Key | Effect |
// | --- | --- |
// | F2  | Toggle the IME record; switching it off reports the reading |
// | F3  | Toggle an inspector repaint pulse, at the app's own reflect floor, through its gated path |
// | F4  | Toggle the same repaint with the composition gate bypassed (pre-gate behaviour) |
// | F6  | Blur the focused element, to set up "focus is not in a text field" |
// | F7  | Toggle the chord log: reports each modified keydown, its target, and whether an earlier handler had already called preventDefault |
// | F8  | Make (once) and focus a probe text input, so a native undo stack can be filled by typing |
// | F9  | `document.execCommand("undo")` — reports the return value and the field afterwards |
// | F10 | `document.execCommand("redo")` |
//
// The chord log registers after the app's own keydown handler, which is what lets it
// report `defaultPrevented` — i.e. whether the app claimed the chord or left it to the
// field. Install order in main.ts is therefore load-bearing.
//
// The IME arm answers a question of the same kind as the undo bindings: whether
// `replaceChildren` ends a live composition in WKWebView, which no synthetic event can
// establish — a CompositionEvent built with `dispatchEvent` is not a composition as far
// as the engine is concerned, so the input has to come from the OS input method and the
// measurement has to run here. F3 / F4 stand in for the stimulus: a device-follow reflect
// repaints this panel at up to 20 Hz while a knob is being swept, and both keys fire that
// same repaint on a timer so no key has to be pressed mid-composition.
//
// Its keys are F2 / F3 / F4 and NOT the free slots beside the existing ones, because
// **F6-F10 are Kotoeri's conversion keys during a composition** (ひらがな / カタカナ /
// 半角カナ / 全角英数 / 半角英数). Measured, and worse than "the page never sees them":
// the key does BOTH — Kotoeri acts on it and the page gets the keydown as well, so F6
// mid-composition ran this harness's blur and committed the composition. The harness was
// destroying what it was measuring. F6-F10 therefore stand down while the record is on;
// F2-F4 are not conversion keys and stay live, or a run could not be stopped.
//
// Statically dropped from a production build (`import.meta.env.DEV`); ci.yml greps the
// bundle for `__urxKeyProbe` to keep it dropped.

/** One entry of the IME record: an event the input method produced, or a repaint the
 *  harness asked for. `value` is what the composing field held at that instant, which is
 *  what a shredded composition shows up in. */
export interface ImeEntry {
  t: number;
  kind: "compositionstart" | "compositionupdate" | "compositionend" | "input" | "focusout" | "repaint" | "replaced";
  value: string;
  detail?: string;
}

/** What the harness can be driven by, from the console or a script, in a dev build. */
export interface KeyProbe {
  /** Blur whatever holds focus. */
  blur(): void;
  /** The probe text input, created on first use and focused. */
  field(): HTMLInputElement;
  /** Run an editing command and report; returns what the platform returned. */
  exec(command: "undo" | "redo"): boolean;
  /** Turn the chord log on or off. */
  setLog(on: boolean): void;
  /** Start / stop the IME record. Stopping reports the reading; starting clears it. */
  setImeRecord(on: boolean): void;
  /** Start / stop the repaint pulse. `gated` runs the app's own path (the composition
   *  gate in front of it), `forced` the rebuild with no gate — the two arms. */
  setPulse(mode: "off" | "gated" | "forced"): void;
  /** Everything the record holds, for a Web Inspector session that wants the timeline
   *  rather than the summary. */
  imeLog(): ImeEntry[];
}

export interface KeyProbeHooks {
  /** Where a reading goes. The status bar, so a screenshot can read it. */
  onReport: (message: string) => void;
  /** The panel repaint as the app runs it — the composition gate decides. */
  refreshInspector: () => void;
  /** The same repaint with no gate in front of it: what the panel did before the gate
   *  existed, and so the "before" arm of the measurement. */
  rebuildInspector: () => void;
  /** The element the composition events reach and the repaint replaces. */
  inspectorHost: HTMLElement;
  /** How often the pulse repaints, ms. Passed in rather than restated here: it is the
   *  app's own reflect floor, and the harness is only valid while it reproduces the
   *  repaint rate a swept knob actually produces. */
  pulseMs: number;
}

/** The text an element holds, or null for one that holds none. */
function textValue(el: Element | null): string | null {
  return el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : null;
}

function describe(el: Element | null): string {
  if (!(el instanceof HTMLElement)) return "none";
  const type = el.tagName === "INPUT" ? `/${(el as HTMLInputElement).type}` : "";
  const held = textValue(el);
  return `${el.tagName}${type}${el.id ? `#${el.id}` : ""}${held === null ? "" : ` val=${JSON.stringify(held)}`}`;
}

export function installKeyProbe(hooks: KeyProbeHooks): KeyProbe {
  let field: HTMLInputElement | null = null;
  let logging = false;

  // The record survives being stopped: the summary is the reading, but the timeline is
  // what a Web Inspector session reads when the summary is surprising.
  let ime: ImeEntry[] = [];
  let recording = false;
  let imeT0 = 0;
  let pulse: ReturnType<typeof setInterval> | null = null;
  // Held here rather than beside the key handler, so a caller that drives the harness
  // through the window handle and one that presses the key cannot disagree about what
  // the next press toggles.
  let pulseMode: "off" | "gated" | "forced" = "off";

  const note = (kind: ImeEntry["kind"], detail?: string): void => {
    if (!recording) return;
    // Read off the focused element rather than a captured handle: the forced arm replaces
    // it, and the whole question is what the replacement did to the text.
    const value = textValue(document.activeElement) ?? "";
    ime.push({ t: +(performance.now() - imeT0).toFixed(1), kind, value, detail });
  };

  const host = hooks.inspectorHost;
  // focusout is recorded because it is the composition gate's BACKSTOP, and the first
  // reading made that load-bearing: 24 compositionstarts reached the host and NOT ONE
  // compositionend did. Whether WebKit fires none when the composing element is removed,
  // or fires it at a node already detached, is the same thing to a listener on the host —
  // the gate's release cannot come from there. Whether anything closes it in that case is
  // then a question only this record can answer.
  for (const kind of ["compositionstart", "compositionupdate", "compositionend", "input", "focusout"] as const) {
    host.addEventListener(kind, () => note(kind), true);
  }
  // A repaint is `replaceChildren`, i.e. one childList record that empties the host.
  // Observed rather than counted at the call site so a repaint the APP made — a real
  // device-follow reflect during a knob sweep — is recorded the same way the pulse's is,
  // which is what lets one record cover both the synthetic and the hardware arm.
  //
  // Connected only while recording: `renderInspector` appends ~46 times per rebuild, and an
  // observed node queues a MutationRecord per append where an unobserved one queues none.
  // Left attached, every panel repaint in a dev session would allocate several dozen records
  // for a callback that is going to drop them.
  const observer = new MutationObserver((records) => {
    if (records.some((r) => r.removedNodes.length)) note("replaced");
  });

  const probe: KeyProbe = {
    blur() {
      (document.activeElement as HTMLElement | null)?.blur();
      hooks.onReport(`probe blur: active=${describe(document.activeElement)}`);
    },
    field() {
      if (!field) {
        field = document.createElement("input");
        field.type = "text";
        field.id = "keyprobe-field";
        // Above everything, and clear of the status bar it reports to.
        field.style.cssText = "position:fixed;left:8px;bottom:28px;z-index:99999;width:260px";
        document.body.append(field);
      }
      field.focus();
      hooks.onReport(`probe field: active=${describe(document.activeElement)}`);
      return field;
    },
    exec(command) {
      const ok = document.execCommand(command);
      hooks.onReport(`probe ${command}: returned=${ok} active=${describe(document.activeElement)}`);
      return ok;
    },
    setLog(on) {
      logging = on;
      hooks.onReport(`probe chord log: ${on ? "on" : "off"}`);
    },
    setImeRecord(on) {
      recording = on;
      if (on) {
        ime = [];
        imeT0 = performance.now();
        observer.observe(host, { childList: true });
        hooks.onReport("probe ime: recording");
        return;
      }
      observer.disconnect();
      const log = ime;
      const count = (k: ImeEntry["kind"]): number => log.filter((e) => e.kind === k).length;
      // The reading, in one line. `asked` is what the pulse fired and `landed` what actually
      // replaced the panel, counted from opposite sides on purpose: a held repaint is one
      // that was asked for and never landed. A composition that survived them ends ONCE —
      // when the operator committed it. One compositionend per replacement would be the
      // defect; zero of them, as the first desktop reading showed, is the gate's backstop
      // never firing either.
      hooks.onReport(
        `probe ime: repaints asked=${count("repaint")} landed=${count("replaced")} ` +
          `start=${count("compositionstart")} end=${count("compositionend")} ` +
          `focusout=${count("focusout")} input=${count("input")} ` +
          `value=${JSON.stringify(log.at(-1)?.value ?? "")}`,
      );
    },
    setPulse(mode) {
      if (pulse !== null) {
        clearInterval(pulse);
        pulse = null;
      }
      pulseMode = mode;
      if (mode !== "off") {
        const run = mode === "gated" ? hooks.refreshInspector : hooks.rebuildInspector;
        pulse = setInterval(() => {
          note("repaint", mode);
          run();
        }, hooks.pulseMs);
      }
      hooks.onReport(`probe pulse: ${mode}`);
    },
    imeLog: () => ime.slice(),
  };

  window.addEventListener("keydown", (e) => {
    switch (e.key) {
      case "F2":
        probe.setImeRecord(!recording);
        return;
      case "F3":
        probe.setPulse(pulseMode === "gated" ? "off" : "gated");
        return;
      case "F4":
        probe.setPulse(pulseMode === "forced" ? "off" : "forced");
        return;
    }
    // F6-F10 belong to the input method while an IME measurement is running: F6 is both
    // this harness's blur and Kotoeri's ひらがな conversion, and pressing it mid-composition
    // blurred the field and committed the composition — the harness destroying the very
    // thing it was measuring. Kotoeri passes the key to the page as well as acting on it,
    // so the page side has to stand down. F2-F4 are not conversion keys and stay live, or
    // there would be no way to stop the run.
    if (recording) return;
    switch (e.key) {
      case "F6":
        probe.blur();
        return;
      case "F7":
        probe.setLog(!logging);
        return;
      case "F8":
        probe.field();
        return;
      case "F9":
        probe.exec("undo");
        return;
      case "F10":
        probe.exec("redo");
        return;
    }
    if (!logging) return;
    if (!e.metaKey && !e.ctrlKey && !e.altKey) return;
    const mods = [e.metaKey && "meta", e.ctrlKey && "ctrl", e.altKey && "alt", e.shiftKey && "shift"]
      .filter(Boolean)
      .join("+");
    // Reported after the app's own handler, so defaultPrevented says whether the app
    // claimed the chord or left it to the focused field.
    hooks.onReport(
      `probe chord: ${mods}+${e.key} prevented=${e.defaultPrevented} target=${describe(e.target as Element)}`,
    );
  });

  (window as unknown as { __urxKeyProbe?: KeyProbe }).__urxKeyProbe = probe;
  return probe;
}
