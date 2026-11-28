// Live hardware control transport: a client for the Device Center broker's "vd"
// protocol. Device Center must be running with a URX connected; it bridges the
// broker to the unit's CDC serial. See the project's private notes.
//
// The link runs over the per-session port Device Center advertises on :51770 —
// newline-delimited JSON over a plain socket, one socket per unit.
//
// A dedicated worker thread owns the socket so the broker's continuous meter
// notifications are drained without blocking command latency; the frontend
// addresses parameters by (param_id, x, y) and never sees the socket. The control
// surface is `#[cfg(desktop)]`, so mobile targets do not build it at all.

use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::ipc::Channel;
use urx_device_transport::connection::{SendGate, SentFrames};

pub mod package;
use package::PackageLink;

// Every error this module returns is a stable kebab-case code, optionally followed
// by ": " and a technical detail (an address, a URI, an OS message). The frontend
// localizes the code and shows the detail as-is (src/i18n error.shell) — a raw
// message would reach a Japanese dialog in English. Codes: broker-unreachable,
// no-device, multiple-devices, control-worker-gone, not-connected, device-lost, broker-closed,
// broker-timeout, broker-unresponsive, broker-rejected, broker-bad-response,
// broker-io, notifications-lost. A write refused while a Console Lock waits for the page
// is the page's own `writes-held`, which it takes as the lock's stop and never words.
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

/// The code a fetch of the notifications is refused with when its number is out of
/// sequence: the page's own code for notifications it could not fetch
/// (`NOTIFICATIONS_LOST`, src/core/platform.ts).
pub(crate) const NOTIFICATIONS_LOST: &str = "notifications-lost";

/// The code a write is refused with while a Console Lock the unit announced has not
/// reached the page yet: the page's own code for a write the lock holds (`WRITES_HELD`,
/// src/core/platform.ts), which it takes as the lock's stop rather than a failure.
pub(crate) const WRITES_HELD: &str = "writes-held";

/// The prefix on the failure of a write the transport never sent (`Evidence::NotSent`):
/// the page takes it off and marks the error (`NOT_SENT`, src/core/platform.ts), so that it
/// can tell a write that cannot have reached the unit from one that may have.
pub(crate) const NOT_SENT: &str = "not-sent";

/// The address of the unit's [Console Lock] (`PARAMS.CONSOLE_LOCK`,
/// src/core/control/params.ts), the same on every model; announced on, it holds the
/// writes in the shell until the page has the announcement.
const CONSOLE_LOCK_PARAM: u32 = 895;

/// Device identity exposed to the frontend (no serial). `firmware` is the
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
/// answer promptly right up to the moment it stops answering. The drop share
/// in particular cannot measure registration accumulation at all: registration and
/// notify emission are decoupled on this protocol (a registered address can change
/// and announce nothing), and an address nobody moves emits nothing however many
/// times it is registered. See docs/{en,ja}/architecture.md "The link ledger".
/// Reads what a connection has written whole — its registration and unregistration
/// frames, its parameter reads and its writes — or nothing once the connection is gone.
type FrameSource = Box<dyn Fn() -> Option<SentFrames> + Send + Sync>;

#[derive(Default)]
pub struct LinkCounters {
    param_subscribes: AtomicU64,
    meter_subscribes: AtomicU64,
    /// The frames and requests the session's connection has written whole, read from the
    /// connection at each reading; installed when it opens. The transport counts a
    /// request as it puts it on the socket, so one it refused before sending — the session
    /// already over included — is in no row.
    frames: OnceLock<FrameSource>,
    deadlines: AtomicU64,
    /// The CURRENT consecutive-deadline run, not a total. The transport ends the
    /// connection on its first response deadline (N1), so it is 1 once a deadline has
    /// ended the session and 0 before.
    stalled: AtomicU64,
}

impl LinkCounters {
    fn bump(c: &AtomicU64) {
        c.fetch_add(1, Ordering::Relaxed);
    }

    /// Where the frame and request rows are read from: the session's connection, set once
    /// when it opens.
    fn read_frames_with(&self, source: FrameSource) {
        let _ = self.frames.set(source);
    }

    /// A command ran out its deadline, which ends the session: one more on the total,
    /// and the run at the limit.
    fn note_deadline(&self) {
        Self::bump(&self.deadlines);
        self.stalled.store(1, Ordering::Relaxed);
    }

    fn read(&self) -> LinkStats {
        let sent = self
            .frames
            .get()
            .and_then(|read| read())
            .unwrap_or_default();
        LinkStats {
            sets: sent.sets,
            gets: sent.gets,
            param_subscribes: self.param_subscribes.load(Ordering::Relaxed),
            meter_subscribes: self.meter_subscribes.load(Ordering::Relaxed),
            regist_frames: sent.registrations,
            unregist_frames: sent.unregistrations,
            deadlines: self.deadlines.load(Ordering::Relaxed),
            stalled: self.stalled.load(Ordering::Relaxed),
        }
    }
}

/// The counters above as one serializable reading. Read straight off the atomics and
/// the connection's counts rather than through `Cmd`, deliberately: a stats request queued behind an ~800
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

/// A run of one subscription's updates: what the page fetches (`vd_notifications`), in
/// the order the shell received them. `handler` is the number the page gave the
/// subscription when it asked for it, so a run reaches that subscription's own handler.
#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Run {
    Meters {
        handler: u64,
        updates: Vec<MeterUpdate>,
    },
    Params {
        handler: u64,
        updates: Vec<ParamUpdate>,
    },
    Probe {
        handler: u64,
        updates: Vec<ParamUpdate>,
    },
}

/// The runs a session has routed that the page has not fetched yet, in receive order.
/// The page fetches them with one numbered request at a time (`vd_notifications`), so
/// they reach it in this order and once each, and a fetch that fails is a rejection the
/// page sees — where notifications pushed over Tauri channels could arrive out of order
/// across channels, and one lost inside a channel held back every one after it unseen.
///
/// An answer is kept until the page asks for the next number, which is its
/// acknowledgement: Tauri resends a request whose response the page could not read
/// (its custom protocol failing over to `postMessage`), and the resend of a number is
/// answered with what that number was answered with, not with the runs after it.
#[derive(Default)]
pub struct Outbox {
    state: Mutex<OutboxState>,
    changed: std::sync::Condvar,
    /// Run once, on the worker, as the next request it makes comes back and before its result
    /// is worded (`Session::run_with`): where a case makes the unit announce something between
    /// the two.
    #[cfg(test)]
    after_request: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

#[derive(Default)]
struct OutboxState {
    runs: Vec<Run>,
    records: usize,
    ended: bool,
    /// The number the page's next new fetch carries.
    expect: u64,
    /// The last answer and its number, kept until a fetch of the next number arrives.
    answered: Option<(u64, Vec<Run>)>,
    /// A fetch of `expect` is waiting for runs: a resend of it waits for its answer.
    taking: bool,
    /// The unit's last announcement of its [Console Lock] the transport received was on: from
    /// it to the announcement of the lock off, the shell sends no write. Taken as the transport
    /// receives it (`hear`), ahead of the batch that carries it, which can wait behind others.
    heard_locked: bool,
    /// Announcements of Console Lock received, and put in `runs` since: equal once every one
    /// received is on its way to the page. An announcement is named by its place in this count.
    heard: u64,
    put_announcements: u64,
    /// The announcements an answer has handed to the page: every one up to this count.
    handed_announcements: u64,
    /// The announcement of the lock on received last, and the first fetch whose answer handed
    /// it on, once one has.
    last_on: u64,
    last_on_fetch: Option<u64>,
    /// The writes the lock holds whose refusal is still to be worded, each with the
    /// announcement it was held on and the first fetch that handed that announcement on: kept
    /// until the refusal takes it (`lock_hold`), whatever the unit announces meanwhile.
    holds: Vec<HeldWrite>,
    next_hold: u64,
}

/// A write the unit's Console Lock held, until its refusal is worded (`Outbox::hold_write`).
struct HeldWrite {
    id: u64,
    announcement: u64,
    fetch: Option<u64>,
}

/// How many updates the outbox holds before the delivery waits for the page: past it,
/// the transport's own bounded queue fills, and its overflow ends the session.
const OUTBOX_UPDATES: usize = 8192;

/// How long a write the unit's Console Lock holds waits for the announcement to be on its way
/// to the page, so that the refusal can name the fetch that carries it: the page's own deadline
/// for a fetch (`NOTIFICATION_FETCH_DEADLINE_MS`, src/core/platform.ts), past which it has lost
/// the notifications and refuses its writes itself.
const LOCK_HAND_ON_WAIT: Duration = Duration::from_secs(5);

impl Outbox {
    /// The announcement of Console Lock on that the transport received last, by its place among
    /// the announcements received, while no announcement of the lock off has come after it.
    #[cfg(test)]
    fn lock_heard(&self) -> Option<u64> {
        let state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.heard_locked.then_some(state.heard)
    }

    /// A number for one write's send gate (`hold_write`, `lock_hold`).
    fn hold_id(&self) -> u64 {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.next_hold += 1;
        state.next_hold
    }

    /// What a write's send gate asks just before its first byte (`Session::set`): whether the
    /// unit's last announcement of Console Lock the transport received was on. If so, the write
    /// `id` is held on that announcement, and the outbox keeps it, with the first fetch that
    /// handed the announcement on, until the refusal is worded (`lock_hold`).
    fn hold_write(&self, id: u64) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        if !state.heard_locked {
            return false;
        }
        let announcement = state.heard;
        let fetch = state.last_on_fetch;
        state.holds.push(HeldWrite {
            id,
            announcement,
            fetch,
        });
        true
    }

    /// The transport received an announcement of Console Lock, `on` or off (its receipt
    /// observer, `open_observed`): it holds the next write at once, whatever the batch that
    /// carries it is waiting for.
    fn hear(&self, on: bool) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.heard_locked = on;
        state.heard += 1;
        if on {
            state.last_on = state.heard;
            state.last_on_fetch = None;
        }
    }

    /// Adds a delivered batch's runs, waiting while the page has more than
    /// `OUTBOX_UPDATES` unfetched; nothing is added once the session has ended.
    /// `announcements` is how many announcements of Console Lock, on or off, the batch
    /// carries. A batch that carries one does not wait: the next fetch has to be the one that
    /// hands it to the page, whatever is waiting.
    fn put(&self, runs: Vec<Run>, announcements: u64) {
        let count: usize = runs.iter().map(Run::len).sum();
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        while announcements == 0 && !state.ended && state.records > OUTBOX_UPDATES {
            state = self
                .changed
                .wait_timeout(state, Duration::from_millis(100))
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        if state.ended {
            return;
        }
        state.put_announcements += announcements;
        state.records += count;
        state.runs.extend(runs);
        self.changed.notify_all();
    }

    /// The answer to the page's fetch numbered `seq`. A resend of the last number gets
    /// that number's answer again; the next number acknowledges it and takes every run
    /// waiting, after waiting up to `wait` for one: empty when none came, and `None`
    /// once the session has ended with nothing left to fetch. Any other number is out
    /// of sequence: the page has lost an answer, and the rejection says so.
    pub fn take(&self, seq: u64, wait: Duration) -> Result<Option<Vec<Run>>, String> {
        let end = Instant::now() + wait;
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        loop {
            if let Some((number, runs)) = &state.answered {
                if *number == seq {
                    return Ok(Some(runs.clone()));
                }
            }
            if seq != state.expect {
                return Err(format!(
                    "{NOTIFICATIONS_LOST}: fetch {seq} out of sequence, {} expected",
                    state.expect
                ));
            }
            if !state.taking {
                break;
            }
            // A resend of the fetch being answered: it gets the same answer.
            state = self.changed.wait(state).unwrap_or_else(|p| p.into_inner());
        }
        state.answered = None;
        state.taking = true;
        while state.runs.is_empty() && !state.ended {
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            state = self
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        state.taking = false;
        self.changed.notify_all();
        if state.runs.is_empty() && state.ended {
            return Ok(None);
        }
        state.records = 0;
        let runs = std::mem::take(&mut state.runs);
        // The announcements this answer hands on: the first fetch of each is this one.
        let (after, through) = (state.handed_announcements, state.put_announcements);
        let first = |announcement: u64| after < announcement && announcement <= through;
        if state.last_on_fetch.is_none() && first(state.last_on) {
            state.last_on_fetch = Some(seq);
        }
        for held in state.holds.iter_mut() {
            if held.fetch.is_none() && first(held.announcement) {
                held.fetch = Some(seq);
            }
        }
        state.handed_announcements = through;
        state.answered = Some((seq, runs.clone()));
        state.expect = seq + 1;
        Ok(Some(runs))
    }

    /// Whether the write `id` was held (`hold_write`), and if so the number of the fetch that
    /// hands the page the announcement of Console Lock it was held on: the first one whose answer
    /// carried it, or the next one while it is unfetched — whatever the unit announced and the
    /// page fetched after it. That number is known once the announcement is in `runs`, which this
    /// waits up to `wait` for; past it, or once the session has ended, it names none. The hold is
    /// let go.
    pub fn lock_hold(&self, id: u64, wait: Duration) -> Option<Option<u64>> {
        let end = Instant::now() + wait;
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        let announcement = state.holds.iter().find(|held| held.id == id)?.announcement;
        while state.put_announcements < announcement && !state.ended {
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                break;
            }
            state = self
                .changed
                .wait_timeout(state, left)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
        let at = state.holds.iter().position(|held| held.id == id)?;
        let held = state.holds.remove(at);
        Some(match held.fetch {
            Some(fetch) => Some(fetch),
            // In `runs`, and no answer has carried it yet: the next one does.
            None if state.put_announcements >= announcement => Some(state.expect),
            None => None,
        })
    }

    /// Runs the case's `after_request`, once.
    #[cfg(test)]
    fn after_request(&self) {
        let hook = self
            .after_request
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .take();
        if let Some(hook) = hook {
            hook();
        }
    }

    /// The session is over: a waiting fetch and a waiting delivery are let go.
    fn end(&self) {
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());
        state.ended = true;
        self.changed.notify_all();
    }
}

/// A write's send gate for the unit's Console Lock, and the write's number in the outbox's record of
/// held writes. As the gate refuses, the outbox records the write as held on the announcement it was
/// refused on (`Outbox::hold_write`), so the refusal is worded from that verdict
/// (`Outbox::lock_hold`) and not from whatever the unit announced after it. Every write of the
/// session goes out through one: the worker's (`Session::set`) and the control package's
/// (`package::PackageLink::request`).
fn lock_gate(outbox: &Arc<Outbox>) -> (SendGate, u64) {
    let id = outbox.hold_id();
    let outbox = Arc::clone(outbox);
    (Box::new(move || !outbox.hold_write(id)), id)
}

impl Run {
    fn len(&self) -> usize {
        match self {
            Run::Meters { updates, .. } => updates.len(),
            Run::Params { updates, .. } | Run::Probe { updates, .. } => updates.len(),
        }
    }
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
/// held-open live session can be dropped instead of silently freezing. `reason` is
/// the stable code of what failed, the same one later commands then fail with.
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
/// did not get one: the unit announces a rename (one notify on the renamed address
/// and nothing else), the frame reached this function, and this line discarded it.
/// Numeric notifies leave the field `None` and pay one `is_none()` on the JS side;
/// the integer decode is still tried first, so the common path costs exactly what it
/// did before.
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
    /// Subscribe to a set of level meters (meter_id, x); their readings go to the
    /// session's outbox as runs for `handler`. Replaces any prior meter subscription. The
    /// reply is the registration's outcome, each address's verdict checked (K9).
    MetersSubscribe {
        addrs: Vec<(u32, i64)>,
        handler: u64,
        reply: Sender<Result<(), String>>,
    },
    /// Drop the current meter subscription (unregisters each address).
    MetersUnsubscribe,
    /// Subscribe to a set of parameter addresses (param_id, x, y); their `notify` frames
    /// go to the session's outbox as runs for `handler`. Replaces any prior parameter
    /// subscription. The reply is the registration's outcome, each address's verdict
    /// checked (K9).
    ParamsSubscribe {
        addrs: Vec<(u32, i64, i64)>,
        handler: u64,
        reply: Sender<Result<(), String>>,
    },
    /// Drop the current parameter subscription (unregisters each address).
    ParamsUnsubscribe,
    /// The dev build's parameter watch: a second, independent parameter subscription
    /// beside the live-sync one, so a watch can register addresses the plan never
    /// names without entering the set the follow layer reads. Replaces any prior
    /// watch; its notifies go to the outbox as runs for its own `handler`, never as the
    /// live-sync subscription's. Same reply contract as ParamsSubscribe. The command that sends it
    /// refuses in a release binary (lib.rs `vd_probe_subscribe`).
    ProbeSubscribe {
        addrs: Vec<(u32, i64, i64)>,
        handler: u64,
        reply: Sender<Result<(), String>>,
    },
    /// Register a channel to receive the link-lost event (see LinkEvent). Replaces
    /// any prior watch. Fire-and-forget; the worker pushes one event if the broker
    /// link fails while idle, and latches the session as lost.
    WatchLink { channel: Channel<LinkEvent> },
    /// Unregister everything this session registered, close the socket, and exit.
    /// `done` is signalled once that has actually happened — only the app-exit path
    /// passes one, because it is the only caller whose process may not outlive the
    /// worker. Everywhere else the worker keeps running and finishes on its own. It
    /// comes with the instant that caller stops waiting, which the close drain ends
    /// ahead of, so the signal is in time.
    Shutdown { done: Option<(Sender<()>, Instant)> },
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
    /// The runs the live worker has routed for the page to fetch (`notifications`).
    outbox: Arc<Outbox>,
    /// The control package's requests on this session's connection (`package`).
    package: Option<Arc<PackageLink>>,
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

/// Spawn the worker and perform the broker handshake (blocking) with the device the
/// selected model `preferred` picks among the online ones (see `choose_online`).
/// Returns the command channel plus the connected device; the caller installs the
/// channel into VdState. Kept free of VdState so a Tauri command can run it on a
/// blocking task — the handshake waits up to seconds and must not stall the UI.
/// What `open` hands back: the worker's command channel, the unit, its ledger and the
/// outbox its notifications go to.
pub struct Opened {
    pub tx: Sender<Cmd>,
    pub device: DeviceSummary,
    pub counters: Arc<LinkCounters>,
    pub outbox: Arc<Outbox>,
    /// The control package's requests on the opened connection.
    pub package: Arc<PackageLink>,
}

pub fn open(preferred: String) -> Result<Opened, String> {
    let (tx, rx) = mpsc::channel::<Cmd>();
    let (ready_tx, ready_rx) = mpsc::channel::<Result<DeviceSummary, String>>();
    let counters = Arc::new(LinkCounters::default());
    let outbox = Arc::new(Outbox::default());
    let package = Arc::new(PackageLink::new(Arc::clone(&counters), Arc::clone(&outbox)));
    let (worker_counters, worker_outbox, worker_package) = (
        Arc::clone(&counters),
        Arc::clone(&outbox),
        Arc::clone(&package),
    );
    std::thread::spawn(move || {
        imp::worker(
            rx,
            ready_tx,
            worker_counters,
            worker_outbox,
            worker_package,
            &preferred,
        )
    });
    let device = ready_rx
        .recv()
        .map_err(|_| CONTROL_WORKER_GONE.to_string())??;
    Ok(Opened {
        tx,
        device,
        counters,
        outbox,
        package,
    })
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
        outbox: Arc<Outbox>,
        package: Arc<PackageLink>,
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
                outbox,
                ..Conn::default()
            };
            stop(&mut dead, None);
            return None;
        }
        stop(&mut c, None);
        c.tx = Some(tx);
        c.counters = counters;
        c.outbox = outbox;
        c.package = Some(package);
        c.owner = Some(owner.to_string());
        c.epoch += 1;
        Some(c.epoch)
    }
}

