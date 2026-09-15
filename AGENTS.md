# deep-wiki — Agent Guide

LLM-managed markdown wiki for persistent knowledge accumulation, exposing skills and
hooks to both Claude Code and Codex. It ships no subagents: every skill runs in the
host's main session.

Read the version with `jq -r .version <plugin_root>/.claude-plugin/plugin.json` — anchored,
because unanchored that command reads the *analysed* project's manifest, and every
plugin checkout has one. It is triple-synced across `<plugin_root>/.claude-plugin/plugin.json`,
`<plugin_root>/.codex-plugin/plugin.json` and `<plugin_root>/package.json`.
Never hardcode it in a doc. Dev setup, tests and PR rules live in `CONTRIBUTING.md`;
documentation rules in `docs/DOCS_RULE.md` — a maintainer rulebook that is gitignored and
ships with nothing. It exists only in a maintainer's own checkout; never try to open it at
runtime, because the only place that path can resolve in an installed plugin is the project
being analysed.

## Where the contracts live

| Concern | Authority | Gate |
|---|---|---|
| Wiki state — storage layout, page + provenance schema, invariants, lock and journal protocol, lifecycle `action` vocabulary | `skills/wiki-schema/`: `SKILL.md` (LLM-readable), `wiki-schema.yaml` (machine-readable), `references/storage-layout.md` (operation catalog) | `npm test` |
| Per-skill runtime routes | `<plugin_root>/skills/wiki-*/SKILL.md`; every argv is allowlisted in `<plugin_root>/scripts/lib/executable-contract.js` | `npm run lint:commands` |
| No shipped subagents — `/wiki-ingest` runs main-caller-sequential on every host | no agents directory or manifest `agents` key; `<plugin_root>/skills/wiki-ingest/SKILL.md` §2 | `npm run lint:agents` |
| SessionStart vault scan | `<plugin_root>/hooks/hooks.json` (15-second timeout) → `<plugin_root>/hooks/scripts/` | `npm run lint:hook-command` |
| Emitted `index.json` envelope | `<plugin_root>/hooks/scripts/envelope.js` | `npm run validate-fixture` |

`<plugin_root>/scripts/wiki-runtime.js` is the sole authority for configuration, lock ownership,
versioning, journaled mutation, derived state and scan-window transitions. Skills and
agents describe intent; they never mutate wiki state directly.

A new entry skill is auto-discovered on both hosts from `skills/<name>/SKILL.md` with
`user-invocable: true` and `runtime_hosts: [claude, codex]` frontmatter. Register it in
`SKILL_COMMAND_CONTRACTS` (`<plugin_root>/scripts/lib/executable-contract.js`) in the same change: the
linters iterate that map, so a skill missing from it is never argv-validated by anything.

## Invariants that bite

- **`<wiki_root>/`** (underscore) is the canonical wiki path prefix suite-wide; the
  hyphen spelling is forbidden and the suite's `check-memory-hierarchy.js` fails on it.
- **`log.jsonl` sits at the vault root; `index.json` sits under `.wiki-meta/`.** The
  asymmetry is deliberate and load-bearing — deep-dashboard resolves both paths
  literally and has already shipped one bug from assuming symmetry.
- **The lifecycle `action` vocabulary is a cross-plugin contract.** deep-dashboard
  counts `ingest`, `ingest-skip`, `ingest-repair` and `ingest-fail` by name, so
  renaming one silently zeroes a suite metric. The full list is `wiki-schema.yaml`
  `log.actions`; the manifest `operation` for auto-filing is `query-autofile` while the
  emitted `action` is `query-filed`, and both literals are test-pinned.
- **`.wiki-meta/index.json` is an M3 aggregator envelope**: its payload must keep
  `pages`, and `parent_run_id` is absent by default — only an explicit
  `--parent-run-id` sets it, and deep-dashboard treats this kind as an aggregator whose
  `run_id` is never a valid parent target.
- **Timestamps are `YYYY-MM-DDTHH:MM:SSZ`** — never a local offset, because log
  analysis relies on lexicographic order matching chronological order.
- **The suite advertises these paths** in `suite-extensions.json`; renaming one breaks
  `check-pinned-plugin-paths.js`: `<wiki_root>/log.jsonl`,
  `<wiki_root>/.wiki-meta/index.json`, `<wiki_root>/.wiki-meta/.versions/*`,
  `<wiki_root>/pages/**/*.md`, and the read path `<wiki_root>/.wiki-meta/.pending-scan`.

## Runtime safety boundary

