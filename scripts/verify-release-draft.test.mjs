// Pins the release-draft verifier against the arrangement it must refuse beside the one it
// must pass. The calibration arm runs the genuine v1.18.2 manifest — the sample beside this
// file — under the project's own public key, so the verifier is held to real tauri output
// and a parser that passed only hand-built fixtures would still fail here. The rest builds
// its own Ed25519 key, signs a manifest the way a release does, and mutates one thing at a
// time: a parser that waved any of these through would wave through a broken release.

import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { verifyReleaseDraft } from "./verify-release-draft.mjs";

const samplePath = fileURLToPath(new URL("./verify-release-draft.sample.json", import.meta.url));
const scriptPath = fileURLToPath(new URL("./verify-release-draft.mjs", import.meta.url));
const realPubkey = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).plugins.updater.pubkey;

function keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const der = publicKey.export({ format: "der", type: "spki" });
  return { privateKey, rawPub: der.subarray(der.length - 32), keyId: crypto.randomBytes(8) };
}

function pubkeyField(keyId, rawPub) {
  const line = Buffer.concat([Buffer.from("Ed", "latin1"), keyId, rawPub]).toString("base64");
  return Buffer.from(`untrusted comment: minisign public key\n${line}\n`, "utf8").toString("base64");
}

function signatureField({ privateKey, keyId, version, file = "URX Router.app.tar.gz" }) {
  const head = Buffer.concat([Buffer.from("ED", "latin1"), keyId, crypto.randomBytes(64)]);
  const trusted = `timestamp:0\tfile:${file}\tversion:${version}`;
  const globalSig = crypto.sign(null, Buffer.concat([head.subarray(10, 74), Buffer.from(trusted, "utf8")]), privateKey);
  const text = `untrusted comment: test\n${head.toString("base64")}\ntrusted comment: ${trusted}\n${globalSig.toString("base64")}\n`;
  return Buffer.from(text, "utf8").toString("base64");
}

function tamperTrusted(field, newTrusted) {
  const lines = Buffer.from(field, "base64").toString("utf8").split("\n");
  lines[2] = `trusted comment: ${newTrusted}`;
  return Buffer.from(lines.join("\n"), "utf8").toString("base64");
}

const latestWith = (version, signatures) => ({
  version,
  platforms: Object.fromEntries(signatures.map((s, i) => [`platform-${i}`, { signature: s }])),
});

// Malformations the downstream client refuses at parse time: a signature the verifier must
// refuse too, or it passes a draft every installed client rejects.
function editSig(field, fn) {
  const lines = Buffer.from(field, "base64").toString("utf8").split("\n");
  fn(lines);
  return Buffer.from(lines.join("\n"), "utf8").toString("base64");
}
const corruptAlgorithm = (field) =>
  editSig(field, (lines) => {
    const raw = Buffer.from(lines[1], "base64");
    raw[0] = "X".charCodeAt(0);
    raw[1] = "X".charCodeAt(0);
    lines[1] = raw.toString("base64");
  });
const appendSigByte = (field) =>
  editSig(field, (lines) => {
    lines[1] = Buffer.concat([Buffer.from(lines[1], "base64"), Buffer.from([0])]).toString("base64");
  });
const dropTrustedPrefix = (field) =>
  editSig(field, (lines) => {
    lines[2] = lines[2].replace(/^trusted comment: /, "");
  });

// Runs the CLI the workflow's verify-draft step runs, reading tauri.conf.json and
// package.json from its working directory as the job's checkout gives them.
function runCli(latest, { tag = "v1.18.2", version = "1.18.2" } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vrd-"));
  mkdirSync(join(dir, "src-tauri"));
  mkdirSync(join(dir, "draft"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ version }));
  writeFileSync(
    join(dir, "src-tauri/tauri.conf.json"),
    JSON.stringify({ plugins: { updater: { pubkey: realPubkey } } }),
  );
  writeFileSync(join(dir, "draft/latest.json"), JSON.stringify(latest));
  return spawnSync(process.execPath, [scriptPath, "--tag", tag, "--latest", "draft/latest.json"], {
    cwd: dir,
    encoding: "utf8",
  });
}

