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

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Condvar, Mutex, MutexGuard, OnceLock, Weak};
use std::time::{Duration, Instant};

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

/// How long a result may hold the connection's wire slot with neither an adoption nor a report
/// from the page: the request deadline every get and set has (`imp::REQUEST_DEADLINE`). Past it
/// the connection ends with the slot, as a report would end it, so a result whose page went quiet
/// stops the session's other requests no longer than one of them waits for its response.
pub const HOLD_DEADLINE: Duration = Duration::from_secs(3);

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

/// Numbers kept as ranges, merged as they fill: what is left of the tickets the page settled and the
/// owners it finished, which a late call on one of them is refused against. However many there are,
/// the ranges number no more than the gaps between them.
#[derive(Default)]
struct Ranges(BTreeMap<u64, u64>);

impl Ranges {
    fn contains(&self, n: u64) -> bool {
        self.0
            .range(..=n)
            .next_back()
            .is_some_and(|(_, &end)| n <= end)
    }

    fn insert(&mut self, n: u64) {
        if self.contains(n) {
            return;
        }
        let mut start = n;
        let mut end = n;
        if let Some((&before, &before_end)) = self.0.range(..n).next_back() {
            if before_end.checked_add(1) == Some(n) {
                start = before;
                self.0.remove(&before);
            }
        }
        if let Some(after_end) = n.checked_add(1).and_then(|next| self.0.remove(&next)) {
            end = after_end;
        }
        self.0.insert(start, end);
    }

    /// Forgets every number below `floor`: the floor answers for them now.
    fn cut_below(&mut self, floor: u64) {
        let below: Vec<(u64, u64)> = self
            .0
            .range(..floor)
            .map(|(&start, &end)| (start, end))
            .collect();
        for (start, end) in below {
            self.0.remove(&start);
            if end >= floor {
                self.0.insert(floor, end);
            }
        }
    }

    #[cfg(test)]
    fn len(&self) -> usize {
        self.0.len()
    }
}

/// One request ticket the page has not settled yet: its reply once its outcome arrives, and the
/// completion slot that reply holds until the page adopts it (none for an outcome that keeps no slot:
/// refused here or reported unsent).
struct Ticket {
    reply: Option<Reply>,
    slot: Option<ResultAdoption>,
    /// Since when the result has held its slot, once its reply is recorded: past `HOLD_DEADLINE`
    /// with no adoption or report, the connection ends with it (`watch`).
    held_since: Option<Instant>,
    /// The page gave the ticket up while its result was still on its way — its floor passed it — so
    /// the slot that result holds ends the connection, as a report would.
    abandoned: bool,
}

/// What the link knows of the page's tickets and owners: the open ones one by one, the settled and
/// finished ones at or above the page's floors as ranges. Below a floor nothing is kept: the floor
/// answers for every number there.
#[derive(Default)]
struct Book {
    open: BTreeMap<u64, Ticket>,
    adopted: Ranges,
    ended: Ranges,
    /// The oldest ticket the page may still name, as it last said (`PackageLink::request`).
    floor: u64,
    owners: HashMap<u64, Arc<Operation>>,
    finished: Ranges,
    /// The oldest operation owner the page has not finished, as it last said.
    owner_floor: u64,
    torn_down: bool,
}

impl Book {
    /// The page's floor rose to `floor`: a ticket below it is one the page is done with. One it never
    /// settled with the shell — its adoption, report or terminate never arrived — it gave up, so its
    /// held slot is handed back to end the connection with, and one still on its way is marked so
    /// its completion does.
    fn advance(&mut self, floor: u64) -> Vec<ResultAdoption> {
        if floor <= self.floor {
            return Vec::new();
        }
        self.floor = floor;
        let below: Vec<u64> = self.open.range(..floor).map(|(&n, _)| n).collect();
        let mut held = Vec::new();
        for n in below {
            let Some(ticket) = self.open.get_mut(&n) else {
                continue;
            };
            if ticket.reply.is_none() {
                ticket.abandoned = true;
                continue;
            }
            if let Some(slot) = ticket.slot.take() {
                held.push(slot);
            }
            self.open.remove(&n);
        }
        self.adopted.cut_below(floor);
        self.ended.cut_below(floor);
        held
    }

