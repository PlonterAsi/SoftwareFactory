#!/usr/bin/env node
// Check that an update installer's .sig was made by the key whose public half
// the app ships (tauri.conf.json, plugins.updater.pubkey). The installed app
// refuses any update that fails this same check, so CI runs it before
// publishing: a wrong TAURI_SIGNING_PRIVATE_KEY secret fails the build instead
// of shipping updates nobody can install.
//
//   node scripts/updates/verify-sig.mjs <file> <file.sig> [pubkey | path to tauri.conf.json]
//
// Format: minisign (Ed25519). Tauri signs the BLAKE2b-512 hash of the file ("ED").
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";

/** Base64 of a minisign text file -> its second line, decoded. */
function minisignBlob(b64) {
  const text = Buffer.from(b64.trim(), "base64").toString("utf8");
  const lines = text.split(/\r?\n/);
  return { blob: Buffer.from(lines[1].trim(), "base64"), trusted: lines[2] ?? "", global: lines[3] ? Buffer.from(lines[3].trim(), "base64") : null };
}

export function pubkeyFromConfig(pathOrKey) {
  if (/\.json$/.test(pathOrKey)) return JSON.parse(readFileSync(pathOrKey, "utf8")).plugins.updater.pubkey;
  return pathOrKey;
}

export function verifyUpdateSignature(fileBytes, sigB64, pubB64) {
  const pk = minisignBlob(pubB64).blob; // "Ed" + 8-byte key id + 32-byte key
  const sig = minisignBlob(sigB64);
  const alg = sig.blob.subarray(0, 2).toString("latin1");
  if (pk.subarray(0, 2).toString("latin1") !== "Ed") return { ok: false, why: "public key is not an Ed25519 minisign key" };
  if (!sig.blob.subarray(2, 10).equals(pk.subarray(2, 10))) {
    return { ok: false, why: `signed by key ${sig.blob.subarray(2, 10).toString("hex").toUpperCase()}, the app trusts key ${pk.subarray(2, 10).toString("hex").toUpperCase()}` };
  }
  const key = createPublicKey({ key: Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), pk.subarray(10, 42)]), format: "der", type: "spki" });
  const msg = alg === "ED" ? createHash("blake2b512").update(fileBytes).digest() : fileBytes;
  if (!verify(null, msg, key, sig.blob.subarray(10, 74))) return { ok: false, why: "signature does not match the file" };
  // minisign also signs the trusted comment; check it when present.
  if (sig.global) {
    const comment = Buffer.from(sig.trusted.replace(/^trusted comment: /, ""), "utf8");
    if (!verify(null, Buffer.concat([sig.blob.subarray(10, 74), comment]), key, sig.global)) return { ok: false, why: "trusted comment signature does not match" };
  }
  return { ok: true, keyId: pk.subarray(2, 10).toString("hex").toUpperCase() };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  const [file, sigFile, pub = new URL("../../src-tauri/tauri.conf.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")] = process.argv.slice(2);
  if (!file || !sigFile) { console.error("usage: verify-sig.mjs <file> <file.sig> [pubkey | tauri.conf.json]"); process.exit(2); }
  const r = verifyUpdateSignature(readFileSync(file), readFileSync(sigFile, "utf8"), pubkeyFromConfig(pub));
  console.log(r.ok ? `signature OK (key ${r.keyId}): ${file}` : `SIGNATURE REJECTED: ${r.why}: ${file}`);
  process.exit(r.ok ? 0 : 1);
}
