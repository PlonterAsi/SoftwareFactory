// SoftwareFactory app kit: the data core. Written by SoftwareFactory; do not edit (it is rewritten on every build).
// Pure functions over a plain database object, so the page, the server and the tests share one set of rules.
//
// A database is { version, seq, data: { <entity>: [records] }, history: [changes] }.
// A record is { id, ...fields, createdAt, updatedAt }.

export const FIELD_TYPES = ["text", "longtext", "number", "bool", "date", "choice", "tags", "ref", "email", "url", "color"];

/** Problems with a schema, as sentences. An empty list means it is usable. */
export function checkSchema(schema) {
  const out = [];
  const entities = schema && Array.isArray(schema.entities) ? schema.entities : null;
  if (!entities || !entities.length) return ["the schema has no entities: an app needs at least one kind of thing to create, see, change and delete"];
  const names = new Set(entities.map((e) => e && e.name));
  for (const e of entities) {
    if (!e || typeof e.name !== "string" || !/^[a-z][a-zA-Z0-9]*$/.test(e.name)) { out.push("an entity has no valid name (lowerCamelCase, like \"task\")"); continue; }
    if (!Array.isArray(e.fields) || !e.fields.length) { out.push(e.name + " has no fields"); continue; }
    const seen = new Set();
    for (const f of e.fields) {
      if (!f || typeof f.name !== "string" || !/^[a-z][a-zA-Z0-9]*$/.test(f.name)) { out.push(e.name + " has a field without a valid name"); continue; }
      if (["id", "createdAt", "updatedAt"].includes(f.name)) out.push(e.name + "." + f.name + " is a reserved name");
      if (seen.has(f.name)) out.push(e.name + "." + f.name + " appears twice");
      seen.add(f.name);
      if (!FIELD_TYPES.includes(f.type || "text")) out.push(e.name + "." + f.name + " has unknown type \"" + f.type + "\" (use one of " + FIELD_TYPES.join(", ") + ")");
      if (f.type === "choice" && (!Array.isArray(f.options) || !f.options.length)) out.push(e.name + "." + f.name + " is a choice without options");
      if (f.type === "ref" && !names.has(f.to)) out.push(e.name + "." + f.name + " refers to \"" + f.to + "\", which is not an entity");
    }
    if (e.title && !seen.has(e.title)) out.push(e.name + ".title names \"" + e.title + "\", which is not one of its fields");
    if (e.seed !== undefined && !Array.isArray(e.seed)) out.push(e.name + ".seed must be a list of sample records");
  }
  return out;
}

export function entityOf(schema, name) {
  const e = schema.entities.find((x) => x.name === name);
  if (!e) throw new Error("Unknown entity \"" + name + "\"");
  return e;
}

/** The field that names a record in lists and pickers. */
export function titleField(entity) {
  return entity.title || (entity.fields.find((f) => (f.type || "text") === "text") || entity.fields[0]).name;
}

export function recordTitle(entity, rec) {
  if (!rec) return "";
  const v = rec[titleField(entity)];
  return v === undefined || v === null || v === "" ? "#" + rec.id : String(v);
}

export function emptyDb(schema) {
  const data = {};
  for (const e of schema.entities) data[e.name] = [];
  return { version: 1, seq: 0, data, history: [] };
}

/** A fresh database holding every entity's sample records, so the app is useful on first open. */
export function seedDb(schema, now) {
  const db = emptyDb(schema);
  const t = now || new Date().toISOString();
  // Seeds may point at each other by position ("@project:0" is the first seeded project).
  const idsBy = {};
  for (const e of schema.entities) {
    idsBy[e.name] = [];
    for (const s of e.seed || []) {
      const rec = { id: ++db.seq, createdAt: t, updatedAt: t };
      for (const f of e.fields) rec[f.name] = s[f.name] === undefined ? defaultOf(f) : s[f.name];
      db.data[e.name].push(rec);
      idsBy[e.name].push(rec.id);
    }
  }
  for (const e of schema.entities) {
    for (const rec of db.data[e.name]) {
      for (const f of e.fields) {
        const v = rec[f.name];
        if (f.type === "ref" && typeof v === "string" && v.startsWith("@")) {
          const m = v.match(/^@(\w+):(\d+)$/);
          rec[f.name] = m && idsBy[m[1]] ? (idsBy[m[1]][Number(m[2])] ?? null) : null;
        }
      }
    }
  }
  db.history.push({ at: t, op: "seed", entity: "*", id: null, title: "Sample data loaded" });
  return db;
}

