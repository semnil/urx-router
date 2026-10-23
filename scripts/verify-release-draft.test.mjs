// Pins the release-draft verifier against the arrangement it must refuse beside the one it
// must pass. The calibration arm runs the genuine v1.18.2 manifest — the sample beside this
// file — under the project's own public key, so the verifier is held to real tauri output
// and a parser that passed only hand-built fixtures would still fail here. The rest builds
// its own Ed25519 key, signs a manifest the way a release does, and mutates one thing at a
// time: a parser that waved any of these through would wave through a broken release.

import { describe, expect, it } from "vitest";
import crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { verifyReleaseDraft } from "./verify-release-draft.mjs";

const samplePath = fileURLToPath(new URL("./verify-release-draft.sample.json", import.meta.url));
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
});
