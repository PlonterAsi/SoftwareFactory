/**
 * Offline checks of the bundled skills, MCP entries, secret-scan hook and sub-agents against the pinned
 * plugin reference (reference/plugin-reference.json). Pure: each returns plain one-sentence problems, [] when fine.
 */

export interface PluginPin {
  repo: string;
  commit: string;
  pinnedOn: string;
  hooks: { events: string[]; matcherEvents: string[]; commandType: string };
  skills: { requiredFields: Record<string, string> };
  mcp: { requiredOneOf: string[] };
  subAgent: { allowedValues: { model: string[] } };
}

function parseFm(text: string): { fields: Record<string, string>; body: string } | null {
  const m = text.replace(/\r\n/g, "\n").match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) return null;
  const fields: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z][\w-]*)\s*:\s*(.*)$/);
    if (kv) fields[kv[1].toLowerCase()] = kv[2].trim().replace(/^["']|["']$/g, "");
  }
  return { fields, body: m[2] };
}

export function checkSkill(name: string, skillMdText: string, pin: PluginPin): string[] {
  const parsed = parseFm(skillMdText);
  if (!parsed) return [`Skill ${name}: SKILL.md must start with a front-matter block holding ${Object.keys(pin.skills.requiredFields).join(" and ")}.`];
  const out: string[] = [];
  if (!parsed.fields.name) out.push(`Skill ${name}: the front-matter name is empty; it must be "${name}".`);
  else if (parsed.fields.name !== name) out.push(`Skill ${name}: the front-matter name is "${parsed.fields.name}" but the folder name is "${name}"; they must match.`);
  if (!parsed.fields.description) out.push(`Skill ${name}: the front-matter description is empty; it must say what the skill does.`);
  if (!parsed.body.trim()) out.push(`Skill ${name}: the body of SKILL.md is empty; it must hold the instructions.`);
  return out;
}

export function checkMcpEntry(name: string, entry: Record<string, unknown>, pin: PluginPin): string[] {
  const live = Object.entries(entry ?? {}).filter(([k]) => !k.startsWith("_"));
  const has = (k: string) => live.some(([key, v]) => key === k && typeof v === "string" && v.trim() !== "");
  return pin.mcp.requiredOneOf.some(has) ? [] : [`MCP server ${name}: it needs a non-empty ${pin.mcp.requiredOneOf.join(" or ")}.`];
}

export function checkHookSettings(settingsJson: string, pin: PluginPin): string[] {
  let s: { hooks?: Record<string, unknown> };
  try { s = JSON.parse(settingsJson); } catch { return ["Hook settings: the settings are not valid JSON."]; }
  const hooks = s?.hooks;
  if (!hooks || typeof hooks !== "object") return ["Hook settings: the settings need a hooks map of event name to a list."];
  const out: string[] = [];
  for (const [event, list] of Object.entries(hooks)) {
    if (!pin.hooks.events.includes(event)) out.push(`Hook ${event}: the event name must be one of ${pin.hooks.events.join(", ")}.`);
    if (!Array.isArray(list) || !list.length) { out.push(`Hook ${event}: it needs a non-empty list of entries.`); continue; }
    list.forEach((e: { matcher?: unknown; hooks?: unknown }, i) => {
      const at = `Hook ${event} entry ${i + 1}`;
      if (pin.hooks.matcherEvents.includes(event) && !(typeof e?.matcher === "string" && e.matcher.trim())) out.push(`${at}: it needs a non-empty matcher string.`);
      const items = e?.hooks;
      if (!Array.isArray(items) || !items.length) { out.push(`${at}: it needs a non-empty hooks list of type "${pin.hooks.commandType}" items.`); return; }
      items.forEach((h: { type?: unknown; command?: unknown }, j) => {
        if (h?.type !== pin.hooks.commandType) out.push(`${at} item ${j + 1}: the type must be "${pin.hooks.commandType}".`);
        if (!(typeof h?.command === "string" && h.command.trim())) out.push(`${at} item ${j + 1}: it needs a non-empty command.`);
      });
    });
  }
  return out;
}

/** A sub-agent file: a front-matter block; its model, when given, must be one of the pinned values. */
export function checkSubAgent(name: string, mdText: string, pin: PluginPin): string[] {
  const parsed = parseFm(mdText);
  if (!parsed) return [`Sub-agent ${name}: the file must start with a front-matter block.`];
  const model = parsed.fields.model;
  const ok = pin.subAgent.allowedValues.model;
  return model && !ok.includes(model) ? [`Sub-agent ${name}: the model is "${model}" but it must be one of ${ok.join(", ")}.`] : [];
}
