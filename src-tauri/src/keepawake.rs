// Keep the computer awake while the app is open (Preferences > Computer sleep).
// Both platforms suppress only the *idle* timer — a lid close or an explicit
// Sleep still works — and both holds are process-scoped, so quitting or crashing
// releases them.
//
// The calls are local OS APIs with no round-trip, so the command stays
// synchronous, like the MIDI bridge.

use std::sync::Mutex;

/// The held suppression, as Tauri state. The handle shape is the backend's, so
/// each platform names its own `Hold`, and releasing it is its `Drop`.
#[derive(Default)]
pub struct KeepAwakeState {
    held: Mutex<Option<imp::Hold>>,
}

/// Turn the suppression on or off. Idempotent: a second `true` keeps the
/// existing hold rather than stacking one the release path would not know about.
pub fn set(state: &KeepAwakeState, on: bool) -> Result<(), String> {
    let mut held = state.held.lock().unwrap();
    if on {
        if held.is_none() {
            *held = Some(imp::acquire()?);
        }
    } else {
        *held = None;
    }
    Ok(())
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
    const NAME: &str = "URX Router is open";

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
                return Err(format!("IOPMAssertionCreateWithName failed ({rc})"));
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
    const REASON: &str = "URX Router is open";

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
            return Err("PowerCreateRequest failed".into());
        }
        let hold = Hold(handle as usize);
        for request_type in TYPES {
            // `hold` drops on the way out, clearing and closing the request.
            if unsafe { PowerSetRequest(handle, request_type) } == 0 {
                return Err("PowerSetRequest failed".into());
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
        Err("keeping the computer awake is not supported on this platform".into())
    }
}
