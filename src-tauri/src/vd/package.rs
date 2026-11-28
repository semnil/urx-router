//! The control package's requests over the session's connection (K34, K37): the shell's half of
//! the `Transport` the page hands urx-device's operations (`src/core/package-transport.ts`).
//!
//! Each request is the transport's own, submitted on the session's connection beside the worker's,
//! and answered with its K34 record exactly as it completed: nothing here retries, reads back or
//! changes a value. A result that reached the unit keeps the connection's single wire slot until
//! the page has validated its record and adopted it (`adopt`), so nothing goes out after it before
//! then — the worker's own requests included. A result the page cannot adopt ends the connection
//! with the slot still held (`fail_delivery`, `terminate`), and the session's link watch reports
//! the end.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, MutexGuard, OnceLock};
use std::time::Duration;

use serde::Serialize;
use urx_device_transport::connection::{Connection, Operation, ResultAdoption};
use urx_device_transport::i64_text;
use urx_device_transport::request::{
    Evidence, Outcome, ReadValue, Request, RequestCause, RequestFailure, RequestPhase,
};
use urx_device_transport::wire::{NameValue, ParameterAddress};

use super::{LinkCounters, Outbox, LOCK_HAND_ON_WAIT};

/// How long ending the connection for an undeliverable result waits for its close: the session's
/// own close deadline.
const FATAL_TEARDOWN: Duration = Duration::from_secs(2);

/// What the session's end is told with once a result the page could not take has ended the
/// connection (`PackageLink::fail_delivery`): a fault of the app's own, which K34 reports as
/// `internal_error`, under the code the page localizes for one (`CONTROL_WORKER_GONE`). The close
/// records no end on the connection, so the session asks this link for it (`PackageLink::ended`).
pub const ENDED: &str = "control-worker-gone: a result the app could not take ended the connection";

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|p| p.into_inner())
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CauseName {
    InvalidInput,
    PreconditionFailed,
    NotConnected,
    SendTimeout,
    ResponseTimeout,
    TeardownTimeout,
    DeviceRejected,
    InvalidResponse,
    ConnectionLost,
    NotificationOverflow,
    InternalError,
}

impl From<RequestCause> for CauseName {
    fn from(cause: RequestCause) -> Self {
        match cause {
            RequestCause::InvalidInput => CauseName::InvalidInput,
            RequestCause::PreconditionFailed => CauseName::PreconditionFailed,
            RequestCause::NotConnected => CauseName::NotConnected,
            RequestCause::SendTimeout => CauseName::SendTimeout,
            RequestCause::ResponseTimeout => CauseName::ResponseTimeout,
            RequestCause::TeardownTimeout => CauseName::TeardownTimeout,
            RequestCause::DeviceRejected => CauseName::DeviceRejected,
            RequestCause::InvalidResponse => CauseName::InvalidResponse,
            RequestCause::ConnectionLost => CauseName::ConnectionLost,
            RequestCause::NotificationOverflow => CauseName::NotificationOverflow,
            RequestCause::InternalError => CauseName::InternalError,
        }
    }
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PhaseName {
    Validation,
    Admission,
    Send,
    Response,
    Delivery,
}

impl From<RequestPhase> for PhaseName {
    fn from(phase: RequestPhase) -> Self {
        match phase {
            RequestPhase::Validation => PhaseName::Validation,
            RequestPhase::Admission => PhaseName::Admission,
            RequestPhase::Send => PhaseName::Send,
            RequestPhase::Response => PhaseName::Response,
            RequestPhase::Delivery => PhaseName::Delivery,
        }
    }
}

/// `{kind: "cause", code, phase}` or `{kind: "cancelled", phase}`.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum FailureRecord {
    Cause { code: CauseName, phase: PhaseName },
    Cancelled { phase: PhaseName },
}

impl From<RequestFailure> for FailureRecord {
    fn from(failure: RequestFailure) -> Self {
        match failure {
            RequestFailure::Cause { code, phase } => FailureRecord::Cause {
                code: code.into(),
                phase: phase.into(),
            },
            RequestFailure::Cancelled { phase } => FailureRecord::Cancelled {
                phase: phase.into(),
            },
        }
    }
}

