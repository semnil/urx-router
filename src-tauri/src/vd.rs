// Live hardware control transport: a client for the Device Center broker's "vd"
// protocol. Device Center must be running with a URX connected; it bridges the
// broker to the unit's CDC serial. See reference/work/vd/vd-protocol.md.
//
// The link runs over the per-session port Device Center advertises on :51770 —
// newline-delimited JSON over a plain socket. A second endpoint (the casket
// WebSocket on :51780) speaks the same messages in a JSON-RPC envelope and is
// reachable with `--experimental --casket`; `Link` below carries both and its
// doc is where the comparison lives.
//
// A dedicated worker thread owns the socket so the broker's continuous meter
// notifications are drained without blocking command latency, and — on the
// casket endpoint, which names the device on every message — so the device GUID
// stays inside Rust; the frontend addresses parameters by (param_id, x, y) and
// never sees the instance secret. Desktop-only: tungstenite (the casket arm) and
// the MIDI bridge (midir) are desktop-only crates, so mobile targets do not
// build the hardware control surface at all.

use std::collections::HashMap;
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
// broker-timeout, broker-unresponsive, broker-rejected, broker-bad-response,
// broker-io, broker-no-vdpport.
//
// This list is the Rust half of a two-sided inventory — src/i18n/index.ts asks to
// keep it in step, and error-text.test.ts asserts the TypeScript half exhaustive
// in both directions. Nothing checks THIS half, so a code added without a line
// here leaves the next reader copying an inventory that is already wrong.

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
    /// The webview that opened this session. A page load is a teardown for the page
    /// being replaced and for nothing else, and the app has more than one page — so
    /// the hold has to say whose it is rather than the teardown assuming.
    owner: Option<String>,
}

/// Managed Tauri state: the channel to the live worker, if connected, tagged with
/// its generation so disconnect can target a specific connection.
#[derive(Default)]
pub struct VdState {
    conn: Mutex<Conn>,
    /// A per-webview page generation, bumped by every page load. Ownership is recorded
    /// by webview LABEL, and a reloaded page carries the same label as the one it
    /// replaced — so the teardown a page load runs cannot cancel a `vd_connect` that is
    /// still in flight for the DEAD page. `open()` takes up to ~9 s (discovery, sync,
    /// device), and inside that window a reload (HMR, crash recovery, --reset-storage)
    /// ran a teardown that found nothing installed and then let the connect install
    /// under the NEW page's label: an open vdp socket the page holds no epoch for,
    /// `vd_link_stats` reporting a live ledger on a page that never connected, and
    /// `sender()` resolving for a session the page believes does not exist.
    pages: Mutex<HashMap<String, u64>>,
}

impl VdState {
    /// The current generation for `label` — taken before a connect, and compared after.
    pub fn page_gen(&self, label: &str) -> u64 {
        *self
            .pages
            .lock()
            .unwrap()
            .entry(label.to_string())
            .or_insert(0)
    }