`<plugin_root>/tests/plugin-contract.test.js` pins fourteen phrases drawn from the bullets below across
`README.md`, this file, `CONTRIBUTING.md` and `SECURITY.md` (with a Korean mirror in
`README.ko.md`). That covers the load-bearing wording, not every clause: the
version-specific detail — `contract_version` 2, the 1.8 → 1.7.1, 1.9 → 1.8.2 and 1.10 → 1.9.x pairs, the
Windows plugin-root pre-expansion — is asserted by **no doc test**, so the prose can rot
even while the behaviour holds (`<plugin_root>/tests/wiki-state-runtime.test.js` does pin the journal's
`contract_version`). Change any of it only when the evidence changes.

- Mutation is governed by a cooperative current writer contract with complete
  post-seizure owner and directory checks. Ordinary acquisition self-heals only
  a structurally valid, same-host owner whose process is proved dead; ambiguous
  locks require stopped-host intervention and a concurrent old version is
  unsupported.
- The claim is mounted-filesystem and process-termination durability only.
- The Node 22 SessionStart hook uses Codex's host-owned `%COMSPEC% /C` boundary on
  Windows, where Codex additionally pre-expands the plugin root before that launch
  boundary runs. There is no shipped shell-script runtime; the three
  `scripts/v0-probe/*-record.sh` files are maintainer-only historical probes.
- The plugin has no plugin MCP server or native binary and no runtime dependency. CI
  evidence covers Windows Server 2025 and macOS arm64 and Intel; it is no Windows 11
  claim.
- Installed-Codex evidence uses an unauthenticated local Responses fixture. It is not
  production OpenAI API, login, model-quality, Windows 11, arbitrary-user-machine, or
  OS-level no-egress certification.
- Rollback is a backup-only downgrade: stop all hosts, let the current version finish
  recovery, restore the authenticated pre-upgrade backup, then start the older one
  (1.8 → 1.7.1, 1.9 → 1.8.2, 1.10 → 1.9.x). A 1.9 in-flight journal uses `contract_version` 2, which
  1.8.x cannot recover, so an interrupted 1.9 commit must be completed with 1.9 first.
  A post-1.10 rollback is likewise backup-only: stop all hosts, let 1.10 finish
  recovery, restore the authenticated pre-upgrade backup, then start 1.9.x.

## Conventions

- **Node 22 portability.** Shipped runtime entrypoints are CommonJS. Use `node:` APIs,
  preserve Windows drive and UNC paths without POSIX conversion, launch children with
  `shell: false`, and add no shipped `.sh`, `.cmd`, `.bat` or `.ps1` runtime.
- **One task per commit.** Never `git add -A` — explicit paths only, so an untracked
  vault path or transcript cannot leak.
- `docs/` is gitignored: plans, handoffs and review notes are author-local. Put PR
  material in the PR description. `.claude/.hook-tool-input.*` transcripts are ignored
  for the same reason — they carry the session ID and the user's vault path.
- Significant changes run `/deep-review` to convergence before and after
  implementation. For config, hook or parser-driven changes, verify against the actual
  parser rather than re-reading the spec: self-coherent is not executable.

## Release

The plugin repo owns its own release: bump the version triple, add the entry to
`CHANGELOG.md` **and** `CHANGELOG.ko.md`, then merge to `main`.

Re-pinning the suite happens in `claude-deep-suite` and takes four steps, because
deep-suite's own release-bump script writes its marketplace manifest only while the
`preflight` it runs checks the Codex mirror and the workflow guides too:

1. `npm run release:bump -- deep-wiki <sha40> --description="<new headline>"`. The
   `--description=` flag is the only thing that updates the marketplace blurb; omit it
   and the old headline stays. The command applies the sha and then runs `preflight`,
   which is **expected to fail** here. Steps 2 and 3 are ordered to match how that
   failure surfaces: `preflight` is an `&&` chain
   (`validate → docs:check → docs:sync → validate-artifact-fixtures → test`), so
   `docs:sync` stops it before `npm test` ever runs.
2. Update the deep-wiki version mentions in `guides/integrated-workflow-guide.md` and
   `guides/integrated-workflow-guide.ko.md` — this is the **first** failure, raised by
   `check-guide-version.js` inside `docs:sync`. That narrative is hand-curated prose
   outside the auto-generated markers, so `docs:write` never regenerates it.
3. Sync `.agents/plugins/marketplace.json` by hand — the next failure, from
   deep-suite's Codex marketplace contract test, which only becomes reachable once
   `docs:sync` passes. Copy all three fields the bump touched: the `source` object, the
   redundant top-level `sha` mirror, and `description`. The contract test compares only
   `source`, so a stale top-level `sha` or blurb in the mirror passes every gate and
   drifts silently.
4. `npm run preflight` — confirm green, then commit and push. The edits above are
   automated or hand-made per step, but committing and pushing the suite is still manual.

Never hand-edit the suite README plugin table: it lives inside
`<!-- deep-suite:auto-generated:plugin-table-en -->` markers and step 1 regenerates it. A
feature release should also get a hand-written bullet appended to the `### Key features`
list in the suite `README.md` / `README.ko.md` `## deep-wiki` section.
