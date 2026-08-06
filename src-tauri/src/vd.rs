// Live hardware control transport: a client for the Device Center broker's
// "vd" protocol over WebSocket (ws://127.0.0.1:51780/casket, JSON-RPC 1.0).
// Device Center must be running with a URX connected; it bridges the broker to
// the unit's CDC serial. See reference/work/vd/vd-protocol.md.
//
// A dedicated worker thread owns the socket so the broker's continuous meter
// notifications are drained without blocking command latency, and so the device
// GUID (dev_uid) stays inside Rust — the frontend addresses parameters by
// (param_id, x, y) and never sees the instance secret. Desktop-only: the broker
// transport (tungstenite) and the MIDI bridge (midir) are desktop-only crates,
// so mobile targets do not build the hardware control surface at all.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use tauri::ipc::Channel;

// Every error this module returns is a stable kebab-case code, optionally followed
// by ": " and a technical detail (an address, a URI, an OS message). The frontend
// localizes the code and shows the detail as-is (src/i18n error.shell) — a raw
// message would reach a Japanese dialog in English. Codes: broker-unreachable,
// no-device, control-worker-gone, not-connected, device-lost, broker-closed,
// broker-timeout, broker-unresponsive, broker-rejected, broker-bad-response, broker-io.

/// Stable error code raised when the worker thread is gone (its command channel or
/// reply channel is closed). The frontend exact-matches this code, so its value
/// must not change. `lib.rs` raises the same code when a worker task panics: from
/// the frontend's side the control worker is equally unavailable either way.
pub(crate) const CONTROL_WORKER_GONE: &str = "control-worker-gone";

/// Device identity exposed to the frontend (no dev_uid / serial). `firmware` is the
/// unit's System firmware version (from /vd/device); empty when the device reports
/// none, and null when the read did not land at all. The frontend warns on a
/// mismatch against the validated version, and refuses the operation on null —
/// an unknown version is not the same as no version.
#[derive(Clone, Serialize)]
pub struct DeviceSummary {
    pub model: String,
    pub label: String,
    pub firmware: Option<String>,
}

/// A freshly opened connection handed to the frontend: the device plus the
/// generation (epoch) that install assigned it. The caller keeps the epoch and
/// passes it back to disconnect, so a stale teardown can only close the exact
/// connection it was issued for (never a newer one that replaced it).
#[derive(Clone, Serialize)]
pub struct Connection {
    #[serde(flatten)]
    pub device: DeviceSummary,
    pub epoch: u64,
}

/// What this connection asked of the broker, and what the broker failed to answer.
///
/// Every field is a monotonic count over ONE connection — a new connection starts
/// at zero — because the question they exist for is "how much did this session cost
/// the broker before it misbehaved", which a rate or an average averages away.
///
/// What is deliberately NOT here: round-trip latency, queue depth, notify rates, the
/// share of notifies the address filter drops. Those measure how the link FEELS from
/// this side, and that is not evidence about the broker's internal state — it can
/// answer promptly right up to the moment its own teardown deadlocks. The drop share
/// in particular cannot measure registration accumulation at all: registration and
/// notify emission are decoupled on this protocol (measured — a registered address
/// can change and announce nothing), and an address nobody moves emits nothing however
/// many times it is registered. See docs/{en,ja}/architecture.md "The link ledger".
#[derive(Default)]
pub struct LinkCounters {
    sets: AtomicU64,
    gets: AtomicU64,
    param_subscribes: AtomicU64,
    meter_subscribes: AtomicU64,
    regist_frames: AtomicU64,
    unregist_frames: AtomicU64,
    deadlines: AtomicU64,
    /// The CURRENT consecutive-deadline run (Health.stalled), not a total: it is the
    /// distance to the stall latch that ends the session, so it goes back to zero the
    /// moment the broker answers anything.
    stalled: AtomicU64,
}

impl LinkCounters {
    fn bump(c: &AtomicU64) {
        c.fetch_add(1, Ordering::Relaxed);
    }

    /// A command ran out its deadline: one more on the total, and the consecutive run
    /// set to where the stall latch has got to. Both here, in one notation, because
    /// they are one event seen two ways.
    fn note_deadline(&self, run: u32) {
        Self::bump(&self.deadlines);
        self.stalled.store(run.into(), Ordering::Relaxed);
    }

    /// The broker answered, so the consecutive run is over.
    fn clear_stall(&self) {
        self.stalled.store(0, Ordering::Relaxed);
    }

    fn read(&self) -> LinkStats {
        LinkStats {
            sets: self.sets.load(Ordering::Relaxed),
            gets: self.gets.load(Ordering::Relaxed),
            param_subscribes: self.param_subscribes.load(Ordering::Relaxed),
            meter_subscribes: self.meter_subscribes.load(Ordering::Relaxed),
            regist_frames: self.regist_frames.load(Ordering::Relaxed),
            unregist_frames: self.unregist_frames.load(Ordering::Relaxed),
            deadlines: self.deadlines.load(Ordering::Relaxed),
            stalled: self.stalled.load(Ordering::Relaxed),
        }
    }
}

/// The counters above as one serializable reading. Read straight off the atomics
/// rather than through `Cmd`, deliberately: a stats request queued behind an ~800
/// command sweep would report the state of the link as it was minutes ago, which is
/// exactly the moment the reading matters.
#[derive(Clone, Default, Serialize)]
pub struct LinkStats {
    pub sets: u64,
    pub gets: u64,
    pub param_subscribes: u64,
    pub meter_subscribes: u64,
    pub regist_frames: u64,
    pub unregist_frames: u64,
    pub deadlines: u64,
    pub stalled: u64,
}

/// One live level-meter reading pushed to the frontend. `value` is the broker's
/// raw meter value (deci-dBFS; 32767 = OVER), decoded on the JS side.
#[derive(Clone, Serialize)]
pub struct MeterUpdate {
    pub meter_id: u32,
    pub x: i64,
    pub value: i64,
}

/// A link-lifecycle event pushed to the frontend. Currently only emitted when the
/// worker loses the broker connection while idle (no command in flight), so a
/// held-open live session can be dropped instead of silently freezing.
#[derive(Clone, Serialize)]
pub struct LinkEvent {
    pub reason: String,
}

/// One device-originated parameter change pushed to the frontend: a `notify` on
/// a registered `/vd/parameters/{id}:{x}:{y}` address. `value` is the same raw
/// broker integer vd_get returns, decoded on the JS side. Lets the UI follow
/// edits made on the device itself (LCD / physical controls).
///
/// `value_str` carries the STRING notifies — the name parameters, whose
/// `current_value` is text rather than a number. They were dropped here for the
/// life of this file, because the decode asked for an integer and gave up when it
/// did not get one: the unit announces a rename (measured on a URX44V, one notify
/// on the renamed address and nothing else), the frame reached this function, and
/// this line discarded it. Numeric notifies leave the field `None` and pay one
/// `is_none()` on the JS side; the integer decode is still tried first, so the
/// common path costs exactly what it did before.
// NOT `rename_all = "camelCase"`: the frontend reads `param_id` off this wire, so a
// blanket rename would quietly break the numeric follow path — and neither the unit
// tests nor the race harness would catch it, because neither goes through serde.
#[derive(Clone, PartialEq, Serialize)]
pub struct ParamUpdate {
    pub param_id: u32,
    pub x: i64,
    pub y: i64,
    pub value: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub value_str: Option<String>,
}

/// The broker's bulk-change push (a namespace-level notify with no address) as one
/// update. Its negative coordinates cannot collide with a real address — catalog x/y
/// are never negative — so the follow layer's unknown-address path escalates it to the
/// full readback a scene recall needs. It belongs to no registered address, so it is
/// also the one update that bypasses the registered-set filter.
pub const BULK_CHANGE: ParamUpdate = ParamUpdate {
    param_id: 0,
    x: -1,
    y: -1,
    value: 0,
    value_str: None,
};

