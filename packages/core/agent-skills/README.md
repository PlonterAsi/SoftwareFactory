# Agents' skills library

Skills an Agent Bay agent can be given (its `skills` list). The core builds a small
plugin folder per agent holding only the skills that agent lists, and turns on the
Skill tool for it, so an agent loads what it uses and nothing else.

Your own skills go in `<data folder>/skills/<name>/SKILL.md` and show up next to these.

| Skill | From | Licence | Given to |
|---|---|---|---|
| architecture-blueprint | anthropics/claude-plugins-official, feature-dev agent code-architect (as a skill, NOTICE) | Apache-2.0 | Architect, Planner |
| architecture-patterns | wshobson/agents, backend-development | MIT | Architect |
| code-exploration | anthropics/claude-plugins-official, feature-dev agent code-explorer (as a skill, NOTICE) | Apache-2.0 | Planner, Cartographer, Surveyor |
| code-simplification | anthropics/claude-plugins-official, pr-review-toolkit agent code-simplifier (as a skill, NOTICE) | Apache-2.0 | Reviewer |
| frontend-design | anthropics/claude-plugins-official, plugin frontend-design | Apache-2.0 | Builder |
| modern-javascript-patterns | wshobson/agents, javascript-typescript | MIT | Builder |
| security-requirement-extraction | wshobson/agents, security-scanning | MIT | Skeptic |
| silent-failure-hunting | anthropics/claude-plugins-official, pr-review-toolkit agent silent-failure-hunter (as a skill, NOTICE) | Apache-2.0 | Reviewer, Fixer, Surveyor |
| stride-analysis-patterns | wshobson/agents, security-scanning | MIT | Skeptic, Reviewer, Surveyor |
| systematic-debugging | obra/superpowers 7.0.0 | MIT | Fixer |
| test-coverage-review | anthropics/claude-plugins-official, pr-review-toolkit agent pr-test-analyzer (as a skill, NOTICE) | Apache-2.0 | Tester, Reviewer |
| test-driven-development | obra/superpowers 7.0.0 | MIT | Tester |
| visualize-everything | SoftwareFactory | this repo | (none yet) |
| wcag-audit-patterns | wshobson/agents, accessibility-compliance | MIT | Builder, Reviewer |

Each folder keeps its LICENSE (and NOTICE when it was adapted). Only Markdown is copied, no scripts.

Left out on purpose: superpowers' brainstorming, writing-plans and verification-before-completion (they ask the
person questions, write plan files or run commands, which a one-shot station agent cannot do), and Express- or
Jest-based skills (SoftwareFactory builds use plain Node with no packages).

MCP servers offered out of the box are in `../agent-mcp.json` (Playwright and Context7, given to the Researcher). The rule for adding one: [docs/mcp-safety.md](../../../docs/mcp-safety.md).
