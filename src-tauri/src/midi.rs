// External MIDI control bridge (desktop only). The frontend maps MIDI messages
// onto console controls; this module only moves raw bytes: it enumerates ports,
// holds at most one open input and one open output connection, streams incoming
// messages to the frontend through a Tauri channel, and sends feedback bytes
// back out. Every call is a local OS-API round-trip (no network), so the
// commands stay synchronous — unlike the vd broker commands, nothing here can
// stall on a remote peer.
//
// Every error returned is a stable kebab-case code, optionally followed by ": "
// and the midir message as a detail, so the frontend can localize it (src/i18n
// error.shell). Codes: midi-port-not-found, midi-output-not-open,
// midi-init-failed, midi-open-failed, midi-send-failed.

use std::sync::mpsc;
use std::sync::Mutex;

use midir::{MidiInput, MidiInputConnection, MidiOutput, MidiOutputConnection};
use serde::Serialize;
use tauri::ipc::Channel;

/// The open connections, managed as Tauri state. One input + one output at a
/// time: opening a port drops the previous connection of the same direction.
///
/// Each is kept with the port name it was opened under, so `open_ports` can
/// answer what is actually open. The frontend holds its own idea of the chosen
/// ports, and that idea is not falsifiable from the page: a connection closed
/// from this side (the page-load teardown) leaves it asserting a port nothing
/// is listening on. Storing the name is what lets it be checked instead.
///
/// The owning webview is kept with it for the other half of the same problem: a
/// page load may close what that page opened and nothing else, and this app has a
/// second window (midiwin.rs) whose own load used to close the first one's ports.
#[derive(Default)]
pub struct MidiState {
    input: Mutex<Option<Held<MidiInputConnection<()>>>>,
    output: Mutex<Option<Held<MidiOutputConnection>>>,
}

/// An open connection, with who opened it and what it was opened on.
struct Held<T> {
    owner: String,
    port: String,
    conn: T,
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
    let midi_in = MidiInput::new(CLIENT).map_err(|e| format!("midi-init-failed: {e}"))?;
    Ok(midi_in
        .ports()
        .iter()
        .filter_map(|p| midi_in.port_name(p).ok())
        .collect())
}

pub fn list_outputs() -> Result<Vec<String>, String> {
    let midi_out = MidiOutput::new(CLIENT).map_err(|e| format!("midi-init-failed: {e}"))?;
    Ok(midi_out
        .ports()
        .iter()
        .filter_map(|p| midi_out.port_name(p).ok())
        .collect())
}

/// Open the named input port and stream its messages through `channel`,
/// replacing any previously open input. The midir callback runs on an OS
/// thread; it hands each message to a forwarder thread that drains bursts into
/// one channel batch, so a controller sweep crosses the IPC boundary per burst
/// rather than per message (the same batching idea as the vd meter pump).
pub fn open_input(
    state: &MidiState,
    owner: &str,
    port: String,
    channel: Channel<Vec<MidiMessage>>,
) -> Result<(), String> {
    let mut slot = state.input.lock().unwrap();
    // Drop the previous connection first: its callback sender dies with it,
    // which ends the old forwarder thread through the closed mpsc receiver.
    *slot = None;
    let midi_in = MidiInput::new(CLIENT).map_err(|e| format!("midi-init-failed: {e}"))?;
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
        .map_err(|e| format!("midi-open-failed: {e}"))?;
    *slot = Some(Held {
        owner: owner.to_string(),
        port,
        conn,
    });
    Ok(())
}

/// Close the input, if `label` is the webview that opened it. Ownership is checked for
/// the reason the page-load teardown checks it: another window closing main's port
/// leaves main delivering into nothing while its select still names the port.
pub fn close_input(state: &MidiState, label: &str) {
    let mut slot = state.input.lock().unwrap();
    if slot.as_ref().is_some_and(|p| p.owner == label) {
        *slot = None;
    }
}

/// Close whichever ports `label` opened, and leave any other page's alone. The
/// page-load teardown's whole job (see `vd::shutdown_owned_by` for the same rule on
/// the device session).
pub fn close_owned_by(state: &MidiState, label: &str) {
    let mut input = state.input.lock().unwrap();
    if input.as_ref().is_some_and(|h| h.owner == label) {
        *input = None;
    }
    let mut output = state.output.lock().unwrap();
    if output.as_ref().is_some_and(|h| h.owner == label) {
        *output = None;
    }
}

/// The ports actually open right now, input first — the answer to "is what the
/// frontend thinks it holds still true". Read on every port refresh rather than
/// pushed, since the closing side (a page-load teardown) is talking about a page
/// that is going away and has nobody left to tell.
pub fn open_ports(state: &MidiState) -> (Option<String>, Option<String>) {
    let input = state.input.lock().unwrap().as_ref().map(|h| h.port.clone());
    let output = state
        .output
        .lock()
        .unwrap()
        .as_ref()
        .map(|h| h.port.clone());
    (input, output)
}

/// Open the named output port for controller feedback, replacing any
/// previously open output.
pub fn open_output(state: &MidiState, owner: &str, port: String) -> Result<(), String> {
    let mut slot = state.output.lock().unwrap();
    *slot = None;
    let midi_out = MidiOutput::new(CLIENT).map_err(|e| format!("midi-init-failed: {e}"))?;
    let target = midi_out
        .ports()
        .into_iter()
        .find(|p| midi_out.port_name(p).ok().as_deref() == Some(port.as_str()))
        .ok_or("midi-port-not-found")?;
    let conn = midi_out
        .connect(&target, "urx-router-output")
        .map_err(|e| format!("midi-open-failed: {e}"))?;
    *slot = Some(Held {
        owner: owner.to_string(),
        port,
        conn,
    });
    Ok(())
}

/// The output twin of `close_input`.
pub fn close_output(state: &MidiState, label: &str) {
    let mut slot = state.output.lock().unwrap();
    if slot.as_ref().is_some_and(|p| p.owner == label) {
        *slot = None;
    }
}

/// Send one raw message out of the open output port (controller feedback:
/// motor faders / LEDs following the plan).
pub fn send(state: &MidiState, bytes: Vec<u8>) -> Result<(), String> {
    match state.output.lock().unwrap().as_mut() {
        Some(held) => held
            .conn
            .send(&bytes)
            .map_err(|e| format!("midi-send-failed: {e}")),
        None => Err("midi-output-not-open".into()),
    }
}
