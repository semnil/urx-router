// Hold off the computer's idle sleep on request (Preferences > Computer sleep).
// The scope belongs to the caller, which holds it for a Live sync session, so this
// module only takes and releases what it is asked for.
// Both platforms suppress only the *idle* timer — a lid close or an explicit
// Sleep still works — and both holds are process-scoped, so quitting or crashing
// releases them.
//
// The calls are local OS APIs with no round-trip, so the command stays
// synchronous, like the MIDI bridge.
//
// A refusal returns a stable kebab-case code the frontend localizes (src/i18n
// error.shell): keep-awake-failed (with the failing OS call as the detail) or
// keep-awake-unsupported.

use std::sync::Mutex;

/// The held suppression, as Tauri state. The handle shape is the backend's, so
/// each platform names its own `Hold`, and releasing it is its `Drop`.
#[derive(Default)]
pub struct KeepAwakeState {
    /// The hold, with the label of the webview that took it — a page load may release
    /// what that page holds and nothing else.
    held: Mutex<Option<(String, imp::Hold)>>,
}

/// Turn the suppression on or off. Idempotent: a second `true` keeps the
/// existing hold rather than stacking one the release path would not know about.
pub fn set(state: &KeepAwakeState, owner: &str, on: bool) -> Result<(), String> {
    let mut held = state.held.lock().unwrap();
    if on {
        if held.is_none() {
            *held = Some((owner.to_string(), imp::acquire()?));
        }
    } else if held.as_ref().is_some_and(|(who, _)| who == owner) {
        // Released only by the webview that took it — the same rule the page-load
        // teardown already applies, retrofitted onto the direct command. Without it a
        // second webview could drop main's hold mid-Live-sync while main's UI went on
        // asserting one; and the inverse, a second caller's `on` recorded under MAIN's
        // label, meant main's next reload released a hold the other still wanted.
        *held = None;
    }
    Ok(())
}

/// Release the hold only if `label` is the webview that took it. A page load ends
/// what that page was holding; another page's load is not its business (see
/// `vd::shutdown_owned_by` for the same rule on the device session).
pub fn release_owned_by(state: &KeepAwakeState, label: &str) {
    let mut held = state.held.lock().unwrap();
    if held.as_ref().is_some_and(|(owner, _)| owner == label) {
        *held = None;
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use core_foundation::base::TCFType;
    use core_foundation::string::{CFString, CFStringRef};

    // kIOPMAssertionLevelOn / kIOReturnSuccess.
    const LEVEL_ON: u32 = 255;
    const SUCCESS: i32 = 0;

    // A display assertion implies the system stays awake, but the app asks for
    // both, so it asserts both — each shows under its own name in
    // `pmset -g assertions`.
    const TYPES: [&str; 2] = ["PreventUserIdleSystemSleep", "PreventUserIdleDisplaySleep"];
    const NAME: &str = "URX Router Live sync is running";

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            level: u32,
            name: CFStringRef,
            id: *mut u32,
        ) -> i32;
        fn IOPMAssertionRelease(id: u32) -> i32;
    }

    /// The live assertion ids, one per entry in TYPES.
    pub struct Hold(Vec<u32>);

    impl Drop for Hold {
        fn drop(&mut self) {
            for id in self.0.drain(..) {
                unsafe { IOPMAssertionRelease(id) };
            }
        }
    }

    pub fn acquire() -> Result<Hold, String> {
        let name = CFString::new(NAME);
        let mut hold = Hold(Vec::with_capacity(TYPES.len()));
        for kind in TYPES {
            let kind = CFString::new(kind);
            let mut id: u32 = 0;
            let rc = unsafe {
                IOPMAssertionCreateWithName(
                    kind.as_concrete_TypeRef(),
                    LEVEL_ON,
                    name.as_concrete_TypeRef(),
                    &mut id,
                )
            };
            // Dropping `hold` on the way out releases whatever was already
            // taken, so a partial acquire never survives as a half hold.
            if rc != SUCCESS {
                return Err(format!(
                    "keep-awake-failed: IOPMAssertionCreateWithName {rc}"
                ));
            }
            hold.0.push(id);
        }
        Ok(hold)
    }
}

