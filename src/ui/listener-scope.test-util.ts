// Take back what the code under test registered on `window`, so one test's
// teardown cannot fire inside the next one's. Not a test file itself (vitest
// collects only *.test.ts).
//
// jsdom's `window` outlives every test in a file, so a class that registers a
// window-LIFETIME listener — the MIDI window's `pagehide`, a tuning screen's
// pointer release — leaves one behind per construction. That is harmless while a
// test observes its own fixture's DOM, and not harmless at all when the
// observation channel is global: a module-level transport mock is written by every
// stale listener as well as the live one, and an assertion phrased as "the last
// thing sent" then holds whether or not the object under test registered anything.
// Measured on this file's own suite before the fix: one `pagehide` produced ELEVEN
// `closed` intents, ten of them from windows earlier tests had built.
//
// Recording rather than a blanket `removeEventListener` sweep: jsdom exposes no
// listener registry, and the callbacks are closures the test never sees.

interface Recorded {
  type: string;
  fn: EventListenerOrEventListenerObject;
  opts?: boolean | AddEventListenerOptions;
}

/**
 * Start recording `window` registrations. Nest LIFO — `stop()` restores only if
 * the patch it installed is still the active one, so an inner scope that outlives
 * its parent leaves the parent's in place rather than tearing it out.
 */
export function recordWindowListeners(): { stop: () => void; release: () => void } {
  const seen: Recorded[] = [];
  const real = window.addEventListener;
  // Forwarded as the tuple the real signature takes, so the pass-through cannot
  // drift from it — a hand-written parameter list has to restate the nullable
  // callback and the boolean-or-options third argument, and gets one of them wrong.
  const patched = function (this: Window, ...args: Parameters<typeof window.addEventListener>): void {
    const [type, fn, opts] = args;
    if (fn) seen.push({ type, fn, opts });
    real.apply(this, args);
  } as typeof window.addEventListener;
  window.addEventListener = patched;

  return {
    stop: () => {
      if (window.addEventListener === patched) window.addEventListener = real;
    },
    release: () => {
      for (const { type, fn, opts } of seen.splice(0)) window.removeEventListener(type, fn, opts);
    },
  };
}