/// A request handed to the worker thread, each carrying a one-shot reply channel.
pub enum Cmd {
    Set {
        param_id: u32,
        x: i64,
        y: i64,
        value: i64,
        reply: Sender<Result<(), String>>,
    },
    Get {
        param_id: u32,
        x: i64,
        y: i64,
        reply: Sender<Result<i64, String>>,
    },
    SetStr {
        param_id: u32,
        x: i64,
        y: i64,
        value: String,
        reply: Sender<Result<(), String>>,
    },
    GetStr {
        param_id: u32,
        x: i64,
        y: i64,
        reply: Sender<Result<String, String>>,
    },
    /// Subscribe to a set of level meters (meter_id, x) and stream their readings
    /// through `channel`. Replaces any prior meter subscription. The reply carries
    /// the first registration *send* failure only (a socket transmit error): the
    /// broker's registration reply is drained by the pump, never read, so a broker
    /// refusal does not surface — only a failure to put the request on the wire.
    /// Each `send` carries a whole pump cycle's readings (the broker streams ~250/s
    /// across the set), so the IPC boundary is crossed ~30×/s instead of per reading.
    MetersSubscribe {
        addrs: Vec<(u32, i64)>,
        channel: Channel<Vec<MeterUpdate>>,
        reply: Sender<Result<(), String>>,
    },
    /// Drop the current meter subscription (unregisters each address).
    MetersUnsubscribe,
    /// Subscribe to a set of parameter addresses (param_id, x, y) and stream their
    /// `notify` frames through `channel`. Replaces any prior parameter subscription.
    /// The reply carries the first registration *send* failure only (a socket
    /// transmit error): the broker's registration reply is drained by the pump,
    /// never read, so a broker refusal does not surface.
    ParamsSubscribe {
        addrs: Vec<(u32, i64, i64)>,
        channel: Channel<Vec<ParamUpdate>>,
        reply: Sender<Result<(), String>>,
    },
    /// Drop the current parameter subscription (unregisters each address).
    ParamsUnsubscribe,
    /// Register a channel to receive the link-lost event (see LinkEvent). Replaces
    /// any prior watch. Fire-and-forget; the worker pushes one event if the broker
    /// link drops while idle, then exits.
    WatchLink { channel: Channel<LinkEvent> },
    /// Unregister everything this session registered, close the socket, and exit.
    /// `done` is signalled once that has actually happened — only the app-exit path
    /// passes one, because it is the only caller whose process may not outlive the
    /// worker. Everywhere else the worker keeps running and finishes on its own.
    Shutdown { done: Option<Sender<()>> },
}

/// The installed connection: the channel to the live worker (if any) and the
/// generation it was assigned. `epoch` increments on every install, so a
/// connection is identified by the generation that opened it.
#[derive(Default)]
struct Conn {
    tx: Option<Sender<Cmd>>,
    epoch: u64,
    /// The live worker's counters, kept here so a reading never has to queue behind
    /// the commands it is counting. Replaced wholesale by each install, so a new
    /// connection's ledger starts at zero and a dead one's stops where it stopped.
    counters: Arc<LinkCounters>,
}

/// Managed Tauri state: the channel to the live worker, if connected, tagged with
/// its generation so disconnect can target a specific connection.
#[derive(Default)]
pub struct VdState {
    conn: Mutex<Conn>,
}

/// Spawn the worker and perform the broker handshake (blocking). Returns the
/// command channel plus the connected device; the caller installs the channel
/// into VdState. Kept free of VdState so a Tauri command can run it on a
/// blocking task — the handshake waits up to seconds and must not stall the UI.
pub fn open() -> Result<(Sender<Cmd>, DeviceSummary, Arc<LinkCounters>), String> {
    let (tx, rx) = mpsc::channel::<Cmd>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<DeviceSummary, String>>();
    let counters = Arc::new(LinkCounters::default());
    let worker_counters = Arc::clone(&counters);
    std::thread::spawn(move || imp::worker(rx, ready_tx, worker_counters));
    let summary = ready_rx
        .recv()
        .map_err(|_| CONTROL_WORKER_GONE.to_string())??;
    Ok((tx, summary, counters))
}

impl VdState {
    /// Install a freshly opened connection, shutting down any prior worker, and
    /// return the generation assigned to it. The caller hands this epoch back to
    /// disconnect so a delayed teardown of an earlier session cannot close this one.
    pub fn install(&self, tx: Sender<Cmd>, counters: Arc<LinkCounters>) -> u64 {
        let mut c = self.conn.lock().unwrap();
        stop(&mut c, None);
        c.tx = Some(tx);
        c.counters = counters;
        c.epoch += 1;
        c.epoch
    }
}

/// This connection's ledger. Zeroed when nothing is connected, which is what the
/// frontend renders as "no link" rather than as a session that did nothing.
pub fn stats(state: &VdState) -> LinkStats {
    let c = state.conn.lock().unwrap();
    if c.tx.is_none() {
        return LinkStats::default();
    }
    c.counters.read()
}

/// Clone the live worker's command channel, or error if not connected. The
/// clone lets the blocking send/reply-wait run on a separate thread, so the
/// Tauri command never stalls the event loop while the broker round-trips.
pub fn sender(state: &VdState) -> Result<Sender<Cmd>, String> {
    state
        .conn
        .lock()
        .unwrap()
        .tx
        .as_ref()
        .cloned()
        .ok_or_else(|| "not-connected".to_string())
}

/// Set one parameter instance to an absolute value. Blocks on the reply, so
/// callers run it off the UI thread. Errors if the worker is gone or the broker
/// rejects the write.
pub fn set(tx: Sender<Cmd>, param_id: u32, x: i64, y: i64, value: i64) -> Result<(), String> {
    let (reply, wait) = mpsc::channel();
    tx.send(Cmd::Set {
        param_id,
        x,
        y,
        value,
        reply,
    })
    .map_err(|_| CONTROL_WORKER_GONE.to_string())?;
    wait.recv().map_err(|_| CONTROL_WORKER_GONE.to_string())?
}

/// Read one parameter instance's current absolute value.
pub fn get(tx: Sender<Cmd>, param_id: u32, x: i64, y: i64) -> Result<i64, String> {
    let (reply, wait) = mpsc::channel();
    tx.send(Cmd::Get {
        param_id,
        x,
        y,
        reply,
    })
    .map_err(|_| CONTROL_WORKER_GONE.to_string())?;
    wait.recv().map_err(|_| CONTROL_WORKER_GONE.to_string())?
}

/// Set one string-valued parameter instance (e.g. a CH SETTING name).
pub fn set_str(
    tx: Sender<Cmd>,
    param_id: u32,
    x: i64,
    y: i64,
    value: String,
) -> Result<(), String> {
    let (reply, wait) = mpsc::channel();
    tx.send(Cmd::SetStr {
        param_id,
        x,
        y,
        value,
        reply,
    })
    .map_err(|_| CONTROL_WORKER_GONE.to_string())?;
    wait.recv().map_err(|_| CONTROL_WORKER_GONE.to_string())?
}

/// Read one string-valued parameter instance's current value.
pub fn get_str(tx: Sender<Cmd>, param_id: u32, x: i64, y: i64) -> Result<String, String> {
    let (reply, wait) = mpsc::channel();
    tx.send(Cmd::GetStr {
        param_id,
        x,
        y,
        reply,
    })
    .map_err(|_| CONTROL_WORKER_GONE.to_string())?;
    wait.recv().map_err(|_| CONTROL_WORKER_GONE.to_string())?
}

/// Subscribe to live level meters; readings stream through `channel`. Replaces
/// any prior subscription. Blocks until the worker has sent every registration;
/// the reply carries only a socket transmit failure, not a broker refusal (the
/// registration reply is never read).
pub fn meters_subscribe(
    tx: Sender<Cmd>,
    addrs: Vec<(u32, i64)>,
    channel: Channel<Vec<MeterUpdate>>,
) -> Result<(), String> {
    let (reply, rx) = mpsc::channel();
    tx.send(Cmd::MetersSubscribe {
        addrs,
        channel,
        reply,
    })
    .map_err(|_| CONTROL_WORKER_GONE.to_string())?;
    rx.recv().map_err(|_| CONTROL_WORKER_GONE.to_string())?
}

/// Drop the current meter subscription.
pub fn meters_unsubscribe(tx: Sender<Cmd>) -> Result<(), String> {
    tx.send(Cmd::MetersUnsubscribe)
        .map_err(|_| CONTROL_WORKER_GONE.to_string())
}

/// Subscribe to device-side parameter changes; notifies stream through `channel`.
/// Replaces any prior subscription. Blocks until the worker has sent every
/// registration; the reply carries only a socket transmit failure, not a broker
/// refusal (the registration reply is never read).
pub fn params_subscribe(
    tx: Sender<Cmd>,
    addrs: Vec<(u32, i64, i64)>,
    channel: Channel<Vec<ParamUpdate>>,
) -> Result<(), String> {
    let (reply, rx) = mpsc::channel();
    tx.send(Cmd::ParamsSubscribe {
        addrs,
        channel,
        reply,
    })
    .map_err(|_| CONTROL_WORKER_GONE.to_string())?;
    rx.recv().map_err(|_| CONTROL_WORKER_GONE.to_string())?
}

/// Drop the current parameter subscription.
pub fn params_unsubscribe(tx: Sender<Cmd>) -> Result<(), String> {
    tx.send(Cmd::ParamsUnsubscribe)
        .map_err(|_| CONTROL_WORKER_GONE.to_string())
}

/// Register a channel to receive the link-lost event. Replaces any prior watch.
pub fn watch_link(tx: Sender<Cmd>, channel: Channel<LinkEvent>) -> Result<(), String> {
    tx.send(Cmd::WatchLink { channel })
        .map_err(|_| CONTROL_WORKER_GONE.to_string())
}

