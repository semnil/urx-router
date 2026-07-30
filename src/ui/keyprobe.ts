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
// Statically dropped from a production build (`import.meta.env.DEV`); ci.yml greps the
// bundle for `__urxKeyProbe` to keep it dropped.

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
}

export interface KeyProbeHooks {
  /** Where a reading goes. The status bar, so a screenshot can read it. */
  onReport: (message: string) => void;
}

function describe(el: Element | null): string {
  if (!(el instanceof HTMLElement)) return "none";
  const type = el.tagName === "INPUT" ? `/${(el as HTMLInputElement).type}` : "";
  const held = el.tagName === "INPUT" || el.tagName === "TEXTAREA" ? (el as HTMLInputElement).value : null;
  return `${el.tagName}${type}${el.id ? `#${el.id}` : ""}${held === null ? "" : ` val=${JSON.stringify(held)}`}`;
}

export function installKeyProbe(hooks: KeyProbeHooks): KeyProbe {
  let field: HTMLInputElement | null = null;
  let logging = false;

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
  };

  window.addEventListener("keydown", (e) => {
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
