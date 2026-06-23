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

/// Device identity exposed to the frontend (no dev_uid / serial).
#[derive(Clone, Serialize)]
pub struct DeviceSummary {
    pub model: String,
    pub label: String,
}

/// One live level-meter reading pushed to the frontend. `value` is the broker's
/// raw meter value (deci-dBFS; 32767 = OVER), decoded on the JS side.
#[derive(Clone, Serialize)]
pub struct MeterUpdate {
    pub meter_id: u32,
    pub x: i64,
    pub value: i64,
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
    MetersSubscribe {
        addrs: Vec<(u32, i64)>,
        channel: Channel<MeterUpdate>,
    },
    /// Drop the current meter subscription (unregisters each address).
    MetersUnsubscribe,
    /// Subscribe to a set of parameter addresses (param_id, x, y) and stream their
    /// `notify` frames through `channel`. Replaces any prior parameter subscription.
    /// Fire-and-forget: the worker registers each address with the broker and
    /// forwards notifies, so device-side edits reach the frontend.
    ParamsSubscribe {
        addrs: Vec<(u32, i64, i64)>,
        channel: Channel<ParamUpdate>,
    },
    /// Drop the current parameter subscription (unregisters each address).
    ParamsUnsubscribe,
    Shutdown,
}

/// Managed Tauri state: the channel to the live worker, if connected.
#[derive(Default)]
pub struct VdState {
    tx: Mutex<Option<Sender<Cmd>>>,
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
            .map_err(|_| "control worker exited before handshake".to_string())??;
        Ok((tx, summary))
    }
}

impl VdState {
    /// Install a freshly opened connection, shutting down any prior worker.
    pub fn install(&self, tx: Sender<Cmd>) {
        if let Some(old) = self.tx.lock().unwrap().replace(tx) {
            let _ = old.send(Cmd::Shutdown);
        }
    }
}

/// Clone the live worker's command channel, or error if not connected. The
/// clone lets the blocking send/reply-wait run on a separate thread, so the
/// Tauri command never stalls the event loop while the broker round-trips.
pub fn sender(state: &VdState) -> Result<Sender<Cmd>, String> {
    state
        .tx
        .lock()
        .unwrap()
        .as_ref()
        .cloned()
        .ok_or_else(|| "not connected".to_string())
}

/// Set one parameter instance to an absolute value. Blocks on the reply, so
/// callers run it off the UI thread. Errors if the worker is gone or the broker
/// rejects the write.
pub fn set(tx: Sender<Cmd>, param_id: u32, x: i64, y: i64, value: i64) -> Result<(), String> {
    let (reply, wait) = mpsc::channel();
    tx.send(Cmd::Set { param_id, x, y, value, reply })
        .map_err(|_| "control worker is gone".to_string())?;
    wait.recv().map_err(|_| "no response from control worker".to_string())?
}

/// Read one parameter instance's current absolute value.
pub fn get(tx: Sender<Cmd>, param_id: u32, x: i64, y: i64) -> Result<i64, String> {
    let (reply, wait) = mpsc::channel();
    tx.send(Cmd::Get { param_id, x, y, reply })
        .map_err(|_| "control worker is gone".to_string())?;
    wait.recv().map_err(|_| "no response from control worker".to_string())?
}

/// Set one string-valued parameter instance (e.g. a CH SETTING name).
pub fn set_str(tx: Sender<Cmd>, param_id: u32, x: i64, y: i64, value: String) -> Result<(), String> {
    let (reply, wait) = mpsc::channel();
    tx.send(Cmd::SetStr { param_id, x, y, value, reply })
        .map_err(|_| "control worker is gone".to_string())?;
    wait.recv().map_err(|_| "no response from control worker".to_string())?
}

/// Read one string-valued parameter instance's current value.
pub fn get_str(tx: Sender<Cmd>, param_id: u32, x: i64, y: i64) -> Result<String, String> {
    let (reply, wait) = mpsc::channel();
    tx.send(Cmd::GetStr { param_id, x, y, reply })
        .map_err(|_| "control worker is gone".to_string())?;
    wait.recv().map_err(|_| "no response from control worker".to_string())?
}

/// The currently connected device, or an error if not connected.
pub fn info(tx: Sender<Cmd>) -> Result<DeviceSummary, String> {
    let (reply, wait) = mpsc::channel();
    tx.send(Cmd::Info { reply }).map_err(|_| "control worker is gone".to_string())?;
    wait.recv().map_err(|_| "no response from control worker".to_string())
}