/// `{state: ...}`; a rejection carries its response code as I64Text.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "state", rename_all = "snake_case")]
pub enum EvidenceRecord {
    NotSent,
    Unconfirmed,
    Rejected {
        #[serde(rename = "responseCode")]
        response_code: String,
    },
    Read,
    Accepted,
}

impl From<Evidence> for EvidenceRecord {
    fn from(evidence: Evidence) -> Self {
        match evidence {
            Evidence::NotSent => EvidenceRecord::NotSent,
            Evidence::Unconfirmed => EvidenceRecord::Unconfirmed,
            Evidence::Rejected(code) => EvidenceRecord::Rejected {
                response_code: i64_text::format(code),
            },
            Evidence::Read => EvidenceRecord::Read,
            Evidence::Accepted => EvidenceRecord::Accepted,
        }
    }
}

/// A name read's raw value: text, or an integer as I64Text (F03-K).
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum NameValueRecord {
    Text { value: String },
    Integer { value: String },
}

/// A success's value: I64Text, a string, a name read's raw value, or `null` for a write.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(untagged)]
pub enum RecordValue {
    Text(String),
    Name(NameValueRecord),
    Null(()),
}

/// One request's K34 record: `{kind: "success", value, evidence}` or
/// `{kind: "failure", failure, evidence}`.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Record {
    Success {
        value: RecordValue,
        evidence: EvidenceRecord,
    },
    Failure {
        failure: FailureRecord,
        evidence: EvidenceRecord,
    },
}

/// Which of the transport's methods a request is, which decides the record's value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    GetNumeric,
    GetText,
    GetName,
    SetNumeric,
    SetText,
}

impl Method {
    /// The method the page names (`Transport`'s own method names).
    pub fn named(name: &str) -> Option<Method> {
        Some(match name {
            "getNumeric" => Method::GetNumeric,
            "getText" => Method::GetText,
            "getName" => Method::GetName,
            "setNumeric" => Method::SetNumeric,
            "setText" => Method::SetText,
            _ => return None,
        })
    }

    fn writes(self) -> bool {
        matches!(self, Method::SetNumeric | Method::SetText)
    }
}

impl Record {
    /// The record of `outcome`, as `method` gives it. A value of another raw type than the method's
    /// is a delivery fault, keeping the evidence it came with.
    pub fn of(method: Method, outcome: Outcome) -> Record {
        match outcome {
            Outcome::Failure { failure, evidence } => Record::Failure {
                failure: failure.into(),
                evidence: evidence.into(),
            },
            Outcome::Success { value, evidence } => {
                let value = match (method, value) {
                    (Method::GetNumeric, Some(ReadValue::Numeric(n))) => {
                        Some(RecordValue::Text(i64_text::format(n)))
                    }
                    (Method::GetText, Some(ReadValue::Text(text))) => Some(RecordValue::Text(text)),
                    (Method::GetName, Some(ReadValue::Name(NameValue::Text(value)))) => {
                        Some(RecordValue::Name(NameValueRecord::Text { value }))
                    }
                    (Method::GetName, Some(ReadValue::Name(NameValue::Integer(value)))) => {
                        Some(RecordValue::Name(NameValueRecord::Integer {
                            value: i64_text::format(value),
                        }))
                    }
                    (Method::SetNumeric | Method::SetText, None) => Some(RecordValue::Null(())),
                    _ => None,
                };
                match value {
                    Some(value) => Record::Success {
                        value,
                        evidence: evidence.into(),
                    },
                    None => Record::Failure {
                        failure: FailureRecord::Cause {
                            code: CauseName::InternalError,
                            phase: PhaseName::Delivery,
                        },
                        evidence: evidence.into(),
                    },
                }
            }
        }
    }
}

/// A refusal decided here, before anything is handed to the transport.
fn refused(code: RequestCause, phase: RequestPhase) -> Outcome {
    Outcome::Failure {
        failure: RequestFailure::Cause { code, phase },
        evidence: Evidence::NotSent,
    }
}

/// What a request answers the page: its record, and for a write the unit's Console Lock held, the
/// fetch that hands the page the announcement it was held on (`Outbox::lock_hold`), so that the
/// page passes the record on once it has the lock.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Reply {
    pub record: Record,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub held: Option<Held>,
}