/// Close the connection of generation `epoch`. A no-op if the current connection
/// is a different generation (a newer install already replaced it) or none is
/// installed — so a delayed teardown of an old session never closes a live one.
/// Safe to call when not connected.
pub fn disconnect(state: &VdState, epoch: u64) {
    let mut c = state.conn.lock().unwrap();
    if c.epoch == epoch {
        stop(&mut c, None);
    }
}

/// Close whatever connection is installed, whatever generation it belongs to. The
/// epoch-matched `disconnect` above is for a session ending; this is for the page
/// that owned it going away, where no epoch survives to name it — see the page-load
/// teardown in lib.rs. A no-op when nothing is installed.
pub fn shutdown(state: &VdState) {
    stop(&mut state.conn.lock().unwrap(), None);
}

/// How long the app-exit teardown waits for the worker to unregister and close.
/// It is the operator's quit that is being held, so it is bounded: a broker that has
/// stopped answering must not turn Quit into a hang of our own making.
const EXIT_TEARDOWN_WAIT: Duration = Duration::from_millis(1500);

/// Close the session and WAIT for the worker to have unregistered and closed the
/// socket, or for the bound above. The other teardowns can be fire-and-forget
/// because the worker outlives them; this one is called as the process is going
/// away, and the frames only reach the broker if they are sent before it does.
///
/// Whether an abandoned session is what leaves Device Center needing a force quit is
/// NOT established — this closes the session properly so that it stops being one of
/// the candidates, which is a different claim. See docs/{en,ja}/known-issues.md.
pub fn shutdown_blocking(state: &VdState) {
    // The wait is the only thing this path adds; the teardown itself is `stop`, so a
    // step added there reaches app quit too — which is the one teardown with no second
    // chance to run it.
    let (done, wait) = mpsc::channel();
    let sent = stop(&mut state.conn.lock().unwrap(), Some(done));
    if !sent {
        return; // nothing installed, or the worker is already gone
    }
    if wait.recv_timeout(EXIT_TEARDOWN_WAIT).is_err() {
        eprintln!("vd: the broker session did not close within the exit teardown window");
    }
}

/// Take the installed worker's channel and tell it to exit, optionally handing it the
/// channel to signal once it has. The one spelling of a teardown, so a step added to it
/// (dropping a channel eagerly, bumping the epoch) cannot reach one caller and miss
/// another. Returns whether a live worker was actually told. Caller holds the lock.
fn stop(c: &mut Conn, done: Option<Sender<()>>) -> bool {
    let Some(tx) = c.tx.take() else { return false };
    tx.send(Cmd::Shutdown { done }).is_ok()
}

#[cfg(desktop)]
mod imp {
    use super::{
        Cmd, DeviceSummary, LinkCounters, LinkEvent, MeterUpdate, ParamUpdate, BULK_CHANGE,
    };
    use std::collections::HashSet;
    use std::net::TcpStream;
    use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use serde_json::{json, Value};
    use tauri::ipc::Channel;
    use tungstenite::stream::MaybeTlsStream;
    use tungstenite::{connect, Message, WebSocket};

    const URL: &str = "ws://127.0.0.1:51780/casket";
    type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

    /// Active frontend subscriptions (meter / parameter channels) plus their
    /// pending notify batches. Shared by the idle pump and the command await
    /// loops (do_set / do_get_value): a notify that lands while a command waits
    /// for its response is absorbed into the batch instead of discarded, so the
    /// console meters keep streaming while a long command sequence (e.g. a
    /// device-follow readback) holds the worker. Batches flush on the pump
    /// cadence (PUMP_BUDGET) inside absorb itself, so batch latency stays
    /// bounded even while commands run back-to-back, and the IPC boundary is
    /// still crossed ~30×/s, never per reading.
    struct Subs {
        meter_ch: Option<Channel<Vec<MeterUpdate>>>,
        param_ch: Option<Channel<Vec<ParamUpdate>>>,
        /// The addresses this session registered with the broker. They serve two
        /// jobs: unregistering the previous set when a subscription is replaced,
        /// and filtering the inbound feed. A notify reaches **every** connected
        /// client, not just the one that registered the address, so what arrives
        /// here also carries another client's registrations and the unit's own
        /// clock, which pushes a notify every 10 s for as long as the link is up.
        /// Forwarding those hands the follow layer addresses outside the plan's
        /// writable set, which it (correctly) escalates to a full device readback —
        /// a full readback every 10 s, all session.
        meter_addrs: HashSet<(u32, i64)>,
        param_addrs: HashSet<(u32, i64, i64)>,
        meters: Vec<MeterUpdate>,
        params: Vec<ParamUpdate>,
        last_flush: Instant,
    }

    impl Subs {
        fn new() -> Self {
            Subs {
                meter_ch: None,
                param_ch: None,
                meter_addrs: HashSet::new(),
                param_addrs: HashSet::new(),
                meters: Vec::new(),
                params: Vec::new(),
                last_flush: Instant::now(),
            }
        }

        /// Whether any subscription is streaming (drives the worker's poll cadence).
        fn active(&self) -> bool {
            self.meter_ch.is_some() || self.param_ch.is_some()
        }

        /// Collect a subscribed meter / parameter notify into its pending batch,
        /// flushing on the pump cadence. Only addresses this session registered are
        /// forwarded (see the address sets above); a notify for any other address is
        /// still consumed — it is a notify frame, never a command reply — just
        /// dropped rather than passed on. Returns true when the frame was consumed
        /// (callers skip further matching).
        fn absorb(&mut self, msg: &Value) -> bool {
            if self.meter_ch.is_some() {
                if let Some(m) = parse_meter(msg) {
                    if self.meter_addrs.contains(&(m.meter_id, m.x)) {
                        self.meters.push(m);
                        self.flush_due();
                    }
                    return true;
                }
            }
            if self.param_ch.is_some() {
                if let Some(p) = parse_param(msg) {
                    if p == BULK_CHANGE || self.param_addrs.contains(&(p.param_id, p.x, p.y)) {
                        self.params.push(p);
                        self.flush_due();
                    }
                    return true;
                }
            }
            false
        }

        /// Flush once the pump cadence has elapsed (bounds the batch latency).
        fn flush_due(&mut self) {
            if self.last_flush.elapsed() >= PUMP_BUDGET {
                self.flush();
            }
        }

        /// Send the pending batches (one channel send each; no-op when empty).
        fn flush(&mut self) {
            if let (Some(ch), false) = (self.meter_ch.as_ref(), self.meters.is_empty()) {
                let _ = ch.send(std::mem::take(&mut self.meters));
            }
            if let (Some(ch), false) = (self.param_ch.as_ref(), self.params.is_empty()) {
                let _ = ch.send(std::mem::take(&mut self.params));
            }
            self.last_flush = Instant::now();
        }
    }

