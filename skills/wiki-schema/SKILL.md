---
name: wiki-schema
description: Canonical Deep Wiki page, provenance, lifecycle, concurrency, and recovery rules. Apply whenever reading, creating, updating, rebuilding, linting, or querying wiki state.
---

# Wiki schema

The wiki is the durable artifact. LLM callers may interpret and synthesize
knowledge, but `<plugin_root>/scripts/wiki-runtime.js` is the sole authority for deterministic
configuration, lock ownership, versioning, journaled mutation, derived state,
and scan-window transitions on every supported host.

## Storage

<!-- deep-wiki:data -->
```text
WIKI_ROOT/
  pages/
  index.md
  log.md
  log.jsonl
  .wiki-meta/
    .config.json
    index.json
    sources/
    .versions/
    .wiki-lock/owner.json
    .transactions/OPERATION_ID/journal.json
    .transaction-receipts/OPERATION_ID.json
    .pending-scan
    .last-scan
    .quarantine/
    .runtime/scan-window-maintenance.json
```

Pages and source provenance are authoritative. `.wiki-meta/index.json`,
`index.md`, `log.jsonl`, and `log.md` are transactionally maintained
representations. A caller never mutates one representation independently.

## Page and provenance rules

Every page is a flat kebab-case `.md` file with `title`, `sources`, and `tags`
frontmatter plus optional `aliases`. Use standard Markdown links. Each source
slug on a page must correspond to `.wiki-meta/sources/SLUG.yaml` containing an
ID, title, type, origin, ingestion time, and created/updated page lists.

## Critical invariants

1. A page filename appears in `pages_created` at most once across lifecycle
   history. Repair actions restore existing pages and classify them as updates.
2. `.last-scan` is monotonic. Promotion succeeds only when the authenticated
   pending value equals the expected UTC value.
3. **Lock atomicity**: every mutation requires an owner token returned by Node
   directory acquisition. `.wiki-lock/owner.json` binds token, operation,
   process, host, start time, and lock identity. Release and recovery revalidate
   full ownership; direct directory deletion is forbidden. The canonical
   operation catalog is in `<plugin_root>/skills/wiki-schema/references/storage-layout.md` and applies to
   wiki-ingest, wiki-query, wiki-rebuild, and wiki-lint.
4. Every page source slug has a corresponding provenance record.
5. A transaction operation ID is stable across retry and journal recovery.
   Expected hashes prevent concurrent updates from being overwritten.

## Lock recovery

Use `wiki-runtime.js lock status` to inspect contention. Use `wiki-runtime.js
lock recover` only when the stored owner is structurally valid, the same-host
process is no longer live, the directory identity still matches, and the age
policy is met. `--force` bypasses age only. `owner.json` and the owner token are
capabilities, not informational labels.
Ordinary acquisition may self-heal without an age delay only after proving the
existing owner is structurally valid, same-host, and dead; live, foreign,
malformed, and ownerless states remain contended.

## Journal and atomic commit