/// Subscribe to live level meters; readings stream through `channel`. Replaces
/// any prior subscription. Fire-and-forget (no broker round-trip awaited here).
pub fn meters_subscribe(
    tx: Sender<Cmd>,
    addrs: Vec<(u32, i64)>,
    channel: Channel<MeterUpdate>,
) -> Result<(), String> {
    tx.send(Cmd::MetersSubscribe { addrs, channel })
        .map_err(|_| "control worker is gone".to_string())
}

/// Drop the current meter subscription.
pub fn meters_unsubscribe(tx: Sender<Cmd>) -> Result<(), String> {
    tx.send(Cmd::MetersUnsubscribe).map_err(|_| "control worker is gone".to_string())
}

/// Subscribe to device-side parameter changes; notifies stream through `channel`.
/// Replaces any prior subscription. Fire-and-forget (no broker round-trip awaited).
pub fn params_subscribe(
    tx: Sender<Cmd>,
    addrs: Vec<(u32, i64, i64)>,
    channel: Channel<ParamUpdate>,
) -> Result<(), String> {
    tx.send(Cmd::ParamsSubscribe { addrs, channel })
        .map_err(|_| "control worker is gone".to_string())
}

/// Drop the current parameter subscription.
pub fn params_unsubscribe(tx: Sender<Cmd>) -> Result<(), String> {
    tx.send(Cmd::ParamsUnsubscribe).map_err(|_| "control worker is gone".to_string())
}

/// Close any live connection. Safe to call when not connected.
pub fn disconnect(state: &VdState) {
    if let Some(tx) = state.tx.lock().unwrap().take() {
        let _ = tx.send(Cmd::Shutdown);
    }
}

#[cfg(desktop)]
mod imp {
    use super::{Cmd, DeviceSummary, MeterUpdate, ParamUpdate};
    use std::net::TcpStream;
    use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
    use std::time::{Duration, Instant};

    use serde_json::{json, Value};
    use tauri::ipc::Channel;
    use tungstenite::stream::MaybeTlsStream;
    use tungstenite::{connect, Message, WebSocket};

    const URL: &str = "ws://127.0.0.1:51780/casket";
    type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

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

        // Active meter subscription, if any: the channel to stream readings on and
        // the addresses registered with the broker (so we can unregister on change).
        let mut meter_ch: Option<Channel<MeterUpdate>> = None;
        let mut meter_addrs: Vec<(u32, i64)> = Vec::new();
        // Active parameter subscription, if any: the channel for device-side param
        // notifies and the registered addresses (unregistered on change / drop).
        let mut param_ch: Option<Channel<ParamUpdate>> = None;
        let mut param_addrs: Vec<(u32, i64, i64)> = Vec::new();

