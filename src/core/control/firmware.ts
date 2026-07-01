// The validated-firmware gate: the app's parameter catalog and routing rules were
// confirmed against one specific URX System firmware version. A unit reporting a
// different System version may not behave as the app expects, so read / write /
// live-sync warn the user (and let them proceed or stop) before touching it.

/**
 * The System firmware version this build was validated against. A connected unit
 * reporting a different System version triggers the mismatch warning. Empty
 * disables the gate entirely (e.g. before a validated version has been recorded).
 */
export const SUPPORTED_SYSTEM_FIRMWARE = "1.3.0.1";

/**
 * Whether the connected unit's System firmware differs from the validated version
 * and the user should be warned. The gate is skipped (returns false) when either
 * side is empty: an unset baseline, or a device that reports no firmware version.
 */
export function firmwareMismatch(deviceFirmware: string): boolean {
  if (!SUPPORTED_SYSTEM_FIRMWARE || !deviceFirmware) return false;
  return deviceFirmware !== SUPPORTED_SYSTEM_FIRMWARE;
}
