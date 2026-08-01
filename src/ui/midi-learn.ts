// MIDI-learn integration shared by every surface a control can be armed from: the
// CONSOLE strips and the channel tuning screens. While learn mode is on, activating
// a control arms it for binding instead of editing it. The MIDI window owns the mode
// and the armed id; a surface only marks its controls and reports the activation.
//
// The tooltip is deliberately NOT gated on learn mode. The MIDI window is a window,
// so it can sit behind the app or on another display, and the LED dot alone says
// only "assigned", never to what — the address has to be readable from the control
// itself, and a title costs no layout.

export interface MidiLearnHooks {
  learnActive: () => boolean;
  armedId: () => string | null;
  isMapped: (id: string) => boolean;
  /** The compact address a mapped control is bound to ("CH 1 CC 21"), or null. */
  addrOf: (id: string) => string | null;
  arm: (id: string) => void;
}

/** Learn-mode affordances on an armable element: target ring, armed pulse and
 *  already-mapped dot while learn is on, plus the bound address as a tooltip at all
 *  times. An element that already carries a title keeps it — the address goes on a
 *  line of its own rather than replacing an explanation. */
export function markMidi(el: HTMLElement, id: string | undefined, midi: MidiLearnHooks | undefined): void {
  if (!id || !midi) return;
  const addr = midi.addrOf(id);
  if (addr) el.title = el.title ? `${el.title}\n${addr}` : addr;
  if (!midi.learnActive()) return;
  el.classList.add("midi-target");
  if (midi.armedId() === id) el.classList.add("midi-armed");
  if (midi.isMapped(id)) el.classList.add("midi-mapped");
}

/** The keys a control would edit with, which learn mode has to take over — a range
 *  input steps on its own, so leaving them through would move the value of the very
 *  control being armed. Tab and the rest stay with the browser so the surface is
 *  still navigable while assigning. */
const EDIT_KEYS = new Set(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "PageUp", "PageDown", "Home", "End"]);

/**
 * Arm `id` when this element is activated while learn mode is on, instead of letting
 * it edit. Registered in the capture phase on all three paths, because the edit is
 * driven from the element itself (a range input's own drag) or from a child (a
 * segmented button's click) and a press that arms must not also change the value.
 */
export function armOnActivate(el: HTMLElement, id: string, midi: MidiLearnHooks | undefined): void {
  if (!midi) return;
  el.addEventListener(
    "pointerdown",
    (e) => {
      if (!midi.learnActive()) return;
      e.preventDefault();
      e.stopPropagation();
      midi.arm(id);
    },
    true,
  );
  // The click follows the pointerdown on a button even after preventDefault, so it
  // is swallowed separately rather than left to toggle what was just armed.
  el.addEventListener(
    "click",
    (e) => {
      if (!midi.learnActive()) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
  el.addEventListener(
    "keydown",
    (e) => {
      if (!midi.learnActive()) return;
      const arms = e.key === " " || e.key === "Enter";
      if (!arms && !EDIT_KEYS.has(e.key)) return;
      e.preventDefault();
      e.stopPropagation();
      if (arms) midi.arm(id);
    },
    true,
  );
}