export function defaultOf(f) {
  if (f.default !== undefined) return f.default;
  switch (f.type || "text") {
    case "number": return null;
    case "bool": return false;
    case "tags": return [];
    case "ref": return null;
    case "choice": return f.required ? f.options[0] : null;
    case "color": return "#4f8cff";
    default: return "";
  }
}

/** Turn what a form or an API call sent into typed values. Unknown keys are dropped. */
export function coerce(entity, input) {
  const out = {};
  for (const f of entity.fields) {
    if (!(f.name in input)) continue;
    let v = input[f.name];
    const t = f.type || "text";
    if (t === "number") v = v === "" || v === null || v === undefined ? null : Number(v);
    else if (t === "bool") v = v === true || v === "true" || v === "on" || v === 1 || v === "1";
    else if (t === "tags") v = Array.isArray(v) ? v.map(String).map((s) => s.trim()).filter(Boolean) : String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    else if (t === "ref") v = v === "" || v === null || v === undefined ? null : Number(v);
    else if (t === "choice") v = v === "" || v === undefined ? null : v;
    else v = v === null || v === undefined ? "" : String(v);
    out[f.name] = v;
  }
  return out;
}

/** What is wrong with a record, by field name. Empty when it may be saved. */
export function validate(schema, entityName, rec, db) {
  const e = entityOf(schema, entityName);
  const errors = {};
  for (const f of e.fields) {
    const v = rec[f.name];
    const t = f.type || "text";
    const empty = v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length);
    if (empty) { if (f.required) errors[f.name] = (f.label || f.name.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase())) + " is required"; continue; }
    if (t === "number") {
      if (typeof v !== "number" || Number.isNaN(v)) errors[f.name] = "must be a number";
      else if (f.min !== undefined && v < f.min) errors[f.name] = "must be at least " + f.min;
      else if (f.max !== undefined && v > f.max) errors[f.name] = "must be at most " + f.max;
    } else if (t === "date" && !/^\d{4}-\d{2}-\d{2}/.test(String(v))) errors[f.name] = "must be a date";
    else if (t === "choice" && !f.options.includes(v)) errors[f.name] = "must be one of " + f.options.join(", ");
    else if (t === "email" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v))) errors[f.name] = "must be an email address";
    else if (t === "url" && !/^https?:\/\//i.test(String(v))) errors[f.name] = "must start with http:// or https://";
    else if (t === "ref" && db && !(db.data[f.to] || []).some((r) => r.id === v)) errors[f.name] = "points at a " + f.to + " that does not exist";
    else if ((t === "text" || t === "longtext") && f.maxLength && String(v).length > f.maxLength) errors[f.name] = "must be at most " + f.maxLength + " characters";
  }
  if (typeof e.validate === "function") {
    const extra = e.validate(rec, db) || {};
    for (const k of Object.keys(extra)) if (extra[k]) errors[k] = extra[k];
  }
  return errors;
}

export class ValidationError extends Error {
  constructor(errors) { super("Please check: " + Object.values(errors).join("; ")); this.errors = errors; }
}

function log(db, op, entity, id, title) {
  db.history.push({ at: new Date().toISOString(), op, entity, id, title });
  if (db.history.length > 500) db.history.splice(0, db.history.length - 500);
}