    /// The page's owner floor rose to `floor`: an owner below it is one the page finished, though
    /// its finish may not have arrived, and nothing below it is kept.
    fn advance_owners(&mut self, floor: u64) {
        if floor <= self.owner_floor {
            return;
        }
        self.owner_floor = floor;
        self.owners.retain(|&id, _| id >= floor);
        self.finished.cut_below(floor);
    }

    /// Whether the page has settled ticket `n` with the shell: below its floor, or recorded so.
    fn settled(&self, n: u64) -> bool {
        (n < self.floor && !self.open.contains_key(&n))
            || self.adopted.contains(n)
            || self.ended.contains(n)
    }
}

/// Ends the connection for a result that holds its slot past the link's hold deadline with no
/// adoption or report: the page that would release it has gone quiet, and the slot would stop the
/// session's other requests. Runs until the session's teardown, or until the link is gone.
fn watch(link: &Weak<PackageLink>, book: &Arc<(Mutex<Book>, Condvar)>) {
    let mut guard = lock(&book.0);
    loop {
        if guard.torn_down {
            return;
        }
        let Some(hold) = link.upgrade().map(|link| link.hold()) else {
            return;
        };
        let now = Instant::now();
        let expired: Vec<u64> = guard
            .open
            .iter()
            .filter(|(_, ticket)| ticket.slot.is_some())
            .filter(|(_, ticket)| ticket.held_since.is_some_and(|at| now >= at + hold))
            .map(|(&n, _)| n)
            .collect();
        if !expired.is_empty() {
            let mut held = Vec::new();
            for n in expired {
                if let Some(ticket) = guard.open.remove(&n) {
                    held.extend(ticket.slot);
                    guard.ended.insert(n);
                }
            }
            drop(guard);
            match link.upgrade() {
                Some(link) => link.end_with(held),
                None => return,
            }
            guard = lock(&book.0);
            continue;
        }
        // Until the oldest held result's deadline; with none held, a while, so a link that is
        // gone lets the thread go.
        let wait = guard
            .open
            .values()
            .filter(|ticket| ticket.slot.is_some())
            .filter_map(|ticket| ticket.held_since)
            .min()
            .map_or(hold, |at| (at + hold).saturating_duration_since(now));
        guard = book
            .1
            .wait_timeout(guard, wait.max(Duration::from_millis(1)))
            .map(|(guard, _)| guard)
            .unwrap_or_else(|p| p.into_inner().0);
    }
}

/// The number of a ticket the page issued (`request-<n>`, package-transport.ts), or none for any
/// other text.
fn ticket_number(ticket: &str) -> Option<u64> {
    let digits = ticket.strip_prefix("request-")?;
    let canonical = !digits.is_empty()
        && digits.bytes().all(|b| b.is_ascii_digit())
        && (digits == "0" || !digits.starts_with('0'));
    canonical.then(|| digits.parse().ok()).flatten()
}

/// The rejection of a request on a ticket the page has finished with — settled, given up, or one a
/// report arrived for before the request did. Nothing is sent for it, and it carries no evidence,
/// which is what the page's operation context takes a rejection for (K33): no record could tell the
/// truth about a request whose first submission this one is not.
pub const FINISHED: &str =
    "control-worker-gone: the request names a ticket the page has finished with";

/// The control package's request side of one session (module doc).
pub struct PackageLink {
    connection: OnceLock<Arc<Connection>>,
    /// A result the page could not take has ended the connection.
    ended: AtomicBool,
    /// `HOLD_DEADLINE` in milliseconds, which a case may shorten.
    hold_ms: AtomicU64,
    book: Arc<(Mutex<Book>, Condvar)>,
    counters: Arc<LinkCounters>,
    outbox: Arc<Outbox>,
}