    pub fn worker(
        rx: Receiver<Cmd>,
        ready: Sender<Result<DeviceSummary, String>>,
        counters: Arc<LinkCounters>,
    ) {
        let mut ws = match connect(URL) {
            Ok((ws, _)) => ws,
            Err(e) => {
                // Device Center isn't running (or the broker port is closed). Return
                // a stable code the frontend localizes; keep the raw cause for logs.
                eprintln!("vd: cannot reach Device Center broker: {e}");
                let _ = ready.send(Err("broker-unreachable".into()));
                return;
            }
        };
        // Short read timeout so the loop can interleave draining and commands.
        // Not optional: every read below blocks with no deadline of its own, so a
        // socket left in blocking mode turns any quiet moment into a hang the user
        // can only escape by quitting. Refuse the session instead.
        if let MaybeTlsStream::Plain(s) = ws.get_ref() {
            if let Err(e) = s.set_read_timeout(Some(Duration::from_millis(200))) {
                let _ = ready.send(Err(format!(
                    "broker-io: could not set the socket read timeout: {e}"
                )));
                return;
            }
        }

        let (dev_uid, summary) = match handshake(&mut ws) {
            Ok(v) => v,
            Err(e) => {
                let _ = ready.send(Err(e));
                return;
            }
        };
        if ready.send(Ok(summary.clone())).is_err() {
            return; // caller gave up
        }

        // Subscribed meter / parameter channels, the addresses registered with the
        // broker, and the pending notify batches (see Subs).
        let mut subs = Subs::new();
        // Channel to push the one-shot link-lost event on, if the frontend is
        // watching: a held-open live session is dropped instead of freezing when
        // the broker link goes away while idle.
        let mut link_ch: Option<Channel<LinkEvent>> = None;
        // Latched once a device-lost push is seen. The push arrives exactly once,
        // so the command that consumed it is the only one that could ever notice:
        // without this, every later command keeps talking to a broker that still
        // ACKs writes with no unit attached and answers reads from its cache, and
        // the frontend is told a plan was written when nothing reached hardware.
        let mut health = Health::new(Arc::clone(&counters));
        // Set by the app-exit teardown, which waits for it: the socket has to be
        // unregistered and closed before the process goes away, not merely told to be.
        let mut exit_done: Option<Sender<()>> = None;
        loop {
            // While a subscription is streaming, poll for commands briefly so the
            // bounded pump runs back-to-back and keeps up with the ~250/s feed; when
            // idle, wait longer so the thread doesn't spin. pump's own blocking read
            // (200 ms socket timeout) supplies the backpressure when the feed is quiet.
            let wait = if subs.active() {
                Duration::from_millis(5)
            } else {
                Duration::from_millis(50)
            };
            match rx.recv_timeout(wait) {
                Ok(Cmd::Shutdown { done }) => {
                    exit_done = done;
                    break;
                }
                Err(RecvTimeoutError::Disconnected) => break,
                Ok(Cmd::Set {
                    param_id,
                    x,
                    y,
                    value,
                    reply,
                }) => {
                    LinkCounters::bump(&counters.sets);
                    let _ = reply.send(health.guard(|| {
                        do_set(&mut ws, &mut subs, &dev_uid, param_id, x, y, json!(value))
                    }));
                }
                Ok(Cmd::Get {
                    param_id,
                    x,
                    y,
                    reply,
                }) => {
                    LinkCounters::bump(&counters.gets);
                    let _ = reply.send(
                        health.guard(|| do_get(&mut ws, &mut subs, &dev_uid, param_id, x, y)),
                    );
                }
                Ok(Cmd::SetStr {
                    param_id,
                    x,
                    y,
                    value,
                    reply,
                }) => {
                    LinkCounters::bump(&counters.sets);
                    let _ = reply.send(health.guard(|| {
                        do_set(&mut ws, &mut subs, &dev_uid, param_id, x, y, json!(value))
                    }));
                }
                Ok(Cmd::GetStr {
                    param_id,
                    x,
                    y,
                    reply,
                }) => {
                    LinkCounters::bump(&counters.gets);
                    let _ =
                        reply
                            .send(health.guard(|| {
                                do_get_str(&mut ws, &mut subs, &dev_uid, param_id, x, y)
                            }));
                }
                Ok(Cmd::MetersSubscribe {
                    addrs,
                    channel,
                    reply,
                }) => {
                    // Replace any prior subscription: unregister the old set, then
                    // register the new one address by address (never a bulk post on
                    // /vd/meters — that has been seen to crash Device Center).
                    LinkCounters::bump(&counters.meter_subscribes);
                    unregister_meters(&mut ws, &dev_uid, &mut subs, &counters);
                    let mut first = Ok(());
                    for &(id, x) in &addrs {
                        LinkCounters::bump(&counters.regist_frames);
                        let r = health.guard(|| reg_meter(&mut ws, &dev_uid, id, x, "regist"));
                        if first.is_ok() {
                            first = r;
                        }
                    }
                    subs.meter_addrs = addrs.into_iter().collect();
                    subs.meters.clear();
                    subs.meter_ch = Some(channel);
                    let _ = reply.send(first);
                }
                Ok(Cmd::MetersUnsubscribe) => {
                    unregister_meters(&mut ws, &dev_uid, &mut subs, &counters);
                    subs.meters.clear();
                    subs.meter_ch = None;
                }
                Ok(Cmd::ParamsSubscribe {
                    addrs,
                    channel,
                    reply,
                }) => {
                    // Replace any prior subscription: unregister the old set, then
                    // register the new one address by address (per-address regist
                    // only, mirroring meters — a bulk post has crashed Device Center).
                    LinkCounters::bump(&counters.param_subscribes);
                    unregister_params(&mut ws, &dev_uid, &mut subs, &counters);
                    let mut first = Ok(());
                    for &(id, x, y) in &addrs {
                        LinkCounters::bump(&counters.regist_frames);
                        let r = health.guard(|| reg_param(&mut ws, &dev_uid, id, x, y, "regist"));
                        if first.is_ok() {
                            first = r;
                        }
                    }
                    subs.param_addrs = addrs.into_iter().collect();
                    subs.params.clear();
                    subs.param_ch = Some(channel);
                    let _ = reply.send(first);
                }
                Ok(Cmd::ParamsUnsubscribe) => {
                    unregister_params(&mut ws, &dev_uid, &mut subs, &counters);
                    subs.params.clear();
                    subs.param_ch = None;
                }
                Ok(Cmd::WatchLink { channel }) => {
                    link_ch = Some(channel);
                }
                Err(RecvTimeoutError::Timeout) => {
                    // Drain the idle socket so its buffer never backs up. While a
                    // meter / parameter subscription is active, forward those
                    // notifications to the frontend instead of discarding them; stop
                    // if the link dropped, pushing the link-lost event first so a
                    // held-open live session is dropped instead of freezing silently.
                    if let Err(e) = pump(&mut ws, &mut subs) {
                        eprintln!("vd: {e}; stopping control worker");
                        if let Some(ch) = &link_ch {
                            let _ = ch.send(LinkEvent { reason: e });
                        }
                        break;
                    }
                }
            }
        }
        // EVERY break above lands here, which is what makes this the session's one exit
        // — including the pump's error break, where the link is already gone and the
        // unregisters are discarded like the rest of that path's writes.
        unregister_all(&mut ws, &dev_uid, &mut subs, &counters);
        // `close` only QUEUES the Close frame; the handshake finishes on the reads that
        // follow, and dropping the socket before then hands the broker an abrupt
        // disconnect instead of a close.
        let _ = ws.close(None);
        let _ = ws.flush();
        for _ in 0..CLOSE_FRAMES {
            // `Ok(None)` is the socket's own 200 ms read timeout: the peer has nothing
            // queued, so its Close is not coming and there is nothing left to drain.
            // Counting those against the budget would spend 64 × 200 ms on a quiet
            // broker — which is exactly the state a session that just unregistered
            // everything is in, and it is the operator's Quit being held.
            match read_text(&mut ws) {
                Ok(Some(_)) => {}
                _ => break, // a closed / dead socket, or nothing more to read
            }
        }
        // Sent LAST, so the app-exit path is released by the close having happened and
        // not merely by the intent to close.
        if let Some(done) = exit_done.take() {
            let _ = done.send(());
        }
    }

    /// Frames the close handshake will read through before giving up on the peer's
    /// half. Under Live sync the broker is still streaming meters when the close goes
    /// out, so the peer's Close frame arrives behind a few readings, not immediately.
    const CLOSE_FRAMES: usize = 64;

    /// Drop every meter registration this session holds. Shared by the subscription
    /// replacement, the explicit unsubscribe and the session teardown, so the three
    /// cannot disagree about what leaving looks like.
    fn unregister_meters(ws: &mut Ws, dev_uid: &str, subs: &mut Subs, counters: &LinkCounters) {
        for &(id, x) in &subs.meter_addrs {
            LinkCounters::bump(&counters.unregist_frames);
            let _ = reg_meter(ws, dev_uid, id, x, "unregist");
        }
        subs.meter_addrs.clear();
    }

    /// The parameter half of the above.
    fn unregister_params(ws: &mut Ws, dev_uid: &str, subs: &mut Subs, counters: &LinkCounters) {
        for &(id, x, y) in &subs.param_addrs {
            LinkCounters::bump(&counters.unregist_frames);
            let _ = reg_param(ws, dev_uid, id, x, y, "unregist");
        }
        subs.param_addrs.clear();
    }

    /// Everything this session registered, on the way out. The registration reply is
    /// never read (see Cmd::ParamsSubscribe), so this cannot confirm the broker took
    /// them — it can only make sure they were asked for, which is the whole of what
    /// this side controls.
    fn unregister_all(ws: &mut Ws, dev_uid: &str, subs: &mut Subs, counters: &LinkCounters) {
        unregister_meters(ws, dev_uid, subs, counters);
        unregister_params(ws, dev_uid, subs, counters);
    }

    fn send_json(ws: &mut Ws, v: Value) -> Result<(), String> {
        ws.send(Message::Text(v.to_string().into()))
            .map_err(|e| format!("broker-io: {e}"))
    }

