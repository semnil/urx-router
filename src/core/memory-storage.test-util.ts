// Shared test stub: minimal spec-shaped localStorage over a Map, for node-env
// tests of the storage-backed modules (settings, recent plans, the guarded JSON
// helpers). Not a test file itself (vitest collects only *.test.ts), so suites
// import it instead of re-declaring the stub. `throwOnWrite` simulates a browser
// in private mode / at quota where setItem raises — the real failure mode the
// guarded helpers are meant to absorb.

import { beforeEach, afterEach } from "vitest";

export class MemoryStorage {
  private map = new Map<string, string>();
  throwOnWrite = false;
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    if (this.throwOnWrite) throw new DOMException("quota", "QuotaExceededError");
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

/** Install a fresh stub as globalThis.localStorage around every test in the
 *  calling suite; the returned accessor reads the current one. */
export function installMemoryStorage(): () => MemoryStorage {
  const g = globalThis as { localStorage?: Storage };
  let store = new MemoryStorage();
  beforeEach(() => {
    store = new MemoryStorage();
    g.localStorage = store as unknown as Storage;
  });
  afterEach(() => {
    delete g.localStorage;
  });
  return () => store;
}
