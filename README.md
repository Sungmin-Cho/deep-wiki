**English** | [한국어](./README.ko.md)

# deep-wiki

![version](https://img.shields.io/github/package-json/v/Sungmin-Cho/deep-wiki?label=version)
![license](https://img.shields.io/github/license/Sungmin-Cho/deep-wiki)
[![part of deep-suite](https://img.shields.io/badge/part%20of-deep--suite-5b8def)](https://github.com/Sungmin-Cho/deep-suite)

An LLM-managed markdown wiki for persistent knowledge accumulation — a plugin implementation of [Karpathy's LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) philosophy for Claude Code and Codex.

> *"Most people's experience with LLMs and documents looks like RAG: you upload a collection of files, the LLM retrieves relevant chunks at query time, and generates an answer. This works, but the LLM is rediscovering knowledge from scratch on every question. There's no accumulation."*
> — Andrej Karpathy

Instead of re-discovering knowledge each time (RAG), deep-wiki **incrementally builds and maintains a persistent wiki** — a structured, interlinked collection of markdown files. When you add a new source, the LLM reads it, extracts key information, and integrates it into the existing wiki. The cross-references are already there; the contradictions have already been flagged; the synthesis already reflects everything you've read. The knowledge is compiled once and kept current, not re-derived on every query.

## Role in deep-suite

deep-wiki is the **persistent knowledge layer** of the [deep-suite](https://github.com/Sungmin-Cho/deep-suite). In the [Harness Engineering](https://martinfowler.com/articles/harness-engineering.html) 2×2 matrix it acts as an **Inferential Guide** — accumulated project knowledge that shapes the agent's understanding, replacing repeated RAG queries with a compounding knowledge base. The 5 `/wiki-*` entry points are skills, so they run natively from Claude Code (slash commands) and from Codex / Copilot CLI / Gemini CLI / the Agent SDK via `Skill({ skill: "deep-wiki:wiki-<verb>" })`.

## Architecture

Based on Karpathy's three-layer model:

```
Raw Sources  →  Wiki (markdown pages)  →  Schema (management rules)
    ↑                   ↑                        ↑
 wiki-ingest        pages/               wiki-schema skill
```

| Layer | Description | Owner |
|-------|-------------|-------|
| **Raw Sources** | Immutable inputs — files, URLs, text, reports | You curate |
| **Wiki** | LLM-generated markdown pages with cross-references | LLM writes, you read |
| **Schema** | Rules governing how the wiki is structured and maintained | Co-evolved |

## Install

### Via the deep-suite marketplace (recommended)

```bash
# Claude Code
/plugin marketplace add Sungmin-Cho/deep-suite
/plugin install deep-wiki@claude-deep-suite

# Codex
codex plugin install deep-wiki
```

### Standalone

```bash
/plugin marketplace add Sungmin-Cho/deep-wiki
/plugin install deep-wiki@Sungmin-Cho-deep-wiki
```

Prerequisite: the [Claude Code](https://docs.anthropic.com/en/docs/claude-code) CLI (or Codex) installed and configured.

## Quick start

```bash
# 1. Initialize the wiki
/wiki-setup ~/Obsidian/MyVault/wiki

# 2. Ingest sources into the wiki
/wiki-ingest https://example.com/article
/wiki-ingest ./document.pdf
/wiki-ingest                       # paste text directly

# 3. Query the wiki
/wiki-query What are the rules of React hooks?

# 4. Health check
/wiki-lint
```

## Commands

| Command | Description |
|---------|-------------|
| `/wiki-setup` | Initialize the wiki and create the directory structure |
| `/wiki-ingest` | Read a source (URL, file, text, deep-work report) and create/update wiki pages |
| `/wiki-query` | Search the wiki and generate grounded answers; auto-files cross-page syntheses back into the wiki |
| `/wiki-lint` | Health check — schema violations, orphan pages, broken links, contradictions (also runs automatically after ingest/rebuild) |
| `/wiki-rebuild` | Regenerate the machine-readable index from page frontmatter |

### Operations in detail

**Ingest** — Drop a new source and the LLM reads it, writes summary pages, updates the index, updates relevant pages across the wiki, and appends to the log. A single source might touch multiple pages. New information is merged with existing content — pages grow richer with each ingest. **Auto-lint runs after every ingest.**

**Query** — Ask questions against the wiki. The LLM searches for relevant pages using a three-layer strategy (index scan → content search → candidate reading) and synthesizes a grounded answer with citations. **When a query synthesizes insights across 2+ pages, the result is automatically filed back into the wiki** — the knowledge compounds.

**Lint** — Health-check the wiki: schema violations, contradictions, orphan pages, broken links, stale versions, and index drift. `--fix` auto-repairs structural issues. **Runs automatically after ingest and rebuild** — invoke it manually for deep inspections.

**Rebuild** — Regenerate `index.json` from page frontmatter. Use when the index is out of sync or corrupted. Auto-lint runs afterward.

## Storage structure

```
<wiki_root>/
├── index.md                  # LLM-written dashboard (human-readable)
├── log.md                    # LLM-written chronicle (human-readable)
├── log.jsonl                 # Append-only structured event log
├── pages/                    # Wiki pages (flat, tag-based classification)
└── .wiki-meta/
    ├── .config.json          # Wiki-local auto-ingest and A5 knob config
    ├── index.json            # Machine-readable page catalog (derived; M3 envelope-wrapped)
    ├── sources/              # Per-source provenance YAML files
    └── .versions/            # Page backups before overwrite (last 3)
```

Key design decisions:
- **Flat `pages/` directory** — no subdirectories. Tags replace categories (more flexible, no broken links from moves).
- **Dual artifacts** — `index.md`/`log.md` are LLM-written for humans; `index.json`/`log.jsonl` are machine-readable counterparts.
- **`.wiki-meta/` is hidden** — invisible in Obsidian's graph view and file explorer.

## Configuration

`~/.claude/deep-wiki-config.yaml`:

```yaml
wiki_root: ~/Obsidian/MyVault/wiki

# Auto-detected by /wiki-setup when Obsidian CLI is available (optional)
obsidian_cli:
  available: true
  vault_name: "My Vault"
  vault_path: ~/Obsidian/MyVault
  wiki_prefix: "wiki"
```

### Auto-ingest scope (`auto_ingest`)

The SessionStart hook accepts an optional `auto_ingest` block to filter what it scans, in any of three YAML forms (all equivalent; when both block and dotted forms appear, the entries are unioned):

```yaml
# Block form
auto_ingest:
  ignore_globs:
    - "**/archive-*.md"
    - "**/draft-*.md"
  require_tag: project        # only ingest files whose frontmatter carries this tag

# Inline form
auto_ingest:
  ignore_globs: ["**/archive-*.md", "**/draft-*.md"]

# Dotted form
auto_ingest.ignore_globs: ["**/archive-*.md"]
```

The YAML examples above are bootstrap/legacy alias forms. The owning wiki-local file is `<wiki_root>/.wiki-meta/.config.json` and uses JSON:

```json
{
  "auto_ingest": {
    "ignore_globs": ["archive/**"],
    "require_tag": "project"
  }
}
```

Production ownership: wiki-local `.wiki-meta/.config.json` owns `auto_ingest`. Accepted wiki-local keys are `auto_ingest`, `a5_fanout_threshold`, and `a5_worker_timeout_sec`; migration preserves A5 keys while moving only `auto_ingest` ownership. The A5 keys are kept only so existing files stay valid; `/wiki-ingest` runs in the main caller on every host and reads neither. The ignore globs are vault-relative, so `notes/private/**` matches from the vault root rather than from the wiki metadata directory.

The global host YAML `auto_ingest` is only a bootstrap/legacy alias; `/wiki-setup` and SessionStart migrate equivalent legacy policy into the wiki-local file before scanning, and retained global aliases continue to resolve until you remove them. Remove legacy YAML only after `policy_source=wiki_local_migrated`, then re-resolve and confirm `policy_source=wiki_local` before relying on the local owner alone. Conflicting local and legacy policies fail closed; `CONFIG_CONFLICT` recovery for local-vs-legacy policy values is to make local and legacy values match, or delete one policy block while all hosts are stopped. `CONFIG_CONFLICT candidates=...` means cross-host candidate YAML files diverge; reconcile the named host YAML files while hosts are stopped. Representative invalid local config shapes, including non-regular file, symlink, duplicate key, invalid UTF-8, or >64 KiB, fail closed with `CONFIG_INVALID`; other malformed or unsupported wiki-local keys also fail closed.

Stop all hosts before direct edit of either file, keep a backup, then restart one host and let the runtime revalidate. `--replace-config` does not bypass invalid selected-host YAML; repair or remove that selected host file under the stopped-host rule before replacing it. Divergent `CODEX_HOME` or `HOME` values create separate setup-authority domains, so use one physical home when sharing a wiki. `.deep-wiki-setup-authority.json` and `.deep-wiki-setup.reserve` are home authority artifacts, never SessionStart config candidates. Moving an authority-owned wiki requires an explicit stopped-host rebind; rebind resumes require the original `CODEX_HOME` and `DEEP_WIKI_CONFIG` spelling used when the pending rebind was published. Rollback remains backup-only downgrade, not in-place mutation by an older version.

### Cloud-backed `wiki_root` (iCloud / Google Drive / Dropbox)

If your Obsidian vault lives on a sync-daemon-mounted path, every wiki write wakes the sync client and adds hundreds of milliseconds of latency per `Read`/`Write` — a typical 5–10 page ingest can add 15–30s of pure I/O wait. Recommended workflow:

1. **Run the wiki on local disk.** Point `wiki_root` at a non-synced path, e.g. `~/deep-wiki-local/`.

   > When `wiki_root` is a non-vault local path, the SessionStart hook watches its parent directory (`dirname "$WIKI_ROOT"`, i.e. `$HOME`), producing noisy auto-ingest candidates. In this mode either disable the hook in `~/.claude/settings.json` or set `auto_ingest.ignore_globs: ['**']`, and rely on reverse-rsync from the vault instead of hook-driven detection.

2. **Mirror to the vault on a schedule** with `rsync` from launchd (macOS) or cron. Use **additive sync only — `--delete` is intentionally omitted**, since the plugin has no external-edit conflict detection and `--delete` could silently destroy edits made on other devices:
   ```bash
   rsync -a --backup --backup-dir="$HOME/.deep-wiki-rsync-backups/$(date +%Y%m%d-%H%M%S)" \
     ~/deep-wiki-local/ \
     "$HOME/Library/CloudStorage/GoogleDrive-.../Obsidian/Personal Vault/deep-wiki/"
   ```

3. **Multi-device editing requires manual reverse-sync first.** If you edit pages in Obsidian on another device, bring those edits into local *before* the next scheduled push:
   ```bash
   rsync -a "$HOME/Library/CloudStorage/.../deep-wiki/" ~/deep-wiki-local/
   ```
   Removing the `auto_ingest:` block does **not** pause auto-ingest (it reverts to whole-vault detection, which is *more* aggressive); instead set `ignore_globs: ['**']` or disable the SessionStart hook.

## Auto-ingest (SessionStart hook)

The plugin ships a SessionStart hook that **automatically detects new or modified files** in the Obsidian vault each time a Claude Code session starts — write notes as usual and the wiki stays up to date.

1. On session start, the hook scans the vault for `.md` files modified since the last scan.
2. If the Obsidian CLI is available, `obsidian recents` supplements the scan (union + dedupe, with mtime verification).
3. If new files are found, Claude is instructed to auto-ingest them.
4. Files are grouped by topic and batch-processed; auto-lint runs afterward.

Excluded from scanning: to-do files, VPN passwords, `.obsidian/` internals, and the wiki itself.

## Obsidian compatibility

- Create the wiki inside an Obsidian vault to leverage graph view, backlinks, and search — or use it as a plain markdown directory without Obsidian.
- `.wiki-meta/` is automatically hidden from Obsidian.
- Standard markdown links (not wikilinks) ensure portability.

When `/wiki-setup` detects an Obsidian vault, it checks for recommended plugins and reports their status. If the Obsidian CLI is installed and the app is running, wiki operations use it for richer results (with filesystem fallback when it is not):

| Feature | CLI command | Fallback |
|---------|-------------|----------|
| Content search | `obsidian search:context` | Grep |
| Orphan detection | `obsidian orphans` | Regex link scan |
| Broken link detection | `obsidian unresolved` | File existence check |
| Backlink analysis | `obsidian backlinks` | Not available |
| Tag statistics | `obsidian tags counts` | Frontmatter parsing |

**Recommended Obsidian plugins:** Graph view (see hubs and orphans), Dataview (query page frontmatter), Marp Slides (render slide decks), and the [Obsidian Web Clipper](https://obsidian.md/clipper) (clip web articles for quick ingest).

## Recommended tools

Tools referenced in [Karpathy's LLM Wiki gist](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) that enhance the workflow. `/wiki-setup` checks whether each is installed and shows install commands for any that are missing.

| Tool | Purpose | Install |
|------|---------|---------|
| **qmd** | Local markdown search engine with BM25/vector search and LLM re-ranking. Also works as an MCP server. | `npm install -g @tobilu/qmd` |
| **marp** | Generate slide presentations (HTML/PDF/PPTX) from markdown wiki pages. | `npm install -g @marp-team/marp-cli` |
| **obsidian** | Obsidian CLI — search, backlinks, tags, properties via the running Obsidian app. Auto-detected by `/wiki-setup`. | [Obsidian CLI](https://github.com/anthropics/obsidian-cli) |

```bash
qmd collection add ~/Obsidian/MyVault/wiki/pages   # index your wiki with qmd
marp wiki-page.md -o slides.html                   # generate slides from a wiki page
qmd mcp --http                                     # run qmd as an MCP server
```

## deep-work integration

Ingest deep-work session reports into the wiki:

```bash
/wiki-ingest /path/to/deep-work/session/report.md
```

## Platform support

| OS | Status | Notes |
|---|---|---|
| macOS | Supported | Fixed CI evidence on macOS arm64 and Intel. |
| Linux | Supported | Fixed CI evidence on Ubuntu 24.04 x64. |
| Windows | Supported | Native Node 22 hook evidence on Windows Server 2025 x64; no Git Bash or WSL2 runtime requirement. |


## Runtime support and safety boundaries

- **Writer protocol.** Every mutation uses a cooperative current writer contract.
  Lock takeover is accepted only after complete post-seizure owner and directory
  checks. An ambiguous lock requires stopped-host intervention; do not run a
  concurrent old version against the same wiki.
- **Durability scope.** The guarantee is mounted-filesystem and process-termination
  durability. It does not claim survival of power loss, broken remote filesystems,
  or a hostile process with access to the same directory.
- **Hook launch.** The shipped hook is Node 22. Codex pre-expands the installed
  plugin root and delegates the selected Windows command to the host-owned
  `%COMSPEC% /C` boundary. There is no shipped shell-script runtime; the historical
  `scripts/v0-probe/*-record.sh` files are maintainer probes, not runtime entrypoints.
- **Runtime surface.** deep-wiki ships no plugin MCP server or native binary and
  has no runtime package dependency. The optional `qmd mcp` command above belongs
  to the external qmd tool, not this plugin.
- **Evidence scope.** Fixed jobs cover Windows Server 2025, Ubuntu 24.04, and
  macOS arm64 and Intel. This is no Windows 11 claim. Installed-Codex evidence
  used an unauthenticated local Responses fixture to exercise plugin
  install/discovery and hooks; it is not production OpenAI API, login,
  model-quality, Windows 11, arbitrary-user-machine, or OS-level no-egress
  certification.
- **Upgrade and rollback.** Stop every host and take an authenticated complete
  backup before the first 1.8 operation. If 1.8 has written state, direct in-place
  rollback is unsupported: recover with 1.8 while stopped, then use a backup-only
  downgrade before starting 1.7.1. The same applies to 1.9: after a 1.9 write,
  recover with 1.9 while stopped, restore the authenticated pre-upgrade backup,
  then start 1.8.2 — a 1.9 in-flight journal (`contract_version` 2) cannot be
  recovered by 1.8.x. After a 1.10 write, recover with 1.10 while stopped,
  restore the authenticated pre-upgrade backup, then start 1.9.x.

## Philosophy

> *"The tedious part of maintaining a knowledge base is not the reading or the thinking — it's the bookkeeping. Updating cross-references, keeping summaries current, noting when new data contradicts old claims, maintaining consistency across dozens of pages. Humans abandon wikis because the maintenance burden grows faster than the value. LLMs don't get bored, don't forget to update a cross-reference, and can touch 15 files in one pass."*
> — Andrej Karpathy

The human's job is to curate sources, direct the analysis, ask good questions, and think about what it all means. The LLM's job is everything else.

## Links

- [CHANGELOG](CHANGELOG.md) — release history
- [deep-suite](https://github.com/Sungmin-Cho/deep-suite) — the marketplace and the other plugins
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License

MIT