impl Reply {
    /// The reply to a request for a connection that is not the one installed: refused unsent.
    pub fn not_connected(method: Method) -> Reply {
        Reply {
            record: Record::of(
                method,
                refused(RequestCause::NotConnected, RequestPhase::Admission),
            ),
            held: None,
        }
    }
}

/// A write the unit's Console Lock held, and the fetch that carries the announcement, when known.
#[derive(Serialize, Debug, Clone, PartialEq, Eq)]
pub struct Held {
    pub fetch: Option<u64>,
}

/// The arguments of one request as the page gives them: the parameter's identifier as the number
/// it is, its coordinates as I64Text, and the value of a write.
pub struct Call<'a> {
    pub method: Method,
    pub param_id: f64,
    pub x: &'a str,
    pub y: &'a str,
    pub value: Option<&'a str>,
}

impl Call<'_> {
    /// The request, or a validation refusal. `param_id` is refused outside `u32` rather than
    /// converted into another valid identifier.
    fn request(&self) -> Result<Request, Outcome> {
        let invalid = || refused(RequestCause::InvalidInput, RequestPhase::Validation);
        let in_range = self.param_id.is_finite()
            && self.param_id.fract() == 0.0
            && (0.0..=f64::from(u32::MAX)).contains(&self.param_id);
        if !in_range {
            return Err(invalid());
        }
        let (Ok(x), Ok(y)) = (i64_text::parse(self.x), i64_text::parse(self.y)) else {
            return Err(invalid());
        };
        // In range and integral, so the conversion is exact.
        let address = ParameterAddress {
            param_id: self.param_id as u32,
            x,
            y,
        };
        Ok(match (self.method, self.value) {
            (Method::GetNumeric, None) => Request::GetNumeric(address),
            (Method::GetText, None) => Request::GetText(address),
            (Method::GetName, None) => Request::GetName(address),
            (Method::SetNumeric, Some(value)) => match i64_text::parse(value) {
                Ok(value) => Request::SetNumeric(address, value),
                Err(_) => return Err(invalid()),
            },
            (Method::SetText, Some(value)) => Request::SetText(address, value.to_owned()),
            _ => return Err(invalid()),
        })
    }
}

/// An operation owner the page named: the transport's, or none once it is finished or the
/// connection refused it, in which case every request it submits is refused unsent.
enum Owner {
    Live(Arc<Operation>),
    Done,
}

/// Each submitted request's completion slot, by its request ticket: pending until its outcome
/// arrives, then held until the page adopts it. A held `None` is an outcome that keeps no slot:
/// refused here or reported unsent.
#[derive(Default)]
struct Slots {
    pending: HashSet<String>,
    held: HashMap<String, Option<ResultAdoption>>,
}

impl Slots {
    fn reserve(&mut self, ticket: &str) -> bool {
        !self.held.contains_key(ticket) && self.pending.insert(ticket.to_owned())
    }

    fn complete(&mut self, ticket: &str, adoption: Option<ResultAdoption>) {
        self.pending.remove(ticket);
        self.held.insert(ticket.to_owned(), adoption);
    }
}

/// The control package's request side of one session (module doc).
pub struct PackageLink {
    connection: OnceLock<Arc<Connection>>,
    /// A result the page could not take has ended the connection.
    ended: AtomicBool,
    operations: Mutex<HashMap<u64, Owner>>,
    slots: Arc<Mutex<Slots>>,
    counters: Arc<LinkCounters>,
    outbox: Arc<Outbox>,
}

impl PackageLink {
    /// The request side of the session whose ledger and notifications are `counters` and `outbox`.
    pub fn new(counters: Arc<LinkCounters>, outbox: Arc<Outbox>) -> PackageLink {
        PackageLink {
            connection: OnceLock::new(),
            ended: AtomicBool::new(false),
            operations: Mutex::new(HashMap::new()),
            slots: Arc::new(Mutex::new(Slots::default())),
            counters,
            outbox,
        }
    }

    /// The session's connection, once it is open: until then every request is refused unsent.
    pub fn attach(&self, connection: Arc<Connection>) {
        let _ = self.connection.set(connection);
    }

