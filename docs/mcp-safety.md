# MCP servers for agents: the safety rule

An MCP server gives an agent new powers, so SoftwareFactory adds them carefully (SF-21).

1. **Pin every version.** `@playwright/mcp@0.0.84`, never `@latest`. A new version is a reviewed change to `packages/core/agent-mcp.json`.
2. **Per-agent allowlist.** A server runs only for agents that tick it in their settings. Lean runs use `--strict-mcp-config`, so nothing else loads, and only that agent's server tools are allowed.
3. **Free tiers only.** No paid plan, no card. Context7 runs without an API key on its free tier (about 1,000 calls a month). If a limit is hit, the agent goes without it.
4. **Telemetry off where the server offers a switch.**
5. **Least privilege for tokens.** If a server ever needs a token: read-only and fine-grained, kept in the data folder, never in the event log.
6. **Never the lethal trio in one agent.** No agent gets untrusted input (web pages, outside docs), private data (your notes, other projects, secrets) and a write channel (edits, pushes, messages) together. Today the Researcher reads the web and writes nothing, and the crew agents that edit read only the project they work on.

| Server | Licence | Runs | Given to |
|---|---|---|---|
| playwright (`@playwright/mcp@0.0.84`) | Apache-2.0, Microsoft | locally, headless, isolated | Researcher |
| context7 (`@upstash/context7-mcp@4.4.4`) | MIT client, hosted free tier | queries Upstash's docs service | Researcher |

Your own servers go in `<data folder>/mcp-servers.json` (Claude Code's `mcpServers` shape) and follow the same rule.