    /// Read one text message, or None on read timeout. Errors on a closed or
    /// broken connection, or on an unexpected binary frame, so the awaiting
    /// command surfaces the failure to the frontend instead of hanging.
    fn read_text(ws: &mut Ws) -> Result<Option<String>, String> {
        match ws.read() {
            Ok(Message::Text(t)) => Ok(Some(t.to_string())),
            Ok(Message::Close(_)) => Err("broker-closed".into()),
            // The vd protocol is JSON text only; a binary frame means the link is
            // out of sync, so fail the awaiting command rather than swallow it.
            Ok(Message::Binary(_)) => Err("broker-bad-response: binary frame".into()),
            Ok(_) => Ok(None), // ping/pong — ignore
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                Ok(None)
            }
            Err(e) => Err(format!("broker-io: {e}")),
        }
    }

    fn handshake(ws: &mut Ws) -> Result<(String, DeviceSummary), String> {
        send_json(ws, json!({ "jsonrpc": "1.0", "method": "getDeviceList" }))?;
        let deadline = Instant::now() + Duration::from_secs(5);
        while Instant::now() < deadline {
            let Some(text) = read_text(ws)? else { continue };
            let Ok(msg) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if msg.get("method").and_then(Value::as_str) != Some("getDeviceList") {
                continue;
            }
            let list = msg.pointer("/params/list").and_then(Value::as_array);
            let first = list.and_then(|l| l.first());
            let Some(dev) = first else {
                // Broker is up but its device list is empty: Device Center is running
                // with no URX attached. Stable code; the frontend localizes it.
                return Err("no-device".into());
            };
            let dev_uid = dev
                .get("dev_uid")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            let mut summary = DeviceSummary {
                model: dev
                    .get("model")
                    .and_then(Value::as_str)
                    .unwrap_or("URX")
                    .to_string(),
                label: dev
                    .get("label")
                    .and_then(Value::as_str)
                    .unwrap_or("URX")
                    .to_string(),
                firmware: Some(String::new()),
            };
            if dev_uid.is_empty() {
                return Err("broker-bad-response: device list entry had no identifier".into());
            }
            // The list entry persists after the unit is unplugged, so confirm the
            // live link before claiming a device: "online" means a URX is actually
            // attached. Anything else (e.g. "lost") is Device Center up with no
            // unit → the same no-device state as an empty list.
            let status = sync_status(ws, &dev_uid)?;
            if status != "online" {
                eprintln!("vd: URX listed but sync_status = {status}; treating as no-device");
                return Err("no-device".into());
            }
            // Read the System firmware version so the frontend can warn when the
            // attached unit's firmware differs from the validated one. A failed read
            // yields None, which the frontend treats as a reason to stop rather than
            // as a reason to skip the check.
            summary.firmware = system_firmware(ws, &dev_uid);
            return Ok((dev_uid, summary));
        }
        // No device list within the deadline. The broker answered the WebSocket
        // handshake but never listed a unit, so treat it as no URX attached
        // (same remedy for the user); the empty-list path above is the other shape.
        eprintln!("vd: timed out waiting for the device list");
        Err("no-device".into())
    }

    /// Send a `requestVD` GET for `uri` and return the matched response's `vdp.data`.
    /// Shared by the handshake-time reads (synchronize, device); drains non-matching
    /// frames until the address echoes back or the 3s deadline lapses. The parameter
    /// read path (do_get_value) keeps its own loop — it also screens for a mid-read
    /// device-lost push, which these handshake reads run before a session exists.
    fn vd_get_data(ws: &mut Ws, dev_uid: &str, uri: &str) -> Result<Value, String> {
        let base = uri.split('?').next().unwrap_or(uri).to_string();
        send_json(
            ws,
            json!({
                "jsonrpc": "1.0",
                "method": "requestVD",
                "params": {
                    "dev_uid": dev_uid,
                    "vdp": { "method": "get", "uri": uri }
                }
            }),
        )?;
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let Some(text) = read_text(ws)? else { continue };
            let Ok(msg) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if msg.get("method").and_then(Value::as_str) != Some("requestVD") {
                continue;
            }
            let vdp = msg.pointer("/params/vdp");
            let ruri = vdp
                .and_then(|v| v.get("uri"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if ruri.split('?').next().unwrap_or(ruri) != base {
                continue;
            }
            return vdp
                .and_then(|v| v.get("data"))
                .cloned()
                .ok_or_else(|| format!("broker-bad-response: no data for {base}"));
        }
        Err(format!("broker-timeout: {base}"))
    }

    /// Query the unit's live link state via /vd/synchronize: "online" means a URX
    /// is actually attached. Device Center keeps the getDeviceList entry after the
    /// unit is unplugged but reports a non-"online" status here, so this is what
    /// separates a present device from a stale list entry.
    fn sync_status(ws: &mut Ws, dev_uid: &str) -> Result<String, String> {
        vd_get_data(ws, dev_uid, "/vd/synchronize")?
            .pointer("/sync_status")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "broker-bad-response: no sync_status".to_string())
    }

    /// The unit's System firmware version, from /vd/device's firm_list. `Some("")`
    /// means the unit answered but reports no System version, which legitimately
    /// disables the frontend's mismatch warning. `None` means the read itself did
    /// not land — an unanswered /vd/device or a response without a firm_list — so
    /// the version is unknown rather than absent, and the frontend refuses to touch
    /// the device instead of proceeding with the gate silently disabled.
    fn system_firmware(ws: &mut Ws, dev_uid: &str) -> Option<String> {
        let data = vd_get_data(ws, dev_uid, "/vd/device").ok()?;
        let list = data.pointer("/firm_list").and_then(Value::as_array)?;
        // The System entry, matched by name (case-insensitive). A missing or renamed
        // entry leaves the version empty (warning disabled) rather than mistaking
        // another component's version for System.
        for entry in list {
            if entry
                .get("firm_name")
                .and_then(Value::as_str)
                .unwrap_or("")
                .eq_ignore_ascii_case("system")
            {
                return Some(
                    entry
                        .get("firm_version")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_string(),
                );
            }
        }
        Some(String::new())
    }

    fn do_set(
        ws: &mut Ws,
        subs: &mut Subs,
        dev_uid: &str,
        param_id: u32,
        x: i64,
        y: i64,
        value: Value,
    ) -> Result<(), String> {
        let uri = format!("/vd/parameters/{param_id}:{x}:{y}?operation=value");
        let base = format!("/vd/parameters/{param_id}:{x}:{y}");
        send_json(
            ws,
            json!({
                "jsonrpc": "1.0",
                "method": "requestVD",
                "params": {
                    "dev_uid": dev_uid,
                    "vdp": { "method": "post", "uri": uri, "data": { "current_value": value } }
                }
            }),
        )?;
        // Await the matching response, skipping unrelated notifications.
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let Some(text) = read_text(ws)? else { continue };
            let Ok(msg) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            // A device-lost push can land mid-write (the broker still ACKs the
            // write itself); fail the command so the session tears down.
            if let Some(err) = synchronize_lost(&msg) {
                return Err(err);
            }
            // Subscribed notifies landing mid-command are batched, not discarded
            // (see Subs).
            let Some(vdp) = reply_for(subs, &msg, &base) else {
                continue;
            };
            let code = vdp
                .pointer("/data/response_code")
                .and_then(Value::as_i64)
                .unwrap_or(0);
            return if code == 200 {
                Ok(())
            } else {
                Err(format!(
                    "broker-rejected: {param_id}:{x}:{y} (response_code {code})"
                ))
            };
        }
        drain_late_reply(ws, subs, &base);
        Err(format!("broker-timeout: write at {param_id}:{x}:{y}"))
    }

    /// A command that timed out may still have its reply in flight. The vd protocol
    /// carries no request id, so a late reply for an address is indistinguishable
    /// from the reply to the *next* command on that same address — it would satisfy
    /// it with a stale value. Drain what is already buffered (bounded, and only
    /// after a timeout, so the healthy path pays nothing) and drop any reply for the
    /// address that just gave up. Notifies stay batched via subs, as everywhere else.
    fn drain_late_reply(ws: &mut Ws, subs: &mut Subs, base: &str) {
        // Bounded by frames rather than wall clock: under Live sync the broker
        // streams meters continuously, so a deadline would always run to the end
        // while absorbing notifies. The straggler is the next reply frame, not a
        // quarter-second of meters away.
        for _ in 0..DRAIN_FRAMES {
            let Ok(Some(text)) = read_text(ws) else { break };
            let Ok(msg) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if reply_for(subs, &msg, base).is_some() {
                return; // the straggler is consumed; the socket is clean again
            }
        }
    }

    /// Frames drain_late_reply will look through for a straggler before giving up.
    const DRAIN_FRAMES: usize = 64;

    /// The `requestVD` reply body for `base`, or None when the message was a notify
    /// (absorbed into the pending batch) or belonged to another address. Shared by
    /// the two await loops and the late drain so the matching cannot drift — the
    /// exact-address compare is what stops another instance's reply (e.g. y=12)
    /// satisfying a y=1 request through a prefix match.
    fn reply_for<'a>(subs: &mut Subs, msg: &'a Value, base: &str) -> Option<&'a Value> {
        if subs.absorb(msg) {
            return None;
        }
        if msg.get("method").and_then(Value::as_str) != Some("requestVD") {
            return None;
        }
        let vdp = msg.pointer("/params/vdp")?;
        let uri = vdp.get("uri").and_then(Value::as_str).unwrap_or("");
        (uri.split('?').next().unwrap_or(uri) == base).then_some(vdp)
    }

    // Read a parameter instance's raw current_value (numeric or string). do_get /
    // do_get_str decode it; sharing the request + address-matched await loop here
    // keeps the two get paths from drifting.
    fn do_get_value(
        ws: &mut Ws,
        subs: &mut Subs,
        dev_uid: &str,
        param_id: u32,
        x: i64,
        y: i64,
    ) -> Result<Value, String> {
        let base = format!("/vd/parameters/{param_id}:{x}:{y}");
        send_json(
            ws,
            json!({
                "jsonrpc": "1.0",
                "method": "requestVD",
                "params": {
                    "dev_uid": dev_uid,
                    "vdp": { "method": "get", "uri": base }
                }
            }),
        )?;
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let Some(text) = read_text(ws)? else { continue };
            let Ok(msg) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            // A device-lost push can land mid-read; fail the command so the caller
            // (readback / converge / live) surfaces the drop instead of timing out.
            if let Some(err) = synchronize_lost(&msg) {
                return Err(err);
            }
            // Subscribed notifies landing mid-command are batched, not discarded
            // (see Subs).
            let Some(vdp) = reply_for(subs, &msg, &base) else {
                continue;
            };
            return vdp.pointer("/data/current_value").cloned().ok_or_else(|| {
                format!("broker-bad-response: no current_value at {param_id}:{x}:{y}")
            });
        }
        drain_late_reply(ws, subs, &base);
        Err(format!("broker-timeout: value at {param_id}:{x}:{y}"))
    }

    fn do_get(
        ws: &mut Ws,
        subs: &mut Subs,
        dev_uid: &str,
        param_id: u32,
        x: i64,
        y: i64,
    ) -> Result<i64, String> {
        do_get_value(ws, subs, dev_uid, param_id, x, y)?
            .as_i64()
            .ok_or_else(|| "broker-bad-response: value was not an integer".to_string())
    }

    // The broker returns a name as a preset index (number) until one is typed,
    // then the literal string; a non-string value decodes to "" so callers see
    // "no custom name".
    fn do_get_str(
        ws: &mut Ws,
        subs: &mut Subs,
        dev_uid: &str,
        param_id: u32,
        x: i64,
        y: i64,
    ) -> Result<String, String> {
        Ok(do_get_value(ws, subs, dev_uid, param_id, x, y)?
            .as_str()
            .unwrap_or("")
            .to_string())
    }

    /// Register or unregister one meter address with the broker. Fire-and-forget:
    /// the response_code reply is drained by `pump` like any other frame.
    fn reg_meter(
        ws: &mut Ws,
        dev_uid: &str,
        meter_id: u32,
        x: i64,
        op: &str,
    ) -> Result<(), String> {
        send_json(
            ws,
            json!({
                "jsonrpc": "1.0",
                "method": "requestVD",
                "params": {
                    "dev_uid": dev_uid,
                    "vdp": { "method": "post", "uri": format!("/vd/meters/{meter_id}:{x}?operation={op}") }
                }
            }),
        )
    }

    /// Register or unregister one parameter address with the broker for change
    /// notifies. Fire-and-forget, like reg_meter: the reply is drained by `pump`.
    fn reg_param(
        ws: &mut Ws,
        dev_uid: &str,
        param_id: u32,
        x: i64,
        y: i64,
        op: &str,
    ) -> Result<(), String> {
        send_json(
            ws,
            json!({
                "jsonrpc": "1.0",
                "method": "requestVD",
                "params": {
                    "dev_uid": dev_uid,
                    "vdp": { "method": "post", "uri": format!("/vd/parameters/{param_id}:{x}:{y}?operation={op}") }
                }
            }),
        )
    }

    /// Validate a broker `notify` frame and return its `vdp` object plus the
    /// address segment after `prefix` (query stripped), or None for any other
    /// frame shape (command replies, notifies on a different uri, etc.). Shared
    /// by the meter and parameter forwarders, which only differ in the prefix,
    /// the address arity, and how strictly they read current_value.
    fn notify_frame<'a>(msg: &'a Value, prefix: &str) -> Option<(&'a Value, &'a str)> {
        let vdp = msg.pointer("/params/vdp").or_else(|| msg.pointer("/vdp"))?;
        if vdp.get("method").and_then(Value::as_str) != Some("notify") {
            return None;
        }
        let uri = vdp.get("uri").and_then(Value::as_str)?;
        let rest = uri.strip_prefix(prefix)?;
        Some((vdp, rest.split('?').next().unwrap_or(rest)))
    }

    /// Parse a meter `notify` frame and stream it to the frontend.
    fn parse_meter(msg: &Value) -> Option<MeterUpdate> {
        let (vdp, addr) = notify_frame(msg, "/vd/meters/")?;
        let mut parts = addr.split(':');
        let (id, xs) = (parts.next()?, parts.next()?);
        let (meter_id, x) = (id.parse::<u32>().ok()?, xs.parse::<i64>().ok()?);
        // Drop the frame rather than substituting a value, like parse_param does:
        // 0 here is not "no reading", it is 0.0 dBFS, so a malformed frame would
        // slam the bar to full scale and read as clipping that never happened.
        let value = vdp.pointer("/data/current_value").and_then(Value::as_i64)?;
        Some(MeterUpdate { meter_id, x, value })
    }

    /// Parse a parameter `notify` frame (a device-side change on a registered
    /// address). A non-integer current_value (e.g. a name string) yields None —
    /// numeric follow only, matching the JS reconcile.
    fn parse_param(msg: &Value) -> Option<ParamUpdate> {
        // A namespace-level notify — `/vd/parameters` with no address and no value —
        // is the broker's bulk-change push: a scene recall on the unit emits only
        // this single frame (confirmed by capture; the changed parameters get no
        // per-address notifies). Forward it as the sentinel (see BULK_CHANGE).
        if notify_frame(msg, "/vd/parameters").is_some_and(|(_, rest)| rest.is_empty()) {
            return Some(BULK_CHANGE);
        }
        let (vdp, addr) = notify_frame(msg, "/vd/parameters/")?;
        let mut parts = addr.split(':');
        let (ids, xs, ys) = (parts.next()?, parts.next()?, parts.next()?);
        let (param_id, x, y) = (
            ids.parse::<u32>().ok()?,
            xs.parse::<i64>().ok()?,
            ys.parse::<i64>().ok()?,
        );
        // Integer first — that is every notify but the name ones, and it must stay
        // the cheap path. A frame carrying neither is still dropped, as before.
        let raw = vdp.pointer("/data/current_value")?;
        let (value, value_str) = match raw.as_i64() {
            Some(v) => (v, None),
            None => (0, Some(raw.as_str()?.to_string())),
        };
        Some(ParamUpdate {
            param_id,
            x,
            y,
            value,
            value_str,
        })
    }

    /// Detect a device-lost push: Device Center spontaneously sends a
    /// `/vd/synchronize` frame with `sync_status` flipping to "offline"/"lost" the
    /// moment the URX is physically unplugged (confirmed by capture). It arrives on
    /// `/vd/synchronize`, not `/vd/parameters`, so the notify forwarders miss it;
    /// the broker also keeps ACKing writes (response_code 200) with no unit
    /// attached, so a write error cannot reveal the drop. Returns the ready-to-use
    /// error message when seen, so each read loop just `return Err(..)`s on it.
    /// Not used by handshake / sync_status, which read `/vd/synchronize` on purpose.
    fn synchronize_lost(msg: &Value) -> Option<String> {
        let vdp = msg.pointer("/params/vdp").or_else(|| msg.pointer("/vdp"))?;
        let uri = vdp.get("uri").and_then(Value::as_str)?;
        if uri.split('?').next().unwrap_or(uri) != "/vd/synchronize" {
            return None;
        }
        let status = vdp.pointer("/data/sync_status").and_then(Value::as_str)?;
        if status == "online" {
            return None;
        }
        Some(format!("{DEVICE_LOST_PREFIX}: sync_status {status}"))
    }

    /// Prefix every device-lost error carries, so the worker can recognise one of
    /// its own and latch the session as dead rather than re-deriving the state.
    pub(super) const DEVICE_LOST_PREFIX: &str = "device-lost";

    /// Prefix every per-command deadline carries. A single one is survivable; a run of
    /// them with nothing answered in between is the stall latched below.
    pub(super) const BROKER_TIMEOUT_PREFIX: &str = "broker-timeout";

    /// Consecutive deadlines, with no command answered in between, that mean the
    /// broker has stopped answering this session rather than that one read was slow.
    ///
    /// Three, because each deadline is 3 s (do_get_value / do_set / vd_get_data), so
    /// the stall is declared ~9 s in. The number that mattered is the one it replaces:
    /// a whole-device readback is ~800 parameters, and with every one of them running
    /// out its own deadline the app sat on "Connecting for live sync…" for ~40 minutes
    /// before the read finished and its error count refused the session. Measured, on
    /// a broker left holding an abandoned session (see the page-load teardown in
    /// lib.rs): the app sent a GET every 3 s and received zero bytes back.
    ///
    /// A healthy local broker answers in milliseconds, so three deadlines in a row is
    /// already far outside normal — and one answered command anywhere in the run puts
    /// the count back to zero, so a single slow parameter cannot trip it.
    pub(super) const BROKER_STALL_LIMIT: u32 = 3;

    /// Stable code the stall latches. Distinct from device-lost: the unit may well be
    /// attached and fine — it is the broker that has stopped talking to us.
    pub(super) const BROKER_UNRESPONSIVE: &str = "broker-unresponsive";

    /// What the worker knows about the session's health, and the one funnel every
    /// parameter command passes through. Held as one value rather than as a pair of
    /// `&mut` locals threaded through each call site, so a third latch is a change
    /// here instead of a change at all seven of them.
    pub(super) struct Health {
        lost: Option<String>,
        stalled: u32,
        /// The session ledger. A deadline is recorded HERE rather than at the call
        /// sites because this is already the one place that classifies one, so the
        /// count and the latch can never come to disagree about what happened.
        counters: Arc<LinkCounters>,
    }

    impl Health {
        pub(super) fn new(counters: Arc<LinkCounters>) -> Self {
            Health {
                lost: None,
                stalled: 0,
                counters,
            }
        }

        /// Fail a command outright once the session is known dead, latching the reason
        /// the first time one surfaces it. The device-lost push arrives exactly once,
        /// so without the latch only the command that consumed it could ever notice —
        /// every later one would keep talking to a broker that ACKs writes with no unit
        /// attached and answers reads from its cache.
        ///
        /// The second latch is the stall: a broker that answers nothing would otherwise
        /// cost every remaining command its full deadline, and the caller only learns the
        /// operation failed once the last of them has run out.
        pub(super) fn guard<T>(
            &mut self,
            call: impl FnOnce() -> Result<T, String>,
        ) -> Result<T, String> {
            if let Some(reason) = &self.lost {
                return Err(reason.clone());
            }
            let r = call();
            match &r {
                Err(e) if e.starts_with(DEVICE_LOST_PREFIX) => self.lost = Some(e.clone()),
                Err(e) if e.starts_with(BROKER_TIMEOUT_PREFIX) => {
                    self.stalled += 1;
                    self.counters.note_deadline(self.stalled);
                    if self.stalled >= BROKER_STALL_LIMIT {
                        eprintln!(
                            "vd: {} consecutive broker deadlines; treating the broker as unresponsive",
                            self.stalled
                        );
                        self.lost = Some(BROKER_UNRESPONSIVE.to_string());
                    }
                }
                // Anything else means the broker is talking to us, whatever it said.
                _ => {
                    self.stalled = 0;
                    self.counters.clear_stall();
                }
            }
            r
        }
    }

    // Bound a single pump's drain. The broker streams meters at ~250/s, so reads
    // rarely block; without this the loop would run a full 512-frame drain (~2 s)
    // before returning, monopolizing the worker for that long — which both delays
    // the meter batch and stalls live writes (Set/Get wait behind the drain). 30 ms
    // keeps the batch latency and (under a live feed) the command latency low while
    // still draining many frames per send (so the IPC boundary stays ~30×/s). The
    // budget is only checked after each read, so when the feed falls quiet a pending
    // command can still wait out the final read's ~200 ms socket timeout before the
    // worker yields — acceptable, since the quiet case is not the one that mattered.
    const PUMP_BUDGET: Duration = Duration::from_millis(30);

    /// Drain buffered frames for up to PUMP_BUDGET, absorbing meter and parameter
    /// notifications and forwarding them in one batched channel send each (the
    /// boundary is crossed per pump, not once per ~250/s reading). Frames other than
    /// the subscribed notifies are discarded. Returns Err if the connection dropped,
    /// or if a device-lost synchronize push arrived, so the worker can stop.
    fn pump(ws: &mut Ws, subs: &mut Subs) -> Result<(), String> {
        let start = Instant::now();
        // 512 is a non-binding hard ceiling; PUMP_BUDGET (or a drained socket)
        // normally ends the loop first, so it only caps a pathological burst.
        for _ in 0..512 {
            match ws.read() {
                Ok(Message::Text(t)) => {
                    // Parse the frame once and share it: synchronize_lost and absorb
                    // read the same envelope, and this drains the ~250/s meter
                    // stream (avoid re-parsing per consumer).
                    let Ok(msg) = serde_json::from_str::<Value>(&t) else {
                        continue;
                    };
                    if let Some(err) = synchronize_lost(&msg) {
                        return Err(err);
                    }
                    subs.absorb(&msg);
                }
                Ok(Message::Close(_)) => return Err("broker-closed".into()),
                Ok(_) => {} // ping/pong/binary — discard, keep going
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    break; // socket drained — fall through to flush the batch
                }
                Err(_) => return Err("broker-closed".into()),
            }
            // Yield the worker once the budget is spent so a pending command (and the
            // accumulated batch below) is serviced without waiting out the stream.
            if start.elapsed() >= PUMP_BUDGET {
                break;
            }
        }
        subs.flush();
        Ok(())
    }

    #[cfg(test)]
    mod guard_tests {
        // The two latches, driven directly: guard is the one funnel every parameter
        // command passes through, and both of its latches decide how long a caller
        // waits for an answer it is never going to get. Asserted through what a caller
        // sees — a latched session refuses a command that would otherwise have run —
        // rather than by reading the struct's own fields.
        use super::super::LinkCounters;
        use super::{Health, BROKER_STALL_LIMIT, BROKER_TIMEOUT_PREFIX, BROKER_UNRESPONSIVE};

        fn timeout() -> Result<i64, String> {
            Err("broker-timeout: value at 139:0:0".to_string())
        }

        /// Did this call reach `call()` at all, or did the latch refuse it first?
        fn ran(health: &mut Health) -> bool {
            health.guard(|| Ok(7)) == Ok(7)
        }

        #[test]
        fn a_run_of_deadlines_latches_the_broker_as_unresponsive() {
            let mut health = Health::new(std::sync::Arc::new(LinkCounters::default()));
            // Every one of them still reports on its own merits: the latch decides what
            // happens NEXT, so a run that stops one short costs nothing but its deadlines.
            for _ in 0..BROKER_STALL_LIMIT {
                let e = health.guard(timeout).unwrap_err();
                assert!(
                    e.starts_with(BROKER_TIMEOUT_PREFIX),
                    "reported as its own timeout: {e}"
                );
            }
            // Past the limit every later command fails on the latch instead of running out
            // its own deadline — the ~800-parameter readback this exists for.
            assert_eq!(health.guard(|| Ok(7)).unwrap_err(), BROKER_UNRESPONSIVE);
        }

        #[test]
        fn one_answered_command_clears_the_run() {
            let mut health = Health::new(std::sync::Arc::new(LinkCounters::default()));
            for _ in 0..BROKER_STALL_LIMIT - 1 {
                let _ = health.guard(timeout);
            }
            assert!(ran(&mut health), "not latched one short of the limit");
            // The answer put the run back to zero, so the same number of deadlines again
            // still does not reach it.
            for _ in 0..BROKER_STALL_LIMIT - 1 {
                let _ = health.guard(timeout);
            }
            assert!(ran(&mut health), "the earlier deadlines no longer count");
        }

        #[test]
        fn a_refusal_is_the_broker_talking_to_us() {
            let mut health = Health::new(std::sync::Arc::new(LinkCounters::default()));
            for _ in 0..BROKER_STALL_LIMIT * 2 {
                let _ = health.guard(|| {
                    Err::<i64, String>("broker-rejected: 140:0:0 (response_code 500)".to_string())
                });
            }
            // A device that refuses every write is not a broker that has stopped
            // answering, and stopping the session on it would take the failure away
            // from the caller that can report which write was refused.
            assert!(ran(&mut health));
        }
    }

    #[cfg(test)]
    mod subs_tests {
        // Pure data-path tests for Subs (no broker, no websocket): absorb must
        // batch subscribed notifies (and leave command replies alone), and the
        // batch must flush on the pump cadence.
        use super::{Subs, PUMP_BUDGET};
        use serde_json::{json, Value};
        use std::sync::{Arc, Mutex};
        use std::time::Instant;
        use tauri::ipc::{Channel, InvokeResponseBody};

        // A subscription whose registered sets hold exactly the addresses a test
        // drives, mirroring what MetersSubscribe / ParamsSubscribe record: absorb
        // forwards a notify only for an address this session registered.
        fn subs_with(meters: &[(u32, i64)], params: &[(u32, i64, i64)]) -> Subs {
            let mut subs = Subs::new();
            subs.meter_addrs = meters.iter().copied().collect();
            subs.param_addrs = params.iter().copied().collect();
            subs
        }

        // A broker notify frame as the read loops see it (already-parsed JSON).
        fn notify(uri: String, value: i64) -> Value {
            json!({
                "jsonrpc": "1.0",
                "params": { "vdp": {
                    "method": "notify",
                    "uri": uri,
                    "data": { "current_value": value }
                }}
            })
        }

        // A capture channel: each flushed batch lands as one JSON payload.
        fn capture<T>() -> (Channel<T>, Arc<Mutex<Vec<Value>>>) {
            let seen: Arc<Mutex<Vec<Value>>> = Arc::new(Mutex::new(Vec::new()));
            let sink = seen.clone();
            let ch = Channel::new(move |body| {
                if let InvokeResponseBody::Json(s) = body {
                    sink.lock().unwrap().push(serde_json::from_str(&s).unwrap());
                }
                Ok(())
            });
            (ch, seen)
        }

        #[test]
        fn absorb_batches_subscribed_notifies_until_flush() {
            let mut subs = subs_with(&[(115, 0), (115, 1)], &[]);
            let (meter_ch, meters_seen) = capture();
            subs.meter_ch = Some(meter_ch);

            // Two meter readings are consumed; a param notify has no subscriber,
            // so it falls through to the caller's own frame matching. A fresh
            // last_flush keeps absorb's own cadence flush out of this test.
            subs.last_flush = Instant::now();
            assert!(subs.absorb(&notify("/vd/meters/115:0".into(), -183)));
            assert!(subs.absorb(&notify("/vd/meters/115:1?x=y".into(), 32767)));
            assert!(!subs.absorb(&notify("/vd/parameters/142:0:0".into(), 1)));
            assert!(
                meters_seen.lock().unwrap().is_empty(),
                "nothing sent before flush"
            );

            subs.flush();
            let batches = meters_seen.lock().unwrap();
            assert_eq!(batches.len(), 1, "one channel send per flush");
            assert_eq!(
                batches[0],
                json!([
                    { "meter_id": 115, "x": 0, "value": -183 },
                    { "meter_id": 115, "x": 1, "value": 32767 }
                ])
            );
            drop(batches);

            // The buffer was emptied: a second flush sends nothing.
            subs.flush();
            assert_eq!(meters_seen.lock().unwrap().len(), 1);
        }

        #[test]
        fn absorb_leaves_command_replies_for_the_await_loops() {
            // The address is registered, so only the frame's method keeps the reply
            // out of the batch — not the registered-set filter.
            let mut subs = subs_with(&[], &[(142, 0, 0)]);
            let (meter_ch, _) = capture();
            let (param_ch, _) = capture();
            subs.meter_ch = Some(meter_ch);
            subs.param_ch = Some(param_ch);

            // A get / set reply (vdp.method is not "notify") must never be
            // consumed, or the awaiting command would time out.
            let reply = json!({
                "jsonrpc": "1.0",
                "method": "requestVD",
                "params": { "vdp": {
                    "method": "get",
                    "uri": "/vd/parameters/142:0:0",
                    "data": { "current_value": 1 }
                }}
            });
            assert!(!subs.absorb(&reply));
        }

        #[test]
        fn absorb_flushes_on_the_pump_cadence() {
            let mut subs = subs_with(&[(100, 2), (100, 3)], &[]);
            let (meter_ch, meters_seen) = capture();
            subs.meter_ch = Some(meter_ch);

            // Within the cadence window a reading only accumulates…
            subs.last_flush = Instant::now();
            assert!(subs.absorb(&notify("/vd/meters/100:2".into(), -50)));
            assert!(meters_seen.lock().unwrap().is_empty());

            // …and once the window has elapsed, the next absorb sends the batch.
            subs.last_flush = Instant::now() - PUMP_BUDGET;
            assert!(subs.absorb(&notify("/vd/meters/100:3".into(), -40)));
            let batches = meters_seen.lock().unwrap();
            assert_eq!(batches.len(), 1);
            assert_eq!(
                batches[0],
                json!([
                    { "meter_id": 100, "x": 2, "value": -50 },
                    { "meter_id": 100, "x": 3, "value": -40 }
                ])
            );
        }

        #[test]
        fn absorb_forwards_the_bulk_change_notify_as_the_sentinel() {
            let mut subs = subs_with(&[], &[(142, 0, 0)]);
            let (param_ch, params_seen) = capture();
            subs.param_ch = Some(param_ch);

            // The broker's scene-recall push (capture-confirmed shape): a
            // namespace-level notify with no address and no data. It must absorb
            // as the unmappable sentinel — without depending on a value — while
            // an addressed notify keeps parsing normally alongside it.
            let bulk = json!({
                "jsonrpc": "1.0",
                "method": "onNotifyVD",
                "params": { "vdp": { "method": "notify", "uri": "/vd/parameters" } }
            });
            subs.last_flush = Instant::now();
            assert!(subs.absorb(&bulk));
            assert!(subs.absorb(&notify("/vd/parameters/142:0:0".into(), 1)));

            subs.flush();
            let batches = params_seen.lock().unwrap();
            assert_eq!(batches.len(), 1);
            assert_eq!(
                batches[0],
                json!([
                    { "param_id": 0, "x": -1, "y": -1, "value": 0 },
                    { "param_id": 142, "x": 0, "y": 0, "value": 1 }
                ])
            );
        }

        #[test]
        fn absorb_drops_notifies_for_addresses_this_session_did_not_register() {
            let mut subs = subs_with(&[(115, 0)], &[(142, 0, 0)]);
            let (meter_ch, meters_seen) = capture();
            let (param_ch, params_seen) = capture();
            subs.meter_ch = Some(meter_ch);
            subs.param_ch = Some(param_ch);

            // The broker broadcasts every notify to every connected client, so the
            // unit's own clock (a push every 10 s) and another client's meter
            // registrations land here too. Both are consumed — they are notify
            // frames — but neither reaches the frontend: an unregistered parameter
            // resolves to no node in the follow layer, which escalates it to a full
            // device readback, so the clock alone would fire one every 10 s for the
            // whole session.
            subs.last_flush = Instant::now();
            assert!(subs.absorb(&notify("/vd/parameters/142:0:1".into(), 35)));
            assert!(subs.absorb(&notify("/vd/meters/115:1".into(), -274)));
            assert!(subs.absorb(&notify("/vd/parameters/142:0:0".into(), 1)));
            assert!(subs.absorb(&notify("/vd/meters/115:0".into(), -183)));

            subs.flush();
            assert_eq!(
                *params_seen.lock().unwrap(),
                vec![json!([{ "param_id": 142, "x": 0, "y": 0, "value": 1 }])]
            );
            assert_eq!(
                *meters_seen.lock().unwrap(),
                vec![json!([{ "meter_id": 115, "x": 0, "value": -183 }])]
            );
        }
    }
}

