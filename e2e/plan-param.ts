import { deflateRawSync, inflateRawSync } from "node:zlib";

// Shared ?plan= codec helpers for the deep-link specs. Kept independent from
// src/core/plan.ts on purpose: the Node-zlib mirror doubles as interop
// coverage of the wire format the app's CompressionStream codec speaks.

// URL-safe base64 of a plan's JSON — the legacy uncompressed ?plan= encoding.
// Links emitted before compression landed use this form and must keep loading.
export function planParam(plan: unknown): string {
  return Buffer.from(JSON.stringify(plan), "utf8").toString("base64url");
}

// The current compressed encoding: "z" + URL-safe base64 of the raw-deflated
// JSON (matches encodePlanParam in core/plan.ts).
export function planParamZ(plan: unknown): string {
  return "z" + deflateRawSync(Buffer.from(JSON.stringify(plan), "utf8")).toString("base64url");
}

// Decode a ?plan= param the app emitted (the compressed z format only — the
// app never emits legacy params anymore).
export function decodeParam(param: string): string {
  if (!param.startsWith("z")) throw new Error(`expected a compressed z param, got: ${param.slice(0, 8)}…`);
  return inflateRawSync(Buffer.from(param.slice(1), "base64url")).toString("utf8");
}
