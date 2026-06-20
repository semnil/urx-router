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

/// Device identity exposed to the frontend (no dev_uid / serial).
#[derive(Clone, Serialize)]
pub struct DeviceSummary {
    pub model: String,
    pub label: String,
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

/// Close any live connection. Safe to call when not connected.
pub fn disconnect(state: &VdState) {
    if let Some(tx) = state.tx.lock().unwrap().take() {
        let _ = tx.send(Cmd::Shutdown);
    }
}

#[cfg(desktop)]
mod imp {
    use super::{Cmd, DeviceSummary};
    use std::net::TcpStream;
    use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
    use std::time::{Duration, Instant};

    use serde_json::{json, Value};
    use tungstenite::stream::MaybeTlsStream;
    use tungstenite::{connect, Message, WebSocket};

    const URL: &str = "ws://127.0.0.1:51780/casket";
    type Ws = WebSocket<MaybeTlsStream<TcpStream>>;

    pub fn worker(rx: Receiver<Cmd>, ready: Sender<Result<DeviceSummary, String>>) {
        let mut ws = match connect(URL) {
            Ok((ws, _)) => ws,
            Err(e) => {
                let _ = ready.send(Err(format!("cannot reach Device Center broker: {e}")));
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
                Err(RecvTimeoutError::Timeout) => {
                    // Discard queued meter notifications so the socket buffer
                    // never backs up while idle, and stop if the link dropped.
                    if let Err(e) = drain(&mut ws) {
                        eprintln!("vd: {e}; stopping control worker");
                        break;
                    }
                }
            }
        }
        let _ = ws.close(None);
    }

    fn send_json(ws: &mut Ws, v: Value) -> Result<(), String> {
        ws.send(Message::Text(v.to_string())).map_err(|e| e.to_string())
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
                return Err("no URX device is connected to Device Center".into());
            };
            let dev_uid = dev.get("dev_uid").and_then(Value::as_str).unwrap_or_default().to_string();
            let summary = DeviceSummary {
                model: dev.get("model").and_then(Value::as_str).unwrap_or("URX").to_string(),
                label: dev.get("label").and_then(Value::as_str).unwrap_or("URX").to_string(),
            };
            if dev_uid.is_empty() {
                return Err("device list entry had no identifier".into());
            }
            return Ok((dev_uid, summary));
        }
        Err("timed out waiting for the device list".into())
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

    /// Outcome of reading one frame while draining the idle socket.
    enum Drained {
        /// A frame was read and discarded; more may be buffered.
        Frame,
        /// No more frames are buffered (socket would block); draining is done.
        Empty,
        /// The connection is closed or broken.
        Closed,
    }

    /// Read one frame for draining, distinguishing an empty socket (WouldBlock)
    /// from a non-text frame so the caller can stop once the buffer is clear.
    fn drain_one(ws: &mut Ws) -> Drained {
        match ws.read() {
            Ok(Message::Close(_)) => Drained::Closed,
            Ok(_) => Drained::Frame, // text/ping/pong/binary — discard, keep going
            Err(tungstenite::Error::Io(e))
                if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) =>
            {
                Drained::Empty
            }
            Err(_) => Drained::Closed,
        }
    }

    /// Read and discard whatever is buffered until the socket would block.
    /// Returns Err if the connection dropped so the worker can stop.
    fn drain(ws: &mut Ws) -> Result<(), String> {
        for _ in 0..256 {
            match drain_one(ws) {
                Drained::Frame => continue,
                Drained::Empty => return Ok(()),
                Drained::Closed => return Err("Device Center closed the control connection".into()),
            }
        }
        Ok(())
    }
}