        loop {
            match rx.recv_timeout(Duration::from_millis(50)) {
                Ok(Cmd::Shutdown) | Err(RecvTimeoutError::Disconnected) => break,
                Ok(Cmd::Info { reply }) => {
                    let _ = reply.send(summary.clone());
                }
                Ok(Cmd::Set { param_id, x, y, value, reply }) => {
                    let _ = reply.send(do_set(&mut ws, &dev_uid, param_id, x, y, json!(value)));
                }
                Ok(Cmd::Get { param_id, x, y, reply }) => {
                    let _ = reply.send(do_get(&mut ws, &dev_uid, param_id, x, y));
                }
                Ok(Cmd::SetStr { param_id, x, y, value, reply }) => {
                    let _ = reply.send(do_set(&mut ws, &dev_uid, param_id, x, y, json!(value)));
                }
                Ok(Cmd::GetStr { param_id, x, y, reply }) => {
                    let _ = reply.send(do_get_str(&mut ws, &dev_uid, param_id, x, y));
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
                    meter_ch = Some(channel);
                }
                Ok(Cmd::MetersUnsubscribe) => {
                    for &(id, x) in &meter_addrs {
                        let _ = reg_meter(&mut ws, &dev_uid, id, x, "unregist");
                    }
                    meter_addrs.clear();
                    meter_ch = None;
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
                    param_ch = Some(channel);
                }
                Ok(Cmd::ParamsUnsubscribe) => {
                    for &(id, x, y) in &param_addrs {
                        let _ = reg_param(&mut ws, &dev_uid, id, x, y, "unregist");
                    }
                    param_addrs.clear();
                    param_ch = None;
                }
                Err(RecvTimeoutError::Timeout) => {
                    // Drain the idle socket so its buffer never backs up. While a
                    // meter / parameter subscription is active, forward those
                    // notifications to the frontend instead of discarding them; stop
                    // if the link dropped.
                    if let Err(e) = pump(&mut ws, meter_ch.as_ref(), param_ch.as_ref()) {
                        eprintln!("vd: {e}; stopping control worker");
                        break;
                    }
                }
            }
        }
        let _ = ws.close(None);
    }

    fn send_json(ws: &mut Ws, v: Value) -> Result<(), String> {
        ws.send(Message::Text(v.to_string().into())).map_err(|e| e.to_string())
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
                if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) =>
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
            let Ok(msg) = serde_json::from_str::<Value>(&text) else { continue };
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
            let dev_uid = dev.get("dev_uid").and_then(Value::as_str).unwrap_or_default().to_string();
            let summary = DeviceSummary {
                model: dev.get("model").and_then(Value::as_str).unwrap_or("URX").to_string(),
                label: dev.get("label").and_then(Value::as_str).unwrap_or("URX").to_string(),
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
            return Ok((dev_uid, summary));
        }
        // No device list within the deadline. The broker answered the WebSocket
        // handshake but never listed a unit, so treat it as no URX attached
        // (same remedy for the user); the empty-list path above is the other shape.
        eprintln!("vd: timed out waiting for the device list");
        Err("no-device".into())
    }

    /// Query the unit's live link state via /vd/synchronize: "online" means a URX
    /// is actually attached. Device Center keeps the getDeviceList entry after the
    /// unit is unplugged but reports a non-"online" status here, so this is what
    /// separates a present device from a stale list entry.
    fn sync_status(ws: &mut Ws, dev_uid: &str) -> Result<String, String> {
        send_json(
            ws,
            json!({
                "jsonrpc": "1.0",
                "method": "requestVD",
                "params": {
                    "dev_uid": dev_uid,
                    "vdp": { "method": "get", "uri": "/vd/synchronize" }
                }
            }),
        )?;
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            let Some(text) = read_text(ws)? else { continue };
            let Ok(msg) = serde_json::from_str::<Value>(&text) else { continue };
            if msg.get("method").and_then(Value::as_str) != Some("requestVD") {
                continue;
            }
            let vdp = msg.pointer("/params/vdp");
            let ruri = vdp.and_then(|v| v.get("uri")).and_then(Value::as_str).unwrap_or("");
            if ruri.split('?').next().unwrap_or(ruri) != "/vd/synchronize" {
                continue;
            }
            return vdp
                .and_then(|v| v.pointer("/data/sync_status"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .ok_or_else(|| "synchronize response had no sync_status".to_string());
        }
        Err("timed out waiting for sync status".into())
    }

    fn do_set(ws: &mut Ws, dev_uid: &str, param_id: u32, x: i64, y: i64, value: Value) -> Result<(), String> {
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
            let Ok(msg) = serde_json::from_str::<Value>(&text) else { continue };
            if msg.get("method").and_then(Value::as_str) != Some("requestVD") {
                continue;
            }
            let vdp = msg.pointer("/params/vdp");
            let ruri = vdp.and_then(|v| v.get("uri")).and_then(Value::as_str).unwrap_or("");
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
                Err(format!("broker rejected the write (response_code {code})"))
            };
        }
        Err("timed out waiting for the broker to confirm the write".into())
    }

    // Read a parameter instance's raw current_value (numeric or string). do_get /
    // do_get_str decode it; sharing the request + address-matched await loop here
    // keeps the two get paths from drifting.
    fn do_get_value(ws: &mut Ws, dev_uid: &str, param_id: u32, x: i64, y: i64) -> Result<Value, String> {
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
            let Ok(msg) = serde_json::from_str::<Value>(&text) else { continue };
            if msg.get("method").and_then(Value::as_str) != Some("requestVD") {
                continue;
            }
            let vdp = msg.pointer("/params/vdp");
            let ruri = vdp.and_then(|v| v.get("uri")).and_then(Value::as_str).unwrap_or("");
            // Match the address exactly so another instance's reply (e.g. y=12) cannot
            // satisfy a y=1 request via a prefix match.
            let ruri_addr = ruri.split('?').next().unwrap_or(ruri);
            if ruri_addr != base {
                continue;
            }
            return vdp
                .and_then(|v| v.pointer("/data/current_value"))
                .cloned()
                .ok_or_else(|| "broker response had no current_value".to_string());
        }
        Err("timed out waiting for the parameter value".into())
    }

    fn do_get(ws: &mut Ws, dev_uid: &str, param_id: u32, x: i64, y: i64) -> Result<i64, String> {
        do_get_value(ws, dev_uid, param_id, x, y)?
            .as_i64()
            .ok_or_else(|| "parameter value was not an integer".to_string())
    }

    // The broker returns a name as a preset index (number) until one is typed,
    // then the literal string; a non-string value decodes to "" so callers see
    // "no custom name".
    fn do_get_str(ws: &mut Ws, dev_uid: &str, param_id: u32, x: i64, y: i64) -> Result<String, String> {
        Ok(do_get_value(ws, dev_uid, param_id, x, y)?
            .as_str()
            .unwrap_or("")
            .to_string())
    }

    /// Register or unregister one meter address with the broker. Fire-and-forget:
    /// the response_code reply is drained by `pump` like any other frame.
    fn reg_meter(ws: &mut Ws, dev_uid: &str, meter_id: u32, x: i64, op: &str) -> Result<(), String> {
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
    fn reg_param(ws: &mut Ws, dev_uid: &str, param_id: u32, x: i64, y: i64, op: &str) -> Result<(), String> {
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
    fn forward_meter(text: &str, ch: &Channel<MeterUpdate>) {
        let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
        let Some((vdp, addr)) = notify_frame(&msg, "/vd/meters/") else { return };
        let mut parts = addr.split(':');
        let (Some(id), Some(xs)) = (parts.next(), parts.next()) else { return };
        let (Ok(meter_id), Ok(x)) = (id.parse::<u32>(), xs.parse::<i64>()) else { return };
        let value = vdp.pointer("/data/current_value").and_then(Value::as_i64).unwrap_or(0);
        let _ = ch.send(MeterUpdate { meter_id, x, value });
    }

    /// Parse a parameter `notify` frame (a device-side change on a registered
    /// address) and stream it to the frontend. A non-integer current_value (e.g.
    /// a name string) is skipped — numeric follow only, matching the JS reconcile.
    fn forward_param(text: &str, ch: &Channel<ParamUpdate>) {
        let Ok(msg) = serde_json::from_str::<Value>(text) else { return };
        let Some((vdp, addr)) = notify_frame(&msg, "/vd/parameters/") else { return };
        let mut parts = addr.split(':');
        let (Some(ids), Some(xs), Some(ys)) = (parts.next(), parts.next(), parts.next()) else { return };
        let (Ok(param_id), Ok(x), Ok(y)) = (ids.parse::<u32>(), xs.parse::<i64>(), ys.parse::<i64>()) else { return };
        let Some(value) = vdp.pointer("/data/current_value").and_then(Value::as_i64) else { return };
        let _ = ch.send(ParamUpdate { param_id, x, y, value });
    }

    /// Read whatever is buffered until the socket would block, forwarding meter
    /// and parameter notifications to their channels (when subscribed) and
    /// discarding everything else. Returns Err if the connection dropped so the
    /// worker can stop.
    fn pump(
        ws: &mut Ws,
        meter_ch: Option<&Channel<MeterUpdate>>,
        param_ch: Option<&Channel<ParamUpdate>>,
    ) -> Result<(), String> {
        for _ in 0..512 {
            match ws.read() {
                Ok(Message::Text(t)) => {
                    if let Some(ch) = meter_ch {
                        forward_meter(&t, ch);
                    }
                    if let Some(ch) = param_ch {
                        forward_param(&t, ch);
                    }
                }
                Ok(Message::Close(_)) => return Err("Device Center closed the control connection".into()),
                Ok(_) => {} // ping/pong/binary — discard, keep going
                Err(tungstenite::Error::Io(e))
                    if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) =>
                {
                    return Ok(());
                }
                Err(_) => return Err("Device Center closed the control connection".into()),
            }
        }
        Ok(())
    }
}