/// The outbox of the connection of generation `epoch`, while it is the one installed.
pub fn outbox(state: &VdState, epoch: u64) -> Option<Arc<Outbox>> {
    let c = state.conn.lock().unwrap();
    (c.epoch == epoch && c.tx.is_some()).then(|| Arc::clone(&c.outbox))
}

/// The control package's requests on the connection of generation `epoch`, while it is the one
/// installed.
pub fn package_link(state: &VdState, epoch: u64) -> Option<Arc<PackageLink>> {
    let c = state.conn.lock().unwrap();
    if c.epoch != epoch || c.tx.is_none() {
        return None;
    }
    c.package.clone()
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

/// Subscribe to live level meters; readings go to the session's outbox as runs for
/// `handler`. Replaces any prior subscription. Blocks until every registration has its
/// verdict; the reply is the registration's outcome.
pub fn meters_subscribe(
    tx: Sender<Cmd>,
    addrs: Vec<(u32, i64)>,
    handler: u64,
) -> Result<(), String> {
    let (reply, rx) = mpsc::channel();
    tx.send(Cmd::MetersSubscribe {
        addrs,
        handler,
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

/// Subscribe to device-side parameter changes; notifies go to the session's outbox as
/// runs for `handler`. Replaces any prior subscription. Blocks until every registration
/// has its verdict; the reply is the registration's outcome.
pub fn params_subscribe(
    tx: Sender<Cmd>,
    addrs: Vec<(u32, i64, i64)>,
    handler: u64,
) -> Result<(), String> {
    let (reply, rx) = mpsc::channel();
    tx.send(Cmd::ParamsSubscribe {
        addrs,
        handler,
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

/// Start the dev build's parameter watch (see Cmd::ProbeSubscribe). Blocks until the
/// worker has sent every registration, like params_subscribe. There is no matching
/// unsubscribe: the watch lasts until the session's own teardown unregisters it.
pub fn probe_subscribe(
    tx: Sender<Cmd>,
    addrs: Vec<(u32, i64, i64)>,
    handler: u64,
) -> Result<(), String> {
    let (reply, rx) = mpsc::channel();
    tx.send(Cmd::ProbeSubscribe {
        addrs,
        handler,
        reply,
    })
    .map_err(|_| CONTROL_WORKER_GONE.to_string())?;
    rx.recv().map_err(|_| CONTROL_WORKER_GONE.to_string())?
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
/// away, and the frames only reach the broker if they are sent before it does. So a
/// quit closes the session as every other teardown does, instead of leaving the broker
/// to find out from a socket that simply went away.
pub fn shutdown_blocking(state: &VdState) {
    // The wait is the only thing this path adds; the teardown itself is `stop`, so a
    // step added there reaches app quit too — which is the one teardown with no second
    // chance to run it.
    let (done, wait) = mpsc::channel();
    let by = Instant::now() + EXIT_TEARDOWN_WAIT;
    let sent = stop(&mut state.conn.lock().unwrap(), Some((done, by)));
    if !sent {
        return; // nothing installed, or the worker is already gone
    }
    if wait
        .recv_timeout(by.saturating_duration_since(Instant::now()))
        .is_err()
    {
        eprintln!("vd: the broker session did not close within the exit teardown window");
    }
}

/// Take the installed worker's channel and tell it to exit, optionally handing it the
/// channel to signal once it has. The one spelling of a teardown, so a step added to it
/// (dropping a channel eagerly, bumping the epoch) cannot reach one caller and miss
/// another. Returns whether a live worker was actually told. Caller holds the lock.
fn stop(c: &mut Conn, done: Option<(Sender<()>, Instant)>) -> bool {
    c.owner = None;
    // Ahead of the worker's shutdown, which a worker waiting behind a slot the page will never
    // adopt would not reach (`PackageLink::tear_down`).
    if let Some(package) = c.package.take() {
        package.tear_down();
    }
    // A fetch waiting on this session's outbox is let go: the session is over for the page.
    c.outbox.end();
    let Some(tx) = c.tx.take() else { return false };
    tx.send(Cmd::Shutdown { done }).is_ok()
}

#[cfg(desktop)]
mod imp {
    //! The control worker over the shared transport (urx-device's `urx-device-transport`).
    //!
    //! The transport owns the wire: discovery, the connection's own worker and reader
    //! threads, request/reply matching, the registration of notification addresses and
    //! the delivery of what they announce. What stays here is the app's side of it: the
    //! `Cmd` queue the Tauri commands feed, the error codes the frontend localizes, the
    //! Tauri channels a notification goes out on, the link-lost event and the ledger.
    use super::package;
    use super::{
        Cmd, DeviceSummary, LinkCounters, LinkEvent, MeterUpdate, Outbox, PackageLink, ParamUpdate,
        Run, BULK_CHANGE, CONSOLE_LOCK_PARAM, CONTROL_WORKER_GONE, LOCK_HAND_ON_WAIT, NOT_SENT,
        WRITES_HELD,
    };
    use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use tauri::ipc::Channel;
    use urx_device_transport::connection::{
        open_observed, CloseOutcome, Connection, ConnectionOptions, LinkFailure, LinkLoss,
        NotificationHandler, ReceiptObserver, SendGate, Subscription,
    };
    use urx_device_transport::delivery::NotificationBatch;
    use urx_device_transport::discovery::{discover, DiscoveryOptions, SystemFirmware};
    use urx_device_transport::lifecycle::{Cause, Control, Failure, LifecycleFailure};
    use urx_device_transport::request::{
        Evidence, Outcome, ReadValue, Request, RequestCause, RequestFailure,
    };
    use urx_device_transport::subscription::{SubscriptionAddress, TokenId};
    use urx_device_transport::wire::{MeterAddress, NameValue, Notification, ParameterAddress};

    /// Device Center's device-list port.
    pub(super) const VDDP_SRV_PORT: u16 = 51770;

    /// The whole discovery: the device list and each listed unit's identity check.
    const DISCOVERY_TIMEOUT: Duration = Duration::from_secs(3);

    /// Each request's send deadline and, once sent, its response deadline: the 3 s every
    /// get and set has always had.
    const REQUEST_DEADLINE: Duration = Duration::from_secs(3);

    /// Opening: connecting, the identity check and the firmware read.
    const CONNECT_DEADLINE: Duration = Duration::from_secs(6);

    /// How long a close waits for the unregistrations and the threads when nothing
    /// bounds it more tightly (the app-exit teardown does).
    const CLOSE_TEARDOWN: Duration = Duration::from_secs(2);

    /// Prefix every device-lost error carries: the unit went away while the link stayed.
    pub(super) const DEVICE_LOST_PREFIX: &str = "device-lost";

    /// Prefix the command whose response deadline passed carries. The transport ends
    /// the connection on that deadline (N1), so the commands after it fail as
    /// unresponsive.
    pub(super) const BROKER_TIMEOUT_PREFIX: &str = "broker-timeout";

    /// The code the session ends with once a response deadline has passed. Distinct
    /// from device-lost: the unit may well be attached and fine — it is the broker that
    /// has stopped talking to us.
    pub(super) const BROKER_UNRESPONSIVE: &str = "broker-unresponsive";

    /// The handler each kind's notifications go to, with the token whose addresses it
    /// carries. A notification reaches a handler only when that handler's token is among
    /// its recipients: the transport hands over only what a token registered, so a notify
    /// meant for another client, or the unit's own clock, never reaches the follow layer.
    #[derive(Default)]
    struct Routes {
        meters: Route,
        params: Route,
        probe: Route,
    }

    /// One kind's handlers: the current token's, and every one it replaced in this
    /// session. A replacement switches to the new token while the old one can still have
    /// notifications queued for it, received before the switch; those still go to the old
    /// token's own handler, however many switches later they are delivered. A
    /// notification several of the tokens received goes once, to the newest one's. The
    /// replaced handlers are kept until the kind is unsubscribed or the session ends, one
    /// per replacement: the transport says nothing of when a token's queued
    /// notifications have all been delivered.
    struct Route<Id = TokenId> {
        current: Option<(Id, u64)>,
        /// Oldest first.
        replaced: Vec<(Id, u64)>,
    }

    impl<Id> Default for Route<Id> {
        fn default() -> Self {
            Route {
                current: None,
                replaced: Vec::new(),
            }
        }
    }

    impl<Id: PartialEq> Route<Id> {
        fn switch(&mut self, token: Id, handler: u64) {
            self.replaced.extend(self.current.take());
            self.current = Some((token, handler));
        }

        fn clear(&mut self) {
            self.current = None;
            self.replaced.clear();
        }

        /// The handler a notification goes to: the current token's when it is a recipient,
        /// else the newest replaced token's that is, else none.
        fn pick(&self, recipients: &[Id]) -> Option<u64> {
            let holds = |(token, _): &&(Id, u64)| recipients.contains(token);
            self.current
                .iter()
                .find(holds)
                .or_else(|| self.replaced.iter().rev().find(holds))
                .map(|(_, handler)| *handler)
        }
    }

    /// The runs of one batch, in receive order: consecutive updates for the same kind
    /// and handler go into one run.
    #[derive(Default)]
    struct Runs(Vec<Run>);

    impl Runs {
        fn meter(&mut self, handler: u64, update: MeterUpdate) {
            if let Some(Run::Meters {
                handler: last,
                updates,
            }) = self.0.last_mut()
            {
                if *last == handler {
                    return updates.push(update);
                }
            }
            self.0.push(Run::Meters {
                handler,
                updates: vec![update],
            });
        }

        fn param(&mut self, probe: bool, handler: u64, update: ParamUpdate) {
            match self.0.last_mut() {
                Some(Run::Params {
                    handler: last,
                    updates,
                }) if !probe && *last == handler => return updates.push(update),
                Some(Run::Probe {
                    handler: last,
                    updates,
                }) if probe && *last == handler => return updates.push(update),
                _ => {}
            }
            let updates = vec![update];
            self.0.push(if probe {
                Run::Probe { handler, updates }
            } else {
                Run::Params { handler, updates }
            });
        }
    }

    /// The unit's announcement of its Console Lock, on or off, when `payload` is one: the one
    /// test the receipt observer and the delivery share, so they count the same announcements.
    fn console_lock(payload: &Notification) -> Option<bool> {
        match payload {
            Notification::Numeric { address, value }
                if address.param_id == CONSOLE_LOCK_PARAM && (address.x, address.y) == (0, 0) =>
            {
                Some(*value != 0)
            }
            _ => None,
        }
    }

    /// One batch the transport delivered, put in the outbox as runs in receive order,
    /// then acknowledged so the next batch can form.
    fn forward(
        routes: &Mutex<Routes>,
        outbox: &Outbox,
        connection: &OnceLock<Arc<Connection>>,
        batch: NotificationBatch,
    ) {
        let mut runs = Runs::default();
        // How many announcements of Console Lock, on or off, the batch carries: every one,
        // routed or not, as the receipt observer hears every one (`hear`).
        let mut announcements = 0;
        {
            let routes = routes.lock().unwrap_or_else(|p| p.into_inner());
            for record in &batch.records {
                match &record.payload {
                    Notification::Meter { address, value } => {
                        if let Some(handler) = routes.meters.pick(&record.recipients) {
                            runs.meter(
                                handler,
                                MeterUpdate {
                                    meter_id: address.meter_id,
                                    x: address.x,
                                    value: *value,
                                },
                            );
                        }
                    }
                    payload => {
                        if console_lock(payload).is_some() {
                            announcements += 1;
                        }
                        let update = match payload {
                            Notification::Numeric { address, value } => ParamUpdate {
                                param_id: address.param_id,
                                x: address.x,
                                y: address.y,
                                value: *value,
                                value_str: None,
                            },
                            Notification::Text { address, value } => ParamUpdate {
                                param_id: address.param_id,
                                x: address.x,
                                y: address.y,
                                value: 0,
                                value_str: Some(value.clone()),
                            },
                            Notification::BulkChange => BULK_CHANGE,
                            Notification::Meter { .. } => unreachable!("matched above"),
                        };
                        let to_params = routes.params.pick(&record.recipients);
                        let to_probe = routes.probe.pick(&record.recipients);
                        if let Some(handler) = to_params {
                            runs.param(false, handler, update.clone());
                        }
                        if let Some(handler) = to_probe {
                            runs.param(true, handler, update);
                        }
                    }
                }
            }
        }
        // Outside the routes lock: a subscribe switching routes must not wait on the page.
        outbox.put(runs.0, announcements);
        if let Some(connection) = connection.get() {
            connection.adopt_notifications(batch.ticket);
        }
    }

    /// The text a discovery's or an opening's failure reaches the frontend as. A link the
    /// unit going offline ended is device-lost and a socket error is broker-io, kept apart
    /// from the peer closing the stream as before the shared transport; `while_it_was` says
    /// what the unit was going through.
    fn link_failure_text(failed: &LinkFailure, while_it_was: &str) -> String {
        match failed.lost_link {
            Some(LinkLoss::UnitLost) => {
                format!("{DEVICE_LOST_PREFIX}: the unit went offline while it was {while_it_was}")
            }
            Some(LinkLoss::SocketError(kind)) => format!("broker-io: {kind:?}"),
            Some(LinkLoss::PeerClosed) | None => lifecycle_text(&failed.failure),
        }
    }

    /// The text a failure reaches the frontend as: `<code>` or `<code>: <detail>`, the
    /// codes `src/i18n/index.ts` (`SHELL_CODES`) localizes.
    fn lifecycle_text(failure: &Failure) -> String {
        match failure {
            Failure::Cancelled { phase } => {
                format!("{CONTROL_WORKER_GONE}: cancelled in {phase:?}")
            }
            Failure::Cause { code, phase } => match code {
                Cause::ConnectionFailed => format!("broker-unreachable: {phase:?}"),
                Cause::DiscoveryTimeout | Cause::ConnectTimeout => {
                    format!("broker-timeout: {phase:?}")
                }
                Cause::SendTimeout | Cause::ResponseTimeout => format!("broker-timeout: {phase:?}"),
                Cause::TeardownTimeout => "broker-timeout: teardown".to_string(),
                Cause::DeviceNotFound => "no-device".to_string(),
                Cause::InvalidResponse | Cause::IdentityError => {
                    format!("broker-bad-response: {phase:?}")
                }
                Cause::DeviceRejected => format!("broker-rejected: {phase:?}"),
                Cause::ConnectionLost => format!("broker-closed: {phase:?}"),
                Cause::NotConnected => "not-connected".to_string(),
                Cause::PreconditionFailed => format!("broker-io: {phase:?} refused locally"),
                Cause::NotificationOverflow => "broker-io: notification overflow".to_string(),
                Cause::InternalError => CONTROL_WORKER_GONE.to_string(),
            },
        }
    }

    /// The text of the session's end once it has ended, which every later command fails with
    /// too: the connection's recorded end, or the control package's end of it for a result the
    /// page could not take, whose close records none (`package::ENDED`).
    fn session_end(connection: &Connection, package: &PackageLink) -> Option<String> {
        match connection.terminal() {
            Some(cause) => Some(ended_text(connection, cause)),
            None => package.ended().then(|| package::ENDED.to_string()),
        }
    }

    /// The text of the cause that ended the connection, which every later command fails
    /// with too.
    fn ended_text(connection: &Connection, cause: RequestCause) -> String {
        match cause {
            RequestCause::ConnectionLost => match connection.lost_link() {
                Some(LinkLoss::UnitLost) => format!("{DEVICE_LOST_PREFIX}: the unit went offline"),
                Some(LinkLoss::PeerClosed) | None => "broker-closed".to_string(),
                Some(LinkLoss::SocketError(kind)) => format!("broker-io: {kind:?}"),
            },
            // The command whose deadline passed failed as broker-timeout; the connection it
            // ended answers everything after it as unresponsive.
            RequestCause::ResponseTimeout => BROKER_UNRESPONSIVE.to_string(),
            RequestCause::NotificationOverflow => "broker-io: notification overflow".to_string(),
            RequestCause::InvalidResponse => "broker-bad-response: the link".to_string(),
            RequestCause::SendTimeout | RequestCause::TeardownTimeout => {
                format!("{BROKER_TIMEOUT_PREFIX}: sending")
            }
            RequestCause::InternalError => CONTROL_WORKER_GONE.to_string(),
            other => format!("broker-io: {other:?}"),
        }
    }

    /// The text one request's failure reaches its caller as. `at` names the address.
    fn request_text(
        connection: &Connection,
        package: &PackageLink,
        failure: RequestFailure,
        evidence: Evidence,
        at: &str,
    ) -> String {
        let RequestFailure::Cause { code, .. } = failure else {
            return format!("{CONTROL_WORKER_GONE}: cancelled");
        };
        // The deadline that ran out the run is still this request's deadline; the
        // commands after it fail with the session's end.
        if code == RequestCause::ResponseTimeout {
            return format!("{BROKER_TIMEOUT_PREFIX}: {at}");
        }
        // The unit's own refusal settled this request; an end that came after it is the
        // next request's to report.
        if let (RequestCause::DeviceRejected, Evidence::Rejected(response)) = (code, &evidence) {
            return format!("broker-rejected: {at} response_code {response}");
        }
        if let Some(ended) = session_end(connection, package) {
            // Whatever this request met, the connection's end is what the session died of.
            return ended;
        }
        match code {
            RequestCause::SendTimeout => format!("{BROKER_TIMEOUT_PREFIX}: sending {at}"),
            RequestCause::DeviceRejected => match evidence {
                Evidence::Rejected(response) => {
                    format!("broker-rejected: {at} response_code {response}")
                }
                _ => format!("broker-rejected: {at}"),
            },
            RequestCause::InvalidResponse => format!("broker-bad-response: {at}"),
            RequestCause::NotConnected => "not-connected".to_string(),
            RequestCause::PreconditionFailed => format!("broker-io: {at} refused locally"),
            RequestCause::InvalidInput => format!("broker-bad-response: {at} could not be framed"),
            other => ended_text(connection, other),
        }
    }

    /// One request, waited for, its result adopted at once; with `gate`, asked just before its
    /// first byte whether it may go out (`Connection::submit_gated`).
    fn request(connection: &Connection, request: Request, gate: Option<SendGate>) -> Outcome {
        let operation = match connection.create_operation() {
            Ok(operation) => operation,
            Err(failure) => {
                return Outcome::Failure {
                    failure,
                    evidence: Evidence::NotSent,
                }
            }
        };
        let (tx, rx) = mpsc::channel();
        let done = move |outcome, adoption: urx_device_transport::connection::ResultAdoption| {
            adoption.adopt();
            let _ = tx.send(outcome);
        };
        match gate {
            Some(gate) => connection.submit_gated(&operation, request, gate, done),
            None => connection.submit(&operation, request, done),
        }
        rx.recv().unwrap_or(Outcome::Failure {
            failure: RequestFailure::Cause {
                code: RequestCause::InternalError,
                phase: urx_device_transport::request::RequestPhase::Delivery,
            },
            evidence: Evidence::Unconfirmed,
        })
    }

    fn address(param_id: u32, x: i64, y: i64) -> ParameterAddress {
        ParameterAddress { param_id, x, y }
    }

    /// A write's send gate for the unit's Console Lock. As it refuses, the outbox records the
    /// write as held on the announcement it was refused on (`Outbox::hold_write`), so the refusal
    /// is worded from that verdict and not from whatever the unit announced after it.
    struct LockGate {
        gate: SendGate,
        /// The write's number in the outbox's record of held writes.
        id: u64,
    }

    impl LockGate {
        fn new(outbox: &Arc<Outbox>) -> Self {
            let (gate, id) = super::lock_gate(outbox);
            LockGate { gate, id }
        }
    }

    /// The refusal of a write the unit's Console Lock held: `writes-held` and the number of the
    /// fetch that hands the page the announcement it was held on, once that is known
    /// (`Outbox::lock_hold`).
    fn held_text(fetch: Option<u64>) -> String {
        match fetch {
            Some(fetch) => {
                format!("{WRITES_HELD}: the unit announced Console Lock (fetch {fetch})")
            }
            None => format!("{WRITES_HELD}: the unit announced Console Lock"),
        }
    }

    /// The worker's view of the session: the connection, the routes its notification
    /// handler reads, and the subscriptions it holds.
    struct Session {
        connection: Arc<Connection>,
        routes: Arc<Mutex<Routes>>,
        counters: Arc<LinkCounters>,
        /// The page's notifications, whose Console Lock the shell holds the writes on
        /// until the page has it.
        outbox: Arc<Outbox>,
        /// The control package's requests on the same connection, whose end for a result the
        /// page could not take is the session's (`session_end`).
        package: Arc<PackageLink>,
        meters: Option<Held>,
        params: Option<Held>,
        probe: Option<Held>,
    }

    /// A subscription in use.
    struct Held {
        subscription: Subscription,
    }

    impl Session {
        /// Runs a parameter command and keeps the ledger's deadline rows: a missed
        /// deadline adds to the total, and the run is the transport's. The get and set rows
        /// are the transport's count of what reached the socket (`LinkCounters::frames`); a
        /// command it refused before sending — the session already over included — is
        /// worded by the session's end (`request_text`).
        fn run(&mut self, req: Request, at: &str) -> Result<Option<ReadValue>, String> {
            self.run_with(req, at, None)
        }

        /// `run`, with the send gate of the unit's Console Lock when `gate` is given: a request
        /// the gate held fails as the write the lock holds (`held_text`), on the gate's own
        /// verdict, whatever the unit announced after it.
        fn run_with(
            &mut self,
            req: Request,
            at: &str,
            gate: Option<LockGate>,
        ) -> Result<Option<ReadValue>, String> {
            let write = matches!(req, Request::SetNumeric(..) | Request::SetText(..));
            let (send_gate, hold) = match gate {
                Some(LockGate { gate, id }) => (Some(gate), Some(id)),
                None => (None, None),
            };
            let outcome = request(&self.connection, req, send_gate);
            #[cfg(test)]
            self.outbox.after_request();
            match outcome {
                Outcome::Success { value, .. } => Ok(value),
                Outcome::Failure { failure, evidence } => {
                    // A write the gate held is refused as held, on the gate's record.
                    if let Some(fetch) =
                        hold.and_then(|id| self.outbox.lock_hold(id, LOCK_HAND_ON_WAIT))
                    {
                        return Err(held_text(fetch));
                    }
                    if matches!(
                        failure,
                        RequestFailure::Cause {
                            code: RequestCause::ResponseTimeout,
                            ..
                        }
                    ) {
                        self.counters.note_deadline();
                    }
                    let text = request_text(&self.connection, &self.package, failure, evidence, at);
                    // A write the transport never sent says so, whatever its cause.
                    Err(if write && evidence == Evidence::NotSent {
                        format!("{NOT_SENT}: {text}")
                    } else {
                        text
                    })
                }
            }
        }

        fn get(&mut self, param_id: u32, x: i64, y: i64) -> Result<i64, String> {
            let at = format!("{param_id}:{x}:{y}");
            match self.run(Request::GetNumeric(address(param_id, x, y)), &at)? {
                Some(ReadValue::Numeric(value)) => Ok(value),
                _ => Err("broker-bad-response: value was not an integer".to_string()),
            }
        }

        /// A name reads as the broker's preset index (a number) until one is typed, then
        /// as the literal string; a number decodes to "", so callers see "no custom name".
        fn get_str(&mut self, param_id: u32, x: i64, y: i64) -> Result<String, String> {
            let at = format!("{param_id}:{x}:{y}");
            match self.run(Request::GetName(address(param_id, x, y)), &at)? {
                Some(ReadValue::Name(NameValue::Text(text))) | Some(ReadValue::Text(text)) => {
                    Ok(text)
                }
                Some(ReadValue::Name(NameValue::Integer(_))) => Ok(String::new()),
                _ => Err("broker-bad-response: value was not a name".to_string()),
            }
        }

        /// A write, refused before its first byte from the transport's receipt of the unit's
        /// announcement of Console Lock to its receipt of the lock off: the page holds its
        /// writes once it has the lock, and a write it handed over before then would reach a
        /// locked unit. The transport asks the hold just before the first byte would go out
        /// (`Connection::submit_gated`), under the gate it takes each announcement under, so a
        /// lock received at any point before that byte holds the write (`held_text`).
        fn set(&mut self, req: Request, at: String) -> Result<(), String> {
            let gate = LockGate::new(&self.outbox);
            self.run_with(req, &at, Some(gate)).map(|_| ())
        }

        /// Replaces one subscription: a new token for `addresses`, switched to, then the
        /// old token released (K10). The token and its route come into being in one step
        /// under the routes lock, which the delivery thread takes for every batch, so
        /// nothing the new token receives is judged before its route is installed: one
        /// that arrives while the registrations are in flight is judged by the NEW set and
        /// goes to the NEW handler, and what the old token received before the switch
        /// still goes to the old one (`Route`). Registration runs one address at a
        /// time with each verdict checked (K9); the reply carries the first failure, of
        /// the registrations or of the old token's release. A refused subscribe leaves
        /// nothing subscribed for its handler: the transport releases a token whose
        /// activation failed, unregistering what it had registered, and the previous token
        /// is released as on success, so neither set is left installed.
        fn subscribe(
            &mut self,
            which: Which,
            addresses: Vec<SubscriptionAddress>,
            install: impl FnOnce(&mut Routes, TokenId),
        ) -> Result<(), String> {
            if let Some(ended) = session_end(&self.connection, &self.package) {
                return Err(ended);
            }
            let operation = self.connection.create_operation().map_err(|failure| {
                request_text(
                    &self.connection,
                    &self.package,
                    failure,
                    Evidence::NotSent,
                    "a registration",
                )
            })?;
            let new = {
                let mut routes = self.routes.lock().unwrap_or_else(|p| p.into_inner());
                let new = self
                    .connection
                    .prepare_subscription(&addresses)
                    .map_err(|failure| self.lifecycle_failure_text(&failure))?;
                install(&mut routes, new.token());
                new
            };
            let (tx, rx) = mpsc::channel();
            new.activate(&operation, move |outcome| {
                let _ = tx.send(outcome);
            });
            let activated = match rx.recv() {
                Ok(Ok(())) => Ok(()),
                Ok(Err(failure)) => Err(self.lifecycle_failed(&failure)),
                Err(_) => Err(CONTROL_WORKER_GONE.to_string()),
            };
            let replaced = self.slot(which).replace(Held { subscription: new });
            let mut released = Ok(());
            if let Some(old) = replaced {
                released = self.release(&old.subscription);
            }
            if activated.is_err() {
                if let Some(failed) = self.slot(which).take() {
                    // The activation's own failure is what the reply carries.
                    let _ = self.release(&failed.subscription);
                }
            }
            activated.and(released)
        }

        /// Takes a subscription away. A release that fails ends the connection, and the
        /// link watch reports that end; the call itself has no reply to carry it.
        fn unsubscribe(&mut self, which: Which, clear: impl FnOnce(&mut Routes)) {
            clear(&mut self.routes.lock().unwrap_or_else(|p| p.into_inner()));
            if let Some(old) = self.slot(which).take() {
                let _ = self.release(&old.subscription);
            }
        }

        /// Releases a token and waits for the outcome: what it was the last holder of is
        /// unregistered, and a failure ends the connection (K10).
        fn release(&self, subscription: &Subscription) -> Result<(), String> {
            let (tx, rx) = mpsc::channel();
            subscription.release(move |outcome| {
                let _ = tx.send(outcome);
            });
            match rx.recv() {
                Ok(Ok(())) => Ok(()),
                Ok(Err(failure)) => Err(self.lifecycle_failed(&failure)),
                Err(_) => Err(CONTROL_WORKER_GONE.to_string()),
            }
        }

        /// A registration's or an unregistration's failure, the ledger's deadline row
        /// kept: a response deadline that ran out there ended the connection (N1) as one
        /// in a parameter command does.
        fn lifecycle_failed(&self, failure: &LifecycleFailure) -> String {
            let deadline = |failure: &Failure| {
                matches!(
                    failure,
                    Failure::Cause {
                        code: Cause::ResponseTimeout,
                        ..
                    }
                )
            };
            if deadline(&failure.failure) || failure.cleanup.failure.as_ref().is_some_and(deadline)
            {
                self.counters.note_deadline();
            }
            self.lifecycle_failure_text(failure)
        }

        fn slot(&mut self, which: Which) -> &mut Option<Held> {
            match which {
                Which::Meters => &mut self.meters,
                Which::Params => &mut self.params,
                Which::Probe => &mut self.probe,
            }
        }

        /// The text a registration's or a release's caller is told, with the precedence
        /// `request_text` gives a request: the unit's own refusal and this operation's own
        /// deadline settled it, and an end of the connection that came with or after them
        /// is the link watch's and the later commands' to report.
        fn lifecycle_failure_text(&self, failure: &LifecycleFailure) -> String {
            if let Failure::Cause {
                code: Cause::DeviceRejected | Cause::ResponseTimeout,
                ..
            } = failure.failure
            {
                return lifecycle_text(&failure.failure);
            }
            if let Some(ended) = session_end(&self.connection, &self.package) {
                return ended;
            }
            lifecycle_text(&failure.failure)
        }
    }

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Which {
        Meters,
        Params,
        Probe,
    }

    /// Discovery picks the unit: the one online unit, or among several the one of the
    /// model the caller selected. When that still leaves zero or several (two units of
    /// one model, or none of the selected one), the connect stops with
    /// `multiple-devices`: a session addresses one unit, and guessing which would write
    /// to a unit the operator did not mean.
    pub(super) fn choose_online<T>(
        online: Vec<(T, String)>,
        preferred: &str,
    ) -> Result<(T, String), String> {
        if online.len() <= 1 {
            return online
                .into_iter()
                .next()
                .ok_or_else(|| "no-device".to_string());
        }
        let models: Vec<String> = online.iter().map(|(_, m)| m.clone()).collect();
        let mut matching: Vec<(T, String)> =
            online.into_iter().filter(|(_, m)| m == preferred).collect();
        if matching.len() == 1 {
            return Ok(matching.remove(0));
        }
        Err(format!(
            "multiple-devices: {} online ({}), {} of them {preferred}",
            models.len(),
            models.join(", "),
            matching.len()
        ))
    }

    pub fn worker(
        rx: Receiver<Cmd>,
        ready: Sender<Result<DeviceSummary, String>>,
        counters: Arc<LinkCounters>,
        outbox: Arc<Outbox>,
        package: Arc<PackageLink>,
        preferred: &str,
    ) {
        worker_at(
            VDDP_SRV_PORT,
            REQUEST_DEADLINE,
            rx,
            ready,
            counters,
            outbox,
            package,
            preferred,
        )
    }

    /// The worker, against a device list on `list_port` (Device Center's own outside
    /// tests), with `deadline` as each request's send and response deadline.
    #[allow(clippy::too_many_arguments)]
    pub(super) fn worker_at(
        list_port: u16,
        deadline: Duration,
        rx: Receiver<Cmd>,
        ready: Sender<Result<DeviceSummary, String>>,
        counters: Arc<LinkCounters>,
        outbox: Arc<Outbox>,
        package: Arc<PackageLink>,
        preferred: &str,
    ) {
        let control = Control::new();
        let discovery = DiscoveryOptions {
            list_port,
            deadline: DISCOVERY_TIMEOUT,
            request_deadline: deadline,
            metadata: false,
        };
        let online = match discover(&discovery, &control) {
            Ok(entries) => entries
                .into_iter()
                .map(|e| {
                    let model = e.model.clone();
                    (e, model)
                })
                .collect::<Vec<_>>(),
            Err(failed) => {
                let e = link_failure_text(&failed, "listed");
                eprintln!("vd: could not open the device link: {e}");
                let _ = ready.send(Err(e));
                return;
            }
        };
        let (entry, model) = match choose_online(online, preferred) {
            Ok(v) => v,
            Err(e) => {
                let _ = ready.send(Err(e));
                return;
            }
        };
        let routes = Arc::new(Mutex::new(Routes::default()));
        let slot: Arc<OnceLock<Arc<Connection>>> = Arc::new(OnceLock::new());
        let handler: NotificationHandler = {
            let routes = Arc::clone(&routes);
            let outbox = Arc::clone(&outbox);
            let slot = Arc::clone(&slot);
            Arc::new(move |batch| forward(&routes, &outbox, &slot, batch))
        };
        // Console Lock is taken as the transport receives it, so the next write is held at
        // once, however long the batch that carries it waits for the page.
        let observer: ReceiptObserver = {
            let outbox = Arc::clone(&outbox);
            Arc::new(move |record| {
                if let Some(on) = console_lock(&record.payload) {
                    outbox.hear(on);
                }
            })
        };
        let options = ConnectionOptions {
            connect_deadline: CONNECT_DEADLINE,
            handshake_request_deadline: deadline,
            send_deadline: deadline,
            response_deadline: deadline,
        };
        let connection =
            match open_observed(entry.port, &entry.id, &options, &control, handler, observer) {
                Ok(connection) => Arc::new(connection),
                Err(failed) => {
                    // Device Center answers the firmware read from its cache once the unit is
                    // unplugged; its push is the only sign, and the link records it.
                    let text = link_failure_text(&failed, "opened");
                    let _ = ready.send(Err(text));
                    return;
                }
            };
        let _ = slot.set(Arc::clone(&connection));
        package.attach(Arc::clone(&connection));
        let summary = DeviceSummary {
            // The device list carries no label, and a unit's label and model name are the
            // same, so the model stands in for it.
            label: model.clone(),
            model,
            // Three-valued: a version, "" for a list read in full with no System entry,
            // and None when the version cannot be read from it.
            firmware: match connection.firmware() {
                SystemFirmware::Version(version) => Some(version.clone()),
                SystemFirmware::Absent => Some(String::new()),
                SystemFirmware::Unreadable => None,
            },
        };
        if ready.send(Ok(summary)).is_err() {
            connection.close(CLOSE_TEARDOWN);
            return;
        }
        // The ledger's frame and request rows are what the connection has written, read at
        // each reading: a frame or a request counts once it is on the socket, whether the
        // call that sent it has its answer yet or not.
        let source = Arc::downgrade(&connection);
        counters.read_frames_with(Box::new(move || {
            source.upgrade().map(|connection| connection.sent_frames())
        }));
        let session = Session {
            connection,
            routes,
            counters,
            outbox: Arc::clone(&outbox),
            package,
            meters: None,
            params: None,
            probe: None,
        };
        serve(session, rx);
        // The session is over: a fetch waiting on its outbox gets the end.
        outbox.end();
    }

    /// Answers commands until a Shutdown (or until every sender is gone), and closes the
    /// connection on the way out.
    fn serve(mut session: Session, rx: Receiver<Cmd>) {
        // The channel to push the one-shot link-lost event on: a held-open live session is
        // dropped instead of freezing when the link ends while idle.
        let mut link_ch: Option<Channel<LinkEvent>> = None;
        // The end, once noticed, and whether the watch has been told of it.
        let mut ended: Option<String> = None;
        let mut announced = false;
        let mut exit_done: Option<(Sender<()>, Instant)> = None;
        loop {
            match rx.recv_timeout(Duration::from_millis(50)) {
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
                    let req = Request::SetNumeric(address(param_id, x, y), value);
                    let _ = reply.send(session.set(req, format!("{param_id}:{x}:{y}")));
                }
                Ok(Cmd::Get {
                    param_id,
                    x,
                    y,
                    reply,
                }) => {
                    let _ = reply.send(session.get(param_id, x, y));
                }
                Ok(Cmd::SetStr {
                    param_id,
                    x,
                    y,
                    value,
                    reply,
                }) => {
                    let req = Request::SetText(address(param_id, x, y), value);
                    let _ = reply.send(session.set(req, format!("{param_id}:{x}:{y}")));
                }
                Ok(Cmd::GetStr {
                    param_id,
                    x,
                    y,
                    reply,
                }) => {
                    let _ = reply.send(session.get_str(param_id, x, y));
                }
                Ok(Cmd::MetersSubscribe {
                    addrs,
                    handler,
                    reply,
                }) => {
                    LinkCounters::bump(&session.counters.meter_subscribes);
                    let addresses = addrs
                        .into_iter()
                        .map(|(meter_id, x)| {
                            SubscriptionAddress::Meter(MeterAddress { meter_id, x })
                        })
                        .collect();
                    let _ =
                        reply.send(
                            session.subscribe(Which::Meters, addresses, |routes, token| {
                                routes.meters.switch(token, handler);
                            }),
                        );
                }
                Ok(Cmd::MetersUnsubscribe) => {
                    session.unsubscribe(Which::Meters, |routes| routes.meters.clear())
                }
                Ok(Cmd::ParamsSubscribe {
                    addrs,
                    handler,
                    reply,
                }) => {
                    LinkCounters::bump(&session.counters.param_subscribes);
                    let addresses = parameter_addresses(addrs);
                    let _ =
                        reply.send(
                            session.subscribe(Which::Params, addresses, |routes, token| {
                                routes.params.switch(token, handler);
                            }),
                        );
                }
                Ok(Cmd::ParamsUnsubscribe) => {
                    session.unsubscribe(Which::Params, |routes| routes.params.clear())
                }
                Ok(Cmd::ProbeSubscribe {
                    addrs,
                    handler,
                    reply,
                }) => {
                    let addresses = parameter_addresses(addrs);
                    let _ =
                        reply.send(session.subscribe(Which::Probe, addresses, |routes, token| {
                            routes.probe.switch(token, handler);
                        }));
                }
                Ok(Cmd::WatchLink { channel }) => link_ch = Some(channel),
                Err(RecvTimeoutError::Timeout) => {}
            }
            // The link ending while nothing asks: the event goes out once, with the code
            // every later command then fails with.
            if ended.is_none() {
                if let Some(reason) = session_end(&session.connection, &session.package) {
                    eprintln!("vd: {reason}; the session is lost until a reconnect");
                    ended = Some(reason);
                }
            }
            if let (Some(reason), Some(channel), false) = (&ended, &link_ch, announced) {
                let _ = channel.send(LinkEvent {
                    reason: reason.clone(),
                });
                announced = true;
            }
        }
        // EVERY break above lands here: the session's one exit.
        let teardown = exit_done.as_ref().map_or(CLOSE_TEARDOWN, |(_, by)| {
            by.saturating_duration_since(Instant::now())
        });
        match session.connection.close(teardown) {
            CloseOutcome::Closed | CloseOutcome::Started => {}
            // The socket is closed, or shut down, either way: what the close could not
            // finish is told here, since nothing after this reads the session.
            unfinished => eprintln!("vd: the session's close did not finish: {unfinished:?}"),
        }
        // Sent LAST, so the app-exit path is released by the close having happened and
        // not merely by the intent to close.
        if let Some((done, _)) = exit_done.take() {
            let _ = done.send(());
        }
    }

    fn parameter_addresses(addrs: Vec<(u32, i64, i64)>) -> Vec<SubscriptionAddress> {
        addrs
            .into_iter()
            .map(|(param_id, x, y)| SubscriptionAddress::Parameter(address(param_id, x, y)))
            .collect()
    }

    #[cfg(test)]
    mod adapter_tests {
        // The worker over the shared transport, against a fake Device Center: a device
        // list on one port and units on others, each answering as a case says. A case
        // waits for what the worker sends back, under a bound, so none depends on a
        // peer's timing.
        use super::super::{
            get, get_str, meters_subscribe, params_subscribe, params_unsubscribe, probe_subscribe,
            set, set_str, watch_link, Cmd, DeviceSummary, LinkCounters, Outbox, PackageLink,
            BULK_CHANGE,
        };
        use super::{
            link_failure_text, request_text, worker_at, Route, Runs, BROKER_UNRESPONSIVE,
            CONNECT_DEADLINE, CONSOLE_LOCK_PARAM, DEVICE_LOST_PREFIX, NOT_SENT, WRITES_HELD,
        };
        use crate::vd::package::{Call, Method};
        use serde_json::{json, Value};
        use std::io::{BufRead, BufReader, Write};
        use std::net::{TcpListener, TcpStream};
        use std::sync::{mpsc, Arc, Mutex};
        use std::thread;
        use std::time::{Duration, Instant};
        use tauri::ipc::{Channel, InvokeResponseBody};
        use urx_device_transport::connection::{
            open_with, ConnectionOptions, LinkFailure, LinkLoss,
        };
        use urx_device_transport::lifecycle::{Cause, Control, Failure, Phase};
        use urx_device_transport::request::{Evidence, RequestCause, RequestFailure, RequestPhase};

        type Answer = Arc<dyn Fn(&Value) -> Vec<Value> + Send + Sync>;

        /// One unit Device Center lists: its vdp port, the requests it received, and the
        /// writer of its latest connection, for what it pushes on its own.
        struct Unit {
            port: u16,
            seen: Arc<Mutex<Vec<String>>>,
            latest: Arc<Mutex<Option<TcpStream>>>,
        }

        impl Unit {
            /// A unit that opens as `id`, online, with System firmware 1.5.0.1, and answers
            /// everything else as `answer` says.
            fn start(
                id: &'static str,
                answer: impl Fn(&Value) -> Vec<Value> + Send + Sync + 'static,
            ) -> Unit {
                Unit::serving(move |request| {
                    opening(id, request).unwrap_or_else(|| answer(request))
                })
            }

            /// A unit that answers every request, the opening's included, as `answer` says.
            fn serving(answer: impl Fn(&Value) -> Vec<Value> + Send + Sync + 'static) -> Unit {
                let answer: Answer = Arc::new(answer);
                let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
                let port = listener.local_addr().unwrap().port();
                let seen = Arc::new(Mutex::new(Vec::new()));
                let latest = Arc::new(Mutex::new(None));
                let (seen_in, latest_in) = (Arc::clone(&seen), Arc::clone(&latest));
                thread::spawn(move || {
                    for stream in listener.incoming() {
                        let Ok(stream) = stream else { return };
                        stream.set_nodelay(true).unwrap();
                        *latest_in.lock().unwrap() = Some(stream.try_clone().unwrap());
                        let (answer, seen) = (Arc::clone(&answer), Arc::clone(&seen_in));
                        thread::spawn(move || serve_unit(stream, answer, seen));
                    }
                });
                Unit { port, seen, latest }
            }

            /// A frame the unit sends on its own, on the connection the worker holds.
            fn push(&self, vdp: Value) {
                let mut latest = self.latest.lock().unwrap();
                let stream = latest.as_mut().expect("a connection is open");
                stream
                    .write_all(format!("{}\n", json!({ "vdp": vdp })).as_bytes())
                    .unwrap();
            }

            /// Bytes the unit writes on its own, as they are: part of a line, or one that is
            /// not JSON.
            fn push_raw(&self, bytes: &[u8]) {
                let mut latest = self.latest.lock().unwrap();
                let stream = latest.as_mut().expect("a connection is open");
                stream.write_all(bytes).unwrap();
            }

            /// Ends the worker's connection from the unit's side.
            fn close(&self) {
                let latest = self.latest.lock().unwrap();
                latest
                    .as_ref()
                    .unwrap()
                    .shutdown(std::net::Shutdown::Both)
                    .unwrap();
            }

            fn seen(&self) -> Vec<String> {
                self.seen.lock().unwrap().clone()
            }
        }

        fn serve_unit(stream: TcpStream, answer: Answer, seen: Arc<Mutex<Vec<String>>>) {
            let mut writer = stream.try_clone().unwrap();
            for line in BufReader::new(stream).lines() {
                let Ok(line) = line else { return };
                let Ok(request) = serde_json::from_str::<Value>(&line) else {
                    return;
                };
                let vdp = &request["vdp"];
                let uri = vdp["uri"].as_str().unwrap_or("").to_string();
                seen.lock().unwrap().push(uri);
                for reply in answer(&request) {
                    // `{"raw": ...}` is written as it is: a line that is not JSON.
                    let bytes = match reply.get("raw").and_then(Value::as_str) {
                        Some(raw) => raw.as_bytes().to_vec(),
                        None => format!("{}\n", json!({ "vdp": reply })).into_bytes(),
                    };
                    if writer.write_all(&bytes).is_err() {
                        return;
                    }
                }
            }
        }

        /// The opening's two reads as a unit answers them online as `id`: its link state and
        /// its firmware.
        fn opening(id: &str, request: &Value) -> Option<Vec<Value>> {
            match request["vdp"]["uri"].as_str()? {
                "/vd/synchronize" => Some(vec![status_reply(id, "online")]),
                "/vd/device" => Some(vec![device_reply(
                    json!([{ "firm_name": "System", "firm_version": "1.5.0.1" }]),
                )]),
                _ => None,
            }
        }

        fn status_reply(id: &str, status: &str) -> Value {
            json!({ "method": "get", "uri": "/vd/synchronize",
                "data": { "response_code": 200, "sync_status": status, "usb_id": id } })
        }

        fn device_reply(firm_list: Value) -> Value {
            json!({ "method": "get", "uri": "/vd/device",
                "data": { "response_code": 200, "firm_list": firm_list } })
        }

        fn synchronize(status: &str) -> Value {
            json!({ "method": "notify", "uri": "/vd/synchronize", "data": { "sync_status": status } })
        }

        /// Device Center's device list, naming each unit by its model.
        fn device_list(units: &[(&Unit, &str)]) -> u16 {
            let list: Vec<Value> = units
                .iter()
                .map(|(u, model)| json!({ "vdpport": u.port, "model": model }))
                .collect();
            list_server(vec![
                json!({ "method": "get", "uri": "/vddp_srv/devices", "data": { "list": list } }),
            ])
        }

        /// Device Center's list port, answering each request with `frames`, in order.
        fn list_server(frames: Vec<Value>) -> u16 {
            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let port = listener.local_addr().unwrap().port();
            thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(stream) = stream else { return };
                    let frames = frames.clone();
                    thread::spawn(move || {
                        let mut writer = stream.try_clone().unwrap();
                        for line in BufReader::new(stream).lines() {
                            let Ok(_) = line else { return };
                            for frame in &frames {
                                let reply = json!({ "vddp": frame });
                                let _ = writer.write_all(format!("{reply}\n").as_bytes());
                            }
                        }
                    });
                }
            });
            port
        }

        /// Answers a GET with `current_value: 7` and every POST with `response_code: 200`.
        fn plain(request: &Value) -> Vec<Value> {
            let vdp = &request["vdp"];
            let uri = vdp["uri"].as_str().unwrap();
            match vdp["method"].as_str().unwrap() {
                "get" => vec![
                    json!({ "method": "get", "uri": uri, "data": { "response_code": 200, "current_value": 7 } }),
                ],
                _ => {
                    vec![json!({ "method": "post", "uri": uri, "data": { "response_code": 200 } })]
                }
            }
        }

        const DEADLINE: Duration = Duration::from_millis(200);

        fn start(
            list_port: u16,
            preferred: &str,
        ) -> (
            mpsc::Sender<Cmd>,
            Result<DeviceSummary, String>,
            Arc<LinkCounters>,
        ) {
            start_within(list_port, preferred, DEADLINE)
        }

        /// `start` with a request deadline of the case's own.
        fn start_within(
            list_port: u16,
            preferred: &str,
            deadline: Duration,
        ) -> (
            mpsc::Sender<Cmd>,
            Result<DeviceSummary, String>,
            Arc<LinkCounters>,
        ) {
            let (tx, rx) = mpsc::channel();
            let (ready_tx, ready_rx) = mpsc::channel();
            let counters = Arc::new(LinkCounters::default());
            let outbox = Arc::new(Outbox::default());
            OUTBOX.with(|current| *current.borrow_mut() = Some(Arc::clone(&outbox)));
            let package = Arc::new(PackageLink::new(Arc::clone(&counters), Arc::clone(&outbox)));
            PACKAGE.with(|current| *current.borrow_mut() = Some(Arc::clone(&package)));
            FETCHED.with(|next| next.set(0));
            let (worker_counters, preferred) = (Arc::clone(&counters), preferred.to_string());
            thread::spawn(move || {
                worker_at(
                    list_port,
                    deadline,
                    rx,
                    ready_tx,
                    worker_counters,
                    outbox,
                    package,
                    &preferred,
                )
            });
            let summary = ready_rx
                .recv_timeout(Duration::from_secs(10))
                .expect("the worker answers the connect");
            (tx, summary, counters)
        }

        fn connected(
            answer: impl Fn(&Value) -> Vec<Value> + Send + Sync + 'static,
        ) -> (mpsc::Sender<Cmd>, Unit, Arc<LinkCounters>) {
            let unit = Unit::start("<device-id-a>", answer);
            let list = device_list(&[(&unit, "URX44V")]);
            let (tx, summary, counters) = start(list, "URX44V");
            summary.expect("the unit opens");
            (tx, unit, counters)
        }

        thread_local! {
            /// The outbox of the session this case started last, which its subscribers read.
            static OUTBOX: std::cell::RefCell<Option<Arc<Outbox>>> = const { std::cell::RefCell::new(None) };
            /// The control package's requests on the session this case started last.
            static PACKAGE: std::cell::RefCell<Option<Arc<PackageLink>>> = const { std::cell::RefCell::new(None) };
            /// Runs fetched from it that belong to a handler not yet read.
            static HELD: std::cell::RefCell<Vec<Value>> = const { std::cell::RefCell::new(Vec::new()) };
            static NEXT_HANDLER: std::cell::Cell<u64> = const { std::cell::Cell::new(1) };
            /// The number of the session's next fetch, as the page counts them.
            static FETCHED: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
        }

        /// A subscription's handler number, as the page gives one, and what reads its runs.
        fn subscriber() -> (u64, Seen) {
            let handler = NEXT_HANDLER.with(|next| {
                let handler = next.get();
                next.set(handler + 1);
                handler
            });
            (handler, Seen { handler })
        }

        /// Reads one handler's runs from the case's outbox, the page's way: fetching, and
        /// keeping the runs of other handlers for their own readers.
        struct Seen {
            handler: u64,
        }

        impl Seen {
            fn run_within(&self, within: Duration) -> Option<Value> {
                let end = Instant::now() + within;
                loop {
                    let held = HELD.with(|held| {
                        let mut held = held.borrow_mut();
                        let at = held.iter().position(|run| run["handler"] == self.handler)?;
                        Some(held.remove(at))
                    });
                    if held.is_some() {
                        return held;
                    }
                    let left = end.saturating_duration_since(Instant::now());
                    if left.is_zero() {
                        return None;
                    }
                    let outbox = OUTBOX.with(|current| current.borrow().clone())?;
                    let seq = FETCHED.with(|next| next.get());
                    let runs = outbox.take(seq, left).expect("fetched in sequence")?;
                    FETCHED.with(|next| next.set(seq + 1));
                    HELD.with(|held| {
                        held.borrow_mut()
                            .extend(runs.iter().map(|run| serde_json::to_value(run).unwrap()))
                    });
                }
            }

            fn none_within(&self, within: Duration) -> bool {
                self.run_within(within).is_none()
            }
        }

        /// A channel whose sends land in the returned receiver, one JSON value each.
        fn capture<T: serde::Serialize + Clone + 'static>() -> (Channel<T>, mpsc::Receiver<Value>) {
            let (tx, rx) = mpsc::channel();
            let channel = Channel::new(move |body| {
                if let InvokeResponseBody::Json(s) = body {
                    let _ = tx.send(serde_json::from_str(&s).unwrap());
                }
                Ok(())
            });
            (channel, rx)
        }

        fn next(rx: &mpsc::Receiver<Value>) -> Value {
            rx.recv_timeout(Duration::from_secs(5)).expect("a send")
        }

        /// The updates of a subscriber's next run.
        fn updates(seen: &Seen) -> Value {
            seen.run_within(Duration::from_secs(5)).expect("a run")["updates"].clone()
        }

        #[test]
        fn reads_and_writes_reach_the_unit_and_the_summary_names_it() {
            let unit = Unit::start("<device-id-a>", plain);
            let list = device_list(&[(&unit, "URX44V")]);
            let (tx, summary, counters) = start(list, "URX44V");
            let summary = summary.unwrap();
            assert_eq!(
                (
                    summary.model.as_str(),
                    summary.label.as_str(),
                    summary.firmware.as_deref()
                ),
                ("URX44V", "URX44V", Some("1.5.0.1"))
            );
            assert_eq!(get(tx.clone(), 1, 0, 2), Ok(7));
            assert_eq!(set(tx.clone(), 1, 0, 2, -600), Ok(()));
            assert!(unit.seen().contains(&"/vd/parameters/1:0:2".to_string()));
            let stats = counters.read();
            assert_eq!((stats.gets, stats.sets), (1, 1));
        }

        #[test]
        fn a_refused_write_is_broker_rejected() {
            let (tx, _unit, _) = connected(|request| {
                let uri = request["vdp"]["uri"].as_str().unwrap();
                vec![json!({ "method": "post", "uri": uri, "data": { "response_code": 400 } })]
            });
            let err = set(tx, 502, 0, 0, 101).unwrap_err();
            assert!(err.starts_with("broker-rejected: 502:0:0"), "{err}");
        }

        #[test]
        fn a_name_reads_as_its_text_or_as_no_custom_name() {
            let (tx, _unit, _) = connected(|request| {
                let uri = request["vdp"]["uri"].as_str().unwrap();
                if request["vdp"]["method"] == "post" {
                    return plain(request);
                }
                let value = if uri.contains("18:0:0") {
                    json!("Vox")
                } else {
                    json!(3)
                };
                vec![
                    json!({ "method": "get", "uri": uri, "data": { "response_code": 200, "current_value": value } }),
                ]
            });
            assert_eq!(get_str(tx.clone(), 18, 0, 0), Ok("Vox".to_string()));
            assert_eq!(get_str(tx.clone(), 18, 0, 1), Ok(String::new()));
            assert_eq!(set_str(tx, 18, 0, 0, "Kick".to_string()), Ok(()));
        }
        // A missed response deadline ends the session (N1): the command fails with its own
        // deadline, its late reply answers nothing, and the watch and every command after it
        // get the session's end.
        #[test]
        fn a_missed_deadline_ends_the_session() {
            let (tx, _unit, counters) = connected(counted(|n, request| {
                let at = address_of(request);
                if n == 1 {
                    thread::sleep(LATE);
                }
                vec![get_reply(&at, 111)]
            }));
            let (channel, events) = capture();
            watch_link(tx.clone(), channel).unwrap();
            let err = get(tx.clone(), 1, 0, 0).unwrap_err();
            assert!(err.starts_with("broker-timeout: 1:0:0"), "{err}");
            assert_eq!(next(&events), json!({ "reason": BROKER_UNRESPONSIVE }));
            assert_eq!(
                get(tx.clone(), 1, 0, 0),
                Err(BROKER_UNRESPONSIVE.to_string())
            );
            let stats = counters.read();
            assert_eq!((stats.deadlines, stats.stalled, stats.gets), (1, 1, 1));
        }

        #[test]
        fn the_unit_going_offline_is_device_lost_for_the_watch_and_every_later_command() {
            let (tx, unit, _) = connected(plain);
            let (channel, events) = capture();
            watch_link(tx.clone(), channel).unwrap();
            assert_eq!(get(tx.clone(), 1, 0, 0), Ok(7));
            unit.push(json!({ "method": "notify", "uri": "/vd/synchronize", "data": { "sync_status": "offline" } }));
            let reason = next(&events)["reason"].as_str().unwrap().to_string();
            assert!(reason.starts_with("device-lost"), "{reason}");
            assert_eq!(get(tx, 1, 0, 0), Err(reason));
        }

        #[test]
        fn a_link_the_peer_closes_is_broker_closed() {
            let (tx, unit, _) = connected(plain);
            let (channel, events) = capture();
            watch_link(tx.clone(), channel).unwrap();
            unit.close();
            assert_eq!(next(&events), json!({ "reason": "broker-closed" }));
            assert_eq!(get(tx, 1, 0, 0), Err("broker-closed".to_string()));
        }

        // What each subscription registered reaches its own channel, and nothing else does;
        // the bulk-change push reaches the parameter channels as its sentinel.
        #[test]
        fn notifies_reach_the_channel_of_the_subscription_that_registered_them() {
            let (tx, unit, counters) = connected(plain);
            let (params, params_seen) = subscriber();
            let (probe, probe_seen) = subscriber();
            let (meters, meters_seen) = subscriber();
            params_subscribe(tx.clone(), vec![(1, 0, 0), (2, 0, 0)], params).unwrap();
            probe_subscribe(tx.clone(), vec![(2, 0, 0), (3, 0, 0)], probe).unwrap();
            meters_subscribe(tx.clone(), vec![(115, 0)], meters).unwrap();
            // The shared address (2:0:0) is registered once.
            let regist = |uri: &str| unit.seen().iter().filter(|s| s.as_str() == uri).count();
            assert_eq!(regist("/vd/parameters/2:0:0?operation=regist"), 1);
            assert_eq!(counters.read().regist_frames, 4);
            for (uri, value) in [
                ("/vd/parameters/9:0:0", 9),
                ("/vd/parameters/1:0:0", 5),
                ("/vd/parameters/3:0:0", 6),
            ] {
                unit.push(
                    json!({ "method": "notify", "uri": uri, "data": { "current_value": value } }),
                );
            }
            unit.push(json!({ "method": "notify", "uri": "/vd/meters/115:1", "data": { "current_value": -300 } }));
            unit.push(json!({ "method": "notify", "uri": "/vd/meters/115:0", "data": { "current_value": -200 } }));
            assert_eq!(
                updates(&params_seen),
                json!([{ "param_id": 1, "x": 0, "y": 0, "value": 5 }])
            );
            assert_eq!(
                updates(&probe_seen),
                json!([{ "param_id": 3, "x": 0, "y": 0, "value": 6 }])
            );
            assert_eq!(
                updates(&meters_seen),
                json!([{ "meter_id": 115, "x": 0, "value": -200 }])
            );
            unit.push(json!({ "method": "notify", "uri": "/vd/parameters", "data": {} }));
            let bulk = serde_json::to_value(vec![BULK_CHANGE]).unwrap();
            assert_eq!(updates(&params_seen), bulk);
            assert_eq!(updates(&probe_seen), bulk);
        }

        #[test]
        fn replacing_a_subscription_registers_the_new_addresses_and_releases_the_old() {
            let (tx, unit, counters) = connected(plain);
            let (first, _) = subscriber();
            let (second, seen) = subscriber();
            params_subscribe(tx.clone(), vec![(1, 0, 0), (2, 0, 0)], first).unwrap();
            params_subscribe(tx.clone(), vec![(2, 0, 0), (3, 0, 0)], second).unwrap();
            let posts: Vec<String> = unit
                .seen()
                .into_iter()
                .filter(|s| s.contains("operation="))
                .collect();
            assert_eq!(
                posts,
                [
                    "/vd/parameters/1:0:0?operation=regist",
                    "/vd/parameters/2:0:0?operation=regist",
                    "/vd/parameters/3:0:0?operation=regist",
                    "/vd/parameters/1:0:0?operation=unregist",
                ]
            );
            let stats = counters.read();
            assert_eq!(
                (
                    stats.param_subscribes,
                    stats.regist_frames,
                    stats.unregist_frames
                ),
                (2, 3, 1)
            );
            unit.push(json!({ "method": "notify", "uri": "/vd/parameters/3:0:0", "data": { "current_value": 1 } }));
            assert_eq!(
                updates(&seen),
                json!([{ "param_id": 3, "x": 0, "y": 0, "value": 1 }])
            );
        }

        // A notify that arrives while the new subscription's registrations are in flight is
        // judged by the new set and goes out on the new channel.
        #[test]
        fn a_notify_during_the_registrations_goes_out_on_the_new_channel() {
            let (tx, _unit, _) = connected(|request| {
                let uri = request["vdp"]["uri"].as_str().unwrap();
                if uri == "/vd/parameters/3:0:0?operation=regist" {
                    return vec![
                        json!({ "method": "notify", "uri": "/vd/parameters/3:0:0", "data": { "current_value": 9 } }),
                        json!({ "method": "post", "uri": uri, "data": { "response_code": 200 } }),
                    ];
                }
                plain(request)
            });
            let (first, _) = subscriber();
            let (second, seen) = subscriber();
            params_subscribe(tx.clone(), vec![(1, 0, 0)], first).unwrap();
            params_subscribe(tx, vec![(3, 0, 0)], second).unwrap();
            assert_eq!(
                updates(&seen),
                json!([{ "param_id": 3, "x": 0, "y": 0, "value": 9 }])
            );
        }

        // A refused subscribe reports the refusal and leaves nothing subscribed on its
        // channel: neither the refused set nor the one it was replacing.
        #[test]
        fn a_refused_subscribe_leaves_neither_set_subscribed() {
            let (tx, unit, counters) = connected(|request| {
                let uri = request["vdp"]["uri"].as_str().unwrap();
                if uri == "/vd/parameters/3:0:0?operation=regist" {
                    return vec![
                        json!({ "method": "post", "uri": uri, "data": { "response_code": 400 } }),
                    ];
                }
                plain(request)
            });
            let (first, first_seen) = subscriber();
            let (second, second_seen) = subscriber();
            params_subscribe(tx.clone(), vec![(1, 0, 0)], first).unwrap();
            let err = params_subscribe(tx.clone(), vec![(3, 0, 0)], second).unwrap_err();
            assert!(err.starts_with("broker-rejected"), "{err}");
            assert!(unit
                .seen()
                .contains(&"/vd/parameters/1:0:0?operation=unregist".to_string()));
            unit.push(json!({ "method": "notify", "uri": "/vd/parameters/1:0:0", "data": { "current_value": 1 } }));
            unit.push(json!({ "method": "notify", "uri": "/vd/parameters/3:0:0", "data": { "current_value": 3 } }));
            assert!(second_seen.none_within(Duration::from_millis(300)));
            assert!(first_seen.none_within(Duration::from_millis(100)));
            assert_eq!(get(tx.clone(), 1, 0, 0), Ok(7), "the session goes on");
            // Nothing of the refused set is held: the next subscribe lets go of no set, so the
            // ledger counts no unregistration for addresses that were never registered.
            let released = counters.read().unregist_frames;
            let (third, _) = subscriber();
            // `tx` is kept until the ledger is read: the last sender's drop ends the session, and the
            // frame rows with its connection.
            params_subscribe(tx.clone(), vec![(1, 0, 0)], third).unwrap();
            assert_eq!(counters.read().unregist_frames, released);
        }

        // A replacement switches to the new token while the old one can still have
        // notifications queued, received before the switch: those go to the old token's
        // handler however many switches later they are delivered, one several tokens
        // received goes once to the newest one's, and a batch's updates go into runs in
        // receive order, consecutive ones for the same handler together.
        #[test]
        fn a_route_keeps_every_replaced_handler_and_runs_keep_receive_order() {
            let mut route: Route<u64> = Route::default();
            assert_eq!(route.pick(&[1]), None);
            route.switch(1, 11);
            route.switch(2, 12);
            route.switch(3, 13);
            assert_eq!(route.pick(&[1, 2, 3]), Some(13), "once, to the newest");
            assert_eq!(route.pick(&[1, 2]), Some(12));
            assert_eq!(
                route.pick(&[1]),
                Some(11),
                "two switches back is still the first token's handler"
            );
            assert_eq!(route.pick(&[4]), None);
            route.clear();
            assert_eq!(route.pick(&[1, 2, 3]), None);
            let update = |value| super::super::ParamUpdate {
                param_id: 1,
                x: 0,
                y: 0,
                value,
                value_str: None,
            };
            let mut runs = Runs::default();
            for (probe, handler, value) in [
                (false, 11, 10),
                (false, 13, 20),
                (false, 13, 30),
                (true, 13, 35),
                (false, 12, 40),
                (false, 11, 50),
            ] {
                runs.param(probe, handler, update(value));
            }
            let shape: Vec<Value> = runs
                .0
                .iter()
                .map(|run| {
                    let run = serde_json::to_value(run).unwrap();
                    let values: Vec<Value> = run["updates"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|u| u["value"].clone())
                        .collect();
                    json!([run["kind"], run["handler"], values])
                })
                .collect();
            assert_eq!(
                shape,
                vec![
                    json!(["params", 11, [10]]),
                    json!(["params", 13, [20, 30]]),
                    json!(["probe", 13, [35]]),
                    json!(["params", 12, [40]]),
                    json!(["params", 11, [50]]),
                ]
            );
        }

        fn meter_run(handler: u64, value: i64) -> super::super::Run {
            super::super::Run::Meters {
                handler,
                updates: vec![super::super::MeterUpdate {
                    meter_id: 1,
                    x: 0,
                    value,
                }],
            }
        }

        fn run_values(runs: Vec<super::super::Run>) -> Vec<Value> {
            runs.iter()
                .map(|run| serde_json::to_value(run).unwrap()["updates"][0]["value"].clone())
                .collect()
        }

        // The outbox hands the page its runs in the order they were put, all that wait at
        // once, an empty list when none came within the wait, and nothing once the session
        // has ended and nothing is left; what was put before the end is still fetched.
        #[test]
        fn the_outbox_hands_over_its_runs_in_order_and_then_the_end() {
            let outbox = Outbox::default();
            assert_eq!(
                outbox
                    .take(0, Duration::from_millis(20))
                    .unwrap()
                    .map(|r| r.len()),
                Some(0)
            );
            outbox.put(vec![meter_run(1, -10)], 0);
            outbox.put(vec![meter_run(2, -20), meter_run(1, -30)], 0);
            assert_eq!(
                run_values(outbox.take(1, Duration::ZERO).unwrap().unwrap()),
                vec![json!(-10), json!(-20), json!(-30)]
            );
            outbox.put(vec![meter_run(1, -40)], 0);
            outbox.end();
            assert_eq!(
                run_values(outbox.take(2, Duration::ZERO).unwrap().unwrap()),
                vec![json!(-40)]
            );
            assert!(
                outbox.take(3, Duration::from_secs(5)).unwrap().is_none(),
                "the end, at once"
            );
            outbox.put(vec![meter_run(1, -50)], 0);
            assert!(
                outbox.take(3, Duration::ZERO).unwrap().is_none(),
                "nothing is added after the end"
            );
        }

        // An answer is kept until the page asks for the next number: Tauri resends a
        // request whose response the page could not read, and the resend gets the same
        // runs, not the ones after them. A number past the next, or one already
        // acknowledged, is refused: an answer has been lost.
        #[test]
        fn a_resend_gets_its_answer_again_until_the_next_number_acknowledges_it() {
            let outbox = Outbox::default();
            outbox.put(vec![meter_run(1, -10)], 0);
            assert_eq!(
                run_values(outbox.take(0, Duration::ZERO).unwrap().unwrap()),
                vec![json!(-10)]
            );
            outbox.put(vec![meter_run(1, -20)], 0);
            assert_eq!(
                run_values(outbox.take(0, Duration::ZERO).unwrap().unwrap()),
                vec![json!(-10)],
                "the resend"
            );
            assert_eq!(
                run_values(outbox.take(1, Duration::ZERO).unwrap().unwrap()),
                vec![json!(-20)]
            );
            assert_eq!(
                run_values(outbox.take(1, Duration::ZERO).unwrap().unwrap()),
                vec![json!(-20)],
                "a resend of the next"
            );
            for lost in [0, 3] {
                let refused = outbox.take(lost, Duration::ZERO).err().expect("refused");
                assert!(
                    refused.starts_with("notifications-lost: fetch"),
                    "{refused}"
                );
            }
            assert_eq!(
                outbox
                    .take(2, Duration::ZERO)
                    .unwrap()
                    .map(|runs| runs.len()),
                Some(0)
            );
        }

        // A resend that arrives while its fetch still waits for runs gets that fetch's
        // answer rather than an answer of its own.
        #[test]
        fn a_resend_while_its_fetch_waits_gets_the_same_answer() {
            let outbox = Arc::new(Outbox::default());
            let fetch = || {
                let outbox = Arc::clone(&outbox);
                thread::spawn(move || outbox.take(0, Duration::from_secs(5)))
            };
            let first = fetch();
            let until = Instant::now() + Duration::from_secs(5);
            while !outbox.state.lock().unwrap().taking {
                assert!(Instant::now() < until, "the first fetch waits");
                thread::sleep(Duration::from_millis(1));
            }
            let resend = fetch();
            thread::sleep(Duration::from_millis(50));
            outbox.put(vec![meter_run(1, -10)], 0);
            for answer in [first, resend] {
                assert_eq!(
                    run_values(answer.join().unwrap().unwrap().unwrap()),
                    vec![json!(-10)]
                );
            }
        }

        /// The unit announces Console Lock `on` or off in a batch of `runs`, as the transport
        /// hands it over: heard at receipt, then put with the batch.
        fn announce(outbox: &Outbox, runs: Vec<super::super::Run>, on: bool) {
            outbox.hear(on);
            outbox.put(runs, 1);
        }

        /// A write meets the hold now: whether it is held, and the fetch its refusal names, without
        /// waiting.
        fn hold(outbox: &Outbox) -> Option<Option<u64>> {
            let id = outbox.hold_id();
            if !outbox.hold_write(id) {
                return None;
            }
            outbox.lock_hold(id, Duration::ZERO)
        }

        /// A write held now, whose refusal is worded later (`Outbox::lock_hold`).
        fn held_now(outbox: &Outbox) -> u64 {
            let id = outbox.hold_id();
            assert!(outbox.hold_write(id), "the premise: the write is held");
            id
        }

        /// Whether the outbox has put the announcements received so far.
        fn put_all(outbox: &Outbox) -> bool {
            let state = outbox.state.lock().unwrap();
            state.put_announcements == state.heard
        }

        // From the unit's announcement of Console Lock to its announcement of the lock off, a
        // write is held, and its refusal names the fetch that hands the announcement to the
        // page — the next one while it is unfetched — whether or not the page has acknowledged it.
        #[test]
        fn a_lock_is_held_from_its_announcement_to_the_announcement_of_the_lock_off() {
            let outbox = Outbox::default();
            outbox.put(vec![meter_run(1, -10)], 0);
            assert_eq!(hold(&outbox), None);
            outbox.take(0, Duration::ZERO).unwrap();
            announce(&outbox, vec![meter_run(1, -20)], true);
            assert_eq!(
                hold(&outbox),
                Some(Some(1)),
                "not fetched: the next fetch hands it on"
            );
            outbox.take(1, Duration::ZERO).unwrap();
            assert_eq!(hold(&outbox), Some(Some(1)), "fetched");
            outbox.take(2, Duration::ZERO).unwrap();
            assert_eq!(hold(&outbox), Some(Some(1)), "acknowledged, still locked");
            outbox.put(vec![meter_run(1, -30)], 0);
            assert_eq!(hold(&outbox), Some(Some(1)), "other announcements leave it");
            announce(&outbox, vec![meter_run(1, -40)], false);
            assert_eq!(hold(&outbox), None, "the lock off");
            announce(&outbox, vec![meter_run(1, -50)], true);
            assert_eq!(
                hold(&outbox),
                Some(Some(3)),
                "locked again, in the next fetch"
            );
            assert!(
                outbox.state.lock().unwrap().holds.is_empty(),
                "every refusal let its hold go"
            );
        }

        // A write held on a lock names the first fetch that handed that lock on, whatever the unit
        // announced and the page fetched after the refusal and before its wording: the lock off,
        // fetched with the lock or after it, a resend, the lock again. The lock is in fetch 0
        // every time.
        #[test]
        fn a_held_write_names_the_first_fetch_of_its_lock_whatever_follows() {
            let on = |outbox: &Outbox| announce(outbox, vec![meter_run(1, -10)], true);
            let off = |outbox: &Outbox| announce(outbox, vec![meter_run(1, -20)], false);
            let fetch = |seq: u64| {
                move |outbox: &Outbox| {
                    outbox.take(seq, Duration::ZERO).unwrap();
                }
            };
            type Steps = Vec<Box<dyn Fn(&Outbox)>>;
            let cases: Vec<(&str, Steps, Steps)> = vec![
                ("nothing after it", vec![Box::new(on)], vec![]),
                (
                    "an empty fetch after it",
                    vec![Box::new(on)],
                    vec![Box::new(fetch(0)), Box::new(fetch(1))],
                ),
                (
                    "the lock off fetched with it",
                    vec![Box::new(on)],
                    vec![Box::new(off), Box::new(fetch(0))],
                ),
                (
                    "the lock off left unfetched",
                    vec![Box::new(on), Box::new(fetch(0))],
                    vec![Box::new(off)],
                ),
                (
                    "the lock off fetched on its own",
                    vec![Box::new(on)],
                    vec![Box::new(fetch(0)), Box::new(off), Box::new(fetch(1))],
                ),
                (
                    "that fetch sent again",
                    vec![Box::new(on)],
                    vec![
                        Box::new(fetch(0)),
                        Box::new(off),
                        Box::new(fetch(1)),
                        Box::new(fetch(1)),
                    ],
                ),
                (
                    "the lock fetched when the write met it, the lock off after",
                    vec![Box::new(on), Box::new(fetch(0))],
                    vec![Box::new(off), Box::new(fetch(1))],
                ),
                (
                    "the lock off and the lock again, each fetched on its own",
                    vec![Box::new(on)],
                    vec![
                        Box::new(fetch(0)),
                        Box::new(off),
                        Box::new(fetch(1)),
                        Box::new(on),
                        Box::new(fetch(2)),
                    ],
                ),
            ];
            for (label, before, after) in cases {
                let outbox = Outbox::default();
                for step in &before {
                    step(&outbox);
                }
                let id = held_now(&outbox);
                for step in &after {
                    step(&outbox);
                }
                assert_eq!(
                    outbox.lock_hold(id, Duration::ZERO),
                    Some(Some(0)),
                    "{label}"
                );
            }
        }

        fn flood() -> super::super::Run {
            super::super::Run::Meters {
                handler: 1,
                updates: (0..=super::super::OUTBOX_UPDATES as i64)
                    .map(|value| super::super::MeterUpdate {
                        meter_id: 1,
                        x: 0,
                        value,
                    })
                    .collect(),
            }
        }

        // Past the cap of unfetched updates a batch waits for the page, but one that carries
        // a Console Lock announcement does not: the next fetch hands it to the page.
        #[test]
        fn a_lock_announcement_is_not_held_back_by_the_cap() {
            let outbox = Arc::new(Outbox::default());
            outbox.put(vec![flood()], 0);
            let lock = {
                let outbox = Arc::clone(&outbox);
                thread::spawn(move || announce(&outbox, vec![meter_run(1, -10)], true))
            };
            let until = Instant::now() + Duration::from_secs(2);
            while !lock.is_finished() {
                assert!(
                    Instant::now() < until,
                    "a lock announcement waits past the cap"
                );
                thread::sleep(Duration::from_millis(1));
            }
            assert_eq!(hold(&outbox), Some(Some(0)), "held, in the next fetch");
            let held = {
                let outbox = Arc::clone(&outbox);
                thread::spawn(move || outbox.put(vec![meter_run(1, -20)], 0))
            };
            thread::sleep(Duration::from_millis(50));
            assert!(
                !held.is_finished(),
                "a batch with no lock waits past the cap"
            );
            let runs = outbox.take(0, Duration::ZERO).unwrap().unwrap();
            assert_eq!(runs.len(), 2, "the flood and the lock, in order");
            held.join().unwrap();
            announce(&outbox, vec![meter_run(1, -30)], false);
            assert_eq!(outbox.lock_heard(), None);
        }

        // A lock announced while a batch ahead of it waits past the cap is not in the outbox
        // yet, but the transport has received it: it holds the next write at once, and the
        // refusal waits to name the fetch that carries it until the batch is put.
        #[test]
        fn a_lock_heard_behind_a_waiting_batch_holds_the_next_write_at_once() {
            let outbox = Arc::new(Outbox::default());
            outbox.put(vec![flood()], 0);
            let waiting = {
                let outbox = Arc::clone(&outbox);
                thread::spawn(move || outbox.put(vec![meter_run(1, -10)], 0))
            };
            thread::sleep(Duration::from_millis(50));
            assert!(!waiting.is_finished(), "the premise: the batch ahead waits");
            outbox.hear(true);
            assert_eq!(outbox.lock_heard(), Some(1), "held at receipt");
            let id = held_now(&outbox);
            let refusal = {
                let outbox = Arc::clone(&outbox);
                thread::spawn(move || outbox.lock_hold(id, Duration::from_secs(5)))
            };
            thread::sleep(Duration::from_millis(50));
            assert!(
                !refusal.is_finished(),
                "it waits for the announcement to be put"
            );
            assert_eq!(outbox.take(0, Duration::ZERO).unwrap().unwrap().len(), 1);
            waiting.join().unwrap();
            outbox.put(vec![meter_run(1, -20)], 1);
            assert_eq!(
                refusal.join().unwrap(),
                Some(Some(1)),
                "the fetch after the flood"
            );
            let runs = outbox.take(1, Duration::ZERO).unwrap().unwrap();
            assert_eq!(
                runs.into_iter()
                    .map(|run| run_values(vec![run]))
                    .collect::<Vec<_>>(),
                vec![vec![json!(-10)], vec![json!(-20)]],
                "the waiting batch, then the lock, in receive order"
            );
            outbox.hear(false);
            assert_eq!(outbox.lock_heard(), None, "the lock off, as it is received");
        }

        // A write held on a lock names the fetch that carries that lock whatever the unit
        // announced after it: the lock off received while the announcement still waits to be
        // put does not take the fetch away, and the fetch carries the lock and its lock off.
        #[test]
        fn a_hold_names_its_lock_s_fetch_when_the_lock_off_follows_it() {
            let outbox = Arc::new(Outbox::default());
            outbox.hear(true);
            let id = held_now(&outbox);
            let refusal = {
                let outbox = Arc::clone(&outbox);
                thread::spawn(move || outbox.lock_hold(id, Duration::from_secs(5)))
            };
            outbox.hear(false);
            thread::sleep(Duration::from_millis(50));
            assert!(
                !refusal.is_finished(),
                "it waits for the announcement it was held on"
            );
            outbox.put(vec![meter_run(1, -10), meter_run(1, -20)], 2);
            assert_eq!(refusal.join().unwrap(), Some(Some(0)));
        }

        // A hold whose announcement never reaches the outbox — the page stopped fetching — names
        // no fetch once its wait is over, and none at once once the session has ended.
        #[test]
        fn a_hold_names_no_fetch_when_the_announcement_does_not_arrive() {
            let outbox = Outbox::default();
            outbox.hear(true);
            let waited = held_now(&outbox);
            assert_eq!(
                outbox.lock_hold(waited, Duration::from_millis(20)),
                Some(None)
            );
            let ended = held_now(&outbox);
            outbox.end();
            let started = Instant::now();
            assert_eq!(outbox.lock_hold(ended, Duration::from_secs(5)), Some(None));
            assert!(started.elapsed() < Duration::from_secs(1), "at once");
            assert_eq!(
                outbox.lock_hold(ended, Duration::ZERO),
                None,
                "a refusal lets its hold go"
            );
        }

        // The shell refuses a write from the unit's announcement of Console Lock to its
        // announcement of the lock off — before the page has the lock, and after it has
        // acknowledged it alike — as the lock's stop, naming the fetch that carries it, and
        // sends nothing for it; once the unit announces the lock off, the shell sends again.
        #[test]
        fn a_console_lock_the_unit_announced_holds_the_shells_writes_until_the_lock_off() {
            let (tx, unit, _) = connected(plain);
            let (params, seen) = subscriber();
            params_subscribe(
                tx.clone(),
                vec![(CONSOLE_LOCK_PARAM, 0, 0), (1, 0, 0)],
                params,
            )
            .unwrap();
            let announce = |value: i64| {
                unit.push(json!({
                    "method": "notify",
                    "uri": format!("/vd/parameters/{CONSOLE_LOCK_PARAM}:0:0"),
                    "data": { "current_value": value },
                }))
            };
            let outbox = OUTBOX.with(|current| current.borrow().clone()).unwrap();
            let first = FETCHED.with(|next| next.get());
            let writes = || {
                unit.seen()
                    .iter()
                    .filter(|uri| uri.as_str() == "/vd/parameters/1:0:0?operation=value")
                    .count()
            };
            announce(1);
            let until = Instant::now() + Duration::from_secs(5);
            while !(outbox.lock_heard().is_some() && put_all(&outbox)) {
                assert!(
                    Instant::now() < until,
                    "the announcement reaches the outbox"
                );
                thread::sleep(Duration::from_millis(1));
            }
            let held = |tx: &mpsc::Sender<Cmd>| {
                let refused = set(tx.clone(), 1, 0, 0, 5).unwrap_err();
                assert!(
                    refused.starts_with(&format!("{WRITES_HELD}:"))
                        && refused.ends_with(&format!("(fetch {first})")),
                    "{refused}"
                );
            };
            held(&tx);
            assert_eq!(
                updates(&seen),
                json!([{ "param_id": CONSOLE_LOCK_PARAM, "x": 0, "y": 0, "value": 1 }])
            );
            held(&tx);
            assert!(
                seen.none_within(Duration::from_millis(20)),
                "the acknowledgement"
            );
            held(&tx);
            assert_eq!(writes(), 0, "nothing was sent for the held writes");
            announce(0);
            let until = Instant::now() + Duration::from_secs(5);
            while outbox.lock_heard().is_some() {
                assert!(Instant::now() < until, "the lock off reaches the outbox");
                thread::sleep(Duration::from_millis(1));
            }
            assert_eq!(
                set(tx.clone(), 1, 0, 0, 5),
                Ok(()),
                "sent once the lock is off"
            );
            assert_eq!(writes(), 1);
        }

        // The unit's announcement of Console Lock behind a batch that waits past the outbox's
        // cap holds the next write at once, as the transport receives it, and the refusal names
        // the fetch that hands it to the page once the page has taken what was ahead of it.
        #[test]
        fn a_lock_behind_a_full_outbox_holds_the_shells_writes_as_it_is_received() {
            let (tx, unit, _) = connected(plain);
            let (params, _params_seen) = subscriber();
            let (meters, _meters_seen) = subscriber();
            params_subscribe(
                tx.clone(),
                vec![(CONSOLE_LOCK_PARAM, 0, 0), (1, 0, 0)],
                params,
            )
            .unwrap();
            meters_subscribe(tx.clone(), vec![(115, 0)], meters).unwrap();
            let outbox = OUTBOX.with(|current| current.borrow().clone()).unwrap();
            let first = FETCHED.with(|next| next.get());
            // Past the cap by more than a batch: at least one batch waits for the page, and the
            // lock is received behind it.
            for value in 0..(super::super::OUTBOX_UPDATES as i64 + 192) {
                unit.push(json!({ "method": "notify", "uri": "/vd/meters/115:0", "data": { "current_value": value } }));
            }
            unit.push(json!({
                "method": "notify",
                "uri": format!("/vd/parameters/{CONSOLE_LOCK_PARAM}:0:0"),
                "data": { "current_value": 1 },
            }));
            let until = Instant::now() + Duration::from_secs(5);
            while outbox.lock_heard().is_none() {
                assert!(Instant::now() < until, "the transport receives the lock");
                thread::sleep(Duration::from_millis(1));
            }
            assert!(
                !put_all(&outbox),
                "the premise: the lock waits behind the cap"
            );
            let writing = {
                let tx = tx.clone();
                thread::spawn(move || set(tx, 1, 0, 0, 5))
            };
            thread::sleep(Duration::from_millis(50));
            assert!(
                !writing.is_finished(),
                "the refusal waits to name the fetch"
            );
            // The page takes what was ahead of the lock.
            outbox.take(first, Duration::from_secs(1)).unwrap();
            assert_eq!(
                writing.join().unwrap(),
                Err(format!(
                    "{WRITES_HELD}: the unit announced Console Lock (fetch {})",
                    first + 1
                ))
            );
            let writes = unit
                .seen()
                .iter()
                .filter(|uri| uri.as_str() == "/vd/parameters/1:0:0?operation=value")
                .count();
            assert_eq!(writes, 0, "nothing was sent for the held write");
        }

        // A write the send gate held on the unit's Console Lock is refused as held, naming the
        // fetch that carries the lock, though the transport receives the lock off between the
        // refusal and its wording: the verdict is the gate's own, taken as it refused.
        #[test]
        fn a_write_held_on_a_lock_stays_held_when_the_lock_off_comes_before_its_wording() {
            let (tx, unit, _) = connected(plain);
            let (params, _seen) = subscriber();
            params_subscribe(
                tx.clone(),
                vec![(CONSOLE_LOCK_PARAM, 0, 0), (1, 0, 0)],
                params,
            )
            .unwrap();
            let outbox = OUTBOX.with(|current| current.borrow().clone()).unwrap();
            let first = FETCHED.with(|next| next.get());
            unit.push(json!({
                "method": "notify",
                "uri": format!("/vd/parameters/{CONSOLE_LOCK_PARAM}:0:0"),
                "data": { "current_value": 1 },
            }));
            let until = Instant::now() + Duration::from_secs(5);
            while !(outbox.lock_heard().is_some() && put_all(&outbox)) {
                assert!(
                    Instant::now() < until,
                    "the announcement reaches the outbox"
                );
                thread::sleep(Duration::from_millis(1));
            }
            // The lock off, as the transport receives it, after the gate has held the write.
            let off = Arc::clone(&outbox);
            *outbox.after_request.lock().unwrap() = Some(Box::new(move || off.hear(false)));
            assert_eq!(
                set(tx.clone(), 1, 0, 0, 5),
                Err(format!(
                    "{WRITES_HELD}: the unit announced Console Lock (fetch {first})"
                ))
            );
            assert_eq!(
                outbox.lock_heard(),
                None,
                "the premise: the lock off came before the wording"
            );
            let writes = unit
                .seen()
                .iter()
                .filter(|uri| uri.as_str() == "/vd/parameters/1:0:0?operation=value")
                .count();
            assert_eq!(writes, 0, "nothing was sent for the held write");
        }

        /// The control package's requests on the session this case started last.
        fn package() -> Arc<PackageLink> {
            PACKAGE.with(|current| current.borrow().clone()).unwrap()
        }

        /// A control-package call at parameter `param_id` (0, 0).
        fn package_call(method: Method, param_id: f64, value: Option<&str>) -> Call<'_> {
            Call {
                method,
                param_id,
                x: "0",
                y: "0",
                value,
            }
        }

        fn writes_to(unit: &Unit, param_id: u32) -> usize {
            let uri = format!("/vd/parameters/{param_id}:0:0?operation=value");
            unit.seen().iter().filter(|seen| **seen == uri).count()
        }

        // A control-package read and write come back as their K34 records, and each result keeps
        // the connection's wire slot until the page adopts it: the worker's own request after it
        // waits for the adoption.
        #[test]
        fn a_package_result_keeps_the_wire_slot_until_the_page_adopts_it() {
            let (tx, unit, _) = connected(plain);
            let link = package();
            let read = link
                .request(
                    1,
                    "request-1",
                    0,
                    0,
                    package_call(Method::GetNumeric, 1.0, None),
                )
                .unwrap();
            assert_eq!(
                serde_json::to_value(&read).unwrap(),
                json!({ "record": { "kind": "success", "value": "7", "evidence": { "state": "read" } } })
            );
            let worker = {
                let tx = tx.clone();
                thread::spawn(move || get(tx, 2, 0, 0))
            };
            thread::sleep(Duration::from_millis(50));
            assert!(
                !worker.is_finished(),
                "the worker's request waits for the slot"
            );
            assert!(link.adopt("request-1"));
            assert_eq!(worker.join().unwrap(), Ok(7));
            let write = link
                .request(
                    1,
                    "request-2",
                    0,
                    0,
                    package_call(Method::SetNumeric, 1.0, Some("5")),
                )
                .unwrap();
            assert_eq!(
                serde_json::to_value(&write).unwrap(),
                json!({ "record": { "kind": "success", "value": null, "evidence": { "state": "accepted" } } })
            );
            assert!(link.adopt("request-2"));
            assert!(
                link.adopt("request-2"),
                "a resend of the adoption is answered alike"
            );
            assert_eq!(writes_to(&unit, 1), 1);
        }

        // A link whose hold thread did not start sends no package request: refused unsent as the
        // app's own fault, so no result can hold the slot unbounded. The worker's own requests go
        // on as before.
        #[test]
        fn a_link_without_its_hold_thread_sends_no_package_request() {
            let (tx, unit, _) = connected(plain);
            let link = package();
            link.as_if_unwatched();
            let reply = link
                .request(
                    1,
                    "request-1",
                    1,
                    1,
                    package_call(Method::SetNumeric, 1.0, Some("5")),
                )
                .unwrap();
            assert_eq!(
                serde_json::to_value(&reply.record).unwrap(),
                json!({
                    "kind": "failure",
                    "failure": { "kind": "cause", "code": "internal_error", "phase": "admission" },
                    "evidence": { "state": "not_sent" },
                })
            );
            assert_eq!(writes_to(&unit, 1), 0);
            assert_eq!(get(tx.clone(), 2, 0, 0), Ok(7));
        }

        // A held result waits for the page no longer than a request waits for its response.
        #[test]
        fn the_hold_deadline_is_the_request_deadline() {
            assert_eq!(crate::vd::package::HOLD_DEADLINE, super::REQUEST_DEADLINE);
        }

        // A result the page leaves with neither an adoption nor a report holds the slot no longer
        // than the hold deadline: the connection then ends with it, the worker's request waiting
        // behind it is told the end, and the page's late adoption finds the slot gone. One adopted
        // in time keeps the connection.
        #[test]
        fn a_result_the_page_leaves_unadopted_ends_the_connection_at_the_hold_deadline() {
            // Shorter than the worker's own response deadline in these cases, so the end is the
            // hold's and not the deadline's.
            let hold = Duration::from_millis(80);
            let (tx, _unit, _) = connected(plain);
            let link = package();
            link.hold_for(hold);
            link.request(
                1,
                "request-1",
                1,
                1,
                package_call(Method::GetNumeric, 1.0, None),
            )
            .unwrap();
            let started = std::time::Instant::now();
            assert_eq!(
                get(tx.clone(), 2, 0, 0),
                Err(crate::vd::package::ENDED.to_string())
            );
            let waited = started.elapsed();
            assert!(
                waited >= hold - Duration::from_millis(20) && waited < Duration::from_secs(2),
                "{waited:?}"
            );
            assert!(
                !link.adopt("request-1"),
                "the slot went with the connection"
            );

            let (tx, _unit, _) = connected(plain);
            let link = package();
            link.hold_for(hold);
            link.request(
                1,
                "request-1",
                1,
                1,
                package_call(Method::GetNumeric, 1.0, None),
            )
            .unwrap();
            assert!(link.adopt("request-1"));
            thread::sleep(hold * 2);
            assert_eq!(
                get(tx.clone(), 2, 0, 0),
                Ok(7),
                "adopted in time, it ends nothing"
            );
        }

        /// `plain`, each reply sent `after` the request arrives.
        fn slow(after: Duration) -> impl Fn(&Value) -> Vec<Value> + Send + Sync + 'static {
            move |request: &Value| {
                thread::sleep(after);
                plain(request)
            }
        }

        // A resend of a request — Tauri sends one again when the page could not read its reply —
        // reaches the unit at most once, and is answered with the first call's record: while the
        // first is out, once it is in, and once the page has adopted it.
        #[test]
        fn a_resent_package_request_reaches_the_unit_once_and_keeps_its_record() {
            let (_tx, unit, _) = connected(slow(Duration::from_millis(100)));
            let link = package();
            let write = |link: Arc<PackageLink>| {
                thread::spawn(move || {
                    link.request(
                        1,
                        "request-1",
                        0,
                        0,
                        package_call(Method::SetNumeric, 1.0, Some("5")),
                    )
                    .unwrap()
                })
            };
            let first = write(Arc::clone(&link));
            thread::sleep(Duration::from_millis(30));
            let resent = write(Arc::clone(&link));
            let (first, resent) = (first.join().unwrap(), resent.join().unwrap());
            assert_eq!(
                resent, first,
                "the resend waits for the first and answers it"
            );
            assert_eq!(
                serde_json::to_value(&first.record).unwrap()["evidence"],
                json!({ "state": "accepted" })
            );
            assert_eq!(
                link.request(
                    1,
                    "request-1",
                    0,
                    0,
                    package_call(Method::SetNumeric, 1.0, Some("5"))
                )
                .unwrap(),
                first,
                "a resend after the reply"
            );
            assert!(link.adopt("request-1"));
            assert!(link.adopt("request-1"), "the adoption's own resend");
            assert_eq!(
                link.request(
                    1,
                    "request-1",
                    0,
                    0,
                    package_call(Method::SetNumeric, 1.0, Some("5"))
                ),
                Err(crate::vd::package::FINISHED.to_string()),
                "a late resend after the adoption is rejected, with no evidence"
            );
            assert_eq!(writes_to(&unit, 1), 1, "the unit took it once");
        }

        // A report or terminate that reaches the shell ahead of its own request — two commands of the
        // page's racing through the IPC — leaves the ticket ended: the request that arrives after it
        // is rejected and sends nothing, and nothing waits behind a slot.
        #[test]
        fn a_package_request_arriving_after_its_own_terminate_is_not_sent() {
            let (tx, unit, _) = connected(plain);
            let link = package();
            assert!(link.terminate("request-1"), "an unseen ticket");
            assert!(!link.fail_delivery("request-2"), "an unseen ticket");
            for ticket in ["request-1", "request-2"] {
                assert_eq!(
                    link.request(
                        1,
                        ticket,
                        0,
                        0,
                        package_call(Method::SetNumeric, 1.0, Some("5"))
                    ),
                    Err(crate::vd::package::FINISHED.to_string()),
                    "{ticket}"
                );
            }
            assert_eq!(writes_to(&unit, 1), 0);
            assert_eq!(
                get(tx.clone(), 2, 0, 0),
                Ok(7),
                "nothing waits behind a slot"
            );
        }

        // A ticket the page's floor passes while the shell still holds its result unsettled is one
        // the page gave up — its adoption, report and terminate never arrived — so the connection
        // ends with its slot rather than leaving a slot nobody can release; so does one the floor
        // passes while its result is still on its way, as that result arrives.
        #[test]
        fn a_package_ticket_the_page_gave_up_ends_the_connection_with_its_slot() {
            let (tx, _unit, _) = connected(plain);
            let link = package();
            link.request(
                1,
                "request-1",
                1,
                0,
                package_call(Method::GetNumeric, 1.0, None),
            )
            .unwrap();
            let after = link
                .request(
                    1,
                    "request-2",
                    2,
                    0,
                    package_call(Method::GetNumeric, 1.0, None),
                )
                .unwrap();
            assert_eq!(
                serde_json::to_value(&after.record).unwrap()["failure"],
                json!({ "kind": "cause", "code": "not_connected", "phase": "admission" }),
                "the connection closed before the request was sent"
            );
            assert_eq!(
                get(tx.clone(), 2, 0, 0),
                Err(crate::vd::package::ENDED.to_string())
            );

            let (tx, _unit, _) = connected(slow(Duration::from_millis(100)));
            let link = package();
            let on_its_way = {
                let link = Arc::clone(&link);
                thread::spawn(move || {
                    link.request(
                        1,
                        "request-1",
                        1,
                        0,
                        package_call(Method::GetNumeric, 1.0, None),
                    )
                })
            };
            thread::sleep(Duration::from_millis(30));
            let passed = {
                let link = Arc::clone(&link);
                thread::spawn(move || {
                    link.request(
                        1,
                        "request-2",
                        2,
                        0,
                        package_call(Method::GetNumeric, 1.0, None),
                    )
                })
            };
            on_its_way.join().unwrap().unwrap();
            let _ = passed.join().unwrap();
            assert_eq!(
                get(tx.clone(), 2, 0, 0),
                Err(crate::vd::package::ENDED.to_string()),
                "the given-up result ended the connection as it arrived"
            );
            assert_eq!(
                link.kept().0,
                1,
                "arriving below the floor, it is recorded nowhere: only the later ticket is kept"
            );
        }

        // A report that a result could not be delivered, made while that result is still on its
        // way, waits for it and ends the connection with the slot it holds.
        #[test]
        fn a_package_result_reported_undelivered_while_on_its_way_ends_the_connection() {
            let (tx, _unit, _) = connected(slow(Duration::from_millis(100)));
            let link = package();
            let reading = {
                let link = Arc::clone(&link);
                thread::spawn(move || {
                    link.request(
                        1,
                        "request-1",
                        0,
                        0,
                        package_call(Method::GetNumeric, 1.0, None),
                    )
                    .unwrap()
                })
            };
            thread::sleep(Duration::from_millis(30));
            assert!(link.fail_delivery("request-1"));
            reading.join().unwrap();
            assert_eq!(
                get(tx.clone(), 2, 0, 0),
                Err(crate::vd::package::ENDED.to_string()),
                "the connection has ended, with nothing waiting behind the slot"
            );
        }

        // A session let go while a package request is still on its way ends as well: its reply
        // arrives after the teardown, and the worker waiting behind it still reaches its shutdown.
        #[test]
        fn a_session_let_go_while_a_package_request_is_on_its_way_still_shuts_down() {
            let (tx, _unit, _) = connected(slow(Duration::from_millis(150)));
            let link = package();
            let reading = {
                let link = Arc::clone(&link);
                thread::spawn(move || {
                    link.request(
                        1,
                        "request-1",
                        0,
                        0,
                        package_call(Method::GetNumeric, 1.0, None),
                    )
                })
            };
            thread::sleep(Duration::from_millis(30));
            let (params, _seen) = subscriber();
            let registering = {
                let tx = tx.clone();
                thread::spawn(move || params_subscribe(tx, vec![(1, 0, 0)], params))
            };
            thread::sleep(Duration::from_millis(30));
            link.tear_down();
            let (done, closed) = mpsc::channel();
            tx.send(Cmd::Shutdown {
                done: Some((done, Instant::now() + Duration::from_secs(3))),
            })
            .unwrap();
            assert!(
                closed.recv_timeout(Duration::from_secs(3)).is_ok(),
                "the worker reaches its shutdown"
            );
            let _ = reading.join();
            assert!(
                registering.join().unwrap().is_err(),
                "the teardown started the close: the registration waiting behind the request is not sent"
            );
        }

        // A session let go while a worker's registration waits behind a slot the page will never
        // adopt still ends: the teardown closes the connection outside the worker's queue.
        #[test]
        fn a_session_let_go_behind_an_unadopted_slot_still_shuts_down() {
            let (tx, _unit, _) = connected(plain);
            let link = package();
            link.request(
                1,
                "request-1",
                0,
                0,
                package_call(Method::GetNumeric, 1.0, None),
            )
            .unwrap();
            let (params, _seen) = subscriber();
            let registering = {
                let tx = tx.clone();
                thread::spawn(move || params_subscribe(tx, vec![(1, 0, 0)], params))
            };
            thread::sleep(Duration::from_millis(50));
            assert!(
                !registering.is_finished(),
                "the premise: the registration waits behind the slot"
            );
            link.tear_down();
            let (done, closed) = mpsc::channel();
            tx.send(Cmd::Shutdown {
                done: Some((done, Instant::now() + Duration::from_secs(3))),
            })
            .unwrap();
            assert!(
                closed.recv_timeout(Duration::from_secs(3)).is_ok(),
                "the worker reaches its shutdown"
            );
            let _ = registering.join();
            let after = link
                .request(
                    2,
                    "request-2",
                    0,
                    0,
                    package_call(Method::GetNumeric, 1.0, None),
                )
                .unwrap();
            assert_eq!(
                serde_json::to_value(&after.record).unwrap()["failure"],
                json!({ "kind": "cause", "code": "not_connected", "phase": "admission" }),
                "nothing is submitted once the link is torn down"
            );
        }

        // The unit's refusal keeps its response code.
        #[test]
        fn a_package_write_the_unit_refuses_keeps_its_response_code() {
            let (_tx, _unit, _) = connected(|request: &Value| {
                let uri = request["vdp"]["uri"].as_str().unwrap();
                vec![json!({ "method": "post", "uri": uri, "data": { "response_code": 403 } })]
            });
            let link = package();
            let reply = link
                .request(
                    1,
                    "request-1",
                    0,
                    0,
                    package_call(Method::SetText, 1.0, Some("a")),
                )
                .unwrap();
            assert_eq!(
                serde_json::to_value(&reply.record).unwrap(),
                json!({
                    "kind": "failure",
                    "failure": { "kind": "cause", "code": "device_rejected", "phase": "response" },
                    "evidence": { "state": "rejected", "responseCode": "403" },
                })
            );
            assert!(link.adopt("request-1"));
        }

        // A control-package write goes through the unit's Console Lock gate as the worker's do: held,
        // it is refused unsent, and the reply names the fetch that carries the lock.
        #[test]
        fn a_package_write_the_lock_holds_is_refused_unsent_with_its_lock_s_fetch() {
            let (tx, unit, _) = connected(plain);
            let (params, _seen) = subscriber();
            params_subscribe(tx.clone(), vec![(CONSOLE_LOCK_PARAM, 0, 0)], params).unwrap();
            let outbox = OUTBOX.with(|current| current.borrow().clone()).unwrap();
            let first = FETCHED.with(|next| next.get());
            unit.push(json!({
                "method": "notify",
                "uri": format!("/vd/parameters/{CONSOLE_LOCK_PARAM}:0:0"),
                "data": { "current_value": 1 },
            }));
            let until = Instant::now() + Duration::from_secs(5);
            while !(outbox.lock_heard().is_some() && put_all(&outbox)) {
                assert!(
                    Instant::now() < until,
                    "the announcement reaches the outbox"
                );
                thread::sleep(Duration::from_millis(1));
            }
            let reply = package()
                .request(
                    1,
                    "request-1",
                    0,
                    0,
                    package_call(Method::SetNumeric, 1.0, Some("5")),
                )
                .unwrap();
            assert_eq!(
                serde_json::to_value(&reply).unwrap(),
                json!({
                    "record": {
                        "kind": "failure",
                        "failure": { "kind": "cause", "code": "precondition_failed", "phase": "admission" },
                        "evidence": { "state": "not_sent" },
                    },
                    "held": { "fetch": first },
                })
            );
            assert_eq!(
                writes_to(&unit, 1),
                0,
                "nothing was sent for the held write"
            );
            let read = package()
                .request(
                    1,
                    "request-2",
                    0,
                    0,
                    package_call(Method::GetNumeric, 1.0, None),
                )
                .unwrap();
            assert_eq!(read.held, None, "a read is not held");
        }

        // A result the page cannot adopt ends the connection with its slot held, and the session's
        // link watch reports the end; one that holds no slot ends nothing.
        #[test]
        fn a_package_result_the_page_cannot_adopt_ends_the_connection() {
            let (tx, _unit, _) = connected(plain);
            let link = package();
            link.request(
                1,
                "request-1",
                0,
                0,
                package_call(Method::GetNumeric, -1.0, None),
            )
            .unwrap();
            assert!(link.fail_delivery("request-1"));
            assert_eq!(
                get(tx.clone(), 2, 0, 0),
                Ok(7),
                "an unsent result ends nothing"
            );
            assert!(!link.fail_delivery("request-9"), "an unknown ticket");
            let (channel, events) = capture();
            watch_link(tx.clone(), channel).unwrap();
            link.request(
                1,
                "request-2",
                0,
                0,
                package_call(Method::GetNumeric, 1.0, None),
            )
            .unwrap();
            assert!(link.fail_delivery("request-2"));
            assert_eq!(
                next(&events),
                json!({ "reason": crate::vd::package::ENDED }),
                "the link watch reports the end"
            );
            assert_eq!(
                get(tx.clone(), 2, 0, 0),
                Err(crate::vd::package::ENDED.to_string()),
                "every later command fails with the same end"
            );
            assert!(!link.adopt("request-2"), "the slot went with the end");
            let after = link
                .request(
                    2,
                    "request-3",
                    0,
                    0,
                    package_call(Method::GetNumeric, 1.0, None),
                )
                .unwrap();
            assert_eq!(
                serde_json::to_value(&after.record).unwrap(),
                json!({
                    "kind": "failure",
                    "failure": { "kind": "cause", "code": "not_connected", "phase": "admission" },
                    "evidence": { "state": "not_sent" },
                }),
                "the connection is closed: a later request is refused before it is sent"
            );
        }

        // Terminate ends the connection only for a result still holding its slot.
        #[test]
        fn a_package_terminate_ends_the_connection_only_for_a_held_slot() {
            let (tx, _unit, _) = connected(plain);
            let link = package();
            link.request(
                1,
                "request-1",
                0,
                0,
                package_call(Method::GetNumeric, 1.0, None),
            )
            .unwrap();
            assert!(link.adopt("request-1"));
            assert!(
                link.terminate("request-1"),
                "an adopted result owns no slot"
            );
            assert_eq!(get(tx.clone(), 2, 0, 0), Ok(7), "the connection goes on");
            link.request(
                1,
                "request-2",
                0,
                0,
                package_call(Method::GetNumeric, 1.0, None),
            )
            .unwrap();
            assert!(link.terminate("request-2"));
            assert_eq!(
                get(tx.clone(), 2, 0, 0),
                Err(crate::vd::package::ENDED.to_string()),
                "the connection has ended"
            );
        }

        // An owner the page cancelled or finished submits nothing.
        #[test]
        fn a_cancelled_or_finished_package_owner_sends_nothing() {
            let (_tx, unit, _) = connected(plain);
            let link = package();
            link.cancel(1);
            let cancelled = link
                .request(
                    1,
                    "request-1",
                    0,
                    0,
                    package_call(Method::SetNumeric, 1.0, Some("5")),
                )
                .unwrap();
            assert_eq!(
                serde_json::to_value(&cancelled.record).unwrap(),
                json!({
                    "kind": "failure",
                    "failure": { "kind": "cancelled", "phase": "admission" },
                    "evidence": { "state": "not_sent" },
                })
            );
            link.finish(2);
            let finished = link
                .request(
                    2,
                    "request-2",
                    0,
                    0,
                    package_call(Method::SetNumeric, 1.0, Some("5")),
                )
                .unwrap();
            assert_eq!(
                serde_json::to_value(&finished.record).unwrap()["failure"],
                json!({ "kind": "cause", "code": "not_connected", "phase": "admission" })
            );
            assert_eq!(writes_to(&unit, 1), 0);
            assert!(link.adopt("request-1") && link.adopt("request-2"));
        }

        // A control-package request's missed deadline is on the ledger, as the worker's are.
        #[test]
        fn a_package_request_past_its_deadline_is_on_the_ledger() {
            let (_tx, _unit, counters) = connected(|_: &Value| vec![]);
            let link = package();
            let reply = link
                .request(
                    1,
                    "request-1",
                    0,
                    0,
                    package_call(Method::GetNumeric, 1.0, None),
                )
                .unwrap();
            assert_eq!(
                serde_json::to_value(&reply.record).unwrap()["failure"],
                json!({ "kind": "cause", "code": "response_timeout", "phase": "response" })
            );
            assert_eq!(counters.read().deadlines, 1);
        }

        // The unit's own refusal settles the request it answers: an end of the link that
        // comes after the reply, before the error is worded, is the next request's to report.
        #[test]
        fn a_refusal_the_unit_gave_stands_when_the_link_ends_after_it() {
            let unit = Unit::start("<device-id-a>", plain);
            let options = ConnectionOptions {
                connect_deadline: CONNECT_DEADLINE,
                handshake_request_deadline: DEADLINE,
                send_deadline: DEADLINE,
                response_deadline: DEADLINE,
            };
            let connection = open_with(unit.port, "<device-id-a>", &options, &Control::new(), None)
                .unwrap_or_else(|_| panic!("the unit opens"));
            unit.push(synchronize("lost"));
            let ended = Instant::now() + Duration::from_secs(5);
            while connection.terminal().is_none() {
                assert!(Instant::now() < ended, "the push ends the connection");
                thread::sleep(Duration::from_millis(5));
            }
            let unattached = PackageLink::new(Arc::default(), Arc::default());
            let rejected = RequestFailure::Cause {
                code: RequestCause::DeviceRejected,
                phase: RequestPhase::Response,
            };
            assert_eq!(
                request_text(
                    &connection,
                    &unattached,
                    rejected,
                    Evidence::Rejected(400),
                    "1:0:0"
                ),
                "broker-rejected: 1:0:0 response_code 400"
            );
            let lost = RequestFailure::Cause {
                code: RequestCause::ConnectionLost,
                phase: RequestPhase::Response,
            };
            assert!(
                request_text(
                    &connection,
                    &unattached,
                    lost,
                    Evidence::Unconfirmed,
                    "1:0:0"
                )
                .starts_with(DEVICE_LOST_PREFIX),
                "a request the end met is told by the end"
            );
        }

        // A replacement is a success only once the old set is let go as well: a release
        // that fails ends the connection, and the reply says so instead of Ok.
        #[test]
        fn a_replacement_whose_old_set_is_not_released_fails() {
            let (tx, _unit, _) = connected(|request| {
                if request["vdp"]["uri"] == "/vd/parameters/1:0:0?operation=unregist" {
                    return vec![post_reply("/vd/parameters/1:0:0", "unregist", 400)];
                }
                plain(request)
            });
            let (first, _) = subscriber();
            let (second, _) = subscriber();
            params_subscribe(tx.clone(), vec![(1, 0, 0)], first).unwrap();
            assert!(params_subscribe(tx.clone(), vec![(2, 0, 0)], second).is_err());
            assert!(
                get(tx, 1, 0, 0).is_err(),
                "the failed release ended the session"
            );
        }

        // A response deadline that runs out in a registration or in the old set's release
        // ends the connection as one in a get does, and the ledger's deadline rows say so.
        #[test]
        fn a_registration_or_a_release_past_its_deadline_is_on_the_ledger() {
            for late in [
                "/vd/parameters/1:0:0?operation=regist",
                "/vd/parameters/1:0:0?operation=unregist",
            ] {
                let (tx, _unit, counters) = connected(move |request| {
                    if request["vdp"]["uri"] == late {
                        thread::sleep(LATE);
                    }
                    plain(request)
                });
                let (first, _) = subscriber();
                let (second, _) = subscriber();
                let replaced = params_subscribe(tx.clone(), vec![(1, 0, 0)], first)
                    .and_then(|()| params_subscribe(tx.clone(), vec![(2, 0, 0)], second));
                // The caller is told of its own deadline, and the commands after it of the
                // end that deadline brought.
                assert_eq!(
                    replaced,
                    Err("broker-timeout: Subscription".to_string()),
                    "{late}"
                );
                assert_eq!(
                    get(tx, 1, 0, 0),
                    Err(BROKER_UNRESPONSIVE.to_string()),
                    "{late}"
                );
                let stats = counters.read();
                assert_eq!((stats.deadlines, stats.stalled), (1, 1), "{late}");
            }
        }

        // The unit's refusal of a registration or of the old set's release is what the
        // caller is told, even when the connection ends with it or right after: a refused
        // registration whose cleanup then runs out of time, and a release the unit refuses,
        // which ends the connection. The later commands are told of that end.
        #[test]
        fn a_refused_registration_or_release_is_what_its_caller_is_told() {
            let refused_then_late = connected(|request| {
                let uri = request["vdp"]["uri"].as_str().unwrap();
                if uri == "/vd/parameters/2:0:0?operation=regist" {
                    return vec![post_reply("/vd/parameters/2:0:0", "regist", 400)];
                }
                if uri == "/vd/parameters/1:0:0?operation=unregist" {
                    thread::sleep(LATE);
                }
                plain(request)
            });
            let release_refused = connected(|request| {
                if request["vdp"]["uri"] == "/vd/parameters/1:0:0?operation=unregist" {
                    return vec![post_reply("/vd/parameters/1:0:0", "unregist", 400)];
                }
                plain(request)
            });
            let (tx, _unit, _) = refused_then_late;
            let (channel, _) = subscriber();
            assert_eq!(
                params_subscribe(tx.clone(), vec![(1, 0, 0), (2, 0, 0)], channel),
                Err("broker-rejected: Subscription".to_string())
            );
            assert_eq!(get(tx, 1, 0, 0), Err(BROKER_UNRESPONSIVE.to_string()));
            let (tx, _unit, _) = release_refused;
            let (first, _) = subscriber();
            let (second, _) = subscriber();
            params_subscribe(tx.clone(), vec![(1, 0, 0)], first).unwrap();
            assert_eq!(
                params_subscribe(tx.clone(), vec![(2, 0, 0)], second),
                Err("broker-rejected: Subscription".to_string())
            );
            let after = get(tx, 1, 0, 0);
            assert!(
                after
                    .as_ref()
                    .is_err_and(|e| !e.starts_with("broker-rejected")),
                "{after:?}"
            );
        }

        // The ledger's frame rows are what reached the unit, however the call that sent
        // them ended (R1-C-A): a registration refused at the second address counts the two
        // registrations sent and the cleanup's one unregistration, not the three planned.
        #[test]
        fn a_refused_registration_counts_the_frames_it_sent() {
            let (tx, unit, counters) = connected(|request| {
                if request["vdp"]["uri"] == "/vd/parameters/2:0:0?operation=regist" {
                    return vec![post_reply("/vd/parameters/2:0:0", "regist", 400)];
                }
                plain(request)
            });
            let (channel, _) = subscriber();
            assert!(
                params_subscribe(tx.clone(), vec![(1, 0, 0), (2, 0, 0), (3, 0, 0)], channel)
                    .is_err()
            );
            let posted = |operation: &str| {
                unit.seen()
                    .iter()
                    .filter(|uri| uri.ends_with(&format!("operation={operation}")))
                    .count() as u64
            };
            assert_eq!((posted("regist"), posted("unregist")), (2, 1));
            let stats = counters.read();
            assert_eq!((stats.regist_frames, stats.unregist_frames), (2, 1));
            assert_eq!(
                get(tx, 1, 0, 0),
                Ok(7),
                "an ordinary refusal keeps the session"
            );
        }

        #[test]
        fn the_unit_is_chosen_by_model_and_none_or_an_ambiguous_choice_is_refused() {
            let a = Unit::start("<device-id-a>", plain);
            let b = Unit::start("<device-id-b>", plain);
            let list = device_list(&[(&a, "URX22"), (&b, "URX44V")]);
            assert_eq!(
                start(list, "URX44V").1.map(|s| s.model),
                Ok("URX44V".to_string())
            );
            let err = start(list, "URX44").1.err().unwrap();
            assert!(
                err.starts_with("multiple-devices: 2 online (URX22, URX44V), 0 of them URX44"),
                "{err}"
            );
            let c = Unit::start("<device-id-c>", plain);
            let err = start(device_list(&[(&b, "URX44V"), (&c, "URX44V")]), "URX44V")
                .1
                .err()
                .unwrap();
            assert!(
                err.starts_with("multiple-devices: 2 online (URX44V, URX44V), 2 of them URX44V"),
                "{err}"
            );
            assert_eq!(
                start(device_list(&[]), "URX44V").1.err(),
                Some("no-device".to_string())
            );
        }

        fn get_reply(uri: &str, value: i64) -> Value {
            json!({ "method": "get", "uri": uri, "data": { "response_code": 200, "current_value": value } })
        }

        /// The reply to one POST operation on `address`.
        fn post_reply(address: &str, operation: &str, code: u16) -> Value {
            json!({ "method": "post", "uri": format!("{address}?operation={operation}"),
                "data": { "response_code": code } })
        }

        /// The address a request names, its operation left out.
        fn address_of(request: &Value) -> String {
            let uri = request["vdp"]["uri"].as_str().unwrap();
            uri.split('?').next().unwrap().to_string()
        }

        /// Counts each request `answer` is asked about, from 1, beside the request.
        fn counted(
            answer: impl Fn(usize, &Value) -> Vec<Value> + Send + Sync + 'static,
        ) -> impl Fn(&Value) -> Vec<Value> + Send + Sync + 'static {
            let calls = Mutex::new(0);
            move |request| {
                let n = {
                    let mut calls = calls.lock().unwrap();
                    *calls += 1;
                    *calls
                };
                answer(n, request)
            }
        }

        /// The error an open that should fail failed with.
        fn refused(summary: Result<DeviceSummary, String>) -> String {
            match summary {
                Ok(summary) => panic!("the unit opened as {}", summary.model),
                Err(e) => e,
            }
        }

        /// How late a case's straggler comes: past the deadline.
        const LATE: Duration = Duration::from_millis(300);

        // A write, a registration and an unregistration are all POSTs on the address, and a
        // registration's reply can still be in flight when the next write starts. Only the
        // reply carrying the write's own operation is its verdict: the refusal here, behind
        // two acknowledgements of registrations.
        #[test]
        fn a_write_takes_its_verdict_only_from_its_own_operations_reply() {
            let (tx, _unit, _) = connected(|request| {
                let at = address_of(request);
                vec![
                    post_reply(&at, "regist", 200),
                    post_reply(&at, "unregist", 200),
                    post_reply(&at, "value", 400),
                ]
            });
            let err = set(tx, 1, 0, 0, 5).unwrap_err();
            assert!(err.starts_with("broker-rejected: 1:0:0"), "{err}");
        }
        // A write past its deadline ends the session, so the acknowledgement that comes after
        // it is no write's verdict: the next write fails with the session's end.
        #[test]
        fn a_write_past_its_deadline_ends_the_session_before_its_late_acknowledgement() {
            let (tx, _unit, _) = connected(counted(|n, request| {
                let at = address_of(request);
                if n == 1 {
                    thread::sleep(LATE);
                    vec![post_reply(&at, "value", 200)]
                } else {
                    vec![post_reply(&at, "value", 400)]
                }
            }));
            let err = set(tx.clone(), 1, 0, 0, 5).unwrap_err();
            assert!(err.starts_with("broker-timeout: 1:0:0"), "{err}");
            // Not sent, and said so: the page takes it as a write that cannot have landed.
            assert_eq!(
                set(tx, 1, 0, 0, 6),
                Err(format!("{NOT_SENT}: {BROKER_UNRESPONSIVE}"))
            );
        }
        // The unit lost after a read's deadline changes nothing: the deadline already ended
        // the session, as unresponsive.
        #[test]
        fn a_unit_lost_after_a_reads_deadline_does_not_change_how_the_session_ended() {
            let (tx, _unit, _) = connected(|_| {
                thread::sleep(LATE);
                vec![synchronize("offline")]
            });
            let err = get(tx.clone(), 1, 0, 0).unwrap_err();
            assert!(err.starts_with("broker-timeout: 1:0:0"), "{err}");
            thread::sleep(Duration::from_millis(200));
            assert_eq!(get(tx, 1, 0, 0), Err(BROKER_UNRESPONSIVE.to_string()));
        }

        // A stray line that is not JSON is dropped rather than failed on: a command waiting
        // for its reply reads past it to the reply behind it…
        #[test]
        fn a_reply_is_read_past_a_line_that_is_not_json() {
            let (tx, _unit, _) = connected(|request| {
                vec![
                    json!({ "raw": "not json\n" }),
                    get_reply(&address_of(request), 5),
                ]
            });
            assert_eq!(get(tx, 1, 0, 0), Ok(5));
        }

        // …and on an idle session the push behind it is what ends the session.
        #[test]
        fn a_line_that_is_not_json_while_idle_is_dropped_and_the_push_behind_it_reported() {
            let (tx, unit, _) = connected(plain);
            let (channel, events) = capture();
            watch_link(tx.clone(), channel).unwrap();
            unit.push_raw(b"not json\n");
            unit.push(synchronize("offline"));
            let reason = next(&events)["reason"].as_str().unwrap().to_string();
            assert!(reason.starts_with("device-lost"), "{reason}");
        }

        // The ledger counts what was put on the socket. A command refused because the session
        // is over never reaches it, so a lost session's later gets, sets and registrations
        // leave their rows where they were — while one that does reach the socket is counted.
        #[test]
        fn a_command_after_the_session_ended_is_not_counted_as_sent() {
            let (tx, unit, counters) = connected(plain);
            let (channel, events) = capture();
            watch_link(tx.clone(), channel).unwrap();
            assert_eq!(get(tx.clone(), 1, 0, 0), Ok(7));
            assert_eq!(
                counters.read().gets,
                1,
                "a get put on the socket is counted"
            );
            unit.push(synchronize("lost"));
            next(&events);
            assert!(get(tx.clone(), 1, 0, 0).is_err());
            assert!(get_str(tx.clone(), 18, 0, 0).is_err());
            assert!(set(tx.clone(), 1, 0, 0, 0).is_err());
            assert!(set_str(tx.clone(), 18, 0, 0, "ch 1".to_string()).is_err());
            let (meters, _) = subscriber();
            assert!(meters_subscribe(tx.clone(), vec![(115, 0)], meters).is_err());
            let (params, _) = subscriber();
            // `tx` is kept until the ledger is read, so the frame rows are still the connection's.
            assert!(params_subscribe(tx.clone(), vec![(1, 0, 0)], params).is_err());
            let after = counters.read();
            assert_eq!(
                (after.gets, after.sets, after.regist_frames),
                (1, 0, 0),
                "commands refused after the end were counted as sent"
            );
        }

        // A notify whose address has more coordinates than its kind takes is not an update of
        // the address its first coordinates name.
        #[test]
        fn a_notify_with_more_coordinates_than_its_kind_is_not_an_update() {
            let (tx, unit, _) = connected(plain);
            let (params, params_seen) = subscriber();
            let (meters, meters_seen) = subscriber();
            params_subscribe(tx.clone(), vec![(1, 0, 0)], params).unwrap();
            // A clone: the last sender gone ends the worker, and the session with it.
            meters_subscribe(tx.clone(), vec![(115, 0)], meters).unwrap();
            for (uri, value) in [
                ("/vd/parameters/1:0:0:7", 9),
                ("/vd/meters/115:0:1", -100),
                ("/vd/parameters/1:0:0", 5),
                ("/vd/meters/115:0", -200),
            ] {
                unit.push(
                    json!({ "method": "notify", "uri": uri, "data": { "current_value": value } }),
                );
            }
            assert_eq!(
                updates(&params_seen),
                json!([{ "param_id": 1, "x": 0, "y": 0, "value": 5 }])
            );
            assert_eq!(
                updates(&meters_seen),
                json!([{ "meter_id": 115, "x": 0, "value": -200 }])
            );
        }

        // The dev build's parameter watch and the live-sync subscription share the broker's
        // one registration per address: an address both hold is registered once, stays
        // registered while either holds it — across the live-sync set being replaced, which
        // follows every structural edit — and is unregistered once when the session closes.
        #[test]
        fn the_parameter_watch_and_live_sync_register_a_shared_address_once() {
            let (tx, unit, _) = connected(plain);
            let (first, _) = subscriber();
            let (probe, _) = subscriber();
            let (second, _) = subscriber();
            params_subscribe(tx.clone(), vec![(1, 0, 0), (2, 0, 0)], first).unwrap();
            probe_subscribe(tx.clone(), vec![(2, 0, 0), (3, 0, 0)], probe).unwrap();
            params_subscribe(tx.clone(), vec![(2, 0, 0), (4, 0, 0)], second).unwrap();
            let count = |uri: &str| unit.seen().iter().filter(|s| s.as_str() == uri).count();
            for (param, regist, unregist) in [(1, 1, 1), (2, 1, 0), (3, 1, 0), (4, 1, 0)] {
                let at = format!("/vd/parameters/{param}:0:0");
                assert_eq!(count(&format!("{at}?operation=regist")), regist, "{at}");
                assert_eq!(count(&format!("{at}?operation=unregist")), unregist, "{at}");
            }
            let (done, signalled) = mpsc::channel();
            tx.send(Cmd::Shutdown {
                done: Some((done, Instant::now() + Duration::from_secs(2))),
            })
            .unwrap();
            signalled.recv_timeout(Duration::from_secs(5)).unwrap();
            for param in 1..=4 {
                let at = format!("/vd/parameters/{param}:0:0?operation=unregist");
                assert_eq!(count(&at), 1, "{at}");
            }
        }

        // The ledger's frame rows are read from the connection at each reading, so a frame is
        // on them once it is on the socket: an unsubscribe still waiting for the unit's answer
        // already counts the unregistration it sent. (The close's own unregistrations come
        // after the app's last reading of a session, and are on none.)
        #[test]
        fn a_reading_takes_in_the_frames_already_on_the_socket() {
            let (answer, held) = mpsc::channel::<()>();
            let held = Mutex::new(held);
            let unit = Unit::start("<device-id-a>", move |request| {
                if request["vdp"]["uri"] == "/vd/parameters/1:0:0?operation=unregist" {
                    let _ = held.lock().unwrap().recv_timeout(Duration::from_secs(5));
                }
                plain(request)
            });
            let list = device_list(&[(&unit, "URX44V")]);
            let (tx, summary, counters) = start_within(list, "URX44V", Duration::from_secs(5));
            summary.expect("the unit opens");
            let (params, _) = subscriber();
            let (probe, _) = subscriber();
            params_subscribe(tx.clone(), vec![(1, 0, 0), (2, 0, 0)], params).unwrap();
            probe_subscribe(tx.clone(), vec![(2, 0, 0), (3, 0, 0)], probe).unwrap();
            params_unsubscribe(tx.clone()).unwrap();
            let frames = || {
                let stats = counters.read();
                (stats.regist_frames, stats.unregist_frames)
            };
            // The unit holds its answer to the unregistration, so the release is still
            // waiting while this reads.
            let reading = Instant::now();
            while frames() != (3, 1) && reading.elapsed() < Duration::from_secs(2) {
                thread::sleep(Duration::from_millis(5));
            }
            assert_eq!(frames(), (3, 1), "the watch still holds 2, so 1 alone goes");
            answer.send(()).unwrap();
            // `tx` is kept until the ledger is read, so the frame rows are still the connection's.
            assert_eq!(
                get(tx.clone(), 1, 0, 0),
                Ok(7),
                "the session goes on once the unit answers"
            );
            let posted = |operation: &str| {
                unit.seen()
                    .iter()
                    .filter(|uri| uri.ends_with(&format!("operation={operation}")))
                    .count() as u64
            };
            assert_eq!((posted("regist"), posted("unregist")), frames());
        }

        // The app-exit teardown's caller stops waiting at its instant, and the close ends by
        // it however the broker behaves: it never answers the unregistrations, sends whole
        // lines 30 ms apart, and then pieces of one that never ends.
        #[test]
        fn the_exit_teardown_ends_by_its_instant_while_the_broker_never_answers() {
            let (tx, unit, _) = connected(|request| {
                let uri = request["vdp"]["uri"].as_str().unwrap();
                if uri.ends_with("operation=unregist") {
                    vec![]
                } else {
                    plain(request)
                }
            });
            let (params, _) = subscriber();
            params_subscribe(tx.clone(), vec![(1, 0, 0)], params).unwrap();
            let latest = Arc::clone(&unit.latest);
            thread::spawn(move || {
                let write = |bytes: &[u8]| {
                    let mut latest = latest.lock().unwrap();
                    latest
                        .as_mut()
                        .map(|s| s.write_all(bytes).is_ok())
                        .unwrap_or(false)
                };
                let notify = format!(
                    "{}\n",
                    json!({ "vdp": { "method": "notify", "uri": "/vd/parameters/1:0:0",
                        "data": { "current_value": 1 } } })
                );
                for _ in 0..10 {
                    if !write(notify.as_bytes()) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(30));
                }
                write(b"{\"vdp\": ");
                for _ in 0..200 {
                    if !write(b" ") {
                        return;
                    }
                    thread::sleep(Duration::from_millis(10));
                }
            });
            thread::sleep(Duration::from_millis(100));
            let wait = Duration::from_millis(500);
            let started = Instant::now();
            let (done, signalled) = mpsc::channel();
            tx.send(Cmd::Shutdown {
                done: Some((done, started + wait)),
            })
            .unwrap();
            signalled
                .recv_timeout(Duration::from_secs(5))
                .expect("the close signals");
            assert!(
                started.elapsed() < wait + Duration::from_millis(300),
                "the close took {:?}",
                started.elapsed()
            );
        }

        // A read's wait ends at its deadline while bytes keep arriving that never end a line,
        // as it does on a silent link, instead of lasting as long as the bytes keep coming.
        #[test]
        fn a_read_ends_at_its_deadline_while_a_line_keeps_arriving() {
            let (tx, unit, _) = connected(|_| vec![json!({ "raw": "{\"vdp\": " })]);
            let latest = Arc::clone(&unit.latest);
            let feeding = Arc::new(std::sync::atomic::AtomicBool::new(true));
            let feed = Arc::clone(&feeding);
            thread::spawn(move || {
                while feed.load(std::sync::atomic::Ordering::SeqCst) {
                    if let Some(s) = latest.lock().unwrap().as_mut() {
                        let _ = s.write_all(b" ");
                    }
                    thread::sleep(Duration::from_millis(10));
                }
            });
            let started = Instant::now();
            let err = get(tx, 1, 0, 0).unwrap_err();
            let took = started.elapsed();
            feeding.store(false, std::sync::atomic::Ordering::SeqCst);
            assert!(err.starts_with("broker-timeout: 1:0:0"), "{err}");
            assert!(
                took < DEADLINE + Duration::from_millis(300),
                "the read took {took:?}"
            );
        }

        // Only the `get` reply for `/vddp_srv/devices` is the device list. Another frame that
        // carries a list — a notify, or the reply to another uri — does not decide which units
        // this session asks about.
        #[test]
        fn the_device_list_is_only_the_list_reply() {
            let unit = Unit::start("<device-id-a>", plain);
            let decoy = Unit::start("<device-id-b>", plain);
            let decoys = json!({ "list": [{ "vdpport": decoy.port, "model": "URX22" }] });
            let list = list_server(vec![
                json!({ "method": "notify", "uri": "/vddp_srv/devices", "data": decoys }),
                json!({ "method": "get", "uri": "/vddp_srv/other", "data": decoys }),
                json!({ "method": "get", "uri": "/vddp_srv/devices",
                    "data": { "list": [{ "vdpport": unit.port, "model": "URX44V" }] } }),
            ]);
            let (_tx, summary, _) = start(list, "URX44V");
            assert_eq!(summary.unwrap().model, "URX44V");
            assert!(decoy.seen().is_empty(), "{:?}", decoy.seen());
        }

        // The list reply without `data` is a bad answer as soon as it arrives, rather than a
        // wait that runs out its deadline as if nothing had answered.
        #[test]
        fn a_list_reply_without_data_is_a_bad_response_at_once() {
            let list = list_server(vec![json!({ "method": "get", "uri": "/vddp_srv/devices" })]);
            let started = Instant::now();
            let (_tx, summary, _) = start(list, "URX44V");
            let err = refused(summary);
            assert!(err.starts_with("broker-bad-response"), "{err}");
            assert!(
                started.elapsed() < Duration::from_secs(2),
                "{:?}",
                started.elapsed()
            );
        }

        // A discovery or an opening that loses its link says how, as the worker did before
        // the shared transport: a closed stream is broker-closed, a socket error broker-io,
        // and the unit going offline device-lost.
        #[test]
        fn a_lost_link_while_listing_or_opening_is_told_by_how_it_was_lost() {
            // A device list that reads the request and closes: the stream ends.
            let closing = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let list = closing.local_addr().unwrap().port();
            thread::spawn(move || {
                let (stream, _) = closing.accept().unwrap();
                let mut request = String::new();
                let _ = BufReader::new(stream).read_line(&mut request);
            });
            let (_tx, summary, _) = start(list, "URX44V");
            assert_eq!(refused(summary), "broker-closed: Discovery");

            // A device list that closes with the request unread: the system resets the
            // connection instead of ending the stream, and the read fails.
            let resetting = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let list = resetting.local_addr().unwrap().port();
            thread::spawn(move || {
                let (stream, _) = resetting.accept().unwrap();
                // Wait for the request without taking it off the socket.
                let _ = stream.peek(&mut [0u8; 1]);
                drop(stream);
            });
            let (_tx, summary, _) = start(list, "URX44V");
            assert_eq!(refused(summary), "broker-io: ConnectionReset");

            let lost = |phase, lost_link| LinkFailure {
                failure: Failure::Cause {
                    code: Cause::ConnectionLost,
                    phase,
                },
                lost_link,
            };
            assert_eq!(
                link_failure_text(&lost(Phase::Identity, Some(LinkLoss::UnitLost)), "opened"),
                "device-lost: the unit went offline while it was opened"
            );
            assert_eq!(
                link_failure_text(&lost(Phase::Identity, None), "opened"),
                "broker-closed: Identity"
            );
        }

        // An empty status is a status that is not `online`: no unit to open.
        #[test]
        fn an_empty_status_is_no_device() {
            let unit = Unit::serving(|request| match request["vdp"]["uri"].as_str() {
                Some("/vd/synchronize") => vec![status_reply("<device-id-a>", "")],
                _ => opening("<device-id-a>", request).unwrap_or_else(|| plain(request)),
            });
            let list = device_list(&[(&unit, "URX44V")]);
            let (_tx, summary, _) = start(list, "URX44V");
            assert_eq!(refused(summary), "no-device");
        }

        // Device Center keeps answering `/vd/device` from its cache once the unit is unplugged,
        // so a unit lost between its `online` and its firmware reply fails the open on the
        // push, as the unit lost.
        #[test]
        fn a_unit_lost_during_the_firmware_read_fails_the_open() {
            let unit = Unit::serving(|request| match request["vdp"]["uri"].as_str() {
                Some("/vd/device") => vec![synchronize("offline")],
                _ => opening("<device-id-a>", request).unwrap_or_else(|| plain(request)),
            });
            let list = device_list(&[(&unit, "URX44V")]);
            let (_tx, summary, _) = start(list, "URX44V");
            let err = refused(summary);
            assert!(err.starts_with("device-lost"), "{err}");
        }

        // The firmware is three-valued: a unit whose list holds no System row opens with an
        // empty version, and one whose rows cannot be read opens with the version unknown,
        // an empty System version included.
        #[test]
        fn the_firmware_is_absent_without_a_system_row_and_unknown_when_rows_cannot_be_read() {
            let with = |firm_list: Value| {
                Unit::serving(move |request| match request["vdp"]["uri"].as_str() {
                    Some("/vd/device") => vec![device_reply(firm_list.clone())],
                    _ => opening("<device-id-a>", request).unwrap_or_else(|| plain(request)),
                })
            };
            let absent = with(json!([{ "firm_name": "Boot", "firm_version": "1.0.0" }]));
            let (_tx, summary, _) = start(device_list(&[(&absent, "URX44V")]), "URX44V");
            assert_eq!(summary.unwrap().firmware.as_deref(), Some(""));
            for rows in [
                json!([{ "firm_name": 5, "firm_version": "1.5.0.1" }]),
                json!([{ "firm_name": "System", "firm_version": "" }]),
                json!([
                    { "firm_name": "System", "firm_version": "1.5.0.1" },
                    { "firm_name": "System", "firm_version": "1.5.0.0" }
                ]),
            ] {
                let unreadable = with(rows.clone());
                let (_tx, summary, _) = start(device_list(&[(&unreadable, "URX44V")]), "URX44V");
                let firmware = summary.map(|summary| summary.firmware);
                assert_eq!(firmware, Ok(None), "{rows}");
            }
        }

        #[test]
        fn shutdown_unregisters_what_the_session_registered_before_it_signals() {
            let (tx, unit, _) = connected(plain);
            let (params, _) = subscriber();
            params_subscribe(tx.clone(), vec![(1, 0, 0)], params).unwrap();
            let (done, signalled) = mpsc::channel();
            tx.send(Cmd::Shutdown {
                done: Some((done, std::time::Instant::now() + Duration::from_secs(2))),
            })
            .unwrap();
            signalled
                .recv_timeout(Duration::from_secs(5))
                .expect("the close signals");
            assert!(unit
                .seen()
                .contains(&"/vd/parameters/1:0:0?operation=unregist".to_string()));
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
    use super::{disconnect, sender, shutdown_owned_by, Cmd, LinkCounters, PackageLink, VdState};
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
            .install_for_page(
                tx,
                Arc::new(LinkCounters::default()),
                Arc::default(),
                Arc::new(PackageLink::new(Arc::default(), Arc::default())),
                "main",
                gen,
            )
            .expect("a page that has not reloaded installs")
    }

    // Every way a session is let go tears its control-package link down first, ahead of the
    // worker's shutdown: a disconnect, a page load, a replacement and the app's quit
    // (`PackageLink::tear_down`, `stop`).
    #[test]
    fn letting_a_session_go_tears_its_package_link_down() {
        let installed = |state: &VdState, label: &str| {
            let (tx, rx) = mpsc::channel::<Cmd>();
            let link = Arc::new(PackageLink::new(Arc::default(), Arc::default()));
            let epoch = state
                .install_for_page(
                    tx,
                    Arc::new(LinkCounters::default()),
                    Arc::default(),
                    Arc::clone(&link),
                    label,
                    state.page_gen(label),
                )
                .expect("installs");
            (epoch, link, rx)
        };
        let state = VdState::default();
        let (epoch, link, _rx) = installed(&state, "main");
        disconnect(&state, epoch);
        assert!(link.torn_down(), "a disconnect");
        let (_, link, _rx) = installed(&state, "main");
        shutdown_owned_by(&state, "main");
        assert!(link.torn_down(), "the page's load");
        let (_, replaced, _rx) = installed(&state, "main");
        let (_, _, _rx2) = installed(&state, "main");
        assert!(replaced.torn_down(), "a replacement");
    }

    // A page load ends what THAT page holds. The app has two webviews, and the second
    // one's load used to end the first one's session — opening the MIDI control window
    // closed the device link and the MIDI input the main window had restored, with the
    // frontend never told. The session now records its owner, so a third window
    // inherits the right behaviour with nothing to remember.
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
        let installed = state.install_for_page(
            tx,
            Arc::new(LinkCounters::default()),
            Arc::default(),
            Arc::new(PackageLink::new(Arc::default(), Arc::default())),
            "main",
            gen,
        );
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
            .install_for_page(
                tx2,
                Arc::new(LinkCounters::default()),
                Arc::default(),
                Arc::new(PackageLink::new(Arc::default(), Arc::default())),
                "main",
                gen
            )
            .is_some());
        assert!(sender(&state).is_ok());
        shutdown_owned_by(&state, "main");
    }

    // …and the reload landing DURING the install, which the caller-side interleaving
    // above cannot reach. Asserted as the LOCK ORDERING rather than by racing the two:
    // a race is timing-dependent and can pass round after round with the check and the
    // install back under separate locks — a test that cannot fail on the defect is not
    // coverage of it.
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
