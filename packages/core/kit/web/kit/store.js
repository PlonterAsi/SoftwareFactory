// SoftwareFactory app kit: the store the screens use. Written by SoftwareFactory; do not edit.
// It keeps the database in memory and saves every change to where the app runs:
//   - started with its server (Run tab "Start"): the file data/db.json in the project folder, through /api/
//   - opened as plain pages: this browser's storage
//   - in tests: memory only
import { createRecord, updateRecord, deleteRecord, seedDb, importDb, query, entityOf, checkSchema } from "./db.js";

export async function openStore(schema, opts) {
  const o = opts || {};
  const problems = checkSchema(schema);
  if (problems.length) throw new Error("The app's schema is not usable: " + problems.join("; "));
  const backend = o.backend || (await pickBackend(schema));
  let db = (await backend.load()) || seedDb(schema);
  if (!backend.serverSide) await backend.save(db);
  const listeners = new Set();
  const changed = () => { for (const fn of listeners) fn(db); };

  async function mutate(local, remote) {
    if (backend.serverSide) {
      const r = await remote();
      db = r.db;
      changed();
      return r.record;
    }
    const rec = local(db);
    await backend.save(db);
    changed();
    return rec;
  }

  return {
    schema,
    where: backend.where,
    get db() { return db; },
    list: (entity, q) => query(schema, db, entity, q),
    get: (entity, id) => (db.data[entity] || []).find((r) => r.id === Number(id)) || null,
    count: (entity) => (db.data[entity] || []).length,
    history: () => db.history.slice().reverse(),
    create: (entity, data) => mutate((d) => createRecord(schema, d, entity, data), () => backend.call("POST", entity, null, data)),
    update: (entity, id, patch) => mutate((d) => updateRecord(schema, d, entity, id, patch), () => backend.call("PUT", entity, id, patch)),
    remove: (entity, id) => mutate((d) => deleteRecord(schema, d, entity, id), () => backend.call("DELETE", entity, id)),
    /** Put the sample records back (everything else is removed). */
    reset: () => mutate(() => { db = seedDb(schema); return null; }, () => backend.call("POST", "_reset")),
    /** Replace everything with a file exported from this app. */
    importAll: (incoming) => mutate(() => { db = importDb(schema, incoming); return null; }, () => backend.call("POST", "_import", null, incoming)),
    exportAll: () => JSON.parse(JSON.stringify(db)),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    entity: (name) => entityOf(schema, name),
  };
}

async function pickBackend(schema) {
  try {
    const r = await fetch("api/_db", { headers: { accept: "application/json" } });
    if (r.ok && (r.headers.get("content-type") || "").includes("json")) return serverBackend();
  } catch { /* not started with its server */ }
  try { if (globalThis.localStorage) return localBackend(schema); } catch { /* storage blocked */ }
  return memoryBackend();
}

export function serverBackend(base) {
  const root = base || "api/";
  const send = async (method, path, body) => {
    const r = await fetch(root + path, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error || r.statusText); e.errors = j.errors; throw e; }
    return j;
  };
  return {
    serverSide: true,
    where: "the file data/db.json in the project folder",
    load: () => send("GET", "_db"),
    save: async () => {},
    call: (method, entity, id, body) => send(method, encodeURIComponent(entity) + (id != null ? "/" + id : ""), body),
  };
}

export function localBackend(schema) {
  const key = "sf-app:" + (schema.app && schema.app.slug || location.pathname);
  return {
    where: "this browser's storage (start the app from the Run tab to keep data in a file)",
    load: async () => { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch { return null; } },
    save: async (db) => { try { localStorage.setItem(key, JSON.stringify(db)); } catch { /* full or blocked: keep working in memory */ } },
  };
}

export function memoryBackend(initial) {
  let saved = initial || null;
  return { where: "memory only", load: async () => saved, save: async (db) => { saved = JSON.parse(JSON.stringify(db)); } };
}