One manifest-backed commit owns page writes, version backups, source records,
catalog refresh, and lifecycle records. The runtime writes a journal intent,
applies expected-hash-guarded changes, and records terminal state. An
interruption is resolved with `wiki-runtime.js transaction recover` using the
same operation ID. A caller that already holds the lock injects `--lock-token`;
the public operator form omits the token and self-locks. A caller never creates
split mutations.
The shared terminal pruner has three callers: `scan-window ensure`,
`wiki-lint --fix`, and the singular operator command `wiki-runtime.js
transaction prune`. Oversized isolatable store entries are relocated into
`.wiki-meta/.quarantine/` bundles by those three callers plus the operator
command `transaction quarantine`. Bundles are never auto-deleted; after
resolution, stop all hosts and dispose of a bundle directory manually. Ordinary selection removes only fully validated, terminal
scan-window journals older than the requested age while the caller still owns
the lock. The lint recovery pass may bypass that ordinary age test only for
authenticated residue from an already-started prune; it does not broaden
ordinary directory selection. The pruner atomically moves each complete transaction directory into a fresh
identity-bound sibling quarantine and revalidates the directory plus journal
identity, bytes, age, and link count there. An interrupted quarantine remains
recognizable and is retried by a later bounded pass. The runtime keeps an
exact journal-copy reservation at the canonical source through quarantine
removal and creates an exact fsynced journal backup before unlinking the
original. Both use exclusive crash-recoverable pending publication, so a later
bounded pass can resume partial publication, backup-only, empty-quarantine, or
orphaned exact-reservation states. Cleanup checks its deadline across
discovery, validation, and recoverable mutation phases. The command is
bounded; rerun it while `complete` is `false` when a larger backlog must be
traversed. `complete: true` means the pass inspected every listed entry, not
that every ambiguous entry was removed. In-flight, malformed, foreign-kind,
linked, or otherwise ambiguous transaction directories are preserved.
For ensure journals, accepted scan-window markers are exact canonical UTC-Z
plus LF, one-link regular non-symlinks; lstat `ENOENT` alone means absent. Either
initial-invalid marker suppresses every `created`, `preserved`, and `stale`
ensure deletion for the pass, including authenticated already-started residue.
Authenticated already-started residue remains protected until a later pass
begins with both markers accepted or absent. Both physical marker seals for
accepted-or-absent state are revalidated before every destructive boundary; unreadable or
physically ambiguous state remains protected. `created` is reclaimable only when pending
does not match and exact `.last-scan >= input.proposed`; `preserved` and `stale`
are no-op evidence. A raw `.reservation-.prune-*` basename has no supported
producer and is rejected before type or content parsing with stopped-host
guidance.
Manifest transaction recovery remains the separate `transaction recover`
authority. If terminal-prune residue is not accepted by the shared pruner,
stop all hosts before stopped-host manual intervention; never reinterpret it
as manifest recovery.

Valid lifecycle actions are `ingest`, `ingest-skip`, `ingest-repair`,
`ingest-fail`, `update`, `lint`, `rebuild`, `delete`, `query-filed`, and
`setup`. Timestamps are ISO 8601 UTC with a `Z` suffix.

## Setup and auto-ingest authority

The wiki-local `.wiki-meta/.config.json` owns `auto_ingest`. The global host YAML
`auto_ingest` is only a bootstrap/legacy alias; setup and SessionStart migrate
equivalent legacy policy to the wiki-local owner before scanning. Conflicting
local and legacy policies fail closed. Accepted wiki-local keys are
`auto_ingest`, `a5_fanout_threshold`, and `a5_worker_timeout_sec`; migration
preserves A5 keys while moving only `auto_ingest` ownership. The A5 keys are
kept only so existing files stay valid; no host reads them. The ignore globs
are vault-relative inside `auto_ingest`.

Invalid wiki-local config is fail-closed before any legacy fallback:
non-regular file, symlink, duplicate key, invalid UTF-8, or >64 KiB state is
`CONFIG_INVALID`. `CONFIG_CONFLICT` recovery for local-vs-legacy policy values
is to make local and legacy values match, or delete one policy block while all
hosts are stopped. `CONFIG_CONFLICT candidates=...` means cross-host candidate
YAML files diverge; reconcile the named host YAML files while hosts are stopped.
Remove legacy YAML only after `policy_source=wiki_local_migrated`, then
re-resolve and confirm `policy_source=wiki_local` before relying on the local
owner alone.

Stop all hosts before direct edit of global YAML or wiki-local JSON, keep a
backup, and restart one host so the runtime can revalidate. `--replace-config`
does not bypass invalid selected-host YAML; repair or remove the invalid file
under the stopped-host rule before replacing it. Divergent `CODEX_HOME` or
`HOME` values create separate setup-authority domains; share one physical home
for one authority. `.deep-wiki-setup-authority.json` and
`.deep-wiki-setup.reserve` are home authority artifacts, never SessionStart
config candidates. Moving an authority-owned wiki is an explicit stopped-host
rebind, and rebind resumes require the original `CODEX_HOME` and
`DEEP_WIKI_CONFIG` spelling used for the pending rebind. Downgrade remains
backup-only downgrade, not older-version in-place recovery.

## Versioning

Before replacement, the transaction stores the previous page under
`.wiki-meta/.versions/`. Keep the latest three versions per page. Pruning is a
mutation and therefore occurs under the wiki lock, including `/wiki-lint --fix`.

## Auto-Lint

Post-ingest and post-rebuild lint is read-only diagnostics. It reports schema,
link, provenance, catalog, lifecycle, scan-window, and retention drift. Repair
is delegated to the self-locking `/wiki-lint --fix` path and is never silently
performed after token release.
