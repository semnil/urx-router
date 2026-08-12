/**
 * Launch flags the race fake never claims, in one place because two sides read it.
 *
 * `fake-device.ts` answers every one of these `false`, and a unit guard
 * (`src/main.device.test.ts`) asserts that `experimental_enabled` is among them —
 * `e2e/race/t3b-undo.spec.ts` skips its `.urxf` case on the settings import being
 * unreachable from this harness, and that rests on the answer staying false.
 *
 * A separate module rather than an export from `fake-device.ts` so the guard can
 * import it: the fake pulls in `@playwright/test`, and the src build's tsconfig would
 * then have to compile that too. Nothing is imported here, deliberately.
 */
export const FAKE_LAUNCH_FLAGS_OFF = [
  "experimental_enabled",
  "self_test_requested",
  "reset_storage_requested",
] as const;
