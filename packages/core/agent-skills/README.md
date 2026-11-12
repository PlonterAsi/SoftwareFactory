# Agents' skills library

Skills an Agent Bay agent can be given (its `skills` list). The core builds a small
plugin folder per agent holding only the skills that agent lists, and turns on the
Skill tool for it, so an agent loads what it uses and nothing else.

Your own skills go in `<data folder>/skills/<name>/SKILL.md` and show up next to these.

| Skill | From | Licence |
|---|---|---|
| frontend-design | anthropics/claude-plugins-official, plugin frontend-design | Apache-2.0 (LICENSE.txt) |
| systematic-debugging | obra/superpowers 7.0.0 | MIT (LICENSE) |
| test-driven-development | obra/superpowers 7.0.0 | MIT (LICENSE) |
| visualize-everything | SoftwareFactory | this repo |

Only the Markdown is copied (no scripts). Re-check the licence when updating a copy.
