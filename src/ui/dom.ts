// Tiny DOM builder shared by the UI modules.
export function el(tag: string, cls: string): HTMLElement {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// Wire scroll-wheel stepping onto a control: a vertical notch steps by one detent
// (`dir` = +1 up / −1 down). A pure-horizontal scroll (deltaY 0) is left alone, and
// `preventDefault` (needs the non-passive listener) stops the page/panel scrolling
// while the pointer is over the control. `blocked` short-circuits before any work
// (e.g. while assigning MIDI). Shared by the console faders/knobs and the inspector
// sliders so the passive/preventDefault contract lives in one place.
export function onWheelStep(el: HTMLElement, step: (dir: 1 | -1) => void, blocked?: () => boolean | undefined): void {
  el.addEventListener(
    "wheel",
    (e) => {
      if (e.deltaY === 0 || blocked?.()) return;
      e.preventDefault();
      step(e.deltaY < 0 ? 1 : -1);
    },
    { passive: false },
  );
}
