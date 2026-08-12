/**
 * Launch flags the race fake never claims, in one place because two sides read it.
 *
 * `fake-device.ts` answers every one of these `false`, and a unit guard
 * (`src/main.device.test.ts`) asserts that `experimental_enabled` is among them —
 * `e2e/race/t3b-undo.spec.ts` skips its `.urxf` case on the settings import being
 * unreachable from this harness, and that rests on the answer staying false.
 *
 * A separate module rather than an export from `fake-device.ts` so the guard can import
 * it: the fake pulls in Playwright's own types, and the src build's tsconfig would then
 * have to compile those too. **Keep this file free of imports.** It is already in that
 * build's program (a src test imports it), so one type import from the E2E side puts
 * back exactly what splitting it out avoided — and nothing enforces that but this line.
 */
export const FAKE_LAUNCH_FLAGS_OFF = [
  "experimental_enabled",
  "self_test_requested",
  "reset_storage_requested",
] as const;