    /// A page load: everything in flight for that label belongs to the page that is
    /// gone.
    ///
    /// Takes the CONNECTION lock first and holds it across the bump. That is the whole
    /// atomicity argument: `install_for_page` acquires the same two locks in the same
    /// order, so a page load cannot land between its check and its install.
    pub fn note_page_load(&self, label: &str) {
        let _conn = self.conn.lock().unwrap();
        *self
            .pages
            .lock()
            .unwrap()
            .entry(label.to_string())
            .or_insert(0) += 1;
    }
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
    /// Install a freshly opened session, shutting down any prior worker, and return the
    /// generation assigned to it — unless the page that asked for it has since reloaded,
    /// in which case the worker is shut down instead of being handed to its replacement
    /// and the caller is told so. The epoch goes back to `disconnect`, so a delayed
    /// teardown of an earlier session cannot close this one.
    ///
    /// The only way in. It had an unguarded twin for a while — the same body without the
    /// generation check, kept because the tests predated the check and still called it —
    /// which meant every case about what an install DOES was driving a function the app
    /// no longer used, and the two bodies were free to drift with nothing comparing them.
    pub fn install_for_page(
        &self,
        tx: Sender<Cmd>,
        counters: Arc<LinkCounters>,
        owner: &str,
        gen: u64,
    ) -> Option<u64> {
        // Both under the connection lock, in that order (see note_page_load): asking and
        // installing have to be one step. Split, a page load landing between them ran a
        // teardown that found nothing installed yet, and this then installed the dead
        // page's session behind it — the exact orphan the generation exists to prevent,
        // reintroduced in the window the check was meant to close.
        let mut c = self.conn.lock().unwrap();
        let current = *self
            .pages
            .lock()
            .unwrap()
            .entry(owner.to_string())
            .or_insert(0);
        if current != gen {
            let mut dead = Conn {
                tx: Some(tx),
                ..Conn::default()
            };
            stop(&mut dead, None);
            return None;
        }
        stop(&mut c, None);
        c.tx = Some(tx);
        c.counters = counters;
        c.owner = Some(owner.to_string());
        c.epoch += 1;
        Some(c.epoch)
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

/// Close the connection this webview opened, whatever generation it belongs to. The
/// epoch-matched `disconnect` above is for a session ending; this is for the page that
/// owned it going away, where no epoch survives to name it — see the page-load teardown
/// in lib.rs. A no-op when nothing is installed, and when what is installed belongs to
/// another page: this app has a second webview (midiwin.rs) whose own load used to end
/// the main window's session, because the teardown asked nothing about ownership.
pub fn shutdown_owned_by(state: &VdState, label: &str) {
    let mut c = state.conn.lock().unwrap();
    if c.owner.as_deref() == Some(label) {
        stop(&mut c, None);
    }
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
    c.owner = None;
    let Some(tx) = c.tx.take() else { return false };
    tx.send(Cmd::Shutdown { done }).is_ok()
}

#[cfg(desktop)]
mod imp {
    use super::{
        Cmd, DeviceSummary, LinkCounters, LinkEvent, MeterUpdate, ParamUpdate, BULK_CHANGE,
    };
    use std::collections::HashSet;
    use std::io::{Read, Write};
    use std::net::TcpStream;
    use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
    use std::sync::Arc;
    use std::time::{Duration, Instant};

    use serde_json::{json, Value};
    use tauri::ipc::Channel;
    use tungstenite::stream::MaybeTlsStream;
    use tungstenite::{connect, Message, WebSocket};

    const CASKET_URL: &str = "ws://127.0.0.1:51780/casket";
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
        // Open the endpoint the launch flags call for, and learn the port for this
        // Device Center session while doing it. Both are per-connection, so a
        // reconnect repeats the lookup rather than reusing a number that a Device
        // Center restart has already invalidated. Failures carry a stable code the
        // frontend localizes; the raw cause stays in the log.
        let (mut link, mut summary) = match Link::open() {
            Ok(v) => v,
            Err(e) => {
                eprintln!("vd: could not open the device link: {e}");
                let _ = ready.send(Err(e));
                return;
            }
        };

        summary.firmware = match handshake(&mut link) {
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
            // (READ_TIMEOUT, 50 ms) supplies the backpressure when the feed is quiet.
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
                    let _ = reply.send(
                        health.guard(|| do_set(&mut link, &mut subs, param_id, x, y, json!(value))),
                    );
                }
                Ok(Cmd::Get {
                    param_id,
                    x,
                    y,
                    reply,
                }) => {
                    LinkCounters::bump(&counters.gets);
                    let _ =
                        reply.send(health.guard(|| do_get(&mut link, &mut subs, param_id, x, y)));
                }
                Ok(Cmd::SetStr {
                    param_id,
                    x,
                    y,
                    value,
                    reply,
                }) => {
                    LinkCounters::bump(&counters.sets);
                    let _ = reply.send(
                        health.guard(|| do_set(&mut link, &mut subs, param_id, x, y, json!(value))),
                    );
                }
                Ok(Cmd::GetStr {
                    param_id,
                    x,
                    y,
                    reply,
                }) => {
                    LinkCounters::bump(&counters.gets);
                    let _ = reply
                        .send(health.guard(|| do_get_str(&mut link, &mut subs, param_id, x, y)));
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
                    unregister_meters(&mut link, &mut subs, &counters);
                    let mut first = Ok(());
                    for &(id, x) in &addrs {
                        LinkCounters::bump(&counters.regist_frames);
                        let r = health.guard(|| reg_meter(&mut link, id, x, "regist"));
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
                    unregister_meters(&mut link, &mut subs, &counters);
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
                    unregister_params(&mut link, &mut subs, &counters);
                    let mut first = Ok(());
                    for &(id, x, y) in &addrs {
                        LinkCounters::bump(&counters.regist_frames);
                        let r = health.guard(|| reg_param(&mut link, id, x, y, "regist"));
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
                    unregister_params(&mut link, &mut subs, &counters);
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
                    if let Err(e) = pump(&mut link, &mut subs) {
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
        unregister_all(&mut link, &mut subs, &counters);
        // `close` only QUEUES the Close frame; the handshake finishes on the reads that
        // follow, and dropping the socket before then hands the broker an abrupt
        // disconnect instead of a close. A plain socket has no such handshake, so the
        // drain below is a no-op there and the shutdown is what ends it.
        link.begin_close();
        for _ in 0..CLOSE_FRAMES {
            // `Ok(None)` is the socket's own read timeout (READ_TIMEOUT, 50 ms): the
            // peer has nothing queued, so its Close is not coming and there is nothing
            // left to drain. Counting those against the budget would spend 64 × that on
            // a quiet broker — which is exactly the state a session that just
            // unregistered everything is in, and it is the operator's Quit being held.
            //
            // This reader's patience is READ_TIMEOUT's, so it moved with it (it was
            // 200 ms). Left inherited rather than pinned like drain_late_reply's,
            // because the two want opposite things: that one must not give up on a
            // straggler too early, this one must not hold Quit, and shorter is the
            // right direction for it. Said out loud so the next change to READ_TIMEOUT
            // knows it is moving this too.
            match link.read_frame() {
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
    fn unregister_meters(link: &mut Link, subs: &mut Subs, counters: &LinkCounters) {
        for &(id, x) in &subs.meter_addrs {
            LinkCounters::bump(&counters.unregist_frames);
            let _ = reg_meter(link, id, x, "unregist");
        }
        subs.meter_addrs.clear();
    }

    /// The parameter half of the above.
    fn unregister_params(link: &mut Link, subs: &mut Subs, counters: &LinkCounters) {
        for &(id, x, y) in &subs.param_addrs {
            LinkCounters::bump(&counters.unregist_frames);
            let _ = reg_param(link, id, x, y, "unregist");
        }
        subs.param_addrs.clear();
    }

    /// Everything this session registered, on the way out. The registration reply is
    /// never read (see Cmd::ParamsSubscribe), so this cannot confirm the broker took
    /// them — it can only make sure they were asked for, which is the whole of what
    /// this side controls.
    fn unregister_all(link: &mut Link, subs: &mut Subs, counters: &LinkCounters) {
        unregister_meters(link, subs, counters);
        unregister_params(link, subs, counters);
    }

    fn send_json(ws: &mut Ws, v: Value) -> Result<(), String> {
        ws.send(Message::Text(v.to_string().into()))
            .map_err(|e| format!("broker-io: {e}"))
    }

    /// Which of Device Center's endpoints this session talks over.
    ///
    /// Both carry the same `vdp` messages and the same `/vd/*` uris. They differ
    /// in framing, and in one property that matters more than the framing:
    ///
    /// - `Vdp` — a plain TCP socket carrying newline-delimited JSON with the `vdp`
    ///   message bare. The port is **not fixed**: Device Center advertises one per
    ///   session on `:51770`, so it is looked up at connect and again on every
    ///   reconnect. **Serves concurrent clients**, so this app no longer competes
    ///   with anything else on the machine for the link.
    /// - `Casket` — `ws://127.0.0.1:51780/casket`, each message wrapped in a
    ///   JSON-RPC `requestVD` envelope naming the device by GUID. **Serves one
    ///   client**: a second connection silences the first, with no error on either
    ///   side, so any other tool touching the broker takes this app's link away
    ///   silently. That is the reason for the move.
    ///
    /// Normal launches use `Vdp`. `Casket` is reachable only with
    /// `--experimental --casket`, and deliberately *not* as an automatic fallback:
    /// falling back on discovery failure would hide a `Vdp` regression behind a
    /// working casket path, and nobody would ever learn the primary route broke.
    /// The flag exists so the two can be compared on purpose — without it the
    /// casket path would be code that only ever runs when something is already
    /// wrong, and that nothing checks in the meantime.
    enum Link {
        Casket { ws: Ws, dev_uid: String },
        Vdp { sock: TcpStream, reader: LineReader },
    }

    /// Arm a plain socket the way every socket here wants it: a short read timeout
    /// so a quiet link never becomes a hang, and Nagle off.
    ///
    /// Both are load-bearing. Without the timeout, every read below blocks with no
    /// deadline of its own and a quiet moment becomes a hang the user can only
    /// escape by quitting. Nagle matters because this link is a strict ping-pong —
    /// write one small line, block for the reply, 7074 times in a full sweep — which
    /// is the shape Nagle punishes with a fixed 40 ms stall rather than a
    /// proportional cost. It is easy to miss because tungstenite sets `TCP_NODELAY`
    /// itself, so the casket endpoint had it for free and a plain `TcpStream` does
    /// not: leaving it off would be a regression against the transport this replaced.
    fn arm_socket(sock: &TcpStream, timeout: Duration) -> Result<(), String> {
        sock.set_read_timeout(Some(timeout))
            .map_err(|e| format!("broker-io: could not set the socket read timeout: {e}"))?;
        sock.set_nodelay(true)
            .map_err(|e| format!("broker-io: could not disable Nagle: {e}"))
    }

    /// The `:51770` lookup that names this session's `vdp` port. Its own short-lived
    /// connection: it speaks a different envelope (`vddp`) and a different uri space
    /// (`/vddp_srv*`) from everything else here.
    fn discover_vdp_port() -> Result<(u16, String), String> {
        let mut sock = TcpStream::connect(("127.0.0.1", VDDP_SRV_PORT))
            .map_err(|e| format!("broker-unreachable: {e}"))?;
        arm_socket(&sock, DISCOVERY_TIMEOUT)?;
        let req = json!({ "vddp": { "method": "get", "uri": "/vddp_srv/devices" } });
        sock.write_all(format!("{req}\n").as_bytes())
            .map_err(|e| format!("broker-io: {e}"))?;

        let mut reader = LineReader::new();
        let deadline = Instant::now() + DISCOVERY_TIMEOUT;
        while Instant::now() < deadline {
            let Some(msg) = reader.read_json(&mut sock)? else {
                continue;
            };
            let Some(data) = msg.get("vddp").and_then(|v| v.get("data")) else {
                continue;
            };
            return vdp_target(data);
        }
        Err("broker-no-vdpport: the device list did not answer".into())
    }

    /// What one `/vddp_srv/devices` answer names: the first device's `vdp` port and
    /// its model. Separated from the socket loop above because every way this can go
    /// wrong is a shape of the broker's JSON, and a live broker answers with the one
    /// shape it is currently written to answer with — the out-of-range port below has
    /// no way to reach the loop at all from a working Device Center.
    fn vdp_target(data: &Value) -> Result<(u16, String), String> {
        // An empty list is Device Center up with no URX — the same state the
        // casket path reports from an empty getDeviceList.
        let Some(dev) = data
            .pointer("/list")
            .and_then(Value::as_array)
            .and_then(|l| l.first())
        else {
            return Err("no-device".into());
        };
        let port = dev
            .get("vdpport")
            .and_then(Value::as_u64)
            .ok_or_else(|| "broker-no-vdpport: the device list carried no port".to_string())?;
        // Checked, not truncated. A broker answer above 65535 (a bug or a schema
        // change) used to cast down silently — 65537 becomes 1 — and the connect
        // then failed naming a port the broker never advertised, which sends the
        // next reader looking in the wrong place entirely.
        let port = u16::try_from(port)
            .map_err(|_| format!("broker-bad-response: vdpport {port} is out of range"))?;
        Ok((port, str_or(dev, "model", "URX")))
    }

    /// How long discovery waits for the device list, and how long its socket blocks
    /// for one read — the same number, so the loop makes one read and then the
    /// deadline ends it rather than spinning.
    const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(3);

    /// A string field, or a placeholder. Both device lists have optional names and
    /// both must fall back to the same word, or the two transports would show
    /// different text for the same unknown unit.
    fn str_or(v: &Value, key: &str, dflt: &str) -> String {
        v.get(key)
            .and_then(Value::as_str)
            .unwrap_or(dflt)
            .to_string()
    }

    /// Newline-delimited JSON off a plain socket.
    ///
    /// It owns both buffers for the life of the connection. `pending` carries the
    /// partial tail between calls, because a chunk boundary is not a message
    /// boundary and a line split across two reads would otherwise be lost; `chunk`
    /// is reused because a fresh `[0u8; 8192]` per read means memsetting 8 KB for
    /// every ~100-byte frame, and this link carries roughly 200 frames a second for
    /// as long as a session is up.
    /// Ceiling on one un-terminated line (see read_json).
    const MAX_PENDING: usize = 1 << 20;

    struct LineReader {
        pending: Vec<u8>,
        chunk: Vec<u8>,
    }

    impl LineReader {
        fn new() -> Self {
            LineReader {
                pending: Vec::new(),
                chunk: vec![0u8; 8192],
            }
        }

        /// One message, or None on read timeout or on a line that is not parseable
        /// JSON — callers treat both as "nothing yet" and loop. Parsed in place out
        /// of `pending`, so a frame is not copied into a `String` on its way to a
        /// parser that would immediately take it apart again.
        ///
        /// Generic over the source rather than taking the `TcpStream` both callers
        /// pass, so the chunk-boundary rejoin and the `MAX_PENDING` refusal can be
        /// driven from a byte source a test owns. Neither of those is reachable
        /// through a socket without a peer that misbehaves on cue.
        fn read_json<R: Read>(&mut self, sock: &mut R) -> Result<Option<Value>, String> {
            loop {
                if let Some(nl) = self.pending.iter().position(|&b| b == b'\n') {
                    let parsed = serde_json::from_slice::<Value>(&self.pending[..nl]).ok();
                    self.pending.drain(..=nl);
                    return Ok(parsed);
                }
                match sock.read(&mut self.chunk) {
                    Ok(0) => return Err("broker-closed".into()),
                    // Disjoint field borrows: reading into `chunk` and appending to
                    // `pending` in one statement is fine, and a temporary between
                    // them would put back the copy this reader exists to avoid.
                    Ok(n) => {
                        self.pending.extend_from_slice(&self.chunk[..n]);
                        // A peer that never sends a newline would otherwise grow this
                        // buffer at socket speed for the life of the session — a silent
                        // memory climb rather than an error anyone can act on. The bound
                        // is far above any real frame (the largest this protocol carries
                        // is a device list of a few KiB), so reaching it means the peer
                        // is not speaking this protocol.
                        if self.pending.len() > MAX_PENDING {
                            return Err(format!(
                                "broker-bad-response: {} bytes with no line break",
                                self.pending.len()
                            ));
                        }
                    }
                    Err(e)
                        if matches!(
                            e.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) =>
                    {
                        return Ok(None)
                    }
                    Err(e) => return Err(format!("broker-io: {e}")),
                }
            }
        }
    }

    /// Device Center's device-list port. Fixed, unlike the `vdp` port it hands out.
    const VDDP_SRV_PORT: u16 = 51770;

    impl Link {
        /// Open the link the launch flags call for, and report what the endpoint says
        /// the unit is. `firmware` is left `None`: the caller completes the handshake
        /// (`/vd/synchronize`, then `/vd/device`) over whichever transport came back
        /// and fills it in, and those two reads are identical on both.
        fn open() -> Result<(Link, DeviceSummary), String> {
            if crate::experimental_enabled() && std::env::args().any(|a| a == "--casket") {
                eprintln!("vd: --casket — using the one-client casket endpoint");
                let (mut ws, _) = connect(CASKET_URL).map_err(|e| {
                    eprintln!("vd: cannot reach Device Center broker: {e}");
                    "broker-unreachable".to_string()
                })?;
                if let MaybeTlsStream::Plain(s) = ws.get_ref() {
                    arm_socket(s, READ_TIMEOUT)?;
                }
                let (dev_uid, device) = casket_device_list(&mut ws)?;
                return Ok((Link::Casket { ws, dev_uid }, device));
            }

            let (port, model) = discover_vdp_port()?;
            let sock = TcpStream::connect(("127.0.0.1", port))
                .map_err(|e| format!("broker-unreachable: vdp port {port}: {e}"))?;
            arm_socket(&sock, READ_TIMEOUT)?;
            Ok((
                Link::Vdp {
                    sock,
                    reader: LineReader::new(),
                },
                DeviceSummary {
                    // The `vddp` device list carries no label, and the two were
                    // identical on every unit measured, so the model stands in for it.
                    label: model.clone(),
                    model,
                    firmware: None,
                },
            ))
        }

        /// Send one `vdp` message, in whatever envelope this transport wants.
        fn send_vdp(&mut self, vdp: Value) -> Result<(), String> {
            match self {
                // The JSON-RPC envelope is casket's, not the protocol's — which is
                // why it is built here rather than at the call sites, and why the
                // other endpoint carries the same message with nothing around it.
                Link::Casket { ws, dev_uid } => send_json(
                    ws,
                    json!({
                        "jsonrpc": "1.0",
                        "method": "requestVD",
                        "params": { "dev_uid": dev_uid, "vdp": vdp }
                    }),
                ),
                Link::Vdp { sock, .. } => {
                    let line = json!({ "vdp": vdp });
                    sock.write_all(format!("{line}\n").as_bytes())
                        .map_err(|e| format!("broker-io: {e}"))
                }
            }
        }

        /// Start the orderly close. On casket that queues a Close frame whose
        /// handshake the caller's drain completes; on a plain socket there is no
        /// handshake to complete, so this shuts the write half and the drain that
        /// follows simply sees the peer's EOF.
        fn begin_close(&mut self) {
            match self {
                Link::Casket { ws, .. } => {
                    let _ = ws.close(None);
                    let _ = ws.flush();
                }
                Link::Vdp { sock, .. } => {
                    let _ = sock.shutdown(std::net::Shutdown::Write);
                }
            }
        }

        /// One inbound message, or None on read timeout or on a frame that is not
        /// parseable JSON — callers treat both as "nothing yet" and loop, which is
        /// what the casket path did before this existed.
        fn read_frame(&mut self) -> Result<Option<Value>, String> {
            match self {
                Link::Casket { ws, .. } => {
                    let Some(text) = read_text(ws)? else {
                        return Ok(None);
                    };
                    Ok(serde_json::from_str::<Value>(&text).ok())
                }
                Link::Vdp { sock, reader } => reader.read_json(sock),
            }
        }
    }

    /// The `vdp` message inside an inbound frame, whichever envelope carried it.
    ///
    /// One accessor rather than the pointer pair spelled out at each parse site.
    /// That spelling has already cost a hardware run: when the transport was added,
    /// three parsers were taught both shapes and `vd_get_data` was not, so every
    /// reply on the new endpoint was skipped for lacking a wrapper it never sends
    /// and the session timed out on `/vd/synchronize`. A fourth site added later
    /// would inherit the same trap, and it fails silently on the DEFAULT transport
    /// while passing on the experimental one.
    ///
    /// `get` rather than `pointer`: `Value::pointer` allocates two Strings per path
    /// token even when nothing needs escaping, and this runs on every frame of a
    /// feed measured at ~200/s. The bare shape is tried first because it is the one
    /// the default endpoint sends.
    fn vdp_of(msg: &Value) -> Option<&Value> {
        msg.get("vdp")
            .or_else(|| msg.get("params").and_then(|p| p.get("vdp")))
    }

    /// Socket read timeout, and with it the longest a queued command waits behind the
    /// pump's blocking read.
    ///
    /// The worker is one thread: while `pump` sits in `read_frame` it is not looking at
    /// the command channel at all, so a `Cmd::Set` enqueued just after that read starts
    /// waits it out. At 200 ms that was measured on a URX44V (2026-08-11) as a **152 ms**
    /// wait for the first live write after a quiet gap — the busy path cannot produce
    /// that, since it is bounded by one `recv_timeout` (5 ms) plus `PUMP_BUDGET` (30 ms).
    /// 50 ms bounds it at roughly a quarter of that; the price is the idle wake rate,
    /// which goes from ~5/s to ~18/s (one cycle is this timeout plus the 5 ms recv).
    ///
    /// It bounds no command's patience: every reply loop carries its own 3 s wall-clock
    /// deadline and treats a read timeout as "keep waiting" (`do_set`, `do_get_value`,
    /// `do_get_str`). `drain_late_reply` is the one reader that used this as its own
    /// give-up point, and it now carries an explicit floor instead — see there.
    const READ_TIMEOUT: Duration = Duration::from_millis(50);

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

    /// Casket's device list: the GUID every message on that transport has to name,
    /// plus what the broker calls the unit. Only the casket path needs this — the
    /// `vdp` port is already scoped to one device, so it carries no GUID at all.
    fn casket_device_list(ws: &mut Ws) -> Result<(String, DeviceSummary), String> {
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
            if dev_uid.is_empty() {
                return Err("broker-bad-response: device list entry had no identifier".into());
            }
            return Ok((
                dev_uid,
                DeviceSummary {
                    model: str_or(dev, "model", "URX"),
                    label: str_or(dev, "label", "URX"),
                    firmware: None,
                },
            ));
        }
        // No device list within the deadline. The broker answered the WebSocket
        // handshake but never listed a unit, so treat it as no URX attached
        // (same remedy for the user); the empty-list path above is the other shape.
        eprintln!("vd: timed out waiting for the device list");
        Err("no-device".into())
    }

    /// Confirm a unit is really there, and read what the frontend needs to know
    /// about it. Identical on both transports: the endpoint only decided how the
    /// two reads below are framed, not what they say.
    fn handshake(link: &mut Link) -> Result<Option<String>, String> {
        // A device entry persists after the unit is unplugged, so confirm the live
        // link before claiming a device: "online" means a URX is actually attached.
        // Anything else (e.g. "lost") is Device Center up with no unit → the same
        // no-device state as an empty list.
        let status = sync_status(link)?;
        if status != "online" {
            eprintln!("vd: URX listed but sync_status = {status}; treating as no-device");
            return Err("no-device".into());
        }
        // Read the System firmware version so the frontend can warn when the
        // attached unit's firmware differs from the validated one. A failed read
        // yields None, which the frontend treats as a reason to stop rather than
        // as a reason to skip the check.
        Ok(system_firmware(link))
    }

    /// Send a GET for `uri` and return the matched response's `vdp.data`.
    /// Shared by the handshake-time reads (synchronize, device); drains non-matching
    /// frames until the address echoes back or the 3s deadline lapses. The parameter
    /// read path (do_get_value) keeps its own loop — it also screens for a mid-read
    /// device-lost push, which these handshake reads run before a session exists.
    fn vd_get_data(link: &mut Link, uri: &str) -> Result<Value, String> {
        let base = uri.split('?').next().unwrap_or(uri).to_string();
        // Sent and awaited under one spelling, as in do_get_value.
        let verb = "get";
        link.send_vdp(json!({ "method": verb, "uri": uri }))?;
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let Some(msg) = link.read_frame()? else {
                continue;
            };
            // This loop is separate from reply_for's: it runs before a session
            // exists, so there is nothing to absorb into and it does not screen for
            // a device-lost push. The verb is matched for the same reason reply_for
            // matches it — a notify echoes the address it is about, and taking one
            // as the answer here would decide the handshake off another client's
            // traffic (a `/vd/synchronize` push is the shape that reaches this one).
            let Some(vdp) = vdp_of(&msg) else { continue };
            if vdp.get("method").and_then(Value::as_str) != Some(verb) {
                continue;
            }
            let ruri = vdp.get("uri").and_then(Value::as_str).unwrap_or("");
            if ruri.split('?').next().unwrap_or(ruri) != base {
                continue;
            }
            return vdp
                .get("data")
                .cloned()
                .ok_or_else(|| format!("broker-bad-response: no data for {base}"));
        }
        Err(format!("broker-timeout: {base}"))
    }

    /// Query the unit's live link state via /vd/synchronize: "online" means a URX
    /// is actually attached. Device Center keeps the getDeviceList entry after the
    /// unit is unplugged but reports a non-"online" status here, so this is what
    /// separates a present device from a stale list entry.
    fn sync_status(link: &mut Link) -> Result<String, String> {
        vd_get_data(link, "/vd/synchronize")?
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
    fn system_firmware(link: &mut Link) -> Option<String> {
        let data = vd_get_data(link, "/vd/device").ok()?;
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
        link: &mut Link,
        subs: &mut Subs,
        param_id: u32,
        x: i64,
        y: i64,
        value: Value,
    ) -> Result<(), String> {
        let uri = format!("/vd/parameters/{param_id}:{x}:{y}?operation=value");
        let base = format!("/vd/parameters/{param_id}:{x}:{y}");
        // One spelling for what is sent and for what will be accepted as its reply,
        // so the two cannot drift into a command that can never be answered.
        let verb = "post";
        link.send_vdp(json!({ "method": verb, "uri": uri, "data": { "current_value": value } }))?;
        // Await the matching response, skipping unrelated notifications.
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let Some(msg) = link.read_frame()? else {
                continue;
            };
            // A device-lost push can land mid-write (the broker still ACKs the
            // write itself); fail the command so the session tears down.
            if let Some(err) = synchronize_lost(&msg) {
                return Err(err);
            }
            // Subscribed notifies landing mid-command are batched, not discarded
            // (see Subs).
            let Some(vdp) = reply_for(subs, &msg, &base, verb) else {
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
        drain_late_reply(link, subs, &base, verb);
        Err(format!("broker-timeout: write at {param_id}:{x}:{y}"))
    }

    /// A command that timed out may still have its reply in flight. The vd protocol
    /// carries no request id, so a late reply for an address is indistinguishable
    /// from the reply to the *next* command on that same address — it would satisfy
    /// it with a stale value. Drain what is already buffered (bounded, and only
    /// after a timeout, so the healthy path pays nothing) and drop any reply for the
    /// address that just gave up. Notifies stay batched via subs, as everywhere else.
    fn drain_late_reply(link: &mut Link, subs: &mut Subs, base: &str, method: &str) {
        // TWO bounds, because they answer different questions and neither covers the
        // other. FRAMES caps the busy case: under Live sync the broker streams meters
        // continuously, so a wall clock alone would run to the end absorbing notifies —
        // the straggler is the next reply frame, not a quarter-second of meters away.
        // The wall-clock FLOOR covers the quiet case: with nothing arriving, every
        // `read_frame` returns None at the socket timeout and the frame cap is never
        // approached, so the loop's real give-up point is that timeout. It used to be
        // 200 ms and is now 50 ms (READ_TIMEOUT, shortened so a live write does not
        // queue behind it), which would have quartered how long a straggler has to show
        // up — silently, since nothing here tests that. The floor keeps this reader's
        // patience where it was and stops it moving with a constant it does not own.
        let deadline = Instant::now() + DRAIN_QUIET;
        for _ in 0..DRAIN_FRAMES {
            match link.read_frame() {
                Ok(Some(msg)) => {
                    if reply_for(subs, &msg, base, method).is_some() {
                        return; // the straggler is consumed; the socket is clean again
                    }
                }
                // A read timeout is silence, not the end: keep waiting until the floor.
                Ok(None) => {
                    if Instant::now() >= deadline {
                        return;
                    }
                }
                Err(_) => return, // the link is gone; there is nothing left to clean
            }
        }
    }

    /// Frames drain_late_reply will look through for a straggler before giving up.
    const DRAIN_FRAMES: usize = 64;

    /// How long drain_late_reply keeps waiting on a link that is saying nothing. Held
    /// separately from READ_TIMEOUT so shortening that one cannot quietly shorten this.
    const DRAIN_QUIET: Duration = Duration::from_millis(200);

    /// The reply body for `method` at `base`, or None when the message was a notify,
    /// a reply to a different verb, or a reply for another address. Shared by the two
    /// await loops and the late drain so the matching cannot drift — the exact-address
    /// compare is what stops another instance's reply (e.g. y=12) satisfying a y=1
    /// request through a prefix match.
    ///
    /// **The address alone does not identify a reply.** A notify carries the same uri
    /// as the command that touches that address, and `absorb` only consumes one while
    /// the matching channel is subscribed — so with Live sync off (a Fetch, a Write,
    /// the self-test) an inbound notify for the address in flight would otherwise be
    /// taken as its answer. It reaches us whether or not this session registered the
    /// address: the broker broadcasts every notify to every connected client, which is
    /// exactly the concurrent-client case the vdp port exists for. On a GET that
    /// returns the pushed value instead of the read; on a POST the notify carries no
    /// `response_code`, so the write is reported refused when it succeeded.
    fn reply_for<'a>(
        subs: &mut Subs,
        msg: &'a Value,
        base: &str,
        method: &str,
    ) -> Option<&'a Value> {
        if subs.absorb(msg) {
            return None;
        }
        // Both envelope shapes, like notify_frame and synchronize_lost: casket
        // wraps the `vdp` message in JSON-RPC, the other endpoint carries it bare.
        // Matching on the wrapper's method would tie reply matching to casket — the
        // verb checked here is the `vdp` one, which both transports carry.
        let vdp = vdp_of(msg)?;
        if vdp.get("method").and_then(Value::as_str) != Some(method) {
            return None;
        }
        let uri = vdp.get("uri").and_then(Value::as_str).unwrap_or("");
        (uri.split('?').next().unwrap_or(uri) == base).then_some(vdp)
    }

    // Read a parameter instance's raw current_value (numeric or string). do_get /
    // do_get_str decode it; sharing the request + address-matched await loop here
    // keeps the two get paths from drifting.
    fn do_get_value(
        link: &mut Link,
        subs: &mut Subs,
        param_id: u32,
        x: i64,
        y: i64,
    ) -> Result<Value, String> {
        let base = format!("/vd/parameters/{param_id}:{x}:{y}");
        // Sent and awaited under one spelling, as in do_set.
        let verb = "get";
        link.send_vdp(json!({ "method": verb, "uri": base }))?;
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let Some(msg) = link.read_frame()? else {
                continue;
            };
            // A device-lost push can land mid-read; fail the command so the caller
            // (readback / converge / live) surfaces the drop instead of timing out.
            if let Some(err) = synchronize_lost(&msg) {
                return Err(err);
            }
            // Subscribed notifies landing mid-command are batched, not discarded
            // (see Subs).
            let Some(vdp) = reply_for(subs, &msg, &base, verb) else {
                continue;
            };
            return vdp.pointer("/data/current_value").cloned().ok_or_else(|| {
                format!("broker-bad-response: no current_value at {param_id}:{x}:{y}")
            });
        }
        drain_late_reply(link, subs, &base, verb);
        Err(format!("broker-timeout: value at {param_id}:{x}:{y}"))
    }

    fn do_get(
        link: &mut Link,
        subs: &mut Subs,
        param_id: u32,
        x: i64,
        y: i64,
    ) -> Result<i64, String> {
        do_get_value(link, subs, param_id, x, y)?
            .as_i64()
            .ok_or_else(|| "broker-bad-response: value was not an integer".to_string())
    }

    // The broker returns a name as a preset index (number) until one is typed,
    // then the literal string; a non-string value decodes to "" so callers see
    // "no custom name".
    fn do_get_str(
        link: &mut Link,
        subs: &mut Subs,
        param_id: u32,
        x: i64,
        y: i64,
    ) -> Result<String, String> {
        Ok(do_get_value(link, subs, param_id, x, y)?
            .as_str()
            .unwrap_or("")
            .to_string())
    }

    /// Register or unregister one meter address with the broker. Fire-and-forget:
    /// the response_code reply is drained by `pump` like any other frame.
    fn reg_meter(link: &mut Link, meter_id: u32, x: i64, op: &str) -> Result<(), String> {
        link.send_vdp(
            json!({ "method": "post", "uri": format!("/vd/meters/{meter_id}:{x}?operation={op}") }),
        )
    }

    /// Register or unregister one parameter address with the broker for change
    /// notifies. Fire-and-forget, like reg_meter: the reply is drained by `pump`.
    fn reg_param(link: &mut Link, param_id: u32, x: i64, y: i64, op: &str) -> Result<(), String> {
        link.send_vdp(json!({ "method": "post", "uri": format!("/vd/parameters/{param_id}:{x}:{y}?operation={op}") }))
    }

    /// Validate a broker `notify` frame and return its `vdp` object plus the
    /// address segment after `prefix` (query stripped), or None for any other
    /// frame shape (command replies, notifies on a different uri, etc.). Shared
    /// by the meter and parameter forwarders, which only differ in the prefix,
    /// the address arity, and how strictly they read current_value.
    fn notify_frame<'a>(msg: &'a Value, prefix: &str) -> Option<(&'a Value, &'a str)> {
        let vdp = vdp_of(msg)?;
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
        let vdp = vdp_of(msg)?;
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
    // command still waits out the final read's socket timeout before the worker yields.
    // That WAS written off here as "not the case that mattered"; it was measured on a
    // URX44V (2026-08-11) as a 152 ms wait for the first live write after a quiet gap,
    // which is the case that mattered. The bound is now READ_TIMEOUT's 50 ms rather
    // than this budget — on a quiet link the loop breaks at `Ok(None)` and never
    // reaches the check below, so shortening the socket timeout is what moved it and
    // changing THIS constant would not have.
    const PUMP_BUDGET: Duration = Duration::from_millis(30);

    /// Drain buffered frames for up to PUMP_BUDGET, absorbing meter and parameter
    /// notifications and forwarding them in one batched channel send each (the
    /// boundary is crossed per pump, not once per ~250/s reading). Frames other than
    /// the subscribed notifies are discarded. Returns Err if the connection dropped,
    /// or if a device-lost synchronize push arrived, so the worker can stop.
    fn pump(link: &mut Link, subs: &mut Subs) -> Result<(), String> {
        let start = Instant::now();
        // 512 is a non-binding hard ceiling; PUMP_BUDGET (or a drained socket)
        // normally ends the loop first, so it only caps a pathological burst.
        for _ in 0..512 {
            // Parse the frame once and share it: synchronize_lost and absorb read
            // the same envelope, and this drains the ~250/s meter stream (avoid
            // re-parsing per consumer).
            //
            // `None` ends this pump. It means the socket is drained (its 50 ms
            // read timeout) — but it also now covers the two frames the casket
            // read used to step over rather than stop on: a ping/pong, and text
            // that is not JSON. Neither carries a notify, and the worker re-enters
            // pump on its next 5 ms poll, so the cost of ending early on one is a
            // single extra loop; the alternative is a third outcome threaded
            // through every reader to distinguish "skipped" from "drained".
            match link.read_frame() {
                Ok(Some(msg)) => {
                    if let Some(err) = synchronize_lost(&msg) {
                        return Err(err);
                    }
                    subs.absorb(&msg);
                }
                Ok(None) => break, // drained — fall through to flush the batch
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
        // batch must flush on the pump cadence. Plus reply_for, which is where a
        // frame absorb declined lands — the two together decide whether a notify
        // can be mistaken for the answer to a command.
        use super::{reply_for, Subs, DRAIN_QUIET, PUMP_BUDGET, READ_TIMEOUT};
        use serde_json::{json, Value};
        use std::sync::{Arc, Mutex};
        use std::time::Instant;
        use tauri::ipc::{Channel, InvokeResponseBody};

        // `drain_late_reply` reads until a straggler, a frame cap, OR silence. Silence is
        // the one bound that used to be READ_TIMEOUT's by accident: every `read_frame`
        // on a quiet link returns None at the socket timeout, so shortening that constant
        // (200 -> 50 ms, so a live write does not queue behind the pump's blocking read)
        // would have quartered how long a late reply has to arrive. The drain now owns
        // DRAIN_QUIET instead. Nothing else can state this — the drain itself needs a
        // socket, so its loop is not reachable from here; what IS checkable is that the
        // two constants stayed independent and that the drain did not get less patient.
        #[test]
        fn the_late_drain_keeps_its_own_patience_when_the_socket_timeout_shortens() {
            // The value the drain's give-up point had while READ_TIMEOUT was 200 ms.
            // A change that lowers this is a change to how long a straggler has, and has
            // to be argued on its own rather than fall out of a socket-timeout tweak.
            assert_eq!(DRAIN_QUIET, std::time::Duration::from_millis(200));
            // Independence, stated as the inequality that makes the floor load-bearing:
            // if the socket timeout ever reached DRAIN_QUIET, the floor would stop adding
            // anything and the coupling would be back without a line changing here.
            assert!(
                READ_TIMEOUT < DRAIN_QUIET,
                "READ_TIMEOUT ({READ_TIMEOUT:?}) must stay under DRAIN_QUIET ({DRAIN_QUIET:?}), \
                 or the late drain is bounded by the socket timeout again"
            );
            // The bound the whole change exists for: a queued command waits at most one
            // recv_timeout (5 ms) plus this. 152 ms was measured on a URX44V at 200 ms.
            assert!(
                READ_TIMEOUT <= std::time::Duration::from_millis(50),
                "a live write queues behind one READ_TIMEOUT; keeping it small is the fix"
            );
        }

        // A subscription whose registered sets hold exactly the addresses a test
        // drives, mirroring what MetersSubscribe / ParamsSubscribe record: absorb
        // forwards a notify only for an address this session registered.
        fn subs_with(meters: &[(u32, i64)], params: &[(u32, i64, i64)]) -> Subs {
            let mut subs = Subs::new();
            subs.meter_addrs = meters.iter().copied().collect();
            subs.param_addrs = params.iter().copied().collect();
            subs
        }

        // A broker notify frame as the read loops see it (already-parsed JSON), in
        // casket's JSON-RPC envelope. The default endpoint sends the same `vdp`
        // object with nothing around it; `both_envelopes_reach_the_same_message`
        // below is what pins that the two converge, so the rest of these tests can
        // use one shape without the other going unchecked.
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

        // The same message in the bare envelope the default (vdp port) endpoint uses.
        fn notify_bare(uri: String, value: i64) -> Value {
            json!({ "vdp": {
                "method": "notify",
                "uri": uri,
                "data": { "current_value": value }
            }})
        }

        /// Every parser reaches the `vdp` message through one accessor, so this is
        /// the single place the two wire shapes have to agree — and the only place
        /// the default endpoint's shape is exercised at all.
        ///
        /// It is pinned because the spelling has already cost a hardware run: when
        /// the second transport was added, three parsers were taught both shapes and
        /// a fourth was not, and every reply on the new endpoint was skipped for
        /// lacking a wrapper it never sends. That failure is silent on the default
        /// path and invisible on the experimental one.
        #[test]
        fn both_envelopes_reach_the_same_message() {
            let wrapped = notify("/vd/parameters/1:0:0".into(), 42);
            let bare = notify_bare("/vd/parameters/1:0:0".into(), 42);
            assert_eq!(super::vdp_of(&wrapped), super::vdp_of(&bare));
            assert_eq!(
                super::vdp_of(&bare)
                    .and_then(|v| v.get("uri"))
                    .and_then(Value::as_str),
                Some("/vd/parameters/1:0:0"),
            );
            // A frame carrying neither envelope is nothing yet, not a panic.
            assert!(super::vdp_of(&json!({ "method": "getDeviceList" })).is_none());
        }

        /// The parse path above `vdp_of` therefore works on both shapes too: absorb
        /// takes the bare frame the default endpoint sends, not only casket's.
        #[test]
        fn absorb_takes_a_bare_envelope_notify() {
            let mut subs = subs_with(&[], &[(1, 0, 0)]);
            let (ch, seen) = capture::<Vec<super::super::ParamUpdate>>();
            subs.param_ch = Some(ch);
            assert!(subs.absorb(&notify_bare("/vd/parameters/1:0:0".into(), 42)));
            subs.flush();
            assert_eq!(seen.lock().unwrap().len(), 1);
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

        // A broker reply, in the bare envelope the default endpoint sends. `data`
        // is the measured shape for each verb (probe-regist-shape / probe-timeline):
        // a get answers with the value plus its bounds, a post with a bare ack.
        fn reply(method: &str, uri: &str, data: Value) -> Value {
            json!({ "vdp": { "method": method, "uri": uri, "data": data } })
        }

        /// Every notify reaches every connected client, so one for the address a
        /// command is waiting on arrives whenever anything else touches the unit —
        /// which is the case the vdp port exists to support. `absorb` consumes it
        /// only while the matching channel is subscribed, so with Live sync off
        /// (a Fetch, a Write, the self-test) nothing but the verb keeps it out of
        /// the await loop. A get would return the pushed value as the read; a post
        /// finds no response_code, reads it as 0, and reports a landed write as
        /// refused — aborting the whole write, per the device-link failure rule.
        #[test]
        fn reply_for_refuses_a_notify_for_the_address_in_flight() {
            // No channels: the state every command outside Live sync runs in.
            let mut subs = Subs::new();
            let base = "/vd/parameters/142:0:0";
            let push = notify_bare(base.into(), 1);

            assert!(!subs.absorb(&push), "nothing subscribed to absorb it");
            assert!(reply_for(&mut subs, &push, base, "get").is_none());
            assert!(reply_for(&mut subs, &push, base, "post").is_none());

            // The replies those two commands are actually waiting for still match,
            // query string and all — the broker echoes it back on a write.
            assert!(reply_for(
                &mut subs,
                &reply("get", base, json!({ "current_value": 1 })),
                base,
                "get"
            )
            .is_some());
            assert!(reply_for(
                &mut subs,
                &reply(
                    "post",
                    &format!("{base}?operation=value"),
                    json!({ "response_code": 200 })
                ),
                base,
                "post"
            )
            .is_some());
        }

        /// The verb separates the two commands that share an address, so a straggler
        /// from one cannot answer the other. A write followed by a read-back of the
        /// same address is the ordinary sequence (converge, readback), and the vd
        /// protocol carries no request id to tell them apart by.
        #[test]
        fn reply_for_refuses_the_other_verbs_reply_on_the_same_address() {
            let mut subs = Subs::new();
            let base = "/vd/parameters/142:0:0";
            let ack = reply("post", base, json!({ "response_code": 200 }));
            let value = reply("get", base, json!({ "current_value": 1 }));

            assert!(reply_for(&mut subs, &ack, base, "get").is_none());
            assert!(reply_for(&mut subs, &value, base, "post").is_none());
        }
    }

    #[cfg(test)]
    mod link_tests {
        // The two halves of the vdp transport that a live broker cannot drive: the
        // framing, whose interesting cases are a chunk boundary landing mid-line and a
        // peer that never terminates one, and the device-list parse, whose interesting
        // cases are answers Device Center does not currently produce. Both take their
        // input from the test rather than from a socket, so each case is one shape of
        // bytes and nothing depends on a peer behaving on cue.
        use super::{vdp_target, LineReader, MAX_PENDING};
        use serde_json::json;
        use std::collections::VecDeque;
        use std::io::{Error, ErrorKind, Read};

        /// A byte source with a socket's manners: at most one scripted piece per read —
        /// split when it does not fit the caller's buffer, as a socket splits one — and
        /// a read timeout once they run out. `WouldBlock` rather than end-of-file on
        /// purpose: an exhausted `Cursor` reports `Ok(0)`, which this reader is required
        /// to treat as the peer closing, so a `Cursor` would answer "connection gone"
        /// everywhere a quiet link is meant.
        struct Chunks(VecDeque<Vec<u8>>);

        impl Chunks {
            fn of(parts: &[&str]) -> Self {
                Chunks(parts.iter().map(|p| p.as_bytes().to_vec()).collect())
            }
        }

        impl Read for Chunks {
            fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                let Some(mut next) = self.0.pop_front() else {
                    return Err(Error::new(ErrorKind::WouldBlock, "quiet link"));
                };
                let n = next.len().min(buf.len());
                buf[..n].copy_from_slice(&next[..n]);
                if n < next.len() {
                    self.0.push_front(next.split_off(n));
                }
                Ok(n)
            }
        }

        // The reason this reader owns a `pending` buffer at all. A chunk boundary is not
        // a message boundary, and the half-line has to survive the read that ends without
        // one — a reader that parsed each chunk on its own would drop both halves here.
        #[test]
        fn a_line_split_across_two_reads_is_rejoined() {
            let mut reader = LineReader::new();
            let mut sock = Chunks::of(&["{\"vddp\":{\"seq\"", ":7}}\n"]);

            assert_eq!(
                reader.read_json(&mut sock).unwrap(),
                Some(json!({ "vddp": { "seq": 7 } }))
            );
        }

        // …and the same buffer is what lets two messages arrive in one read. The second
        // call must answer out of `pending` without reading: the source is quiet by then,
        // so a call that reached the socket would report "nothing yet" and lose the frame.
        #[test]
        fn two_messages_in_one_chunk_come_back_one_per_call() {
            let mut reader = LineReader::new();
            let mut sock = Chunks::of(&["{\"a\":1}\n{\"b\":2}\n"]);

            assert_eq!(reader.read_json(&mut sock).unwrap(), Some(json!({"a": 1})));
            assert_eq!(reader.read_json(&mut sock).unwrap(), Some(json!({"b": 2})));
            assert_eq!(reader.read_json(&mut sock).unwrap(), None, "then quiet");
        }

        // A line that is not JSON is "nothing yet" to the caller, and it must be DRAINED
        // by the call that declined it. Left in place it would be re-parsed forever and
        // the message behind it would never be reached.
        #[test]
        fn an_unparseable_line_is_dropped_rather_than_re_read() {
            let mut reader = LineReader::new();
            let mut sock = Chunks::of(&["not json\n{\"a\":1}\n"]);

            assert_eq!(reader.read_json(&mut sock).unwrap(), None);
            assert_eq!(reader.read_json(&mut sock).unwrap(), Some(json!({"a": 1})));
        }

        // A peer that never sends a newline. Without the cap this is a `Vec` growing at
        // socket speed for the life of the session — a memory climb with nothing in the
        // log, rather than an error the caller can act on and report.
        #[test]
        fn a_peer_that_never_terminates_a_line_is_refused_at_the_cap() {
            /// Endless bytes, none of them a newline — but only up to four times the cap,
            /// so a reader that does not stop fails this case instead of running the host
            /// out of memory. Without that bound the defect's own signature (a buffer
            /// growing at socket speed) is what the test would reproduce.
            struct Noise(usize);
            impl Read for Noise {
                fn read(&mut self, buf: &mut [u8]) -> std::io::Result<usize> {
                    self.0 += buf.len();
                    assert!(self.0 < MAX_PENDING * 4, "unbounded: the cap did not hold");
                    buf.fill(b'x');
                    Ok(buf.len())
                }
            }

            let mut reader = LineReader::new();
            let err = reader
                .read_json(&mut Noise(0))
                .expect_err("an unterminated stream must end as an error, not as memory");

            assert!(
                err.starts_with("broker-bad-response:"),
                "reported as a bad answer from the broker: {err}"
            );
            assert!(
                err.contains("with no line break"),
                "and says what is wrong with it: {err}"
            );
        }

        // The cap is a ceiling on ONE line, so it must sit far above any frame the
        // protocol carries. The largest is a device list of a few KiB; a frame at 64 KiB
        // — an order of magnitude past that — still has to come back whole.
        #[test]
        fn a_large_but_terminated_frame_is_not_refused() {
            let big = "y".repeat(64 * 1024);
            assert!(big.len() < MAX_PENDING, "the cap is a ceiling on one line");
            let mut reader = LineReader::new();
            let mut sock = Chunks::of(&["{\"note\":\"", &big, "\"}\n"]);

            let msg = reader.read_json(&mut sock).unwrap().expect("one frame");
            assert_eq!(msg["note"].as_str().map(str::len), Some(big.len()));
        }

        fn devices(entry: serde_json::Value) -> serde_json::Value {
            json!({ "list": [entry] })
        }

        #[test]
        fn an_ordinary_device_list_names_its_port_and_model() {
            assert_eq!(
                vdp_target(&devices(json!({ "vdpport": 51234, "model": "URX44V" }))),
                Ok((51234, "URX44V".to_string()))
            );
        }

        // The boundary the checked conversion is drawn at: the last port that exists is
        // still a port. A cap written one short here would refuse a working broker.
        #[test]
        fn the_highest_real_port_is_accepted() {
            assert_eq!(
                vdp_target(&devices(json!({ "vdpport": 65535 }))).map(|(p, _)| p),
                Ok(65535)
            );
        }

        // What the truncating cast did: 65537 became 1, and the connect that followed
        // failed naming port 1 — a port the broker never advertised, which sends whoever
        // reads that error looking at the wrong process entirely.
        #[test]
        fn a_port_past_u16_is_refused_naming_the_value_the_broker_sent() {
            let err = vdp_target(&devices(json!({ "vdpport": 65537 })))
                .expect_err("out of range is an error, not a truncation");

            assert!(
                err.starts_with("broker-bad-response:"),
                "attributed to the broker's answer: {err}"
            );
            assert!(
                err.contains("65537"),
                "naming what was actually sent, not what it truncates to: {err}"
            );
        }

        #[test]
        fn a_list_entry_with_no_port_is_a_missing_port_rather_than_a_bad_one() {
            let err = vdp_target(&devices(json!({ "model": "URX22" }))).unwrap_err();
            assert!(err.starts_with("broker-no-vdpport:"), "{err}");
        }

        // Device Center up with no URX attached. Distinct from every error above: it is
        // the state the frontend turns into "connect the unit", not into a fault report.
        #[test]
        fn an_empty_list_is_no_device() {
            assert_eq!(vdp_target(&json!({ "list": [] })), Err("no-device".into()));
            assert_eq!(vdp_target(&json!({})), Err("no-device".into()));
        }

        // Both transports fall back to the same word for an unnamed unit, or the two
        // would show different text for the same unknown device.
        #[test]
        fn an_unnamed_device_falls_back_to_the_shared_placeholder() {
            assert_eq!(
                vdp_target(&devices(json!({ "vdpport": 51234 }))).map(|(_, m)| m),
                Ok("URX".to_string())
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
    use super::{disconnect, sender, shutdown_owned_by, Cmd, LinkCounters, VdState};
    use std::sync::mpsc::{self, Sender};
    use std::sync::Arc;

    /// Install the way a page that has not reloaded does: the generation taken and
    /// handed straight back. Through the shipped function rather than beside it — the
    /// cases below are about what an install DOES, and a test-only twin of its body is
    /// a second answer to that with nothing holding the two together.
    ///
    /// The reload arm is not a parameter here: what it does instead of installing is
    /// the subject of two cases of its own, which call `install_for_page` directly.
    fn install(state: &VdState, tx: Sender<Cmd>) -> u64 {
        let gen = state.page_gen("main");
        state
            .install_for_page(tx, Arc::new(LinkCounters::default()), "main", gen)
            .expect("a page that has not reloaded installs")
    }

    // A page load ends what THAT page holds. The app has two webviews, and the second
    // one's load used to end the first one's session — measured: opening the MIDI
    // control window closed the device link and the MIDI input the main window had
    // restored, with the frontend never told. The session now records its owner, so a
    // third window inherits the right behaviour with nothing to remember.
    #[test]
    fn a_page_load_ends_only_the_session_that_page_opened() {
        let state = VdState::default();
        let (tx, rx) = mpsc::channel::<Cmd>();
        install(&state, tx);

        shutdown_owned_by(&state, "midi");
        sender(&state).expect("another window's load leaves this session alone");

        shutdown_owned_by(&state, "main");
        assert!(
            sender(&state).is_err(),
            "its own page load ends it, as it always did"
        );
        assert!(
            matches!(rx.recv(), Ok(Cmd::Shutdown { .. })),
            "and the worker is told to close"
        );
    }

    // The reported field bug: live connects, its teardown's disconnect is delayed,
    // a write connects (new generation), then the stale disconnect finally lands.
    // It must be a no-op and leave the write's channel installed and reachable.
    #[test]
    fn stale_disconnect_spares_newer_connection() {
        let state = VdState::default();

        // Live session connects.
        let (live_tx, _live_rx) = mpsc::channel::<Cmd>();
        let live_epoch = install(&state, live_tx);

        // A later write connects before the live teardown's disconnect runs.
        let (write_tx, write_rx) = mpsc::channel::<Cmd>();
        let write_epoch = install(&state, write_tx);
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
        let epoch = install(&state, tx);

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
        install(&state, tx1);
        let (tx2, _rx2) = mpsc::channel::<Cmd>();
        install(&state, tx2);
        assert!(
            matches!(rx1.recv(), Ok(Cmd::Shutdown { .. })),
            "prior worker told to stop"
        );
    }

    // Ownership is recorded by webview LABEL, and a page load keeps the label — so the
    // teardown a load runs cannot cancel a connect still in flight for the dead page.
    // `open()` takes up to ~9 s (discovery, sync, device), and inside that window a
    // reload's teardown found nothing installed and the connect then installed under the
    // NEW page: an open vdp socket it holds no epoch for, and `vd_link_stats` reporting
    // a live ledger on a page that never connected.
    #[test]
    fn a_connect_that_outlived_its_page_is_not_installed_under_its_replacement() {
        let state = VdState::default();
        let gen = state.page_gen("main");

        // The page reloads while the handshake is in flight.
        state.note_page_load("main");

        let (tx, rx) = mpsc::channel::<Cmd>();
        let installed = state.install_for_page(tx, Arc::new(LinkCounters::default()), "main", gen);
        assert!(installed.is_none(), "the page that asked for it is gone");
        assert!(
            sender(&state).is_err(),
            "nothing was installed for the page that replaced it"
        );
        // …and the worker it opened was told to stop rather than left running.
        assert!(matches!(rx.recv(), Ok(Cmd::Shutdown { .. })));

        // The same connect, with no reload under it, installs as it always did.
        let gen = state.page_gen("main");
        let (tx2, _rx2) = mpsc::channel::<Cmd>();
        assert!(state
            .install_for_page(tx2, Arc::new(LinkCounters::default()), "main", gen)
            .is_some());
        assert!(sender(&state).is_ok());
        shutdown_owned_by(&state, "main");
    }

    // …and the reload landing DURING the install, which the caller-side interleaving
    // above cannot reach. Asserted as the LOCK ORDERING rather than by racing the two:
    // a race is timing-dependent, and measured, 200 rounds of it passed with the check
    // and the install back under separate locks — a test that cannot fail on the defect
    // is not coverage of it.
    //
    // What must hold is that `note_page_load` cannot complete while the connection lock
    // is held, since `install_for_page` holds that lock across its check AND its
    // install. Without it a page load lands between the two: the teardown behind it
    // finds nothing to shut down, and the dead page's session is installed afterwards
    // with no page holding its epoch.
    #[test]
    fn a_page_load_cannot_land_while_the_connection_lock_is_held() {
        let state = std::sync::Arc::new(VdState::default());
        let held = state.conn.lock().unwrap();

        let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let bumping = std::sync::Arc::clone(&state);
        let flag = std::sync::Arc::clone(&done);
        let t = std::thread::spawn(move || {
            bumping.note_page_load("main");
            flag.store(true, std::sync::atomic::Ordering::SeqCst);
        });

        std::thread::sleep(std::time::Duration::from_millis(50));
        assert!(
            !done.load(std::sync::atomic::Ordering::SeqCst),
            "a page load must wait for the connection lock, or it can land between a \
             connect's check and its install"
        );

        drop(held);
        t.join().unwrap();
        assert!(done.load(std::sync::atomic::Ordering::SeqCst));
        assert_eq!(state.page_gen("main"), 1);
    }
}
