// The trace file a dev-build instrument writes beside its in-page ring: one JSON object
// per line, batched behind a short timer and handed to a shell append command.
//
// Shared by `midi-probe.ts` and `param-watch.ts`. Each creates its sink at module scope
// behind `/* @__PURE__ */`, so a production bundle — where nothing reaches the sink —
// drops it with the instrument.

/** Where the file stands, for an instrument's `report()`. */
export type TraceSinkStatus =
  /** Not opened: nothing is queued or written. */
  | { state: "closed" }
  /** Opened, and no batch has landed yet. */
  | { state: "waiting" }
  /** The path the shell answered with for the last batch that landed. */
  | { state: "writing"; path: string }
  /** A batch was refused, and nothing more is written. `t` is `performance.now()` at the
   *  refusal. */
  | { state: "stopped"; t: number; reason: string };

export interface TraceSink {
  /** Begin accepting records and flush on `pagehide`. Idempotent. */
  open(): void;
  /** Queue one record. Dropped while the sink is closed or stopped. */
  push(record: object): void;
  /** Hand the queued records to the shell now instead of waiting out the batch window. */
  flush(): void;
  status(): TraceSinkStatus;
}

/**
 * A sink writing through `append`, which resolves with the file's path.
 *
 * Each record is serialised with `JSON.stringify`, which escapes a control character
 * inside a string field: the shell refuses the WHOLE batch over one (`log_line_ok`), so
 * an unescaped one would cost every record queued beside it.
 *
 * A refused batch gives the sink up rather than retrying it: the queue is the only thing
 * holding those lines, and re-queueing a failing write grows it for as long as the app
 * runs. The queue is cleared and the refusal kept for `status()`, so a file that stopped
 * mid-run is distinguishable from one that simply ends.
 *
 * The `pagehide` flush is best-effort: a dying page's IPC is not guaranteed to leave
 * before the webview is torn down, so what bounds a reload's lost tail is `windowMs`.
 */
export function createTraceSink(append: (lines: string[]) => Promise<string>, windowMs: number): TraceSink {
  const pending: string[] = [];
  let timer = 0;
  let opened = false;
  let path: string | null = null;
  let stopped: { t: number; reason: string } | null = null;

  function flush(): void {
    window.clearTimeout(timer);
    timer = 0;
    if (!pending.length || stopped) return;
    const batch = pending.splice(0, pending.length);
    void append(batch).then(
      (p) => {
        path = p;
      },
      (err: unknown) => {
        pending.length = 0;
        stopped = { t: performance.now(), reason: err instanceof Error ? err.message : String(err) };
      },
    );
  }

  return {
    open() {
      if (opened) return;
      opened = true;
      window.addEventListener("pagehide", flush);
    },
    push(record) {
      if (!opened || stopped) return;
      pending.push(JSON.stringify(record));
      if (!timer) timer = window.setTimeout(flush, windowMs);
    },
    flush,
    status() {
      if (stopped) return { state: "stopped", ...stopped };
      if (path) return { state: "writing", path };
      return opened ? { state: "waiting" } : { state: "closed" };
    },
  };
}