describe("verifyReleaseDraft", () => {
  it("passes the genuine v1.18.2 manifest under the project public key", () => {
    const latest = JSON.parse(readFileSync(samplePath, "utf8"));
    expect(verifyReleaseDraft({ tag: "v1.18.2", latest, pubkey: realPubkey, packageVersion: "1.18.2" })).toEqual([]);
  });

  it("passes a consistent, authentic draft", () => {
    const k = keypair();
    const latest = latestWith("1.18.3", [signatureField({ ...k, version: "1.18.3" })]);
    expect(
      verifyReleaseDraft({ tag: "v1.18.3", latest, pubkey: pubkeyField(k.keyId, k.rawPub), packageVersion: "1.18.3" }),
    ).toEqual([]);
  });

  it("fails when latest.json version does not match the tag", () => {
    const k = keypair();
    const latest = latestWith("1.18.2", [signatureField({ ...k, version: "1.18.2" })]);
    const errors = verifyReleaseDraft({
      tag: "v1.18.3",
      latest,
      pubkey: pubkeyField(k.keyId, k.rawPub),
      packageVersion: "1.18.3",
    });
    expect(errors.join("\n")).toMatch(/latest.json version/);
  });

  it("fails when package.json version does not match the tag", () => {
    const k = keypair();
    const latest = latestWith("1.18.3", [signatureField({ ...k, version: "1.18.3" })]);
    const errors = verifyReleaseDraft({
      tag: "v1.18.3",
      latest,
      pubkey: pubkeyField(k.keyId, k.rawPub),
      packageVersion: "1.18.2",
    });
    expect(errors.join("\n")).toMatch(/package.json version/);
  });

  it("fails when the manifest names no platforms", () => {
    const k = keypair();
    const errors = verifyReleaseDraft({
      tag: "v1.18.3",
      latest: latestWith("1.18.3", []),
      pubkey: pubkeyField(k.keyId, k.rawPub),
      packageVersion: "1.18.3",
    });
    expect(errors.join("\n")).toMatch(/no platforms/);
  });

  it("fails when a platform has no signature", () => {
    const k = keypair();
    const latest = { version: "1.18.3", platforms: { "darwin-aarch64": {} } };
    const errors = verifyReleaseDraft({
      tag: "v1.18.3",
      latest,
      pubkey: pubkeyField(k.keyId, k.rawPub),
      packageVersion: "1.18.3",
    });
    expect(errors.join("\n")).toMatch(/no signature/);
  });

  it("fails when a signature is from another key", () => {
    const k = keypair();
    const foreign = signatureField({ privateKey: k.privateKey, keyId: crypto.randomBytes(8), version: "1.18.3" });
    const latest = latestWith("1.18.3", [foreign]);
    const errors = verifyReleaseDraft({
      tag: "v1.18.3",
      latest,
      pubkey: pubkeyField(k.keyId, k.rawPub),
      packageVersion: "1.18.3",
    });
    expect(errors.join("\n")).toMatch(/signed by key/);
  });

  it("fails when the trusted comment was edited after signing", () => {
    const k = keypair();
    const field = signatureField({ ...k, version: "1.18.3" });
    const edited = tamperTrusted(field, "timestamp:0\tfile:x\tversion:1.18.3");
    const latest = latestWith("1.18.3", [edited]);
    const errors = verifyReleaseDraft({
      tag: "v1.18.3",
      latest,
      pubkey: pubkeyField(k.keyId, k.rawPub),
      packageVersion: "1.18.3",
    });
    expect(errors.join("\n")).toMatch(/not authentic/);
  });

  it("fails when a signature's trusted-comment version does not match the tag", () => {
    const k = keypair();
    const latest = latestWith("1.18.3", [signatureField({ ...k, version: "9.9.9" })]);
    const errors = verifyReleaseDraft({
      tag: "v1.18.3",
      latest,
      pubkey: pubkeyField(k.keyId, k.rawPub),
      packageVersion: "1.18.3",
    });
    expect(errors.join("\n")).toMatch(/trusted-comment version 9.9.9/);
  });

  it("fails a signature whose algorithm identifier is corrupted — the client refuses it", () => {
    const k = keypair();
    const latest = latestWith("1.18.3", [corruptAlgorithm(signatureField({ ...k, version: "1.18.3" }))]);
    const errors = verifyReleaseDraft({
      tag: "v1.18.3",
      latest,
      pubkey: pubkeyField(k.keyId, k.rawPub),
      packageVersion: "1.18.3",
    });
    expect(errors.join("\n")).toMatch(/algorithm/);
  });

  it("fails a signature line that carries extra bytes — the client refuses it", () => {
    const k = keypair();
    const latest = latestWith("1.18.3", [appendSigByte(signatureField({ ...k, version: "1.18.3" }))]);
    const errors = verifyReleaseDraft({
      tag: "v1.18.3",
      latest,
      pubkey: pubkeyField(k.keyId, k.rawPub),
      packageVersion: "1.18.3",
    });
    expect(errors.join("\n")).toMatch(/74/);
  });

  it("fails a trusted comment line with no prefix — the client refuses it", () => {
    const k = keypair();
    const latest = latestWith("1.18.3", [dropTrustedPrefix(signatureField({ ...k, version: "1.18.3" }))]);
    const errors = verifyReleaseDraft({
      tag: "v1.18.3",
      latest,
      pubkey: pubkeyField(k.keyId, k.rawPub),
      packageVersion: "1.18.3",
    });
    expect(errors.join("\n")).toMatch(/trusted comment/);
  });
});

// The step the workflow runs is `node scripts/verify-release-draft.mjs`, so the finding's
// completion condition — genuine accepted, each malformation non-zero — is asked of the
// program, over the genuine v1.18.2 manifest and the same malformations on its own signature.
describe("verify-release-draft CLI", () => {
  const sample = () => JSON.parse(readFileSync(samplePath, "utf8"));

  it("exits 0 on the genuine manifest", () => {
    const run = runCli(sample());
    expect(run.status, run.stderr).toBe(0);
  });

  for (const [name, mutate] of [
    ["a corrupted algorithm identifier", corruptAlgorithm],
    ["extra bytes on the signature line", appendSigByte],
    ["a trusted comment with no prefix", dropTrustedPrefix],
  ]) {
    it(`exits non-zero on ${name}`, () => {
      const latest = sample();
      const [first] = Object.keys(latest.platforms);
      latest.platforms[first].signature = mutate(latest.platforms[first].signature);
      expect(runCli(latest).status).not.toBe(0);
    });
  }
});