#[cfg(target_os = "windows")]
mod imp {
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::Power::{
        PowerClearRequest, PowerCreateRequest, PowerRequestDisplayRequired,
        PowerRequestSystemRequired, PowerSetRequest, POWER_REQUEST_TYPE,
    };
    use windows_sys::Win32::System::Threading::{
        POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
    };

    const TYPES: [POWER_REQUEST_TYPE; 2] =
        [PowerRequestSystemRequired, PowerRequestDisplayRequired];

    // The reason shown beside the request in `powercfg /requests`.
    const REASON: &str = "URX Router Live sync is running";

    /// The power request handle, carried as a usize so the state stays Send.
    pub struct Hold(usize);

    impl Drop for Hold {
        fn drop(&mut self) {
            let handle = self.0 as HANDLE;
            // Clearing a type that was never set answers FALSE and changes
            // nothing, which is what the partial-acquire path relies on.
            for request_type in TYPES {
                unsafe { PowerClearRequest(handle, request_type) };
            }
            unsafe { CloseHandle(handle) };
        }
    }

    pub fn acquire() -> Result<Hold, String> {
        // The reason string only has to outlive the create call, which copies it.
        let reason: Vec<u16> = REASON.encode_utf16().chain(std::iter::once(0)).collect();
        let context = REASON_CONTEXT {
            Version: 0,
            Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
            Reason: REASON_CONTEXT_0 {
                SimpleReasonString: reason.as_ptr() as *mut u16,
            },
        };
        let handle = unsafe { PowerCreateRequest(&context) };
        if handle.is_null() || handle as isize == -1 {
            return Err("keep-awake-failed: PowerCreateRequest".into());
        }
        let hold = Hold(handle as usize);
        for request_type in TYPES {
            // `hold` drops on the way out, clearing and closing the request.
            if unsafe { PowerSetRequest(handle, request_type) } == 0 {
                return Err("keep-awake-failed: PowerSetRequest".into());
            }
        }
        Ok(hold)
    }
}

// Neither shipped platform. Refusing keeps the UI's report honest — succeeding
// would show a suppression the OS never took.
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
mod imp {
    pub struct Hold;

    pub fn acquire() -> Result<Hold, String> {
        Err("keep-awake-unsupported".into())
    }
}

// Only on the two platforms that can actually take a hold: elsewhere `acquire`
// refuses by design, and a test that asserted on that would be testing the refusal.
// The hold taken here is real (an IOKit assertion / a power request) and is released
// by the Drop this exercises, so the process leaves nothing behind either way.
#[cfg(all(test, any(target_os = "macos", target_os = "windows")))]
mod tests {
    use super::{release_owned_by, set, KeepAwakeState};

    // The app has two webviews and one hold. A page load ends what THAT page holds —
    // the same rule as the device session's, which is what the second window's load
    // used to break. This one has no test of its own without a real acquire, which is
    // why it is guarded above rather than faked.
    #[test]
    fn a_page_load_releases_only_the_hold_that_page_took() {
        let state = KeepAwakeState::default();
        set(&state, "main", true).expect("the hold must be available to test the release");

        release_owned_by(&state, "midi");
        assert!(
            state.held.lock().unwrap().is_some(),
            "another window's load leaves this hold alone"
        );

        release_owned_by(&state, "main");
        assert!(
            state.held.lock().unwrap().is_none(),
            "its own page load releases it, as it always did"
        );
    }

    // The direct command took the same rule on, later. Without it a second webview
    // could drop main's hold mid-Live-sync while main's UI went on asserting one.
    #[test]
    fn only_the_owner_can_release_the_hold_through_the_command() {
        let state = KeepAwakeState::default();
        set(&state, "main", true).expect("the hold must be available to test the release");

        set(&state, "midi", false).expect("a non-owner's release is a no-op, not an error");
        assert!(
            state.held.lock().unwrap().is_some(),
            "another window's set(false) leaves this hold alone"
        );

        set(&state, "main", false).expect("the owner releases its own hold");
        assert!(state.held.lock().unwrap().is_none());
    }
}
