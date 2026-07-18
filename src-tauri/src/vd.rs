// Live hardware control transport: a client for the Device Center broker's
// "vd" protocol over WebSocket (ws://127.0.0.1:51780/casket, JSON-RPC 1.0).
// Device Center must be running with a URX connected; it bridges the broker to
// the unit's CDC serial. See reference/.local/vd-protocol.md.
//
// A dedicated worker thread owns the socket so the broker's continuous meter
// notifications are drained without blocking command latency, and so the device
// GUID (dev_uid) stays inside Rust — the frontend addresses parameters by
// (param_id, x, y) and never sees the instance secret. Desktop-only: mobile
// builds compile the command surface but every entry point returns an error.

use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;

/// Device identity exposed to the frontend (no dev_uid / serial). `firmware` is the
/// unit's System firmware version (from /vd/device), or empty when the device does
/// not report one; the frontend warns when it differs from the validated version.
#[derive(Clone, Serialize)]
pub struct DeviceSummary {
    pub model: String,
    pub label: String,
    pub firmware: String,
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
#[derive(Clone, Serialize)]
pub struct ParamUpdate {
    pub param_id: u32,
    pub x: i64,
    pub y: i64,
    pub value: i64,
}

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
    Info {
        reply: Sender<DeviceSummary>,
    },
    /// Subscribe to a set of level meters (meter_id, x) and stream their readings
    /// through `channel`. Replaces any prior meter subscription. Fire-and-forget:
    /// the worker registers each address with the broker and forwards notifies.
    /// Each `send` carries a whole pump cycle's readings (the broker streams ~250/s
    /// across the set), so the IPC boundary is crossed ~30×/s instead of per reading.
    MetersSubscribe {
        addrs: Vec<(u32, i64)>,
        channel: Channel<Vec<MeterUpdate>>,
    },
    /// Drop the current meter subscription (unregisters each address).
    MetersUnsubscribe,
    /// Subscribe to a set of parameter addresses (param_id, x, y) and stream their
    /// `notify` frames through `channel`. Replaces any prior parameter subscription.
    /// Fire-and-forget: the worker registers each address with the broker and
    /// forwards notifies, so device-side edits reach the frontend.
    ParamsSubscribe {
        addrs: Vec<(u32, i64, i64)>,
        channel: Channel<Vec<ParamUpdate>>,
    },
    /// Drop the current parameter subscription (unregisters each address).
    ParamsUnsubscribe,
    /// Register a channel to receive the link-lost event (see LinkEvent). Replaces
    /// any prior watch. Fire-and-forget; the worker pushes one event if the broker
    /// link drops while idle, then exits.
    WatchLink {
        channel: Channel<LinkEvent>,
    },
    Shutdown,
}

