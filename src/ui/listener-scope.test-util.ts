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
  capture: boolean;
}

/**
 * Start recording registrations on an event target.
 *
 * `window.addEventListener` is already an OWN accessor property of jsdom's window
 * — the recorder does not make it one — so assigning runs its setter and the
 * accessor survives. Restoring by assignment is therefore exact, and deleting the
 * property would be wrong: it would take jsdom's own accessor away and leave the
 * window inheriting from the prototype, which is not the state anything started
 * in. `listener-scope.test.ts` pins both facts.
 *
 * Nest LIFO. `stop()` restores only when the patch it installed is still the
 * active one, so an inner scope that outlives its parent does not tear the
 * parent's out — and a scope that has stopped is inert either way, so a patch left
 * installed by an out-of-order stop forwards without recording rather than
 * collecting registrations for a scope that is finished with.
 */
export function recordListeners(target: EventTarget): { stop: () => void; release: () => void } {
  const seen: Recorded[] = [];
  const real = target.addEventListener;
  const own = Object.hasOwn(target, "addEventListener");
  let recording = true;
  // Forwarded as the tuple the real signature takes, so the pass-through cannot
  // drift from it — a hand-written parameter list has to restate the nullable
  // callback and the boolean-or-options third argument, and gets one of them wrong.
  const patched = function (this: EventTarget, ...args: Parameters<typeof target.addEventListener>): void {
    const [type, fn, opts] = args;
    const capture = typeof opts === "boolean" ? opts : (opts?.capture ?? false);
    real.apply(this, args);
    if (recording && fn) seen.push({ type, fn, capture });
  };
  target.addEventListener = patched;

  return {
    stop: () => {
      recording = false;
      if (target.addEventListener === patched) {
        if (own) target.addEventListener = real;
        else delete (target as Partial<EventTarget>).addEventListener;
      }
    },
    release: () => {
      for (const { type, fn, capture } of seen.splice(0)) target.removeEventListener(type, fn, capture);
    },
  };
}

/** Start recording registrations on the window. */
export function recordWindowListeners(): ReturnType<typeof recordListeners> {
  return recordListeners(window);
}
