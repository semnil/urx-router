// The two re-entry guards the app's click handlers run behind, and the difference
// between them — which is the whole point of keeping both.
//
// `singleFlight` is a rapid-repeat guard on ONE handler: a second click while its
// action is in flight is ignored silently, because that click is a slip rather than
// a request. `FileFlowLatch` is shared across every plan/settings entry point, and
// it distinguishes two refusals: another file flow is silent for the same reason,
// but a device read in flight is REPORTED — the flow the operator picked simply
// does not happen, and the status line is showing the read's progress rather than an
// answer to that click.
//
// Split out of main.ts because both are latches over async work, and neither can be
// observed from outside the handler that owns it.

/**
 * Wrap a click handler so re-entry while its action is in flight is ignored. The
 * device actions (fetch / write / compare / self-test) stay outside this — their
 * second click deliberately means cancel.
 *
 * `onError` is required rather than optional because the promise is fired without
 * being awaited: with nothing catching it, an action that rejects reaches no
 * surface at all and lands in the console as an unhandled rejection. Naming the
 * sink is what keeps that from being a decision nobody made. Most callers also
 * catch inside their own action to say something specific; this is the backstop
 * under them, and it is what makes "let it throw and be reported" true.
 *
 * The latch is cleared BEFORE the report, so a reporter that blocks cannot hold the
 * button shut, and the catch is last so nothing escapes past it.
 */
export function singleFlight(run: () => Promise<void>, onError: (err: unknown) => void): () => void {
  let busy = false;
  return () => {
    if (busy) return;
    busy = true;
    void run()
      .finally(() => {
        busy = false;
      })
      .catch(onError);
  };
}

export interface FileFlowHooks {
  /** A device read holds the plan: say so, since the operator's click went
   *  unanswered rather than being a repeat. */
  onDeviceReadBusy: () => void;
  /** The latch was let go. The MIDI gate's reported window ends here. */
  onReleased: () => void;
}

/**
 * One plan/settings file flow at a time across every entry point (File > New /
 * Open / Save, a recent row, a window drop, the `.urxf` import). `run` resolves
 * null when the latch refused it.
 *
 * `deviceReadInFlight` is a plain mutable field rather than a setter: a device read
 * passes the module plan by reference into a readback that mutates it across many
 * awaited round trips, and every wholesale plan replacement reads this flag, so the
 * read sites stay one identifier.
 */
export class FileFlowLatch {
  private running = false;
  /** A device read (fetch / Live-sync start) is holding the plan by reference. */
  deviceReadInFlight = false;

  constructor(private readonly hooks: FileFlowHooks) {}

  /** True while either latch would refuse a flow — what the undo history and the
   *  MIDI gate consult. */
  get busy(): boolean {
    return this.running || this.deviceReadInFlight;
  }

  async run<T>(action: () => Promise<T>): Promise<T | null> {
    if (this.deviceReadInFlight) {
      this.hooks.onDeviceReadBusy();
      return null;
    }
    // A second file flow stays silent — its own native dialog is already on screen,
    // and the second click is a rapid-repeat guard rather than an unanswered request.
    if (this.running) return null;
    this.running = true;
    try {
      return await action();
    } finally {
      this.running = false;
      this.hooks.onReleased();
    }
  }
}