#[cfg(test)]
mod tests {
    // Connection-lifecycle race: a fire-and-forget disconnect of a torn-down live
    // session must not close a newer connection that a later connect installed in
    // the meantime. These drive VdState's install/sender/disconnect directly with
    // dummy worker channels, so they reproduce the exact interleaving deterministi-
    // cally on any host (no broker, no websocket, no threads).
    use super::{disconnect, sender, Cmd, LinkCounters, VdState};
    use std::sync::mpsc;
    use std::sync::Arc;

    // The reported field bug: live connects, its teardown's disconnect is delayed,
    // a write connects (new generation), then the stale disconnect finally lands.
    // It must be a no-op and leave the write's channel installed and reachable.
    #[test]
    fn stale_disconnect_spares_newer_connection() {
        let state = VdState::default();

        // Live session connects.
        let (live_tx, _live_rx) = mpsc::channel::<Cmd>();
        let live_epoch = state.install(live_tx, Arc::new(LinkCounters::default()));

        // A later write connects before the live teardown's disconnect runs.
        let (write_tx, write_rx) = mpsc::channel::<Cmd>();
        let write_epoch = state.install(write_tx, Arc::new(LinkCounters::default()));
        assert_ne!(
            live_epoch, write_epoch,
            "each install gets a fresh generation"
        );

        // The delayed stale disconnect now lands — targets the old generation.
        disconnect(&state, live_epoch);

        // The write's connection survives: sender() resolves (not "not connected")
        // and the cloned channel still reaches its worker.
        let tx = sender(&state).expect("write connection must stay installed");
        tx.send(Cmd::Shutdown { done: None })
            .expect("worker channel must still be open");
        assert!(matches!(write_rx.recv(), Ok(Cmd::Shutdown { .. })));
    }

    // A disconnect that matches the current generation closes it.
    #[test]
    fn matching_disconnect_closes() {
        let state = VdState::default();
        let (tx, _rx) = mpsc::channel::<Cmd>();
        let epoch = state.install(tx, Arc::new(LinkCounters::default()));

        disconnect(&state, epoch);

        assert!(
            sender(&state).is_err(),
            "after its own disconnect: not connected"
        );
    }

    // Installing a new connection shuts the prior worker down (unchanged behavior).
    #[test]
    fn install_shuts_prior_worker() {
        let state = VdState::default();
        let (tx1, rx1) = mpsc::channel::<Cmd>();
        state.install(tx1, Arc::new(LinkCounters::default()));
        let (tx2, _rx2) = mpsc::channel::<Cmd>();
        state.install(tx2, Arc::new(LinkCounters::default()));
        assert!(
            matches!(rx1.recv(), Ok(Cmd::Shutdown { .. })),
            "prior worker told to stop"
        );
    }
}
