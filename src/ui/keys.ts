// Who owns a keystroke. Two questions the app asks from unrelated places — the undo
// shortcut, the Shift tracker behind fine-tuning mode — and both got their own answer
// before this file existed. A tracker will never think to import the undo module, so
// the answers live where anything can reach them.

/** Input types that hold text and therefore have a native undo stack of their own.
 *  An allowlist rather than a denylist, so a field added later falls to the browser
 *  instead of being silently claimed. `select` and `input[type=range]` are deliberately
 *  absent: neither has an undo stack, and focus rests on a range right after a slider
 *  drag and on the model / rate picker right after a change, where bailing out would
 *  make Ctrl+Z quietly do nothing. */
const NATIVE_UNDO_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);

/** Whether the target owns its own undo, so an undo command belongs to it — the
 *  keyboard leaves the chord alone and the menu hands it `document.execCommand`.
 *  Measured on macOS: the page receives Cmd+Z even with a native Edit menu installed,
 *  and calling preventDefault is what suppresses WebKit's own field undo, so returning
 *  true here is what keeps a text field's undo working. */
export function ownsNativeUndo(target: unknown): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.tagName === "TEXTAREA") return true;
  // isContentEditable is the browser's own answer (inherited state included); the
  // attribute walk beside it is what makes this testable under jsdom, which does not
  // implement the property.
  if (target.isContentEditable || target.closest("[contenteditable]:not([contenteditable='false'])")) return true;
  return target.tagName === "INPUT" && NATIVE_UNDO_TYPES.has((target as HTMLInputElement).type);
}

/** Whether the event carries a command modifier, i.e. it is part of a shortcut rather
 *  than a bare key. Asked by anything that acts on a bare modifier and must not fire
 *  inside a chord: Shift alone latches fine-tuning mode, but the Shift in
 *  Cmd/Ctrl+Shift+Z is not that press. Enumerating today's chords at each such site is
 *  what makes the next chord a bug in a file its author never opened. */
export function isChord(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey || e.altKey;
}