impl PackageLink {
    /// The request side of the session whose ledger and notifications are `counters` and `outbox`.
    pub fn new(counters: Arc<LinkCounters>, outbox: Arc<Outbox>) -> PackageLink {
        PackageLink {
            connection: OnceLock::new(),
            ended: AtomicBool::new(false),
            hold_ms: AtomicU64::new(HOLD_DEADLINE.as_millis() as u64),
            book: Arc::new((Mutex::new(Book::default()), Condvar::new())),
            counters,
            outbox,
        }
    }

    /// The session's connection, once it is open: until then every request is refused unsent. From
    /// then on a thread of the link's own ends the connection for a result that holds its slot past
    /// `HOLD_DEADLINE` (`watch`); where that thread cannot start, a slot is released only by the
    /// page's calls, as before the deadline existed.
    pub fn attach(self: &Arc<Self>, connection: Arc<Connection>) {
        if self.connection.set(connection).is_err() {
            return;
        }
        let link = Arc::downgrade(self);
        let book = Arc::clone(&self.book);
        let _ = std::thread::Builder::new()
            .name("vd-package-hold".to_owned())
            .spawn(move || watch(&link, &book));
    }

    /// Shortens `HOLD_DEADLINE` for a case.
    #[cfg(test)]
    pub fn hold_for(&self, hold: Duration) {
        self.hold_ms
            .store(hold.as_millis() as u64, Ordering::SeqCst);
        self.book.1.notify_all();
    }

    fn hold(&self) -> Duration {
        Duration::from_millis(self.hold_ms.load(Ordering::SeqCst))
    }

    /// Whether a result the page could not take has ended the connection (`ENDED`).
    pub fn ended(&self) -> bool {
        self.ended.load(Ordering::SeqCst)
    }

