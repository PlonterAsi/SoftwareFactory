// SoftwareFactory app kit: the app's frame. Written by SoftwareFactory; do not edit.
// startApp() turns a schema into a whole program: navigation, a list, form and delete for every
// entity (full CRUD), the app's own views, and a System view where every entity, field, flow,
// feature, change and source file can be seen.
import { openStore } from "./store.js";
import { titleField, recordTitle, referencesTo, computedValue, entityOf } from "./db.js";

/** Make an element: h("button", { class: "x", onclick }, "Save"). */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of children.flat(Infinity)) if (c !== null && c !== undefined && c !== false) el.append(c instanceof Node ? c : String(c));
  return el;
}

/** Horizontal bars: bars([{ label, value, max?, color? }]). */
export function bars(items, opts) {
  const max = Math.max(1, ...items.map((i) => Number(i.max ?? i.value) || 0));
  return h("div", { class: "kit-bars" }, items.map((i) => h("div", { class: "kit-bar-row" },
    h("span", { class: "kit-bar-label" }, i.label),
    h("span", { class: "kit-bar-track" }, h("span", { class: "kit-bar-fill", style: { width: Math.max(0, Math.min(100, (Number(i.value) || 0) / max * 100)) + "%", background: i.color || "" } })),
    h("span", { class: "kit-bar-value" }, (opts && opts.format ? opts.format(i.value, i) : String(i.value ?? 0))),
  )));
}

/** A small number card: stat("Open tasks", 4, "of 9"). */
export function stat(label, value, sub) {
  return h("div", { class: "kit-stat" }, h("div", { class: "kit-stat-value" }, String(value)), h("div", { class: "kit-stat-label" }, label), sub ? h("div", { class: "kit-stat-sub" }, sub) : null);
}

const plural = (e) => e.label || (e.name.charAt(0).toUpperCase() + e.name.slice(1) + "s");
const single = (e) => e.singular || (e.name.charAt(0).toUpperCase() + e.name.slice(1));
const fieldLabel = (f) => f.label || f.name.replace(/([A-Z])/g, " $1").replace(/^./, (c) => c.toUpperCase());

/**
 * Start the app.
 *   schema: the module src/schema.js (app, entities, flows, features)
 *   views:  the app's own screens, [{ id, label, render(container, ctx) }]; a view with id "dashboard" replaces the default home
 */