    /// Whether a result the page could not take has ended the connection (`ENDED`).
    pub fn ended(&self) -> bool {
        self.ended.load(Ordering::SeqCst)
    }

    /// The owner `id`, made on first use: a cancel or a request may come first.
    fn owner(&self, id: u64) -> Option<Arc<Operation>> {
        let mut operations = lock(&self.operations);
        if let Some(owner) = operations.get(&id) {
            return match owner {
                Owner::Live(operation) => Some(Arc::clone(operation)),
                Owner::Done => None,
            };
        }
        let made = self
            .connection
            .get()
            .and_then(|connection| connection.create_operation().ok())
            .map(Arc::new);
        let owner = match &made {
            Some(operation) => Owner::Live(Arc::clone(operation)),
            None => Owner::Done,
        };
        operations.insert(id, owner);
        made
    }

    /// Idempotent: stops owner `id`'s unsent requests; sent ones settle under their deadlines.
    pub fn cancel(&self, id: u64) {
        if let Some(operation) = self.owner(id) {
            operation.cancel();
        }
    }

    /// Releases owner `id` once its requests are consumed; no device I/O. A later request of it is
    /// refused unsent.
    pub fn finish(&self, id: u64) {
        lock(&self.operations).insert(id, Owner::Done);
    }

    /// Submits `call` for owner `operation` under `ticket` and waits for its outcome: the record,
    /// with the result's slot held until `adopt`. A write goes out through the unit's Console Lock
    /// gate, as every write of the session does.
    pub fn request(&self, operation: u64, ticket: &str, call: Call<'_>) -> Reply {
        let method = call.method;
        let reply = |outcome| Reply {
            record: Record::of(method, outcome),
            held: None,
        };
        if !lock(&self.slots).reserve(ticket) {
            // A ticket already in use owns another call's slot: refuse without touching it.
            return reply(refused(
                RequestCause::InternalError,
                RequestPhase::Admission,
            ));
        }
        let request = match call.request() {
            Ok(request) => request,
            Err(outcome) => {
                lock(&self.slots).complete(ticket, None);
                return reply(outcome);
            }
        };
        let (Some(connection), Some(owner)) = (self.connection.get(), self.owner(operation)) else {
            lock(&self.slots).complete(ticket, None);
            return reply(refused(RequestCause::NotConnected, RequestPhase::Admission));
        };
        let (tx, rx) = mpsc::channel::<Outcome>();
        let slots = Arc::clone(&self.slots);
        let held_ticket = ticket.to_owned();
        let done = move |outcome: Outcome, adoption: ResultAdoption| {
            // Recorded before the record goes back, so the page can adopt the slot as soon as it
            // has the record. An unsent outcome holds none.
            let unsent = matches!(
                outcome,
                Outcome::Failure {
                    evidence: Evidence::NotSent,
                    ..
                }
            );
            lock(&slots).complete(&held_ticket, (!unsent).then_some(adoption));
            if tx.send(outcome).is_err() {
                // Nobody waits for the record: its slot is let go at once, so it cannot hold up
                // the connection's later requests.
                if let Some(Some(adoption)) = lock(&slots).held.remove(&held_ticket) {
                    adoption.adopt();
                }
            }
        };
        let hold = if method.writes() {
            let (gate, id) = super::lock_gate(&self.outbox);
            connection.submit_gated(&owner, request, gate, done);
            Some(id)
        } else {
            connection.submit(&owner, request, done);
            None
        };
        let outcome = rx.recv().unwrap_or(Outcome::Failure {
            failure: RequestFailure::Cause {
                code: RequestCause::InternalError,
                phase: RequestPhase::Delivery,
            },
            evidence: Evidence::Unconfirmed,
        });
        if matches!(
            outcome,
            Outcome::Failure {
                failure: RequestFailure::Cause {
                    code: RequestCause::ResponseTimeout,
                    ..
                },
                ..
            }
        ) {
            self.counters.note_deadline();
        }
        let held = hold
            .and_then(|id| self.outbox.lock_hold(id, LOCK_HAND_ON_WAIT))
            .map(|fetch| Held { fetch });
        Reply {
            record: Record::of(method, outcome),
            held,
        }
    }