    fn book(&self) -> MutexGuard<'_, Book> {
        lock(&self.book.0)
    }

    /// Ends the connection for results the page will not adopt, with their slots still held: an
    /// unadopted slot would stop every later request. Recorded first, so whatever the close makes
    /// fail is told by this end.
    fn end_with(&self, held: Vec<ResultAdoption>) {
        if held.is_empty() {
            return;
        }
        self.ended.store(true, Ordering::SeqCst);
        if let Some(connection) = self.connection.get() {
            connection.close(FATAL_TEARDOWN);
        }
        drop(held);
    }

    /// The owner `id`, made on first use: a cancel or a request may come first. None once finished,
    /// or once the session is being torn down.
    fn owner(&self, book: &mut Book, id: u64) -> Option<Arc<Operation>> {
        if book.torn_down || id < book.owner_floor || book.finished.contains(id) {
            return None;
        }
        if let Some(operation) = book.owners.get(&id) {
            return Some(Arc::clone(operation));
        }
        let made = self
            .connection
            .get()
            .and_then(|connection| connection.create_operation().ok())
            .map(Arc::new);
        match &made {
            Some(operation) => {
                book.owners.insert(id, Arc::clone(operation));
            }
            None => book.finished.insert(id),
        }
        made
    }

    /// Idempotent: stops owner `id`'s unsent requests; sent ones settle under their deadlines.
    pub fn cancel(&self, id: u64) {
        let operation = {
            let mut book = self.book();
            self.owner(&mut book, id)
        };
        if let Some(operation) = operation {
            operation.cancel();
        }
    }

    /// Releases owner `id` once its requests are consumed; no device I/O. A later request of it is
    /// refused unsent.
    pub fn finish(&self, id: u64) {
        let mut book = self.book();
        book.owners.remove(&id);
        if id >= book.owner_floor {
            book.finished.insert(id);
        }
    }

    /// Submits `call` for owner `operation` under `ticket` and waits for its outcome: the record,
    /// with the result's slot held until `adopt`. A write goes out through the unit's Console Lock
    /// gate, as every write of the session does. A resend of the ticket — Tauri sends a request
    /// again when the page could not read its reply — waits for the first one's reply and answers
    /// it, and sends nothing. `floor` is the oldest ticket the page may still name; a ticket below
    /// it, or one the page has settled, is rejected (`FINISHED`) and sends nothing. `owner_floor`
    /// is the oldest owner the page has not finished: one below it is finished, and its request is
    /// refused unsent.
    pub fn request(
        &self,
        operation: u64,
        ticket: &str,
        floor: u64,
        owner_floor: u64,
        call: Call<'_>,
    ) -> Result<Reply, String> {
        let method = call.method;
        let reply = |outcome| Reply {
            record: Record::of(method, outcome),
            held: None,
        };
        let Some(number) = ticket_number(ticket) else {
            return Ok(reply(refused(
                RequestCause::InvalidInput,
                RequestPhase::Validation,
            )));
        };
        let mut book = self.book();
        let given_up = book.advance(floor);
        book.advance_owners(owner_floor);
        let entry = if book.settled(number) || number < book.floor {
            Err(())
        } else if let std::collections::btree_map::Entry::Vacant(vacant) = book.open.entry(number) {
            vacant.insert(Ticket {
                reply: None,
                slot: None,
                held_since: None,
                abandoned: false,
            });
            Ok(Some(self.owner(&mut book, operation)))
        } else {
            Ok(None)
        };
        let owner = match entry {
            Err(()) => {
                drop(book);
                self.end_with(given_up);
                return Err(FINISHED.to_string());
            }
            // A resend: the first submission's reply, once there is one.
            Ok(None) => {
                drop(book);
                self.end_with(given_up);
                return self.reply_of(number);
            }
            Ok(Some(owner)) => {
                drop(book);
                self.end_with(given_up);
                owner
            }
        };
        let request = match call.request() {
            Ok(request) => request,
            Err(outcome) => return Ok(self.complete(number, reply(outcome))),
        };
        let (Some(connection), Some(owner)) = (self.connection.get(), owner) else {
            return Ok(self.complete(
                number,
                reply(refused(RequestCause::NotConnected, RequestPhase::Admission)),
            ));
        };
        let (tx, rx) = mpsc::channel::<Outcome>();
        let book = Arc::clone(&self.book);
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
            if !unsent {
                if let Some(ticket) = lock(&book.0).open.get_mut(&number) {
                    ticket.slot = Some(adoption);
                }
            }
            if tx.send(outcome).is_err() {
                // Nobody waits for the record: its slot is let go at once, so it cannot hold up
                // the connection's later requests.
                let taken = lock(&book.0)
                    .open
                    .get_mut(&number)
                    .and_then(|ticket| ticket.slot.take());
                if let Some(adoption) = taken {
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
        Ok(self.complete(
            number,
            Reply {
                record: Record::of(method, outcome),
                held,
            },
        ))
    }

    /// Records `reply` as ticket `number`'s and wakes a resend waiting for it. A ticket the page gave
    /// up while its result was on its way ends the connection with the slot it holds; one completing
    /// after the session's teardown lets its slot go, since no page will adopt it.
    fn complete(&self, number: u64, reply: Reply) -> Reply {
        let mut book = self.book();
        let mut given_up = Vec::new();
        let mut released = None;
        let torn_down = book.torn_down;
        if let Some(ticket) = book.open.get_mut(&number) {
            if ticket.abandoned || torn_down {
                let slot = ticket.slot.take();
                book.open.remove(&number);
                book.ended.insert(number);
                if torn_down {
                    released = slot;
                } else {
                    given_up.extend(slot);
                }
            } else {
                ticket.reply = Some(reply.clone());
                ticket.held_since = ticket.slot.is_some().then(Instant::now);
            }
        }
        drop(book);
        self.book.1.notify_all();
        if let Some(adoption) = released {
            adoption.adopt();
        }
        self.end_with(given_up);
        reply
    }

    /// The reply of open ticket `number`, once it has one: what a resend answers.
    fn reply_of(&self, number: u64) -> Result<Reply, String> {
        let mut book = self.book();
        loop {
            match book.open.get(&number) {
                Some(Ticket {
                    reply: Some(reply), ..
                }) => return Ok(reply.clone()),
                Some(Ticket {
                    abandoned: false, ..
                }) => {}
                _ => return Err(FINISHED.to_string()),
            }
            book = self.book.1.wait(book).unwrap_or_else(|p| p.into_inner());
        }
    }

    /// Releases the completion slot of `ticket`'s result once the page has validated it; no device
    /// I/O. True for any completed result: one that held no slot (refused, unsent, expired or
    /// ended) has nothing to release, and a resend of an adoption is answered as the adoption was.
    /// False for a ticket with no completed result, or one the page reported or that ended.
    pub fn adopt(&self, ticket: &str) -> bool {
        let Some(number) = ticket_number(ticket) else {
            return false;
        };
        let mut book = self.book();
        if book.adopted.contains(number)
            || (number < book.floor && !book.open.contains_key(&number))
        {
            return true;
        }
        let completed = matches!(
            book.open.get(&number),
            Some(Ticket {
                reply: Some(_),
                abandoned: false,
                ..
            })
        );
        if !completed {
            return false;
        }
        let slot = book.open.remove(&number).and_then(|ticket| ticket.slot);
        book.adopted.insert(number);
        drop(book);
        if let Some(adoption) = slot {
            adoption.adopt();
        }
        true
    }

    /// The page could not adopt `ticket`'s result: when it still holds a slot, the connection ends
    /// with the slot held, since an unadopted slot would stop every later request, and the
    /// session's link watch reports the end. A result still on its way is waited for first. A
    /// ticket the shell has not seen is recorded as ended, so a request on it that arrives later is
    /// refused before it is sent; false for it.
    pub fn fail_delivery(&self, ticket: &str) -> bool {
        self.end_for(ticket, false)
    }

    /// Ends the connection if, and only if, `ticket` still owns a slot not yet released; true
    /// otherwise as well, a ticket the shell has not seen recorded as ended as a report records it.
    pub fn terminate(&self, ticket: &str) -> bool {
        self.end_for(ticket, true)
    }

    fn end_for(&self, ticket: &str, unknown_is_done: bool) -> bool {
        let Some(number) = ticket_number(ticket) else {
            return unknown_is_done;
        };
        let mut book = self.book();
        let held = loop {
            if book.settled(number) {
                return true;
            }
            match book.open.get_mut(&number) {
                None => {
                    book.ended.insert(number);
                    return unknown_is_done;
                }
                // A result still on its way: the end has to take the slot it will hold. One the page
                // gave up meanwhile ends the connection as it completes.
                Some(Ticket {
                    reply: None,
                    abandoned,
                    ..
                }) => {
                    if *abandoned {
                        return true;
                    }
                    book = self.book.1.wait(book).unwrap_or_else(|p| p.into_inner());
                }
                Some(ticket) => {
                    let slot = ticket.slot.take();
                    book.open.remove(&number);
                    book.ended.insert(number);
                    break slot;
                }
            }
        };
        drop(book);
        self.end_with(held.into_iter().collect());
        true
    }

    /// The session is being let go (`super::stop`): nothing more is submitted, and while a package
    /// request is on its way or holds the wire slot — which the page that would adopt it no longer
    /// will — the connection's close is started from a thread of its own, outside the worker's
    /// queue, so a worker waiting behind it reaches its shutdown. A request completing after this
    /// lets its slot go (`complete`). Where no thread can be started, the held slots are let go
    /// instead, which frees the worker the same way.
    pub fn tear_down(&self) {
        self.book.1.notify_all();
        let (held, waiting): (Vec<ResultAdoption>, bool) = {
            let mut book = self.book();
            book.torn_down = true;
            let completed: Vec<u64> = book
                .open
                .iter()
                .filter(|(_, ticket)| ticket.reply.is_some())
                .map(|(&n, _)| n)
                .collect();
            let mut held = Vec::new();
            for n in completed {
                if let Some(slot) = book.open.remove(&n).and_then(|ticket| ticket.slot) {
                    held.push(slot);
                }
                book.ended.insert(n);
            }
            let waiting = !book.open.is_empty();
            (held, waiting)
        };
        if held.is_empty() && !waiting {
            return;
        }
        let Some(connection) = self.connection.get().cloned() else {
            return;
        };
        let held = Arc::new(Mutex::new(Some(held)));
        let closing = Arc::clone(&held);
        let started = std::thread::Builder::new()
            .name("vd-package-teardown".to_owned())
            .spawn(move || {
                connection.close(FATAL_TEARDOWN);
                drop(lock(&closing).take());
            });
        if started.is_err() {
            for adoption in lock(&held).take().into_iter().flatten() {
                adoption.adopt();
            }
        }
    }

    /// How many records the link keeps of tickets and of owners: what bounds it.
    #[cfg(test)]
    pub fn kept(&self) -> (usize, usize) {
        let book = self.book();
        (
            book.open.len() + book.adopted.len() + book.ended.len(),
            book.owners.len() + book.finished.len(),
        )
    }

    /// Whether the session's teardown has reached the link.
    #[cfg(test)]
    pub fn torn_down(&self) -> bool {
        self.book().torn_down
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
        let reply = link
            .request(
                1,
                "request-1",
                0,
                0,
                call(Method::GetNumeric, 1.0, "0", None),
            )
            .unwrap();
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
        assert!(
            link.adopt("request-1"),
            "a resend of the adoption is answered alike"
        );
        assert!(!link.fail_delivery("request-2"), "an unknown ticket");
        assert!(
            link.terminate("request-2"),
            "an unknown ticket owns no slot"
        );
    }

    #[test]
    fn a_resent_ticket_is_answered_with_its_first_reply() {
        let link = unattached();
        let first = link
            .request(
                1,
                "request-1",
                0,
                0,
                call(Method::GetNumeric, 1.0, "0", None),
            )
            .unwrap();
        let again = link
            .request(
                1,
                "request-1",
                0,
                0,
                call(Method::GetNumeric, 2.0, "0", None),
            )
            .unwrap();
        assert_eq!(again, first, "the record is the first call's");
        assert!(link.adopt("request-1"));
        assert_eq!(
            link.request(
                1,
                "request-1",
                0,
                0,
                call(Method::GetNumeric, 1.0, "0", None)
            ),
            Err(FINISHED.to_string()),
            "once adopted, a late resend is rejected and sends nothing"
        );
        assert_eq!(
            link.request(
                1,
                "request-1",
                2,
                0,
                call(Method::GetNumeric, 1.0, "0", None)
            ),
            Err(FINISHED.to_string()),
            "and so below the page's floor"
        );
    }

    #[test]
    fn a_ticket_the_page_did_not_issue_is_refused_unsent_and_recorded_nowhere() {
        let link = unattached();
        for ticket in [
            "",
            "request-",
            "request-01",
            "request--1",
            "ticket-1",
            "request-1x",
        ] {
            let reply = link
                .request(1, ticket, 0, 0, call(Method::GetNumeric, 1.0, "0", None))
                .unwrap();
            assert_eq!(
                json_of(reply.record)["failure"],
                json!({ "kind": "cause", "code": "invalid_input", "phase": "validation" }),
                "{ticket:?}"
            );
        }
        assert_eq!(link.kept(), (0, 0));
    }

    // What the link keeps does not grow with the number of operations: settled tickets and finished
    // owners are ranges, so one owner or one ticket left open keeps only itself.
    #[test]
    fn what_the_link_keeps_does_not_grow_with_the_operations_run() {
        let read = |link: &PackageLink, op: u64, n: u64, floor: u64, owners: u64| {
            link.request(
                op,
                &format!("request-{n}"),
                floor,
                owners,
                call(Method::GetNumeric, 1.0, "0", None),
            )
            .unwrap()
        };
        // One by one, each adopted and finished.
        let link = unattached();
        for n in 1..=100u64 {
            read(&link, n, n, n, 0);
            assert!(link.adopt(&format!("request-{n}")));
            link.finish(n);
        }
        assert_eq!(link.kept(), (1, 1));
        // One owner and one ticket left open ahead of 100 others.
        let link = unattached();
        read(&link, 1, 1, 1, 0);
        for n in 2..=101u64 {
            read(&link, n, n, 1, 0);
            assert!(link.adopt(&format!("request-{n}")));
            link.finish(n);
        }
        let (tickets, owners) = link.kept();
        assert!(
            tickets <= 2 && owners <= 2,
            "{tickets} tickets, {owners} owners"
        );
        // Owners that send nothing, only finished.
        let link = unattached();
        for n in 1..=100u64 {
            link.finish(n);
        }
        assert_eq!(link.kept(), (0, 1));
        // A request of a finished owner, or on a settled ticket, sends nothing.
        let finished = link
            .request(
                7,
                "request-1",
                0,
                0,
                call(Method::GetNumeric, 1.0, "0", None),
            )
            .unwrap();
        assert_eq!(
            json_of(finished.record)["failure"],
            json!({ "kind": "cause", "code": "not_connected", "phase": "admission" })
        );
        // Tickets the page refused itself, which never reach the shell, and owners of another
        // connection leave gaps: the page's floors close them.
        let link = unattached();
        for n in (1..=200u64).step_by(2) {
            read(&link, n, n, n, n);
            assert!(link.adopt(&format!("request-{n}")));
            link.finish(n);
        }
        assert_eq!(link.kept(), (1, 1));
        // Owners whose finish was lost are gone once the page's owner floor passes them.
        let link = unattached();
        for n in 1..=100u64 {
            read(&link, n, n, n, n);
            assert!(link.adopt(&format!("request-{n}")));
            if n % 2 == 0 {
                link.finish(n);
            }
        }
        assert_eq!(link.kept(), (1, 1));
        let below = read(&link, 99, 101, 101, 100);
        assert_eq!(
            json_of(below.record)["failure"],
            json!({ "kind": "cause", "code": "not_connected", "phase": "admission" }),
            "an owner below the floor is finished"
        );
        assert_eq!(
            link.request(
                1,
                "request-50",
                101,
                100,
                call(Method::GetNumeric, 1.0, "0", None)
            ),
            Err(FINISHED.to_string()),
            "a ticket below the floor is finished, with nothing kept of it"
        );
        assert!(link.adopt("request-50") && link.terminate("request-50"));
        assert_eq!(link.kept(), (1, 1), "and a late call on it keeps nothing");
    }

    #[test]
    fn ranges_merge_as_they_fill() {
        let mut ranges = Ranges::default();
        for n in [5, 3, 4, 1, u64::MAX, 2, u64::MAX - 1] {
            ranges.insert(n);
        }
        assert_eq!(ranges.len(), 2);
        assert!((1..=5).all(|n| ranges.contains(n)));
        assert!(!ranges.contains(0) && !ranges.contains(6));
        assert!(ranges.contains(u64::MAX) && ranges.contains(u64::MAX - 1));
        ranges.insert(3);
        assert_eq!(ranges.len(), 2, "an insert of a member changes nothing");
    }

    #[test]
    fn ranges_forget_what_is_below_a_floor() {
        let mut ranges = Ranges::default();
        for n in [1, 2, 3, 5, 7, 8, 9] {
            ranges.insert(n);
        }
        ranges.cut_below(8);
        assert_eq!(ranges.len(), 1);
        assert!(!(1..8).any(|n| ranges.contains(n)));
        assert!(ranges.contains(8) && ranges.contains(9));
        ranges.cut_below(u64::MAX);
        assert_eq!(ranges.len(), 0);
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
