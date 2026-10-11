// One CPython process that answers plan_tool.py's command line for the pin, in place of one
// process per document.
//
// `run(argv)` returns what `spawnSync(python, [plan_tool.py, ...argv], { encoding: "utf8" })`
// returns for the fields the pin reads — `status`, `stdout`, `stderr` — and returns it
// synchronously, so a call site swaps one for the other and nothing around it changes. Each
// call goes to `plan_tool.main(argv)` inside the long-lived interpreter with both streams
// captured, `sys.argv[0]` set to the tool's own path so argparse names the program the way the
// command line does, and a `SystemExit` or an uncaught exception turned into the status and
// stderr the interpreter would have exited with. Output is LF-terminated on every platform.
//
// What it does NOT answer is anything about the process itself: the stream reconfiguration
// `main` applies to a real stdout, the locale's encoding, an exit code produced by the
// interpreter rather than by `main`. Those pins keep spawning the tool.
//
// The interpreter's pipes are asynchronous, so a worker thread owns the process and the caller
// blocks on an `Atomics.wait` until the worker has posted the answer. A call that waits past
// `timeoutMs`, or an interpreter that exits, THROWS rather than returning a status — an answer
// nobody produced must not read as the tool's — and a call that times out kills the interpreter.
// `close()` ends a healthy interpreter by closing its input, kills one still running
// `closeGraceMs` after that, and settles within `CLOSE_BOUND_MS` either way: past it the worker
// is terminated, the interpreter killed, and `close()` rejects.

import { MessageChannel, receiveMessageOnPort, Worker } from "node:worker_threads";

const TIMEOUT_MS = 30_000;
const CLOSE_GRACE_MS = 2_000;
const CLOSE_BOUND_MS = 5_000;

const DRIVER = `
import contextlib, io, json, os, sys, traceback
tool_dir = sys.argv[1]
sys.path.insert(0, tool_dir)
import plan_tool
for raw in sys.stdin.buffer:
    argv = json.loads(raw)["argv"]
    sys.argv = [os.path.join(tool_dir, "plan_tool.py")] + argv
    out, err = io.StringIO(), io.StringIO()
    with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
        try:
            status = plan_tool.main(argv)
        except SystemExit as e:
            if e.code is None:
                status = 0
            elif isinstance(e.code, int):
                status = e.code
            else:
                print(e.code, file=sys.stderr)
                status = 1
        except BaseException:
            traceback.print_exc()
            status = 1
    sys.stdout.write(json.dumps({"status": status, "stdout": out.getvalue(), "stderr": err.getvalue()}) + "\\n")
    sys.stdout.flush()
`;

const WORKER = `
const { parentPort, workerData } = require("node:worker_threads");
const { spawn } = require("node:child_process");
const child = spawn(workerData.python, ["-c", workerData.driver, workerData.toolDir], {
  stdio: ["pipe", "pipe", "pipe"],
});
parentPort.postMessage({ pid: child.pid });
const waiting = [];
let pending = "";
let stderr = "";
let exited = null;
const answer = (w, msg) => {
  w.port.postMessage(msg);
  w.port.close();
  Atomics.store(w.flag, 0, 1);
  Atomics.notify(w.flag, 0);
};
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  pending += chunk;
  for (let i; (i = pending.indexOf("\\n")) >= 0; ) {
    const line = pending.slice(0, i);
    pending = pending.slice(i + 1);
    answer(waiting.shift(), { answer: JSON.parse(line) });
  }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => (stderr += chunk));
child.on("exit", (code, signal) => {
  exited = { code, signal, stderr };
  for (const w of waiting.splice(0)) answer(w, { exited });
});
child.on("error", (err) => {
  exited = { code: null, signal: null, stderr: String(err) };
  for (const w of waiting.splice(0)) answer(w, { exited });
});
parentPort.on("message", (msg) => {
  if (msg.abort) {
    if (!exited) child.kill();
    return;
  }
  if (msg.close) {
    if (exited) process.exit(0);
    child.on("exit", () => process.exit(0));
    child.stdin.end();
    setTimeout(() => child.kill(), msg.graceMs);
    return;
  }
  const w = { port: msg.port, flag: new Int32Array(msg.flag) };
  if (exited) return answer(w, { exited });
  waiting.push(w);
  child.stdin.write(JSON.stringify({ argv: msg.argv }) + "\\n");
});
`;

/** A session of plan_tool.py inside one `python` process. `toolDir` holds plan_tool.py. */
export function planToolSession(python, toolDir, { timeoutMs = TIMEOUT_MS, closeGraceMs = CLOSE_GRACE_MS } = {}) {
  let worker = null;
  /** The interpreter's pid, as the worker reports it once the process starts. */
  let pid = null;
  /** Set once a call threw: the answer it gave up on may still arrive and would be handed to the next call. */
  let broken = null;
  const run = (argv) => {
    if (broken) throw new Error(`the plan_tool.py session stopped answering earlier: ${broken}`);
    try {
      return ask(argv);
    } catch (err) {
      broken = err.message;
      worker?.postMessage({ abort: true });
      throw err;
    }
  };
  const ask = (argv) => {
    if (!worker) {
      worker = new Worker(WORKER, {
        eval: true,
        workerData: { python, driver: DRIVER, toolDir },
      });
      worker.on("message", (msg) => (pid = msg.pid ?? pid));
      worker.unref();
    }
    const flag = new SharedArrayBuffer(4);
    const { port1, port2 } = new MessageChannel();
    worker.postMessage({ argv, port: port2, flag }, [port2]);
    const waited = Atomics.wait(new Int32Array(flag), 0, 0, timeoutMs);
    const msg = receiveMessageOnPort(port1)?.message;
    port1.close();
    if (waited === "timed-out") throw new Error(`plan_tool.py gave no answer to ${argv.join(" ")} in ${timeoutMs} ms`);
    if (!msg) throw new Error(`plan_tool.py's worker woke with no answer to ${argv.join(" ")}`);
    if (msg.exited)
      throw new Error(
        `the plan_tool.py process exited (code ${msg.exited.code}, signal ${msg.exited.signal}): ${msg.exited.stderr}`,
      );
    return msg.answer;
  };
  /** Ends the interpreter and the worker; a session never started has nothing to end. */
  const close = async () => {
    if (!worker) return;
    const w = worker;
    worker = null;
    let timer;
    const done = new Promise((resolve) => w.once("exit", () => resolve(true)));
    const late = new Promise((resolve) => (timer = setTimeout(() => resolve(false), CLOSE_BOUND_MS)));
    w.postMessage({ close: true, graceMs: closeGraceMs });
    const ended = await Promise.race([done, late]);
    clearTimeout(timer);
    if (!ended) {
      await w.terminate();
      try {
        if (pid !== null) process.kill(pid);
      } catch (err) {
        if (err.code !== "ESRCH") throw err;
      }
      throw new Error(
        `the plan_tool.py session did not end within ${CLOSE_BOUND_MS} ms; its worker was terminated and its interpreter killed`,
      );
    }
  };
  return { run, close };
}