    /// Releases the completion slot of `ticket`'s result once the page has validated it; no device
    /// I/O. True for any completed result: one that held no slot (refused, unsent, expired or
    /// ended) has nothing to release. False for a ticket with no completed result, or one already
    /// adopted, reported or ended.
    pub fn adopt(&self, ticket: &str) -> bool {
        let taken = lock(&self.slots).held.remove(ticket);
        match taken {
            None => false,
            Some(None) => true,
            Some(Some(adoption)) => {
                adoption.adopt();
                true
            }
        }
    }

    /// The page could not adopt `ticket`'s result: when it still holds a slot, the connection ends
    /// with the slot held, since an unadopted slot would stop every later request, and the
    /// session's link watch reports the end. False for an unknown ticket.
    pub fn fail_delivery(&self, ticket: &str) -> bool {
        self.end_for(ticket, false)
    }

    /// Ends the connection if, and only if, `ticket` still owns a slot not yet released; true
    /// otherwise as well.
    pub fn terminate(&self, ticket: &str) -> bool {
        self.end_for(ticket, true)
    }

    fn end_for(&self, ticket: &str, unknown_is_done: bool) -> bool {
        let taken = lock(&self.slots).held.remove(ticket);
        match taken {
            None => unknown_is_done,
            Some(None) => true,
            Some(Some(held)) => {
                // Recorded first, so whatever the close makes fail is told by this end. The
                // connection closes with the result still held; only then is it let go.
                self.ended.store(true, Ordering::SeqCst);
                if let Some(connection) = self.connection.get() {
                    connection.close(FATAL_TEARDOWN);
                }
                drop(held);
                true
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    fn json_of(record: Record) -> Value {
        serde_json::to_value(record).unwrap()
    }

    fn failed(code: RequestCause, phase: RequestPhase, evidence: Evidence) -> Outcome {
        Outcome::Failure {
            failure: RequestFailure::Cause { code, phase },
            evidence,
        }
    }

    #[test]
    fn a_read_keeps_its_value_as_canonical_text_and_its_evidence() {
        let record = Record::of(
            Method::GetNumeric,
            Outcome::Success {
                value: Some(ReadValue::Numeric(i64::MIN)),
                evidence: Evidence::Read,
            },
        );
        assert_eq!(
            json_of(record),
            json!({ "kind": "success", "value": "-9223372036854775808", "evidence": { "state": "read" } })
        );
        let text = Record::of(
            Method::GetText,
            Outcome::Success {
                value: Some(ReadValue::Text(String::new())),
                evidence: Evidence::Read,
            },
        );
        assert_eq!(json_of(text)["value"], json!(""));
    }

    #[test]
    fn a_name_read_keeps_its_wire_type() {
        let name = |value| {
            json_of(Record::of(
                Method::GetName,
                Outcome::Success {
                    value: Some(ReadValue::Name(value)),
                    evidence: Evidence::Read,
                },
            ))["value"]
                .clone()
        };
        assert_eq!(
            name(NameValue::Text("123".into())),
            json!({ "kind": "text", "value": "123" })
        );
        assert_eq!(
            name(NameValue::Integer(123)),
            json!({ "kind": "integer", "value": "123" })
        );
    }

    #[test]
    fn a_write_succeeds_with_a_null_value() {
        for method in [Method::SetNumeric, Method::SetText] {
            let record = Record::of(
                method,
                Outcome::Success {
                    value: None,
                    evidence: Evidence::Accepted,
                },
            );
            assert_eq!(
                json_of(record),
                json!({ "kind": "success", "value": null, "evidence": { "state": "accepted" } })
            );
        }
    }

    #[test]
    fn a_value_of_another_raw_type_is_a_delivery_fault_keeping_its_evidence() {
        let fault = json!({ "kind": "cause", "code": "internal_error", "phase": "delivery" });
        for (method, value, evidence) in [
            (
                Method::GetNumeric,
                Some(ReadValue::Text("1".into())),
                Evidence::Read,
            ),
            (Method::GetText, Some(ReadValue::Numeric(1)), Evidence::Read),
            (
                Method::GetName,
                Some(ReadValue::Text("a".into())),
                Evidence::Read,
            ),
            (Method::GetNumeric, None, Evidence::Read),
            (
                Method::SetNumeric,
                Some(ReadValue::Numeric(1)),
                Evidence::Accepted,
            ),
        ] {
            let record = json_of(Record::of(method, Outcome::Success { value, evidence }));
            assert_eq!(record["kind"], json!("failure"), "{method:?}");
            assert_eq!(record["failure"], fault, "{method:?}");
            assert!(record.get("value").is_none(), "{method:?}: no value");
        }
    }

    #[test]
    fn a_rejection_keeps_its_response_code_and_a_cancellation_its_phase() {
        let rejected = Record::of(
            Method::SetText,
            failed(
                RequestCause::DeviceRejected,
                RequestPhase::Response,
                Evidence::Rejected(403),
            ),
        );
        assert_eq!(
            json_of(rejected),
            json!({
                "kind": "failure",
                "failure": { "kind": "cause", "code": "device_rejected", "phase": "response" },
                "evidence": { "state": "rejected", "responseCode": "403" },
            })
        );
        let cancelled = Record::of(
            Method::GetText,
            Outcome::Failure {
                failure: RequestFailure::Cancelled {
                    phase: RequestPhase::Send,
                },
                evidence: Evidence::Unconfirmed,
            },
        );
        assert_eq!(
            json_of(cancelled),
            json!({
                "kind": "failure",
                "failure": { "kind": "cancelled", "phase": "send" },
                "evidence": { "state": "unconfirmed" },
            })
        );
    }

    #[test]
    fn every_cause_and_phase_has_the_name_the_package_validates() {
        let causes = [
            (RequestCause::InvalidInput, "invalid_input"),
            (RequestCause::PreconditionFailed, "precondition_failed"),
            (RequestCause::NotConnected, "not_connected"),
            (RequestCause::SendTimeout, "send_timeout"),
            (RequestCause::ResponseTimeout, "response_timeout"),
            (RequestCause::TeardownTimeout, "teardown_timeout"),
            (RequestCause::DeviceRejected, "device_rejected"),
            (RequestCause::InvalidResponse, "invalid_response"),
            (RequestCause::ConnectionLost, "connection_lost"),
            (RequestCause::NotificationOverflow, "notification_overflow"),
            (RequestCause::InternalError, "internal_error"),
        ];
        for (cause, name) in causes {
            assert_eq!(
                serde_json::to_value(CauseName::from(cause)).unwrap(),
                json!(name)
            );
        }
        let phases = [
            (RequestPhase::Validation, "validation"),
            (RequestPhase::Admission, "admission"),
            (RequestPhase::Send, "send"),
            (RequestPhase::Response, "response"),
            (RequestPhase::Delivery, "delivery"),
        ];
        for (phase, name) in phases {
            assert_eq!(
                serde_json::to_value(PhaseName::from(phase)).unwrap(),
                json!(name)
            );
        }
    }

    fn call<'a>(method: Method, param_id: f64, x: &'a str, value: Option<&'a str>) -> Call<'a> {
        Call {
            method,
            param_id,
            x,
            y: "0",
            value,
        }
    }

    #[test]
    fn an_argument_out_of_its_range_is_refused_unsent_at_validation() {
        let invalid = |call: Call<'_>| {
            matches!(
                call.request(),
                Err(Outcome::Failure {
                    failure: RequestFailure::Cause {
                        code: RequestCause::InvalidInput,
                        phase: RequestPhase::Validation,
                    },
                    evidence: Evidence::NotSent,
                })
            )
        };
        assert!(invalid(call(Method::GetNumeric, -1.0, "0", None)));
        assert!(invalid(call(
            Method::GetNumeric,
            4_294_967_296.0,
            "0",
            None
        )));
        assert!(invalid(call(Method::GetNumeric, 1.5, "0", None)));
        assert!(invalid(call(Method::GetNumeric, f64::NAN, "0", None)));
        assert!(invalid(call(Method::GetNumeric, 1.0, "01", None)));
        assert!(invalid(call(
            Method::GetNumeric,
            1.0,
            "9223372036854775808",
            None
        )));
        assert!(invalid(call(Method::SetNumeric, 1.0, "0", Some("1.0"))));
        assert!(invalid(call(Method::SetNumeric, 1.0, "0", None)));
        assert!(invalid(call(Method::GetText, 1.0, "0", Some("1"))));
        assert!(matches!(
            call(
                Method::SetNumeric,
                4_294_967_295.0,
                "-9223372036854775808",
                Some("-1")
            )
            .request(),
            Ok(Request::SetNumeric(
                ParameterAddress {
                    param_id: u32::MAX,
                    x: i64::MIN,
                    ..
                },
                -1
            ))
        ));
        assert!(matches!(
            call(Method::SetText, 1.0, "0", Some("")).request(),
            Ok(Request::SetText(_, text)) if text.is_empty()
        ));
    }

    fn unattached() -> PackageLink {
        PackageLink::new(
            Arc::new(LinkCounters::default()),
            Arc::new(Outbox::default()),
        )
    }

    #[test]
    fn a_request_before_the_connection_opens_is_refused_unsent_and_holds_no_slot() {
        let link = unattached();
        let reply = link.request(1, "request-1", call(Method::GetNumeric, 1.0, "0", None));
        assert_eq!(
            json_of(reply.record),
            json!({
                "kind": "failure",
                "failure": { "kind": "cause", "code": "not_connected", "phase": "admission" },
                "evidence": { "state": "not_sent" },
            })
        );
        assert_eq!(reply.held, None);
        assert!(link.adopt("request-1"), "a completed result is adoptable");
        assert!(!link.adopt("request-1"), "once");
        assert!(!link.fail_delivery("request-2"), "an unknown ticket");
        assert!(
            link.terminate("request-2"),
            "an unknown ticket owns no slot"
        );
    }

    #[test]
    fn a_ticket_in_use_is_refused_without_touching_its_slot() {
        let link = unattached();
        link.request(1, "request-1", call(Method::GetNumeric, 1.0, "0", None));
        let again = link.request(1, "request-1", call(Method::GetNumeric, 1.0, "0", None));
        assert_eq!(
            json_of(again.record)["failure"],
            json!({ "kind": "cause", "code": "internal_error", "phase": "admission" })
        );
        assert!(
            link.adopt("request-1"),
            "the first call's slot is still there"
        );
    }

    #[test]
    fn a_method_is_named_as_the_transport_names_it() {
        assert_eq!(Method::named("getNumeric"), Some(Method::GetNumeric));
        assert_eq!(Method::named("getText"), Some(Method::GetText));
        assert_eq!(Method::named("getName"), Some(Method::GetName));
        assert_eq!(Method::named("setNumeric"), Some(Method::SetNumeric));
        assert_eq!(Method::named("setText"), Some(Method::SetText));
        assert_eq!(Method::named("get_numeric"), None);
    }

    /// One record of every shape the shell builds, each under the method it answers: the list the
    /// page's contract test validates with urx-device's own validators
    /// (`src/core/package-transport.test.ts`).
    fn shared_cases() -> Vec<(&'static str, Method, Outcome)> {
        let read = |value| Outcome::Success {
            value: Some(value),
            evidence: Evidence::Read,
        };
        let cancelled = |phase, evidence| Outcome::Failure {
            failure: RequestFailure::Cancelled { phase },
            evidence,
        };
        use RequestCause as C;
        use RequestPhase as P;
        vec![
            (
                "the smallest numeric read",
                Method::GetNumeric,
                read(ReadValue::Numeric(i64::MIN)),
            ),
            (
                "the largest numeric read",
                Method::GetNumeric,
                read(ReadValue::Numeric(i64::MAX)),
            ),
            (
                "an empty text read",
                Method::GetText,
                read(ReadValue::Text(String::new())),
            ),
            (
                "a digit-only text read",
                Method::GetText,
                read(ReadValue::Text("123".into())),
            ),
            (
                "a name read as text",
                Method::GetName,
                read(ReadValue::Name(NameValue::Text("Vocal".into()))),
            ),
            (
                "a name read as an integer",
                Method::GetName,
                read(ReadValue::Name(NameValue::Integer(3))),
            ),
            (
                "an accepted numeric write",
                Method::SetNumeric,
                Outcome::Success {
                    value: None,
                    evidence: Evidence::Accepted,
                },
            ),
            (
                "an accepted text write",
                Method::SetText,
                Outcome::Success {
                    value: None,
                    evidence: Evidence::Accepted,
                },
            ),
            (
                "a write the unit refused",
                Method::SetNumeric,
                failed(C::DeviceRejected, P::Response, Evidence::Rejected(500)),
            ),
            (
                "a read the unit refused",
                Method::GetNumeric,
                failed(C::DeviceRejected, P::Response, Evidence::Rejected(404)),
            ),
            (
                "an argument refused at validation",
                Method::SetText,
                failed(C::InvalidInput, P::Validation, Evidence::NotSent),
            ),
            (
                "a write held at admission",
                Method::SetNumeric,
                failed(C::PreconditionFailed, P::Admission, Evidence::NotSent),
            ),
            (
                "a request for no connection",
                Method::GetName,
                failed(C::NotConnected, P::Admission, Evidence::NotSent),
            ),
            (
                "a send past its deadline",
                Method::SetNumeric,
                failed(C::SendTimeout, P::Send, Evidence::Unconfirmed),
            ),
            (
                "a response past its deadline",
                Method::GetNumeric,
                failed(C::ResponseTimeout, P::Response, Evidence::Unconfirmed),
            ),
            (
                "a malformed verdict",
                Method::SetText,
                failed(C::InvalidResponse, P::Response, Evidence::Unconfirmed),
            ),
            (
                "a link lost while sending",
                Method::GetText,
                failed(C::ConnectionLost, P::Send, Evidence::Unconfirmed),
            ),
            (
                "a read lost at delivery",
                Method::GetNumeric,
                failed(C::ConnectionLost, P::Delivery, Evidence::Read),
            ),
            (
                "an accepted write overflowing at delivery",
                Method::SetNumeric,
                failed(C::NotificationOverflow, P::Delivery, Evidence::Accepted),
            ),
            (
                "a value of another raw type",
                Method::GetName,
                read(ReadValue::Numeric(1)),
            ),
            (
                "a cancellation before sending",
                Method::SetText,
                cancelled(P::Admission, Evidence::NotSent),
            ),
            (
                "a cancellation while sending",
                Method::GetNumeric,
                cancelled(P::Send, Evidence::Unconfirmed),
            ),
        ]
    }

    const SHARED_RECORDS: &str = include_str!("../../../src/core/package-records.fixture.json");

    // The records the page's contract test validates are the ones built here: the fixture is this
    // list, regenerated with `UPDATE_PACKAGE_RECORDS=1 cargo test`.
    #[test]
    fn the_records_the_page_validates_are_the_ones_built_here() {
        let built: Vec<Value> = shared_cases()
            .into_iter()
            .map(|(case, method, outcome)| {
                let name = match method {
                    Method::GetNumeric => "getNumeric",
                    Method::GetText => "getText",
                    Method::GetName => "getName",
                    Method::SetNumeric => "setNumeric",
                    Method::SetText => "setText",
                };
                json!({ "case": case, "method": name, "record": Record::of(method, outcome) })
            })
            .collect();
        let built = Value::Array(built);
        if std::env::var_os("UPDATE_PACKAGE_RECORDS").is_some() {
            let path = concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../src/core/package-records.fixture.json"
            );
            let text = serde_json::to_string_pretty(&built).unwrap() + "\n";
            std::fs::write(path, text).unwrap();
            return;
        }
        let shared: Value = serde_json::from_str(SHARED_RECORDS).unwrap();
        assert_eq!(
            shared, built,
            "regenerate with UPDATE_PACKAGE_RECORDS=1 cargo test"
        );
    }

    #[test]
    fn the_end_a_result_the_page_could_not_take_makes_is_the_app_s_own_fault() {
        assert!(ENDED.starts_with(&format!("{}:", super::super::CONTROL_WORKER_GONE)));
    }

    #[test]
    fn a_reply_for_another_connection_is_refused_unsent() {
        let reply = Reply::not_connected(Method::SetText);
        assert_eq!(
            serde_json::to_value(reply).unwrap(),
            json!({ "record": {
                "kind": "failure",
                "failure": { "kind": "cause", "code": "not_connected", "phase": "admission" },
                "evidence": { "state": "not_sent" },
            } })
        );
    }
}