/// The installed connection: the channel to the live worker (if any) and the
/// generation it was assigned. `epoch` increments on every install, so a
/// connection is identified by the generation that opened it.
#[derive(Default)]
struct Conn {
    tx: Option<Sender<Cmd>>,
    epoch: u64,
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
pub fn open() -> Result<(Sender<Cmd>, DeviceSummary), String> {
    #[cfg(not(desktop))]
    {
        Err("hardware control is available on desktop only".into())
    }
    #[cfg(desktop)]
    {
        let (tx, rx) = mpsc::channel::<Cmd>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<DeviceSummary, String>>();
        std::thread::spawn(move || imp::worker(rx, ready_tx));
        let summary = ready_rx
            .recv()
            .map_err(|_| "control-worker-gone".to_string())??;
        Ok((tx, summary))
    }
}

impl VdState {
    /// Install a freshly opened connection, shutting down any prior worker, and
    /// return the generation assigned to it. The caller hands this epoch back to
    /// disconnect so a delayed teardown of an earlier session cannot close this one.
    pub fn install(&self, tx: Sender<Cmd>) -> u64 {
        let mut c = self.conn.lock().unwrap();
        if let Some(old) = c.tx.replace(tx) {
            let _ = old.send(Cmd::Shutdown);
        }
        c.epoch += 1;
        c.epoch
    }
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
        .ok_or_else(|| "not connected".to_string())
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
    .map_err(|_| "control-worker-gone".to_string())?;
    wait.recv().map_err(|_| "control-worker-gone".to_string())?
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
    .map_err(|_| "control-worker-gone".to_string())?;
    wait.recv().map_err(|_| "control-worker-gone".to_string())?
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
    .map_err(|_| "control-worker-gone".to_string())?;
    wait.recv().map_err(|_| "control-worker-gone".to_string())?
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
    .map_err(|_| "control-worker-gone".to_string())?;
    wait.recv().map_err(|_| "control-worker-gone".to_string())?
}

/// The currently connected device, or an error if not connected.
pub fn info(tx: Sender<Cmd>) -> Result<DeviceSummary, String> {
    let (reply, wait) = mpsc::channel();
    tx.send(Cmd::Info { reply })
        .map_err(|_| "control-worker-gone".to_string())?;
    wait.recv().map_err(|_| "control-worker-gone".to_string())
}

/// Subscribe to live level meters; readings stream through `channel`. Replaces
/// any prior subscription. Fire-and-forget (no broker round-trip awaited here).
pub fn meters_subscribe(
    tx: Sender<Cmd>,
    addrs: Vec<(u32, i64)>,
    channel: Channel<Vec<MeterUpdate>>,
) -> Result<(), String> {
    tx.send(Cmd::MetersSubscribe { addrs, channel })
        .map_err(|_| "control-worker-gone".to_string())
}

/// Drop the current meter subscription.
pub fn meters_unsubscribe(tx: Sender<Cmd>) -> Result<(), String> {
    tx.send(Cmd::MetersUnsubscribe)
        .map_err(|_| "control-worker-gone".to_string())
}

/// Subscribe to device-side parameter changes; notifies stream through `channel`.
/// Replaces any prior subscription. Fire-and-forget (no broker round-trip awaited).
pub fn params_subscribe(
    tx: Sender<Cmd>,
    addrs: Vec<(u32, i64, i64)>,
    channel: Channel<Vec<ParamUpdate>>,
) -> Result<(), String> {
    tx.send(Cmd::ParamsSubscribe { addrs, channel })
        .map_err(|_| "control-worker-gone".to_string())
}

/// Drop the current parameter subscription.
pub fn params_unsubscribe(tx: Sender<Cmd>) -> Result<(), String> {
    tx.send(Cmd::ParamsUnsubscribe)
        .map_err(|_| "control-worker-gone".to_string())
}

/// Register a channel to receive the link-lost event. Replaces any prior watch.
pub fn watch_link(tx: Sender<Cmd>, channel: Channel<LinkEvent>) -> Result<(), String> {
    tx.send(Cmd::WatchLink { channel })
        .map_err(|_| "control-worker-gone".to_string())
}

/// Close the connection of generation `epoch`. A no-op if the current connection
/// is a different generation (a newer install already replaced it) or none is
/// installed — so a delayed teardown of an old session never closes a live one.
/// Safe to call when not connected.
pub fn disconnect(state: &VdState, epoch: u64) {
    let mut c = state.conn.lock().unwrap();
    if c.epoch == epoch {
        if let Some(tx) = c.tx.take() {
            let _ = tx.send(Cmd::Shutdown);
        }
    }
}

#[cfg(desktop)]
mod imp {
    use super::{Cmd, DeviceSummary, LinkEvent, MeterUpdate, ParamUpdate};
    use std::net::TcpStream;
    use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
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
        meters: Vec<MeterUpdate>,
        params: Vec<ParamUpdate>,
        last_flush: Instant,
    }

