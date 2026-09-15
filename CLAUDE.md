@AGENTS.md

# deep-wiki — Claude Code notes

`AGENTS.md` (imported above) carries every shared runtime rule. `README.md` explains
what the plugin is and why. Only Claude Code-specific behaviour belongs here.

- The five entry skills are reachable as slash commands (`/wiki-setup`, `/wiki-ingest`,
  `/wiki-query`, `/wiki-lint`, `/wiki-rebuild`). Other hosts call the same skills as
  `Skill({ skill: "deep-wiki:wiki-<verb>" })`, and both routes must stay identical.
- deep-wiki ships no subagents. `/wiki-ingest` does its analysis and page writing in
  the main session, exactly as on Codex, so each body is written with the full source
  and the current page in view. See `<plugin_root>/skills/wiki-ingest/SKILL.md` §2.