export async function startApp({ schema, views, root, store }) {
  const mount = root || document.getElementById("app") || document.body;
  let st;
  try { st = store || (await openStore(schema)); } catch (e) {
    mount.replaceChildren(h("div", { class: "kit-fatal" }, h("h1", {}, "This app cannot start"), h("p", {}, e.message)));
    throw e;
  }
  const own = (views || []).filter((v) => v && v.id && typeof v.render === "function");
  const app = schema.app || {};
  document.title = app.name || document.title;
  const toastBox = h("div", { class: "kit-toasts", role: "status" });
  const toast = (text, kind) => { const t = h("div", { class: "kit-toast " + (kind || "") }, text); toastBox.append(t); setTimeout(() => t.remove(), kind === "error" ? 6000 : 2500); };
  const go = (path) => { location.hash = "#/" + path; };
  const ctx = { store: st, schema, h, bars, stat, go, toast };

  const nav = h("nav", { class: "kit-nav", "aria-label": "Main" });
  const main = h("main", { class: "kit-main" });
  mount.replaceChildren(h("div", { class: "kit-app" },
    h("aside", { class: "kit-side" }, h("div", { class: "kit-brand" }, h("strong", {}, app.name || "App"), app.tagline ? h("span", {}, app.tagline) : null), nav),
    main, toastBox));

  function route() {
    const parts = (location.hash.replace(/^#\/?/, "") || "home").split("/").map(decodeURIComponent);
    return parts;
  }

  function drawNav(parts) {
    const here = parts.join("/");
    const link = (path, label, count) => h("a", { href: "#/" + path, "aria-current": here === path || here.startsWith(path + "/") ? "page" : null }, h("span", {}, label), count !== undefined ? h("span", { class: "kit-count" }, String(count)) : null);
    nav.replaceChildren(
      link("home", own.find((v) => v.id === "dashboard")?.label || "Overview"),
      h("div", { class: "kit-nav-head" }, "Data"),
      ...schema.entities.map((e) => link("e/" + e.name, plural(e), st.count(e.name))),
      ...(own.filter((v) => v.id !== "dashboard").length ? [h("div", { class: "kit-nav-head" }, "Views"), ...own.filter((v) => v.id !== "dashboard").map((v) => link("v/" + v.id, v.label || v.id))] : []),
      h("div", { class: "kit-nav-head" }, "Inside"),
      link("system", "System"),
    );
  }

  function draw() {
    const parts = route();
    drawNav(parts);
    try {
      if (parts[0] === "e" && parts[1]) {
        if (parts[2]) main.replaceChildren(recordPage(parts[1], parts[2]));
        else main.replaceChildren(listPage(parts[1]));
      } else if (parts[0] === "v" && parts[1]) {
        const v = own.find((x) => x.id === parts[1]);
        main.replaceChildren(v ? viewPage(v) : notFound());
      } else if (parts[0] === "system") main.replaceChildren(systemPage(parts[1] || "overview"));
      else {
        const dash = own.find((v) => v.id === "dashboard");
        main.replaceChildren(dash ? viewPage(dash) : homePage());
      }
    } catch (e) {
      main.replaceChildren(h("div", { class: "kit-error" }, h("h2", {}, "Something went wrong on this screen"), h("pre", {}, String(e && e.stack || e))));
    }
  }

  function viewPage(v) {
    const box = h("section", { class: "kit-view" });
    try { v.render(box, ctx); } catch (e) { box.replaceChildren(h("div", { class: "kit-error" }, h("h2", {}, (v.label || v.id) + " could not draw"), h("pre", {}, String(e && e.message || e)))); }
    return box;
  }

  function notFound() { return h("section", {}, h("h1", {}, "Not found"), h("p", {}, h("a", { href: "#/home" }, "Back to the overview"))); }

  function homePage() {
    return h("section", {},
      h("header", { class: "kit-head" }, h("h1", {}, app.name || "Overview"), app.summary ? h("p", { class: "kit-sub" }, app.summary) : null),
      h("div", { class: "kit-cards" }, schema.entities.map((e) => h("a", { class: "kit-card", href: "#/e/" + e.name },
        h("div", { class: "kit-stat-value" }, String(st.count(e.name))), h("div", { class: "kit-stat-label" }, plural(e)),
        h("div", { class: "kit-card-list" }, st.list(e.name).slice(-3).reverse().map((r) => h("div", {}, recordTitle(e, r))))))),
      (schema.flows || []).length ? h("div", { class: "kit-panel" }, h("h2", {}, "How it works"), flowsList()) : null,
      h("div", { class: "kit-panel" }, h("h2", {}, "Latest changes"), activityList(6)),
    );
  }

  function cell(e, f, r) {
    const v = r[f.name];
    const t = f.type || "text";
    if (v === null || v === undefined || v === "") return h("span", { class: "kit-muted" }, "—");
    if (t === "bool") return v ? "Yes" : "No";
    if (t === "ref") { const to = entityOf(schema, f.to); const target = st.get(f.to, v); return target ? h("a", { href: "#/e/" + f.to + "/" + v, onclick: (ev) => ev.stopPropagation() }, recordTitle(to, target)) : h("span", { class: "kit-muted" }, "missing"); }
    if (t === "tags") return h("span", {}, v.map((x) => h("span", { class: "kit-tag" }, x)));
    if (t === "choice") return h("span", { class: "kit-chip" }, String(v));
    if (t === "color") return h("span", { class: "kit-swatch", style: { background: v }, title: v });
    if (t === "longtext") return String(v).length > 80 ? String(v).slice(0, 80) + "…" : String(v);
    if (t === "url") return h("a", { href: v, target: "_blank", rel: "noopener" }, String(v));
    return String(v);
  }

  function listPage(name) {
    const e = entityOf(schema, name);
    const cols = e.fields.filter((f) => !f.hidden && (e.columns ? e.columns.includes(f.name) : (f.type || "text") !== "longtext")).slice(0, 6);
    const computed = (e.computed || []).slice(0, 3);
    const state = listState[name] || (listState[name] = { q: "", sort: null, desc: false });
    const tbody = h("tbody");
    const counter = h("span", { class: "kit-muted" });
    const fill = () => {
      const rows = st.list(name, state);
      counter.textContent = rows.length + " of " + st.count(name);
      tbody.replaceChildren(...(rows.length ? rows.map((r) => h("tr", { tabindex: "0", onclick: () => go("e/" + name + "/" + r.id), onkeydown: (ev) => { if (ev.key === "Enter") go("e/" + name + "/" + r.id); } },
        cols.map((f) => h("td", {}, cell(e, f, r))),
        computed.map((c) => h("td", { class: "kit-num" }, fmt(computedValue(c, r, st.db)))),
        h("td", { class: "kit-row-actions" }, h("button", { class: "kit-link danger", title: "Delete", onclick: (ev) => { ev.stopPropagation(); remove(name, r); } }, "Delete")),
      )) : [h("tr", {}, h("td", { colspan: String(cols.length + computed.length + 1), class: "kit-empty" }, st.count(name) ? "Nothing matches the search." : "No " + plural(e).toLowerCase() + " yet. Press New to add the first one."))]));
    };
    const sortBy = (key) => { state.desc = state.sort === key ? !state.desc : false; state.sort = key; fill(); };
    fill();
    return h("section", {},
      h("header", { class: "kit-head" }, h("h1", {}, plural(e)), e.description ? h("p", { class: "kit-sub" }, e.description) : null),
      h("div", { class: "kit-toolbar" },
        h("input", { type: "search", placeholder: "Search " + plural(e).toLowerCase(), value: state.q, "aria-label": "Search", oninput: (ev) => { state.q = ev.target.value; fill(); } }),
        counter,
        h("button", { class: "kit-primary", onclick: () => go("e/" + name + "/new") }, "New " + single(e).toLowerCase())),
      h("div", { class: "kit-table-wrap" }, h("table", { class: "kit-table" },
        h("thead", {}, h("tr", {}, cols.map((f) => h("th", { onclick: () => sortBy(f.name), class: "kit-sortable" }, fieldLabel(f), state.sort === f.name ? (state.desc ? " ↓" : " ↑") : "")), computed.map((c) => h("th", { class: "kit-num" }, c.label || c.name)), h("th", {}))),
        tbody)),
    );
  }

  async function remove(name, r) {
    const e = entityOf(schema, name);
    const refs = referencesTo(schema, st.db, name, r.id);
    const warn = refs.length ? "\n\n" + refs.length + " linked record" + (refs.length > 1 ? "s" : "") + " will be unlinked." : "";
    if (!confirm("Delete " + single(e).toLowerCase() + " \"" + recordTitle(e, r) + "\"?" + warn)) return;
    try { await st.remove(name, r.id); toast("Deleted " + recordTitle(e, r)); if (route()[2]) go("e/" + name); } catch (err) { toast(err.message, "error"); }
  }

  function input(f, value, onChange) {
    const t = f.type || "text";
    const id = "f-" + f.name;
    if (t === "longtext") return h("textarea", { id, rows: "5", value: value ?? "", oninput: (ev) => onChange(ev.target.value) });
    if (t === "bool") return h("input", { id, type: "checkbox", checked: !!value, onchange: (ev) => onChange(ev.target.checked) });
    if (t === "choice") return h("select", { id, onchange: (ev) => onChange(ev.target.value) }, f.required ? null : h("option", { value: "" }, "—"), f.options.map((o) => { const op = h("option", { value: o }, o); if (o === value) op.selected = true; return op; }));
    if (t === "ref") {
      const to = entityOf(schema, f.to);
      return h("span", { class: "kit-ref" },
        h("select", { id, onchange: (ev) => onChange(ev.target.value) }, h("option", { value: "" }, "—"), st.list(f.to).map((r) => { const op = h("option", { value: String(r.id) }, recordTitle(to, r)); if (r.id === value) op.selected = true; return op; })),
        h("a", { href: "#/e/" + f.to + "/new", class: "kit-link" }, "New " + single(to).toLowerCase()));
    }
    if (t === "tags") return h("input", { id, type: "text", value: (value || []).join(", "), placeholder: "comma, separated", oninput: (ev) => onChange(ev.target.value) });
    const type = t === "number" ? "number" : t === "date" ? "date" : t === "email" ? "email" : t === "url" ? "url" : t === "color" ? "color" : "text";
    return h("input", { id, type, value: value ?? "", step: t === "number" ? (f.step || "any") : null, min: f.min, max: f.max, placeholder: f.placeholder || null, oninput: (ev) => onChange(ev.target.value) });
  }

  function recordPage(name, idPart) {
    const e = entityOf(schema, name);
    const isNew = idPart === "new";
    const rec = isNew ? null : st.get(name, idPart);
    if (!isNew && !rec) return h("section", {}, h("h1", {}, single(e) + " #" + idPart + " is gone"), h("p", {}, h("a", { href: "#/e/" + name }, "Back to " + plural(e).toLowerCase())));
    const draft = {};
    for (const f of e.fields) draft[f.name] = rec ? rec[f.name] : (f.default !== undefined ? f.default : (f.type === "choice" && f.required ? f.options[0] : (f.type === "bool" ? false : "")));
    const errs = {};
    const rows = e.fields.filter((f) => !f.hidden).map((f) => {
      errs[f.name] = h("div", { class: "kit-field-error", role: "alert" });
      return h("div", { class: "kit-field" + ((f.type || "text") === "bool" ? " kit-check" : "") },
        h("label", { for: "f-" + f.name }, fieldLabel(f), f.required ? h("span", { class: "kit-req", title: "required" }, " *") : null),
        input(f, draft[f.name], (v) => { draft[f.name] = v; }), f.help ? h("div", { class: "kit-help" }, f.help) : null, errs[f.name]);
    });
    const save = async (ev) => {
      ev.preventDefault();
      for (const k in errs) errs[k].textContent = "";
      try {
        const saved = isNew ? await st.create(name, draft) : await st.update(name, rec.id, draft);
        toast((isNew ? "Created " : "Saved ") + recordTitle(e, saved));
        go("e/" + name + (isNew ? "/" + saved.id : ""));
        if (!isNew) draw();
      } catch (err) {
        const fe = err.errors || {};
        for (const k in fe) if (errs[k]) errs[k].textContent = fe[k];
        toast(err.message, "error");
      }
    };
    const refs = rec ? referencesTo(schema, st.db, name, rec.id) : [];
    const computed = rec ? (e.computed || []) : [];
    return h("section", {},
      h("nav", { class: "kit-crumbs" }, h("a", { href: "#/e/" + name }, plural(e)), " / ", isNew ? "New" : recordTitle(e, rec)),
      h("header", { class: "kit-head" }, h("h1", {}, isNew ? "New " + single(e).toLowerCase() : recordTitle(e, rec))),
      computed.length ? h("div", { class: "kit-cards" }, computed.map((c) => stat(c.label || c.name, fmt(computedValue(c, rec, st.db))))) : null,
      h("form", { class: "kit-form", onsubmit: save }, rows,
        h("div", { class: "kit-actions" },
          h("button", { class: "kit-primary", type: "submit" }, isNew ? "Create" : "Save"),
          h("a", { href: "#/e/" + name, class: "kit-button" }, "Cancel"),
          rec ? h("button", { type: "button", class: "kit-button danger", onclick: () => remove(name, rec) }, "Delete") : null)),
      rec ? h("div", { class: "kit-panel" }, h("h2", {}, "Linked here"), refs.length
        ? h("ul", { class: "kit-list" }, refs.map((r) => h("li", {}, h("a", { href: "#/e/" + r.entity + "/" + r.id }, r.title), h("span", { class: "kit-muted" }, " (" + plural(entityOf(schema, r.entity)).toLowerCase() + ", " + r.field + ")"))))
        : h("p", { class: "kit-muted" }, "Nothing points at this " + single(e).toLowerCase() + ".")) : null,
      rec ? h("p", { class: "kit-muted kit-meta" }, "#" + rec.id + " · created " + when(rec.createdAt) + " · changed " + when(rec.updatedAt)) : null,
    );
  }

  function flowsList() {
    return h("div", { class: "kit-flows" }, (schema.flows || []).map((fl) => h("div", { class: "kit-flow" },
      h("h3", {}, fl.name), fl.description ? h("p", { class: "kit-sub" }, fl.description) : null,
      h("ol", { class: "kit-steps" }, (fl.steps || []).map((s) => h("li", {}, typeof s === "string" ? s : (s.label || s.name)))))));
  }

  function activityList(n) {
    const items = st.history().slice(0, n || 50);
    if (!items.length) return h("p", { class: "kit-muted" }, "No changes yet.");
    return h("ul", { class: "kit-activity" }, items.map((x) => {
      const e = x.entity && x.entity !== "*" ? schema.entities.find((y) => y.name === x.entity) : null;
      const target = e && x.op !== "delete" && st.get(x.entity, x.id) ? h("a", { href: "#/e/" + x.entity + "/" + x.id }, x.title) : h("span", {}, x.title);
      return h("li", {}, h("span", { class: "kit-op kit-op-" + x.op }, x.op), " ", e ? single(e).toLowerCase() + " " : "", target, h("span", { class: "kit-muted" }, " · " + when(x.at)));
    }));
  }

  function systemPage(tab) {
    const tabs = [["overview", "Overview"], ["entities", "Entities"], ["flows", "Flows"], ["features", "Features"], ["activity", "Activity"], ["data", "Data"], ["code", "Code"]];
    const body = h("div", {});
    const counts = schema.entities.map((e) => ({ label: plural(e), value: st.count(e.name) }));
    if (tab === "overview") body.append(
      h("div", { class: "kit-cards" }, stat("Entities", schema.entities.length), stat("Records", counts.reduce((a, c) => a + c.value, 0)), stat("Flows", (schema.flows || []).length), stat("Views", own.length)),
      h("div", { class: "kit-panel" }, h("h2", {}, "Records by entity"), bars(counts)),
      h("div", { class: "kit-panel" }, h("h2", {}, "Where the data lives"), h("p", {}, st.where)),
      h("div", { class: "kit-panel" }, h("h2", {}, "Map"), entityMap()));
    else if (tab === "entities") body.append(...schema.entities.map(entityPanel));
    else if (tab === "flows") body.append((schema.flows || []).length ? flowsList() : h("p", { class: "kit-muted" }, "This app lists no flows."));
    else if (tab === "features") body.append(h("div", { class: "kit-panel" }, h("ul", { class: "kit-list" },
      (schema.features || []).map((f) => h("li", {}, h("strong", {}, typeof f === "string" ? f : f.name), typeof f === "object" && f.description ? h("span", { class: "kit-muted" }, " · " + f.description) : null, typeof f === "object" && f.where ? h("a", { href: "#/" + f.where, class: "kit-link" }, " open") : null)),
      schema.entities.map((e) => h("li", {}, h("strong", {}, "Manage " + plural(e).toLowerCase()), h("span", { class: "kit-muted" }, " · list, search, sort, create, edit, delete"), h("a", { href: "#/e/" + e.name, class: "kit-link" }, " open"))),
      own.map((v) => h("li", {}, h("strong", {}, v.label || v.id), v.description ? h("span", { class: "kit-muted" }, " · " + v.description) : null, h("a", { href: v.id === "dashboard" ? "#/home" : "#/v/" + v.id, class: "kit-link" }, " open"))))));
    else if (tab === "activity") body.append(h("div", { class: "kit-panel" }, activityList(200)));
    else if (tab === "data") body.append(dataPanel());
    else if (tab === "code") body.append(codePanel());
    return h("section", {},
      h("header", { class: "kit-head" }, h("h1", {}, "System"), h("p", { class: "kit-sub" }, "Everything this app is made of: its data, flows, features, changes and code.")),
      h("div", { class: "kit-tabs", role: "tablist" }, tabs.map(([id, label]) => h("a", { role: "tab", href: "#/system/" + id, "aria-selected": id === tab ? "true" : "false" }, label))),
      body);
  }

  function entityPanel(e) {
    const fieldRows = e.fields.map((f) => h("tr", {},
      h("td", {}, fieldLabel(f), h("code", { class: "kit-muted" }, " " + f.name)),
      h("td", {}, f.type || "text"),
      h("td", {}, f.required ? "yes" : ""),
      h("td", {}, f.type === "ref" ? h("a", { href: "#/e/" + f.to }, "→ " + plural(entityOf(schema, f.to))) : f.options ? f.options.join(", ") : (f.help || ""))));
    const computedRows = (e.computed || []).map((c) => h("tr", {},
      h("td", {}, c.label || c.name), h("td", {}, "computed"), h("td", {}), h("td", {}, c.description || "worked out from the record")));
    return h("div", { class: "kit-panel" },
      h("h2", {}, h("a", { href: "#/e/" + e.name }, plural(e)), h("span", { class: "kit-muted" }, " · " + st.count(e.name) + " records")),
      e.description ? h("p", { class: "kit-sub" }, e.description) : null,
      h("table", { class: "kit-table" },
        h("thead", {}, h("tr", {}, ["Field", "Type", "Required", "Details"].map((x) => h("th", {}, x)))),
        h("tbody", {}, fieldRows, computedRows)));
  }

  function entityMap() {
    const links = [];
    for (const e of schema.entities) for (const f of e.fields) if (f.type === "ref") links.push(h("li", {}, plural(e), " → ", plural(entityOf(schema, f.to)), h("span", { class: "kit-muted" }, " (" + fieldLabel(f) + ")")));
    return h("div", {}, h("div", { class: "kit-map" }, schema.entities.map((e) => h("a", { class: "kit-node", href: "#/e/" + e.name }, h("strong", {}, plural(e)), h("span", {}, e.fields.map((f) => f.name).join(" · "))))),
      links.length ? h("ul", { class: "kit-list" }, links) : null);
  }

  function dataPanel() {
    const file = h("input", { type: "file", accept: ".json,application/json", class: "kit-hidden", onchange: async (ev) => {
      const f = ev.target.files[0]; if (!f) return;
      try { await st.importAll(JSON.parse(await f.text())); toast("Imported " + f.name); draw(); } catch (err) { toast("Could not import: " + err.message, "error"); }
    } });
    return h("div", { class: "kit-panel" },
      h("h2", {}, "Your data"), h("p", {}, "Stored in " + st.where + "."),
      h("div", { class: "kit-actions" },
        h("button", { class: "kit-button", onclick: () => {
          const blob = new Blob([JSON.stringify(st.exportAll(), null, 2)], { type: "application/json" });
          const a = h("a", { href: URL.createObjectURL(blob), download: ((schema.app && schema.app.slug) || "app") + "-data.json" }); document.body.append(a); a.click(); a.remove();
        } }, "Download a backup"),
        h("button", { class: "kit-button", onclick: () => file.click() }, "Restore from a backup"), file,
        h("button", { class: "kit-button danger", onclick: async () => { if (confirm("Replace all data with the sample records?")) { await st.reset(); toast("Sample data restored"); draw(); } } }, "Start over with sample data")),
      h("p", { class: "kit-muted" }, "Backups are files this app makes and reads; you never write them by hand."));
  }

  function codePanel() {
    const box = h("div", { class: "kit-code" }, h("p", { class: "kit-muted" }, "Loading the file list…"));
    fetch("api/_system").then((r) => r.ok ? r.json() : Promise.reject(new Error("not started with its server"))).then((sys) => {
      const viewer = h("pre", { class: "kit-source" }, "Pick a file to read it.");
      box.replaceChildren(h("div", { class: "kit-code-grid" },
        h("ul", { class: "kit-files" }, sys.files.map((f) => h("li", {}, h("button", { class: "kit-link", onclick: async () => {
          const r = await fetch("api/_system/file?path=" + encodeURIComponent(f.path)); viewer.textContent = r.ok ? await r.text() : "Cannot read " + f.path;
        } }, f.path), h("span", { class: "kit-muted" }, " " + f.lines + " lines")))), viewer));
    }).catch(() => box.replaceChildren(h("p", { class: "kit-muted" }, "Start the app with its server (the Run tab's Start) to browse its source files here. The project's Code tab in SoftwareFactory shows them too.")));
    return h("div", { class: "kit-panel" }, h("h2", {}, "Code"), box);
  }

  const listState = {};
  window.addEventListener("hashchange", draw);
  // Typing in a form must not be wiped by a redraw; lists and views redraw on every change.
  st.subscribe(() => { if (!main.querySelector("form.kit-form")) draw(); else drawNav(route()); });
  draw();
  return ctx;
}

function fmt(v) {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

function when(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

export { titleField };