    impl Subs {
        fn new() -> Self {
            Subs {
                meter_ch: None,
                param_ch: None,
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
        /// flushing on the pump cadence. Returns true when the frame was consumed
        /// (callers skip further matching).
        fn absorb(&mut self, msg: &Value) -> bool {
            if self.meter_ch.is_some() {
                if let Some(m) = parse_meter(msg) {
                    self.meters.push(m);
                    self.flush_due();
                    return true;
                }
            }
            if self.param_ch.is_some() {
                if let Some(p) = parse_param(msg) {
                    self.params.push(p);
                    self.flush_due();
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

    pub fn worker(rx: Receiver<Cmd>, ready: Sender<Result<DeviceSummary, String>>) {
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
        if let MaybeTlsStream::Plain(s) = ws.get_ref() {
            let _ = s.set_read_timeout(Some(Duration::from_millis(200)));
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

        // Subscribed meter / parameter channels and their pending notify batches
        // (see Subs); the address lists registered with the broker stay local so
        // a replaced subscription can unregister its old set.
        let mut subs = Subs::new();
        let mut meter_addrs: Vec<(u32, i64)> = Vec::new();
        let mut param_addrs: Vec<(u32, i64, i64)> = Vec::new();
        // Channel to push the one-shot link-lost event on, if the frontend is
        // watching: a held-open live session is dropped instead of freezing when
        // the broker link goes away while idle.
        let mut link_ch: Option<Channel<LinkEvent>> = None;

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
                Ok(Cmd::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(Cmd::Info { reply }) => {
                    let _ = reply.send(summary.clone());
                }
                Ok(Cmd::Set {
                    param_id,
                    x,
                    y,
                    value,
                    reply,
                }) => {
                    let _ = reply.send(do_set(
                        &mut ws,
                        &mut subs,
                        &dev_uid,
                        param_id,
                        x,
                        y,
                        json!(value),
                    ));
                }
                Ok(Cmd::Get {
                    param_id,
                    x,
                    y,
                    reply,
                }) => {
                    let _ = reply.send(do_get(&mut ws, &mut subs, &dev_uid, param_id, x, y));
                }
                Ok(Cmd::SetStr {
                    param_id,
                    x,
                    y,
                    value,
                    reply,
                }) => {
                    let _ = reply.send(do_set(
                        &mut ws,
                        &mut subs,
                        &dev_uid,
                        param_id,
                        x,
                        y,
                        json!(value),
                    ));
                }
                Ok(Cmd::GetStr {
                    param_id,
                    x,
                    y,
                    reply,
                }) => {
                    let _ = reply.send(do_get_str(&mut ws, &mut subs, &dev_uid, param_id, x, y));
                }
                Ok(Cmd::MetersSubscribe { addrs, channel }) => {
                    // Replace any prior subscription: unregister the old set, then
                    // register the new one address by address (never a bulk post on
                    // /vd/meters — that has been seen to crash Device Center).
                    for &(id, x) in &meter_addrs {
                        let _ = reg_meter(&mut ws, &dev_uid, id, x, "unregist");
                    }
                    for &(id, x) in &addrs {
                        let _ = reg_meter(&mut ws, &dev_uid, id, x, "regist");
                    }
                    meter_addrs = addrs;
                    subs.meters.clear();
                    subs.meter_ch = Some(channel);
                }
                Ok(Cmd::MetersUnsubscribe) => {
                    for &(id, x) in &meter_addrs {
                        let _ = reg_meter(&mut ws, &dev_uid, id, x, "unregist");
                    }
                    meter_addrs.clear();
                    subs.meters.clear();
                    subs.meter_ch = None;
                }
                Ok(Cmd::ParamsSubscribe { addrs, channel }) => {
                    // Replace any prior subscription: unregister the old set, then
                    // register the new one address by address (per-address regist
                    // only, mirroring meters — a bulk post has crashed Device Center).
                    for &(id, x, y) in &param_addrs {
                        let _ = reg_param(&mut ws, &dev_uid, id, x, y, "unregist");
                    }
                    for &(id, x, y) in &addrs {
                        let _ = reg_param(&mut ws, &dev_uid, id, x, y, "regist");
                    }
                    param_addrs = addrs;
                    subs.params.clear();
                    subs.param_ch = Some(channel);
                }
                Ok(Cmd::ParamsUnsubscribe) => {
                    for &(id, x, y) in &param_addrs {
                        let _ = reg_param(&mut ws, &dev_uid, id, x, y, "unregist");
                    }
                    param_addrs.clear();
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
        let _ = ws.close(None);
    }

    fn send_json(ws: &mut Ws, v: Value) -> Result<(), String> {
        ws.send(Message::Text(v.to_string().into()))
            .map_err(|e| e.to_string())
    }

    /// Read one text message, or None on read timeout. Errors on a closed or
    /// broken connection, or on an unexpected binary frame, so the awaiting
    /// command surfaces the failure to the frontend instead of hanging.
    fn read_text(ws: &mut Ws) -> Result<Option<String>, String> {
        match ws.read() {
            Ok(Message::Text(t)) => Ok(Some(t.to_string())),
            Ok(Message::Close(_)) => Err("Device Center closed the control connection".into()),
            // The vd protocol is JSON text only; a binary frame means the link is
            // out of sync, so fail the awaiting command rather than swallow it.
            Ok(Message::Binary(_)) => Err("unexpected binary frame from broker".into()),
            Ok(_) => Ok(None), // ping/pong — ignore
            Err(tungstenite::Error::Io(e))
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                ) =>
            {
                Ok(None)
            }
            Err(e) => Err(e.to_string()),
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
                firmware: String::new(),
            };
            if dev_uid.is_empty() {
                return Err("device list entry had no identifier".into());
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
            // attached unit's firmware differs from the validated one. Best-effort:
            // an unreadable list leaves it empty, which disables the warning.
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
                .ok_or_else(|| format!("vd response had no data for {base}"));
        }
        Err(format!("timed out waiting for {base}"))
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
            .ok_or_else(|| "synchronize response had no sync_status".to_string())
    }

    /// The unit's System firmware version, from /vd/device's firm_list. Best-effort:
    /// any failure (no response, missing list, no System entry) yields an empty string
    /// so the frontend simply skips the firmware-mismatch warning rather than blocking.
    fn system_firmware(ws: &mut Ws, dev_uid: &str) -> String {
        let Ok(data) = vd_get_data(ws, dev_uid, "/vd/device") else {
            return String::new();
        };
        let Some(list) = data.pointer("/firm_list").and_then(Value::as_array) else {
            return String::new();
        };
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
                return entry
                    .get("firm_version")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
            }
        }
        String::new()
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
            if subs.absorb(&msg) {
                continue;
            }
            if msg.get("method").and_then(Value::as_str) != Some("requestVD") {
                continue;
            }
            let vdp = msg.pointer("/params/vdp");
            let ruri = vdp
                .and_then(|v| v.get("uri"))
                .and_then(Value::as_str)
                .unwrap_or("");
            // Match the address exactly so another instance's reply (e.g. y=12) cannot
            // satisfy a y=1 request via a prefix match.
            let ruri_addr = ruri.split('?').next().unwrap_or(ruri);
            if ruri_addr != base {
                continue;
            }
            let code = vdp
                .and_then(|v| v.pointer("/data/response_code"))
                .and_then(Value::as_i64)
                .unwrap_or(0);
            return if code == 200 {
                Ok(())
            } else {
                Err(format!(
                    "broker rejected the write at {param_id}:{x}:{y} (response_code {code})"
                ))
            };
        }
        Err(format!(
            "timed out waiting for the broker to confirm the write at {param_id}:{x}:{y}"
        ))
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
            if subs.absorb(&msg) {
                continue;
            }
            if msg.get("method").and_then(Value::as_str) != Some("requestVD") {
                continue;
            }
            let vdp = msg.pointer("/params/vdp");
            let ruri = vdp
                .and_then(|v| v.get("uri"))
                .and_then(Value::as_str)
                .unwrap_or("");
            // Match the address exactly so another instance's reply (e.g. y=12) cannot
            // satisfy a y=1 request via a prefix match.
            let ruri_addr = ruri.split('?').next().unwrap_or(ruri);
            if ruri_addr != base {
                continue;
            }
            return vdp
                .and_then(|v| v.pointer("/data/current_value"))
                .cloned()
                .ok_or_else(|| {
                    format!("broker response had no current_value at {param_id}:{x}:{y}")
                });
        }
        Err(format!(
            "timed out waiting for the parameter value at {param_id}:{x}:{y}"
        ))
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
            .ok_or_else(|| "parameter value was not an integer".to_string())
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
        let value = vdp
            .pointer("/data/current_value")
            .and_then(Value::as_i64)
            .unwrap_or(0);
        Some(MeterUpdate { meter_id, x, value })
    }

    /// Parse a parameter `notify` frame (a device-side change on a registered
    /// address). A non-integer current_value (e.g. a name string) yields None —
    /// numeric follow only, matching the JS reconcile.
    fn parse_param(msg: &Value) -> Option<ParamUpdate> {
        // A namespace-level notify — `/vd/parameters` with no address and no value —
        // is the broker's bulk-change push: a scene recall on the unit emits only
        // this single frame (confirmed by capture; the changed parameters get no
        // per-address notifies). Forward it as a sentinel no real address can
        // collide with (catalog x/y are never negative), so the follow layer's
        // unknown-address path escalates it to a full readback.
        if notify_frame(msg, "/vd/parameters").is_some_and(|(_, rest)| rest.is_empty()) {
            return Some(ParamUpdate {
                param_id: 0,
                x: -1,
                y: -1,
                value: 0,
            });
        }
        let (vdp, addr) = notify_frame(msg, "/vd/parameters/")?;
        let mut parts = addr.split(':');
        let (ids, xs, ys) = (parts.next()?, parts.next()?, parts.next()?);
        let (param_id, x, y) = (
            ids.parse::<u32>().ok()?,
            xs.parse::<i64>().ok()?,
            ys.parse::<i64>().ok()?,
        );
        let value = vdp.pointer("/data/current_value").and_then(Value::as_i64)?;
        Some(ParamUpdate {
            param_id,
            x,
            y,
            value,
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
        Some(format!("device disconnected (sync_status {status})"))
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
                Ok(Message::Close(_)) => {
                    return Err("Device Center closed the control connection".into())
                }
                Ok(_) => {} // ping/pong/binary — discard, keep going
                Err(tungstenite::Error::Io(e))
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) =>
                {
                    break; // socket drained — fall through to flush the batch
                }
                Err(_) => return Err("Device Center closed the control connection".into()),
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
    mod subs_tests {
        // Pure data-path tests for Subs (no broker, no websocket): absorb must
        // batch subscribed notifies (and leave command replies alone), and the
        // batch must flush on the pump cadence.
        use super::{Subs, PUMP_BUDGET};
        use serde_json::{json, Value};
        use std::sync::{Arc, Mutex};
        use std::time::Instant;
        use tauri::ipc::{Channel, InvokeResponseBody};

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
            let mut subs = Subs::new();
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
            let mut subs = Subs::new();
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
            let mut subs = Subs::new();
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
            let mut subs = Subs::new();
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
    }
}

#[cfg(test)]
mod tests {
    // Connection-lifecycle race: a fire-and-forget disconnect of a torn-down live
    // session must not close a newer connection that a later connect installed in
    // the meantime. These drive VdState's install/sender/disconnect directly with
    // dummy worker channels, so they reproduce the exact interleaving deterministi-
    // cally on any host (no broker, no websocket, no threads).
    use super::{disconnect, sender, Cmd, VdState};
    use std::sync::mpsc;

    // The reported field bug: live connects, its teardown's disconnect is delayed,
    // a write connects (new generation), then the stale disconnect finally lands.
    // It must be a no-op and leave the write's channel installed and reachable.
    #[test]
    fn stale_disconnect_spares_newer_connection() {
        let state = VdState::default();

        // Live session connects.
        let (live_tx, _live_rx) = mpsc::channel::<Cmd>();
        let live_epoch = state.install(live_tx);

        // A later write connects before the live teardown's disconnect runs.
        let (write_tx, write_rx) = mpsc::channel::<Cmd>();
        let write_epoch = state.install(write_tx);
        assert_ne!(
            live_epoch, write_epoch,
            "each install gets a fresh generation"
        );

        // The delayed stale disconnect now lands — targets the old generation.
        disconnect(&state, live_epoch);

        // The write's connection survives: sender() resolves (not "not connected")
        // and the cloned channel still reaches its worker.
        let tx = sender(&state).expect("write connection must stay installed");
        tx.send(Cmd::Shutdown)
            .expect("worker channel must still be open");
        assert!(matches!(write_rx.recv(), Ok(Cmd::Shutdown)));
    }

    // A disconnect that matches the current generation closes it.
    #[test]
    fn matching_disconnect_closes() {
        let state = VdState::default();
        let (tx, _rx) = mpsc::channel::<Cmd>();
        let epoch = state.install(tx);

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
        state.install(tx1);
        let (tx2, _rx2) = mpsc::channel::<Cmd>();
        state.install(tx2);
        assert!(
            matches!(rx1.recv(), Ok(Cmd::Shutdown)),
            "prior worker told to stop"
        );
    }
}
