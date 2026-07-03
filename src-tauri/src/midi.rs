// External MIDI control bridge (desktop only). The frontend maps MIDI messages
// onto console controls; this module only moves raw bytes: it enumerates ports,
// holds at most one open input and one open output connection, streams incoming
// messages to the frontend through a Tauri channel, and sends feedback bytes
// back out. Every call is a local OS-API round-trip (no network), so the
// commands stay synchronous — unlike the vd broker commands, nothing here can
// stall on a remote peer.

use std::sync::mpsc;
use std::sync::Mutex;

use midir::{MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use serde::Serialize;
use tauri::ipc::Channel;

/// The open connections, managed as Tauri state. One input + one output at a
/// time: opening a port drops the previous connection of the same direction.
#[derive(Default)]
pub struct MidiState {
    input: Mutex<Option<MidiInputConnection<()>>>,
    output: Mutex<Option<MidiOutputConnection>>,
}

/// One incoming MIDI message. The OS layer resolves running status, so `bytes`
/// always starts with a status byte.
#[derive(Serialize, Clone)]
pub struct MidiMessage {
    pub bytes: Vec<u8>,
}

const CLIENT: &str = "urx-router";

/// Names of the attached input ports. Re-enumerated on every call so the
/// settings UI sees hot-plugged devices (midir has no hot-plug notification);
/// the name doubles as the port id when opening.
pub fn list_inputs() -> Result<Vec<String>, String> {
    let midi_in = MidiInput::new(CLIENT).map_err(|e| e.to_string())?;
    Ok(midi_in.ports().iter().filter_map(|p| midi_in.port_name(p).ok()).collect())
}

pub fn list_outputs() -> Result<Vec<String>, String> {
    let midi_out = MidiOutput::new(CLIENT).map_err(|e| e.to_string())?;
    Ok(midi_out.ports().iter().filter_map(|p| midi_out.port_name(p).ok()).collect())
}

/// Open the named input port and stream its messages through `channel`,
/// replacing any previously open input. The midir callback runs on an OS
/// thread; it hands each message to a forwarder thread that drains bursts into
/// one channel batch, so a controller sweep crosses the IPC boundary per burst
/// rather than per message (the same batching idea as the vd meter pump).
pub fn open_input(state: &MidiState, port: String, channel: Channel<Vec<MidiMessage>>) -> Result<(), String> {
    let mut slot = state.input.lock().unwrap();
    // Drop the previous connection first: its callback sender dies with it,
    // which ends the old forwarder thread through the closed mpsc receiver.
    *slot = None;
    let midi_in = MidiInput::new(CLIENT).map_err(|e| e.to_string())?;
    let target = midi_in
        .ports()
        .into_iter()
        .find(|p| midi_in.port_name(p).ok().as_deref() == Some(port.as_str()))
        .ok_or("midi-port-not-found")?;
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        while let Ok(first) = rx.recv() {
            let mut batch = vec![MidiMessage { bytes: first }];
            while let Ok(more) = rx.try_recv() {
                batch.push(MidiMessage { bytes: more });
            }
            if channel.send(batch).is_err() {
                return; // frontend side gone — stop forwarding
            }
        }
    });
    let conn = midi_in
        .connect(
            &target,
            "urx-router-input",
            move |_ts, bytes, _| {
                let _ = tx.send(bytes.to_vec());
            },
            (),
        )
        .map_err(|e| e.to_string())?;
    *slot = Some(conn);
    Ok(())
}

pub fn close_input(state: &MidiState) {
    *state.input.lock().unwrap() = None;
}

/// Open the named output port for controller feedback, replacing any
/// previously open output.
pub fn open_output(state: &MidiState, port: String) -> Result<(), String> {
    let mut slot = state.output.lock().unwrap();
    *slot = None;
    let midi_out = MidiOutput::new(CLIENT).map_err(|e| e.to_string())?;
    let target = midi_out
        .ports()
        .into_iter()
        .find(|p| midi_out.port_name(p).ok().as_deref() == Some(port.as_str()))
        .ok_or("midi-port-not-found")?;
    let conn = midi_out.connect(&target, "urx-router-output").map_err(|e| e.to_string())?;
    *slot = Some(conn);
    Ok(())
}

pub fn close_output(state: &MidiState) {
    *state.output.lock().unwrap() = None;
}

/// Send one raw message out of the open output port (controller feedback:
/// motor faders / LEDs following the plan).
pub fn send(state: &MidiState, bytes: Vec<u8>) -> Result<(), String> {
    match state.output.lock().unwrap().as_mut() {
        Some(conn) => conn.send(&bytes).map_err(|e| e.to_string()),
        None => Err("midi-output-not-open".into()),
    }
}
