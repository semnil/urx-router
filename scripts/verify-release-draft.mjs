// Verifies a release draft's updater manifest before a human publishes it.
//
// tag-release.yml tags the merge of a version-bump pull request and release.yml builds the
// draft Release: the installers, one minisign signature per updater bundle, and a
// `latest.json` the updater reads. An installed client offers an update only when
// `latest.json`'s `version` is higher than its own, and it accepts the download only when
// the signature verifies under the public key in `src-tauri/tauri.conf.json`. So a draft
// whose `latest.json` `version` and whose signatures' trusted-comment `version:` disagree,
// or whose signatures are not this project's key, is one every installed client refuses —
// a broken release that looks complete.
//
// This is the check that used to be a line in every release pull request's body asking the
// operator to read the draft before publishing. It reads the same thing by machine: the
// `version` agrees across the tag, `package.json`, `latest.json` and every signature's
// trusted comment, and each signature's trusted comment is authentic under the public key.
//
// It verifies the GLOBAL signature — minisign's second signature, which covers the trusted
// comment and so the `version:` field in it — with Node's own Ed25519. That needs no
// bundle download: the trusted comment is what carries the version, and its authenticity is
// what says the version was not edited after signing. The file signature (the first one,
// over the bundle itself) is the client's to check against the bundle it downloads, and is
// out of scope here.

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

/** A minisign public key or signature line decodes to a 2-byte algorithm, an 8-byte key id
 *  and the key or signature bytes. */
function decodeKeyline(b64) {
  const raw = Buffer.from(b64, "base64");
  return { algorithm: raw.subarray(0, 2).toString("latin1"), keyId: raw.subarray(2, 10), rest: raw.subarray(10) };
}

/** The `pubkey` in tauri.conf.json is base64 over the two-line minisign public-key file;
 *  the second line carries the key. */
export function parsePublicKey(pubkeyField) {
  const text = Buffer.from(pubkeyField, "base64").toString("utf8");
  const keyLine = text.split("\n")[1];
  if (!keyLine) throw new Error("public key has no key line");
  const { keyId, rest } = decodeKeyline(keyLine);
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), rest.subarray(0, 32)]);
  return { keyId, key: crypto.createPublicKey({ key: spki, format: "der", type: "spki" }) };
}

/** A latest.json signature is base64 over the four-line minisign signature file: an
 *  untrusted comment, the file signature, the trusted comment, and the global signature
 *  over the file signature followed by the trusted comment's text. */
export function parseSignature(signatureField) {
  const text = Buffer.from(signatureField, "base64").toString("utf8");
  const lines = text.split("\n");
  if (lines.length < 4) throw new Error("signature is not a minisign signature");
  const { keyId, rest } = decodeKeyline(lines[1]);
  const trusted = lines[2].replace(/^trusted comment: /, "");
  const version = Object.fromEntries(
    trusted.split("\t").map((f) => [f.slice(0, f.indexOf(":")), f.slice(f.indexOf(":") + 1)]),
  ).version;
  return {
    keyId,
    fileSignature: rest.subarray(0, 64),
    trusted,
    version,
    globalSignature: Buffer.from(lines[3], "base64"),
  };
}

/** Returns the reasons the draft is not a releasable manifest; an empty array means it is.
 *  Collects every reason rather than stopping at the first, so one run names all of them. */
export function verifyReleaseDraft({ tag, latest, pubkey, packageVersion }) {
  const errors = [];
  const expected = String(tag).replace(/^v/, "");

  if (packageVersion !== expected) errors.push(`package.json version ${packageVersion} does not match tag ${tag}`);
  if (latest?.version !== expected) errors.push(`latest.json version ${latest?.version} does not match tag ${tag}`);

  const platforms = latest?.platforms ?? {};
  const names = Object.keys(platforms);
  if (names.length === 0) errors.push("latest.json names no platforms");

  const key = parsePublicKey(pubkey);
  for (const name of names) {
    const field = platforms[name]?.signature;
    if (!field) {
      errors.push(`${name}: no signature`);
      continue;
    }
    let sig;
    try {
      sig = parseSignature(field);
    } catch (e) {
      errors.push(`${name}: ${e.message}`);
      continue;
    }
    if (!sig.keyId.equals(key.keyId))
      errors.push(`${name}: signed by key ${sig.keyId.toString("hex")}, not ${key.keyId.toString("hex")}`);
    const message = Buffer.concat([sig.fileSignature, Buffer.from(sig.trusted, "utf8")]);
    if (!crypto.verify(null, message, key.key, sig.globalSignature))
      errors.push(`${name}: trusted comment is not authentic under the public key`);
    else if (sig.version !== expected)
      errors.push(`${name}: trusted-comment version ${sig.version} does not match tag ${tag}`);
  }
  return errors;
}

function arg(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function main() {
  const tag = arg("--tag", process.env.GITHUB_REF_NAME);
  const latestPath = arg("--latest");
  if (!tag || !latestPath) {
    console.error("usage: verify-release-draft.mjs --tag <vX.Y.Z> --latest <path to latest.json>");
    process.exitCode = 2;
    return;
  }
  const latest = JSON.parse(readFileSync(latestPath, "utf8"));
  const pubkey = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).plugins.updater.pubkey;
  const packageVersion = JSON.parse(readFileSync("package.json", "utf8")).version;

  const errors = verifyReleaseDraft({ tag, latest, pubkey, packageVersion });
  if (errors.length === 0) {
    console.log(
      `release draft ${tag} verified: version agrees and ${Object.keys(latest.platforms).length} signature(s) authentic`,
    );
    return;
  }
  for (const e of errors) console.error(`draft ${tag}: ${e}`);
  process.exitCode = 1;
}

/** Whether this file is the program, by resolved path, so a run reached through a symlink
 *  does not read as "not the program" and exit 0 having verified nothing. */
function isEntry() {
  if (process.argv[1] === undefined) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntry()) main();