export function createRecord(schema, db, entityName, input) {
  const e = entityOf(schema, entityName);
  const rec = {};
  for (const f of e.fields) rec[f.name] = defaultOf(f);
  Object.assign(rec, coerce(e, input || {}));
  const errors = validate(schema, entityName, rec, db);
  if (Object.keys(errors).length) throw new ValidationError(errors);
  const t = new Date().toISOString();
  const saved = { id: ++db.seq, ...rec, createdAt: t, updatedAt: t };
  db.data[entityName].push(saved);
  log(db, "create", entityName, saved.id, recordTitle(e, saved));
  return saved;
}

export function updateRecord(schema, db, entityName, id, patch) {
  const e = entityOf(schema, entityName);
  const list = db.data[entityName];
  const i = list.findIndex((r) => r.id === Number(id));
  if (i < 0) throw new Error("No " + entityName + " #" + id);
  const next = { ...list[i], ...coerce(e, patch || {}) };
  const errors = validate(schema, entityName, next, db);
  if (Object.keys(errors).length) throw new ValidationError(errors);
  next.updatedAt = new Date().toISOString();
  list[i] = next;
  log(db, "update", entityName, next.id, recordTitle(e, next));
  return next;
}

/** Records elsewhere that point at this one. */
export function referencesTo(schema, db, entityName, id) {
  const out = [];
  for (const e of schema.entities) for (const f of e.fields) {
    if (f.type !== "ref" || f.to !== entityName) continue;
    for (const r of db.data[e.name] || []) if (r[f.name] === Number(id)) out.push({ entity: e.name, field: f.name, id: r.id, title: recordTitle(e, r) });
  }
  return out;
}

/** Delete a record; whatever pointed at it is unlinked (set to empty), never left dangling. */
export function deleteRecord(schema, db, entityName, id) {
  const e = entityOf(schema, entityName);
  const list = db.data[entityName];
  const i = list.findIndex((r) => r.id === Number(id));
  if (i < 0) throw new Error("No " + entityName + " #" + id);
  const [gone] = list.splice(i, 1);
  for (const ref of referencesTo(schema, db, entityName, gone.id)) {
    const r = db.data[ref.entity].find((x) => x.id === ref.id);
    if (r) r[ref.field] = null;
  }
  log(db, "delete", entityName, gone.id, recordTitle(e, gone));
  return gone;
}

/** Records of one entity, filtered by text and sorted. */
export function query(schema, db, entityName, opts) {
  const e = entityOf(schema, entityName);
  const o = opts || {};
  let rows = (db.data[entityName] || []).slice();
  const q = String(o.q || "").trim().toLowerCase();
  if (q) rows = rows.filter((r) => e.fields.some((f) => String(r[f.name] ?? "").toLowerCase().includes(q)));
  const key = o.sort || null;
  if (key) {
    const dir = o.desc ? -1 : 1;
    rows.sort((a, b) => (a[key] ?? "") > (b[key] ?? "") ? dir : (a[key] ?? "") < (b[key] ?? "") ? -dir : 0);
  }
  return rows;
}

/** A computed column's value; a throwing formula shows as empty instead of breaking the screen. */
export function computedValue(c, rec, db) {
  try { return c.value(rec, db); } catch { return null; }
}

/** Replace the whole database with one the person imported (a file exported from this app). */
export function importDb(schema, incoming) {
  if (!incoming || typeof incoming !== "object" || !incoming.data) throw new Error("This file is not an export of this app");
  const db = emptyDb(schema);
  let max = 0;
  for (const e of schema.entities) {
    for (const r of incoming.data[e.name] || []) {
      const rec = { id: Number(r.id), createdAt: r.createdAt || new Date().toISOString(), updatedAt: r.updatedAt || new Date().toISOString(), ...coerce(e, r) };
      if (!Number.isFinite(rec.id)) continue;
      db.data[e.name].push(rec);
      max = Math.max(max, rec.id);
    }
  }
  db.seq = Math.max(max, Number(incoming.seq) || 0);
  db.history = Array.isArray(incoming.history) ? incoming.history.slice(-500) : [];
  log(db, "import", "*", null, "Data imported");
  return db;
}
