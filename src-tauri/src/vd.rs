// Live hardware control transport: a client for the Device Center broker's
// "vd" protocol over WebSocket (ws://127.0.0.1:51780/casket, JSON-RPC 1.0).
// Device Center must be running with a URX connected; it bridges the broker to
// the unit's CDC serial. See reference/.local/control-protocol-research.md §12.
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

/// Open a connection (spawns the worker, performs the broker handshake) and
/// return the connected device. Replaces any prior connection.
pub fn connect(state: &VdState) -> Result<DeviceSummary, String> {
    #[cfg(not(desktop))]
    {
        let _ = state;
        Err("hardware control is available on desktop only".into())
    }
    #[cfg(desktop)]
    {
        disconnect(state);
        let (tx, rx) = mpsc::channel::<Cmd>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<DeviceSummary, String>>();
        std::thread::spawn(move || imp::worker(rx, ready_tx));
        let summary = ready_rx
            .recv()
            .map_err(|_| "control worker exited before handshake".to_string())??;
        *state.tx.lock().unwrap() = Some(tx);
        Ok(summary)
    }
}

/// Set one parameter instance to an absolute value. Errors if not connected or
/// the broker rejects the write.
pub fn set(state: &VdState, param_id: u32, x: i64, y: i64, value: i64) -> Result<(), String> {
    let (reply, wait) = mpsc::channel();
    {
        let guard = state.tx.lock().unwrap();
        let tx = guard.as_ref().ok_or("not connected")?;
        tx.send(Cmd::Set { param_id, x, y, value, reply })
            .map_err(|_| "control worker is gone".to_string())?;
    }
    wait.recv().map_err(|_| "no response from control worker".to_string())?
}

/// Read one parameter instance's current absolute value. Errors if not connected.
pub fn get(state: &VdState, param_id: u32, x: i64, y: i64) -> Result<i64, String> {
    let (reply, wait) = mpsc::channel();
    {
        let guard = state.tx.lock().unwrap();
        let tx = guard.as_ref().ok_or("not connected")?;
        tx.send(Cmd::Get { param_id, x, y, reply })
            .map_err(|_| "control worker is gone".to_string())?;
    }
    wait.recv().map_err(|_| "no response from control worker".to_string())?
}

/// The currently connected device, or an error if not connected.
pub fn info(state: &VdState) -> Result<DeviceSummary, String> {
    let (reply, wait) = mpsc::channel();
    {
        let guard = state.tx.lock().unwrap();
        let tx = guard.as_ref().ok_or("not connected")?;
        tx.send(Cmd::Info { reply }).map_err(|_| "control worker is gone".to_string())?;
    }
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
                    let _ = reply.send(do_set(&mut ws, &dev_uid, param_id, x, y, value));
                }
                Ok(Cmd::Get { param_id, x, y, reply }) => {
                    let _ = reply.send(do_get(&mut ws, &dev_uid, param_id, x, y));
                }
                Err(RecvTimeoutError::Timeout) => {
                    // Discard queued meter notifications so the socket buffer
                    // never backs up while idle.
                    drain(&mut ws);
                }
            }
        }
        let _ = ws.close(None);
    }

    fn send_json(ws: &mut Ws, v: Value) -> Result<(), String> {
        ws.send(Message::Text(v.to_string())).map_err(|e| e.to_string())
    }

    /// Read one text message, or None on read timeout. Errors only on a closed
    /// or broken connection.
    fn read_text(ws: &mut Ws) -> Result<Option<String>, String> {
        match ws.read() {
            Ok(Message::Text(t)) => Ok(Some(t.to_string())),
            Ok(Message::Close(_)) => Err("connection closed".into()),
            Ok(_) => Ok(None), // ping/pong/binary — ignore
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

    fn do_set(ws: &mut Ws, dev_uid: &str, param_id: u32, x: i64, y: i64, value: i64) -> Result<(), String> {
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
            if !ruri.starts_with(&base) {
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

    fn do_get(ws: &mut Ws, dev_uid: &str, param_id: u32, x: i64, y: i64) -> Result<i64, String> {
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
            if !ruri.starts_with(&base) {
                continue;
            }
            return vdp
                .and_then(|v| v.pointer("/data/current_value"))
                .and_then(Value::as_i64)
                .ok_or_else(|| "broker response had no current_value".to_string());
        }
        Err("timed out waiting for the parameter value".into())
    }

    /// Read and discard whatever is buffered until the socket would block.
    fn drain(ws: &mut Ws) {
        for _ in 0..256 {
            match read_text(ws) {
                Ok(Some(_)) => continue,
                _ => break,
            }
        }
    }
}
