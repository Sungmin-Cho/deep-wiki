# Changelog

All notable changes to deep-wiki are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.11.0] — 2026-09-15 (main-caller ingest)

### Changed

- `/wiki-ingest` now runs in the main caller on Claude Code, as it already did on Codex. One host-neutral `main-caller-sequential` route analyzes each input in stable order, writes every page body with the full source and the current page on disk in view, and validates it before the next plan. Claude Code previously delegated this work to three subagents pinned to Sonnet, and the page writer saw only the excerpts serialized into its payload, which made large ingests slow and could drop source context.
- The grounding rules and the URL source-origin prompt contract those agents carried now live in `/wiki-ingest` §3, together with the rule that an update is written from the complete page read from disk.
- `/wiki-ingest` now states the manifest rules a multi-source merge needs: a merged page is listed only by its first contributing source's event, a failure leaves its whole merge group out of the manifest and registers once per run, and a batch too large to keep in view commits group by group before the pending window is promoted. The commit's own `EXPECTED_HASH_CONFLICT` check replaces a reference to snapshot page hashes the runtime never returned, and the `wiki-schema.yaml` failure-state prose now describes the current runtime while keeping legacy field names.
- `a5_fanout_threshold` and `a5_worker_timeout_sec` stay accepted wiki-local keys and `config resolve --json` still reports them, so existing `.wiki-meta/.config.json` files remain valid, but no host reads them.
- No runtime, journal, manifest, or wiki state format changed; pages, provenance, and lifecycle events keep their existing contract.
- These changes ship under a distinct 1.11.0 installation identity across both plugin manifests and package metadata.

### Removed

- All four `agents/*.md` files: `wiki-synthesizer-analysis`, `wiki-synthesizer-worker`, `wiki-page-writer`, and the dormant `wiki-synthesizer-inline`. A caller that dispatched a `deep-wiki:wiki-*` agent directly must run `/wiki-ingest` instead. `npm run lint:agents` now fails if an agent file, a manifest `agents` key, or a delegation instruction reappears, or if the ingest route record or any clause of its URL rule goes missing.

## [1.10.1] — 2026-08-26 (worker dispatch contract)

### Fixed

- `config resolve --json` now exposes the effective `a5_fanout_threshold` and `a5_worker_timeout_sec`, including defaults, through the validated runtime path. Both knobs must be positive safe integers, so Claude never receives an unusable fanout threshold or wall-clock budget.
- Claude ingest dispatch now reads each qualified agent's anchored input/output contract exactly. Named-agent resolution and invalid output remain fail-closed; only a true non-response at the effective timeout discards late output and replays the affected work item through the stable main-caller `analyze` → `write` → `validate` route before complete-manifest validation and mutation.

### Changed

- These fixes ship under a distinct 1.10.1 installation identity across both plugin manifests and package metadata.

## [1.10.0] — 2026-08-25 (oversized transaction isolation)

### Fixed

- `/wiki-setup` now emits its setup lifecycle event with the canonical `YYYY-MM-DDTHH:MM:SSZ` timestamp, so the documented setup route no longer fails with `MANIFEST_INVALID`.
- An oversized leftover transaction directory no longer wedges every runtime inspection with a permanent `DEADLINE_EXCEEDED`. Readers classify it as `TRANSACTION_OVERSIZED`, lock-held writers skip the interior, and isolatable names can be moved with `transaction quarantine` without deleting the tree. SessionStart ensure, lint fix, transaction prune, and transaction quarantine automatically relocate isolatable oversized trees into `.wiki-meta/.quarantine/` bundles that are never auto-deleted; after resolution, stop all hosts and dispose of a bundle manually.
- `transaction recover --wiki-root … --operation-id … --json` is self-locking when `--lock-token` is omitted, so rollback quarantine `follow_up` is an executable second stage. Callers that already hold a lock may still inject `--lock-token`. A public recover that self-acquired the lock and hits `DEADLINE_EXCEEDED` now emits a tokenless self-locking retry; only token-injected callers receive `--lock-token <token>`. Both retry hints use the same absolute, shell-quoted `scripts/wiki-runtime.js` path as isolatable oversized hints, so the exact command is executable from a non-plugin cwd.
- Reservation-only quarantine re-proves that the `.prune-*` source is still absent immediately before creating `.quarantine` and before every later bundle, metadata, or reservation mutation. The final complete marker publish re-proves that absence through `writeMaintenanceMarker` `beforePublish`. A reappeared source fails `WIKI_STATE_FILESYSTEM` as committed/incomplete after the reservation has moved; it never records a false complete.
- Isolatable `TRANSACTION_OVERSIZED` hints now include a complete `node` invocation of the actual `scripts/wiki-runtime.js` path. Direct and rollback commands each live on independently copyable lines for POSIX and labeled PowerShell.
- Per-directory prune pressure-probe failures (`EACCES`/`EIO` and other non-ENOENT errors) now travel through `terminal_prune` with accumulated `processed`, `removed`, `complete: false`, and `skipped_oversized`, so lint repair can persist or promote that residue under a still-valid lock before rethrowing.

### Changed

- `auto_ingest` policy now lives in `<wiki_root>/.wiki-meta/.config.json`; `/wiki-setup` and SessionStart create it by migrating an equivalent global YAML block. `/wiki-setup` also creates `~/.deep-wiki-setup-authority.json` and `~/.deep-wiki-setup.reserve/`. Divergent local/legacy policy and representative invalid local config shapes now fail closed.
- Operator docs now describe the bootstrap/legacy YAML alias, `CONFIG_CONFLICT` and `CONFIG_INVALID` recovery boundaries, stopped-host direct edits, divergent physical homes, explicit rebind, and backup-only downgrade safety.
- Lint inspect reports isolation history in informational `maintenance_residue` without flipping `ok`. Partial setup accepts `.quarantine` and a validated engine-owned `.runtime/scan-window-maintenance.json`.

## [1.9.7] — 2026-08-05 (content metadata and nested prune safety)

### Fixed

- Nested terminal and quarantine metadata left by desktop shells or sync clients is now reclaimed as bounded internal scan-window prerequisite work under the current owner and complete directory-identity chain. A held regular file reports `terminal_prune.complete: false` before any later authenticated journal, backup, reservation, operation, or quarantine evidence is removed; non-regular recognized names remain recovery conditions and nested cleanup never widens top-level `removed_junk`.
- The scan-window prune-name preflight now uses a parent-first `.wiki-meta` anchor before treating a missing `.transactions` child as benign, so a symlinked metadata parent fails closed with `SCAN_WINDOW_FILESYSTEM`.
- Content readers now skip regular AppleDouble and exact OS-metadata files in `pages/`, `.wiki-meta/sources/`, and `.wiki-meta/.versions/`, report them in `ignored_os_metadata`, and never delete them; junk-named symlinks/directories remain fail-closed, and `removed_junk` remains transaction-store-only.

### Changed

- These fixes ship under a distinct 1.9.7 installation identity across both plugin manifests and package metadata.

## [1.9.6] — 2026-08-04 (transaction store junk tolerance)

### Fixed

- A desktop shell or sync client writing its own metadata file into `<wiki_root>/.wiki-meta/.transactions/` no longer wedges the wiki. Previously any non-directory entry there — a macOS `.DS_Store` being the common case on an Obsidian vault held in cloud storage — failed every route that inspects transaction state (`snapshot`, `commit`, `index read`, `transaction recover`, `lint inspect`, and `lint fix`) with `TRANSACTION_RECOVERY_REQUIRED`, and the bounded debris sweep skipped non-directories, so no shipped command could clear it. Recognized OS metadata is now treated as inert debris: lock-free readers step over it, and the lock-held debris sweep reclaims it during `commit`, `lint --fix`, and scan-window maintenance. Recognition is by exact name plus the AppleDouble `._` prefix, and only for a plain regular file whose type is re-proved immediately before removal — an unrecognized stray entry, and a symlink wearing a recognized name, still demand recovery and are never followed or removed. Reclamation is an `unlink`, never a recursive delete. Because this class is by definition written and held by a foreign process, a refused unlink (`EPERM`, `EACCES`, `EBUSY`, `EROFS`, `ETXTBSY`) leaves the file in place and lets the enclosing route continue rather than failing it with a raw errno; readers already tolerate the file and a later pass retries. That tolerance is scoped to the unlink alone — a failure while proving the owner token or the store anchor still fails closed, whatever its errno. `wiki-runtime lint fix` reports exactly what it reclaimed as `removed_junk`, computed by diffing the store across the whole operation so a nested commit sweep is included, plus `removed_junk_complete` for whether any recognized metadata remains.
- Transaction-class debris is now swept to completion before any OS metadata is considered. Ordering, not a second budget, is what keeps inert files from displacing or outrunning a cancelled-transaction teardown — the only debris class fatal to a lock-free reader — so one pass still mutates at most `limit` entries in total, and every junk reclamation *attempt* counts against it so an unremovable file cannot be retried without bound.

### Security

- The bounded transaction debris sweep now anchors its own store before it enumerates or deletes anything. `readdirSync` follows a directory symlink, so a `.wiki-meta` or `.wiki-meta/.transactions` symlink previously let the sweep delete entries outside the wiki, and a missing `.transactions` under a symlinked `.wiki-meta` let `commit` go on to create a transaction directory and journal outside it; lock ownership proves who may write, never where. Both `.wiki-meta` and `.wiki-meta/.transactions` are now proved to be physical directories whose real path equals their expected path, and that identity — device, inode, and birth time, so a recycled inode cannot impersonate it — is re-proved alongside the owner token immediately before every removal, catching a parent replaced mid-sweep. `lint --fix` and scan-window maintenance already anchored through their scan-window preflight; `commit` did not, and now fails closed with `WIKI_STATE_FILESYSTEM` before creating or deleting anything. Because the sweep's anchor expires when the sweep returns, transaction creation re-proves it before `.transactions` is created and again immediately before the activation directory is renamed into place.
- Known residual: the anchor and the removal it guards cannot be made atomic on this runtime. Node exposes no handle-relative `unlinkat`, and this plugin ships no native binary, so an ancestor replaced in the instructions between the final check and the syscall is detected afterwards rather than prevented. This is bounded by the existing threat model — mutation is governed by a cooperative current writer contract, and a hostile non-cooperating local process was never covered by it — and no durability or recovery claim depends on closing it.

### Changed

- These runtime changes ship under a distinct 1.9.6 installation identity across both plugin manifests and package metadata.

## [1.9.5] — 2026-08-01 (lock contention observability)

### Fixed

- `wiki-runtime lock acquire --json` now reports every `LOCK_CONTENDED` result as one stable JSON stderr envelope with exit code 3 and empty stdout. A complete canonical owner is projected to the token-free `holder` fields `operation`, `pid`, `hostname`, and `acquired_at`; malformed, incomplete, extra-field, or ownerless evidence fails closed as `holder: null`. The public message is always `wiki lock is contended`, including contention caused by an active release transition, while lock acquisition, dead-owner self-healing, recovery, release, and liveness behavior remain unchanged ([#40](https://github.com/Sungmin-Cho/deep-wiki/issues/40)).

### Changed

- This public CLI contract ships under a distinct 1.9.5 installation identity across both plugin manifests and package metadata.

## [1.9.4] — 2026-07-31 (lint repair reclamation)

### Fixed

- Completed scan-window `ensure` journals no longer accumulate without bound after authenticated scan-window state proves them reclaimable. Explicit `wiki-lint --fix` performs self-healing reclamation under the current lock, and the bounded `transaction prune` command atomically moves each eligible transaction directory into a fresh identity-bound sibling quarantine before deleting its authenticated journal. Interrupted quarantines remain recognizable and are retried by a later bounded pass. An exact journal-copy reservation closes the canonical source generation until quarantine removal finishes, while an exact fsynced backup makes an interruption after the original journal unlink resumable. Both files use exclusive, crash-recoverable pending publication, and later bounded passes also finish partial publications, backup-only or empty quarantines, and orphaned exact reservations. Cleanup rechecks its deadline across discovery, validation, and recoverable mutation phases. It removes only age-eligible, fully validated `cleaned` scan-window directories while preserving unproved created state, in-flight, malformed, foreign-kind, linked, or ambiguous state. Its `complete` result distinguishes full traversal from a deadline- or limit-truncated pass.
- Fractional-clock `lint fix` operations now canonicalize manifest event timestamps to whole-second UTC-Z before commit, so a successful repair no longer ends with `MANIFEST_INVALID`.

### Changed

- These runtime changes ship under a distinct 1.9.4 installation identity across both plugin manifests and package metadata.

## [1.9.3] — 2026-07-30

### Fixed

- `wiki-runtime snapshot` no longer waits indefinitely for a sync-drive transaction journal blocked inside a filesystem metadata call ([#39](https://github.com/Sungmin-Cho/deep-wiki/issues/39)). Snapshot execution now runs in a supervised read-only child, with the parent timer outside the potentially blocked syscall. When the 12-second timer fires, the parent requests whole-tree termination, detaches the worker pipes and handle, and returns actionable `DEADLINE_EXCEEDED` guidance without awaiting worker close or changing recovery evidence. POSIX and native Windows both report an issued termination request conservatively as unconfirmed; a launch or request failure is reported as neither requested nor confirmed. An immediately unreadable journal fails closed as `TRANSACTION_RECOVERY_REQUIRED` with the same stopped-host/readability recovery boundary.
- SessionStart scan-window persistence now runs in a supervised child process. A timeout confirms child-tree termination before reclaiming only a same-host dead lock whose recorded PID matches that child, and normal lock acquisition self-heals the same authenticated dead-owner case without weakening live, foreign, malformed, or ownerless contention.

## [1.9.2] — 2026-07-27 (context diet)

### Changed

- Agent docs are restructured to an AGENTS-first single source: AGENTS.md now carries the shared runtime rules (storage layout, lifecycle actions, invariants, conventions, release workflow) and CLAUDE.md is a thin `@AGENTS.md` wrapper with Claude Code-specific notes only.
- AGENTS.md and CLAUDE.md are substantially shorter, so more of a session's context budget is available for your work. Duplicated directory and storage trees, the annotated lifecycle-action list, and conventions already covered by CONTRIBUTING.md now point at their canonical source instead of restating it.
- Skill and agent descriptions are shorter and lead with what the skill does. Every trigger phrase is unchanged, so every existing invocation still routes the same way.

### Fixed

- The 1.9 backup-only downgrade boundary (`contract_version` 2 in-flight journal is unrecoverable by 1.8.x) is now stated in AGENTS.md, CONTRIBUTING.md, and the README safety-boundary section (EN + KO).
- The documented release workflow no longer directs maintainers to hand-edit the auto-generated deep-suite README plugin table. It now gives the sequence that actually runs: `release:bump` automates the marketplace and doc-region edits, while the Codex mirror and the workflow-guide version mentions still need hand edits, and committing and pushing the suite remains manual.
- The optional `.wiki-meta/.config.json` fan-out knobs are no longer presented as runtime configuration in the agent guide. At 1.9.2 release time, no shipped code read that file; the declaration remained in `wiki-schema.yaml`, where callers honored it. Current runtime reads the wiki-local file as the `auto_ingest` owner.

## [1.9.1] — 2026-07-22

### Fixed

- SessionStart vault-change notices now use the shared `hookSpecificOutput.additionalContext` JSON contract, preventing Codex hook errors while preserving silent no-change and fail-open behavior.

## [1.9.0] — 2026-07-21 (commit deadline scaling — hash-only catalog seal and crash-safe cancel)

### Fixed

- `wiki-runtime commit` no longer forces a single logical commit to be split across repeated `transaction recover` calls on large vaults ([#30](https://github.com/Sungmin-Cho/deep-wiki/issues/30) Issue 2). The per-commit cost was O(catalog) rather than O(diff): `buildPlan` sealed every unchanged page/version/source as a full-byte `before==after` artifact, which inflated the journal (re-persisted up to ~14× through `atomicWriteFile`'s fsync) and staging (2N fsync writes) with no deadline checks — so the fixed 12-second budget was consumed during staging and surfaced misleadingly at `wiki-state:publish:versions`. Unchanged files are now recorded as a hash-only `catalog_seal` (`{relative_path, sha256}`); journal persistence and staging drop to O(diff), bringing the measured 590- and ~1,406-page cases comfortably inside the 12-second budget in a single commit.

### Changed

- Journal `contract_version` bumped 1 → 2 (adds `catalog_seal`, `catalog_seal_sha256`, `catalog_seal_cursor`). `validateJournal` dual-accepts either a legacy v1 or a v2 exact-key journal, so a v1.8.x commit interrupted before upgrade still recovers under its original semantics, while a v1.9 in-flight journal is rejected by v1.8.x (backup-only downgrade — see the updated safety boundary in `CLAUDE.md`). Receipt shape and success-result shape are unchanged.
- Drift response is now cancel-only. When the resumable drift scan detects that an unchanged catalog file changed or was deleted mid-commit, the transaction is torn down crash-safely (tombstone-before-destruction: a durable `cancelled.json` decision point precedes any destructive step) and exits `TRANSACTION_CANCELLED` (exit 4, no receipt) instead of committing a stale derived index. The fail-before-stale-publication property is preserved; the previous full-snapshot restore — which could clobber a concurrent external edit — is intentionally dropped as a data-safety improvement under the cooperative-writer contract. Source provenance is restated as a commit-time / no-compounding guarantee.

### Added

- Journal-first atomic transaction activation: a transaction directory becomes reader-visible only once its journal exists (built under `.activate-<pid>-<uuid>/` then `renameSync`d into place), making "journal-less ⟹ not-live" a protocol invariant so lock-free readers can never mistake a live pre-journal writer for debris. A bounded, lock-guarded, deadline-aware `sweepTransactionDebris` (in the shared leaf module `hooks/scripts/runtime/transaction-debris.js`) converges abandoned activation/transaction remnants without blocking readers and never touches a journal-present directory. Also: per-artifact resumable deadline checkpoints across stage/verify/publish, lock-owner-guarded runtime-manifest cleanup shared by commit and recover, and a `transaction recover` resume hint appended to `DEADLINE_EXCEEDED` output.

### Review

- The design converged over a 6-round cross-model review loop (Claude Opus + Codex, with adversarial passes) that hardened the cancel/tombstone crash-safety matrix and the journal-first activation invariant against reader-race and partial-teardown edge cases. Implementation by gpt-5.6-sol; every commit kept the suite green.

## [1.8.2] — 2026-07-21 (Windows st_dev asymmetry fix for atomic writes and lock acquisition)

### Fixed

- Wiki lock acquisition (and every other runtime state write) no longer fails permanently on recent Windows. `atomicWriteFile` seals ownership of its temp file by comparing an fd-based `fstatSync` identity against a path-based `lstatSync` identity — the only cross-API stat comparison in the runtime — and that seal included strict `st_dev` equality. On Windows 11 24H2 / Server 2025, libuv ≥ 1.49.0 (bundled from Node 22.12.0) serves path stats through the `GetFileInformationByName` fast path while fd stats still use `NtQueryVolumeInformationFile`, so the two APIs can report different `st_dev` for the same file: a 64-bit versus truncated 32-bit volume serial before libuv 1.51.0 (Node 22.12.0–22.16.0), and zero when the serial is unavailable (for example FSLogix-style environments) even after. Every `owner.json` write then aborted with `FILESYSTEM_IDENTITY_UNAVAILABLE`, making `/wiki-*` lock acquisition impossible. The seal now uses a directional `devicesCompatible` predicate — exact equality, either side zero, or a truncated 32-bit fd-side serial matching the path-side low 32 bits, which are exactly the documented Windows representations — while `ino` and `birthtimeNs` remain strictly compared and genuinely different devices are still rejected. Regression tests cover both accepted Windows forms, the end-to-end `acquireLock` path, and three rejection cases (distinct devices, coincidental low-32 with a non-truncated fd serial, reused-inode generation change).

### Review

- The fix went through a 3-round cross-model review loop (Claude Opus + Codex review + Codex adversarial). Rounds 1–2 tightened the predicate from "drop `dev` entirely" to the directional shape above; round 3 closed with Opus and Codex review approving. lstat-vs-lstat identity seals in `lock.js` / `scan-window.js` are unaffected by the asymmetry and intentionally stay strict.

## [1.8.1] — 2026-07-20 (portable Obsidian CLI discovery and ingest integration)

### Added

- `/wiki-ingest` now uses the Obsidian CLI for optional read-only vault context when `/wiki-setup` recorded it. A new runtime bridge (`wiki-runtime.js obsidian search|backlinks|tags --json`) reuses the probe's discovery, targets the configured vault by name, allowlists only read-only subcommands, validates argument values, and launches with `shell:false`, a 10-second kill timeout, and bounded output. The ingest skill gates the calls on the resolved `obsidianCli.enabled` configuration and treats every failure as informational, so ingest behavior is unchanged when Obsidian is absent or disabled; the runtime additionally refuses when the configuration disables Obsidian. The bridge also absorbs an upstream CLI race in which an app-connected command exits 0 with entirely empty output before results stream (observed on roughly one in three searches): a genuine zero-match always prints a message, so a fully empty reply is retried within a fixed bound.

### Fixed

- `/wiki-setup`'s Obsidian availability probe no longer depends on a bare `obsidian` name resolving on the caller's `PATH`. The old direct `{"executable":"obsidian"}` probe only worked when the interactive shell profile happened to put the app directory on `PATH` (and, on macOS, only via case-insensitive matching of the `Obsidian` app binary), so non-interactive hosts — Codex `shell:false` structured exec, hooks, or any environment without the user's profile — reported the CLI missing even with Obsidian 1.12+ installed and running. Discovery now runs inside the portable Node runtime (`wiki-runtime.js probe obsidian --json`): it honors an absolute `DEEP_WIKI_OBSIDIAN_BIN` override, scans `PATH` under both binary casings (with Windows executable extensions), and falls back to well-known per-platform install locations (macOS application bundles, `%LOCALAPPDATA%\Programs\obsidian`, Linux system/flatpak/snap paths). Each candidate launches read-only with `shell:false`, a 3-second kill timeout, and bounded output capture; at most three candidates are spawned. The result distinguishes `found` (a CLI binary exists) from `reachable` (the running app answered with its vault), so setup reports why a probe failed instead of a bare "unavailable".

### Changed

- Shipped skills now contain no direct non-Node executables. The former direct `obsidian` exec block was the sole exception; with it replaced by the Node runtime probe, the executable contract rejects every non-`node` executable in every skill (`EXECUTABLE_NOT_ALLOWED`), and the `wiki-setup` allowlist gains the fixed `['probe','obsidian','--json']` argv contract.

## [1.8.0] — 2026-07-19 (Node 22 runtime, native Windows hook, and Codex authority)

### Changed

- Replaced the shipped Bash SessionStart scanner and persistence paths with a portable Node 22 runtime shared by Claude Code and Codex. The hook has no shipped shell-script runtime: Codex selects `commandWindows`, pre-expands the plugin root, and uses the host-owned `%COMSPEC% /C` launch boundary.
- Consolidated scan-window, wiki transaction, setup, ingest, lint-fix, and rebuild state changes behind the same cooperative current writer protocol. Writers authenticate complete post-seizure owner and directory checks before mutation; ambiguous locks require stopped-host intervention, and a concurrent old version is unsupported.
- The durability claim is limited to mounted-filesystem and process-termination durability. It is not a power-loss, remote-filesystem, or hostile-process guarantee. After any 1.8 write, only a backup-only downgrade is supported.

### Compatibility and evidence

- Added fixed CI authority for Ubuntu 24.04 x64, macOS arm64 and Intel, and Windows Server 2025 x64. This is no Windows 11 claim.
- Added an exact installed-Codex 0.144.1 Windows smoke that authenticates marketplace install/discovery, installed bytes, the pre-model shipped hook effect, direct installed-supervisor output, the no-effect untrusted path, and `commandWindows` root expansion.
- The installed-Codex test uses an unauthenticated local Responses fixture. It is not production OpenAI API, login, model-quality, Windows 11, arbitrary-user-machine, or OS-level no-egress certification.
- The plugin ships no plugin MCP server or native binary, no runtime dependency, and no executable shell entrypoint. The three `scripts/v0-probe/*-record.sh` files remain maintainer-only historical probes.

## [1.7.1] — 2026-07-07 (wiki-lint --fix lock + atomic .last-scan promotion)

### Fixed

- `/wiki-lint --fix` now acquires the wiki lock before mutating wiki state. Its `.pending-scan` drop and version prune previously ran with no `.wiki-lock`, so a concurrent hook-driven `/wiki-ingest` (holding the lock) could lost-update `index.json`, clobber the scan window, or race the `.versions/` prune — a breach of invariant #3 (lock atomicity). The `--fix` mutations now run inside a single self-contained lock block (acquire → EXIT-trap release → re-read + re-validate under the lock → mutate); on contention they soft-skip while the read-only diagnostics still print. Index-drift repair delegates to `/wiki-rebuild` only after that lock is released (its acquisition is non-reentrant).
- Made the hook-driven `.last-scan` promotion write atomic (temp file + `mv`), matching the repo's `.pending-scan` and `index.json` writers. The prior direct `echo > .last-scan` redirect could leave the file empty/truncated if interrupted mid-write (e.g. the 15s SessionStart hook budget on network-backed volumes).
- Converted the `/wiki-ingest` A5-fanout write path (Step 7.6.C) to the multi-block lock pattern. Its lock must stay held across Steps 7.6.C → 7.6.G (separate Bash blocks), but the acquisition block registered an unconditional `EXIT` trap that fired the moment the block ended — releasing the lock before Steps 7.6.D-G ran and reopening the concurrent-write window (the same early-release bug wiki-rebuild's round-4 fix addressed). The acquisition block now registers a failure-only cleanup instead, Step 7.6.G keeps the explicit success-path release, and Step 7.6.F releases on its own abort paths (the lock is now held that far). The lock-pattern catalog reclassifies Step 7.6.C from Pattern 1 to Pattern 2.
- Guarded the `/wiki-ingest` F1 all-dropped 3-strike escape's `.last-scan` promotion. It previously did a raw `mv .pending-scan .last-scan` with no timestamp validation and no monotonicity check, so a stale or malformed stuck window could regress or corrupt `.last-scan` (an invariant #2 break). It now shares the Step 11 promotion guard: advance `.last-scan` only when the window is a valid timestamp strictly newer than the current value. The stuck state (`.pending-scan` + retry counter) is cleared only after a confirmed temp-file rename — a failed rename (ENOSPC / EACCES / network FS) preserves both and bails with a fatal error so the next hook cycle re-detects the window and retries, rather than losing the only record of it. An invalid or stale window (no `.last-scan` write attempted) still drops `.pending-scan` to release the stuck window. The two `promote_pending_scan_to_last_scan` shorthands and the Step 7.5.M-D 3-strike prose are annotated to reference this shared guarded procedure.
- Fixed the `/wiki-ingest` F1 all-dropped 3-strike retry counter, which never reached 3. Its counter file is keyed by the `.pending-scan` window — an ISO-8601 timestamp containing colons — but the read used `${saved%%:*}`, truncating the key at its first colon (`2026-06-01T00`) so it never matched the current window and reset the count to 1 on every run. The 3-strike escape (and the guarded promotion above) was therefore unreachable in the real hook flow, leaving `.pending-scan` permanently stuck. The read now strips from the last colon (`${saved%:*}`, preserving the full timestamp) and integer-validates the count.
- Stopped the `/wiki-ingest` post-ingest auto-lint (Step 7.6.G) from pruning `.versions/` backups after releasing the wiki lock. The Step 13 comment claimed the retention prune was "safe outside the transaction", but pruning is a mutation and running it unlocked breaks invariant #3 — a concurrent ingest that grabs the just-freed lock would race the prune against its own fresh backups and index repair. The post-lock auto-lint is now read-only diagnostics; the retention prune runs under the lock only via wiki-lint §13 Auto-Fix Phase A, which self-acquires `.wiki-lock` and soft-skips on contention.
- Removed the unlocked-mutation instruction from the `/wiki-ingest` Step 13 (Auto-Lint) section body itself. The prior fix corrected the Step 7.6.G comment but the section still told the agent to "Auto-fix" — add/remove `index.json` entries and prune excess `.versions/` — after the lock was released. The section is now read-only: auto-fixable mutations are delegated to `/wiki-lint --fix`, whose §13 Phase A/B acquire the lock themselves (`index.json` is already kept in sync under the lock by Step 9 during the ingest transaction).
- Unified the on-disk format of the `.pending-scan-retry-count` file. The F1 single-source path keys it by the verbatim `.pending-scan` timestamp (`<ISO>:<count>`), but the multi-source Step 7.5.M-D contract defined the same shared file as `<window_epoch>:<count>`. Two paths reading/writing the file with different key formats reset each other's counter, delaying or blocking the 3-strike escape. The multi-source contract now uses the same verbatim-`.pending-scan` key with full-string equality and the colon-safe parse (`${saved%:*}`); an epoch conversion was rejected because a bash-3.2 / BSD-`date` portable ISO→epoch is not available.
- Added failure-only release traps to the `/wiki-ingest` A5-fanout intermediate lock-holding blocks (Steps 7.6.D and 7.6.F). After the Pattern 2 conversion the `.wiki-lock` is held across Steps 7.6.C → 7.6.G (separate Bash blocks), but only 7.6.C registered a release-on-failure trap; a general command failure in an intermediate block would exit it non-zero with the lock still held, stranding it and blocking every writer. Each intermediate block now registers a `cleanup_*` trap that `rmdir`s the lock only on non-zero exit (wiki-rebuild's `cleanup_step3` model), while success keeps it held for Step 7.6.G's explicit release. Steps 8-11 stay covered by Step 7.7.F's `on_metadata_failure` release.
- Rewrote the stale lock-release directives that still told the agent to register a cleanup `trap` "at lock-acquisition time". For the multi-block main ingest (Step 3 acquire → Steps 4-11 mutate → Step 12 release) an unconditional acquisition-time trap fires at the end of the Step 3 block and releases the lock early — the same bug Pattern 2 fixed. Step 3, Step 12, the crash-note, and the Error Handling bullet now delegate the trap form to the lock-pattern catalog (failure-only trap per mutating block for multi-block paths; single-block paths may use the unconditional-release trap). Also made the version-prune lock discipline explicit in `wiki-schema` (`## Versioning`) and `wiki-rebuild` (Step 5), which read as unqualified prunes; both now state the prune runs under the lock (invariant #3).
- Finished the retry-counter format unification in the machine-readable schema. The R4 change updated the SKILL.md prose but left `skills/wiki-schema/wiki-schema.yaml` (the canonical schema) and the `ingest-fail` log-line contract still declaring the old `<window_epoch>:<count>` epoch key. `wiki-schema.yaml` `retry_counter.format` and the `ingest-fail` action note now declare `<pending_scan_iso>:<count>`, and the `ingest-fail` log field is `window` (the `.pending-scan` ISO string) rather than `window_epoch` (an int). A schema↔SKILL.md sync test now fails if either side drifts back to the epoch key.
- Made the `/wiki-ingest` 3-strike terminal `ingest-fail` logging idempotent and emit-first, on both the F1 all-dropped and the Step 7.7.B all-workers-fail paths. The terminal row is now written *before* the guarded promotion releases the scan window — so a log-write failure blocks the release instead of leaving a 3-strike with no audit record (no fail-open) — and it is keyed by the window (+source): a retry cycle that re-enters the escape skips the emit when a terminal row for that window already exists, so a failed rename that preserves `.pending-scan` + the retry counter never produces a duplicate terminal row. An `ingest-fail` emit-site grep confirms these are the only two 3-strike paths.
- Rewrote the canonical `auto_lint` contract to the read-only-delegation model. `wiki-schema.yaml` and the `wiki-schema` `## Auto-Lint` section still promised `auto_fix: "Fix silently without user action"` for index drift / excess versions / stale `.pending-scan`, contradicting the change that made the post-ingest auto-lint read-only. The schema now declares `mode: read-only-diagnostics` and an `auto_repair` block delegated to `/wiki-lint --fix` (mutations under the lock); the SKILL.md prose matches, and the prose↔schema sync test now covers the auto_lint contract too.

### Changed

- Documented the three concurrency-lock trap patterns (single-block unconditional trap / multi-block failure-only trap + explicit release / contention soft-fail) in `storage-layout.md`, and split invariant #3 into *what* (acquire before any write, release before end of critical section) vs *how* (trap form → pattern catalog). Existing skill trap code is unchanged.
- The `/wiki-lint --fix` version prune now sorts backups by numeric version, so `.v10`/`.v11` are correctly retained over `.v2` (a lexicographic sort would have deleted the newest backups).

## [1.7.0] — 2026-05-22 (large-wiki reader race fix + index.md dashboard + inbox cleanup)

### Fixed

- Fixed a stdout-flush race in the index-envelope reader that could nondeterministically truncate its output on large wikis (~400+ pages), risking duplicate-page creation or silent page loss on index merge.

### Changed

- Redefined `index.md` as a lightweight, always-fresh dashboard (wiki overview, at-a-glance stats, recent activity, top tags, opt-in featured pages) instead of a full catalog rewrite each ingest, which was infeasible above ~100 pages. The full machine-readable catalog stays in `.wiki-meta/index.json`. The dashboard is marked with `<!-- deep-wiki-dashboard-v1.7.0 -->`; a pre-1.7.0 `index.md` is auto-backed-up to `.wiki-meta/.backups/index.md.pre-1.7.0` before the first overwrite.
- `/wiki-setup` now seeds a fresh wiki with the v1.7.0 dashboard shape.

### Added

- Added an inbox stale-cleanup step to `/wiki-ingest`: files older than 7 days that are not referenced by an unresolved `partial_fail` sentinel are moved to `.wiki-meta/.inbox/.quarantine/` (quarantined, not deleted) so a crashed-session source can still be recovered.

## [1.6.2] — 2026-05-18 (Codex-native plugin manifest and AGENTS guide)

### Added

- Added `.codex-plugin/plugin.json`, a Codex-native plugin manifest pointing at the same skill and hook surfaces as the Claude Code manifest.
- Added `AGENTS.md`, a Codex project guide covering runtime surfaces and verification.

### Changed

- README now documents Codex compatibility alongside the existing Claude Code surface.

## [1.6.1] — 2026-05-18 (Codex strict-YAML parse fix for wiki-setup description)

### Fixed

- Fixed the `wiki-setup` skill frontmatter description so Codex's strict YAML parser no longer rejects it and silently drops the skill at load time. The `A:`/`B:` colon-space pattern was rewritten to `option A —`/`option B —` and the description quoted; content is unchanged.

## [1.6.0] — 2026-05-18 (5 commands → user-invocable skills: cross-platform)

### Changed

- Promoted all 5 `/wiki-*` slash commands to `user-invocable: true` skills under `skills/wiki-{setup,ingest,query,lint,rebuild}/SKILL.md`, and removed the `commands/` directory. Each skill gains `## Invocation`, `## Inputs`, and `## Prerequisites` head sections. Command behavior (ingest / query / lint / rebuild / setup procedures) is unchanged.

### Migration

- **Claude Code users:** no change — `/wiki-setup`, `/wiki-ingest`, `/wiki-lint`, `/wiki-query`, `/wiki-rebuild` and the SessionStart auto-ingest hook continue to work; Claude Code auto-discovers the skills as slash commands.
- **Codex / Copilot CLI / Gemini CLI / Agent SDK users:** invoke as `Skill({ skill: "deep-wiki:wiki-ingest", args: "<source>" })` etc. Argument syntax is identical.

## [1.5.3] — 2026-05-13 (metadata — SKILL.md description length)

### Fixed

- Trimmed the `wiki-schema` skill frontmatter description below the Claude Code 1024-character cap (it had exceeded it, surfacing a load-time warning), preserving every trigger keyword. Metadata-only patch; no behavior change.

## [1.5.2] — 2026-05-12

### Added

- Added a `.pending-scan` recovery integration test for the SessionStart scan hook, pinning its behavior against artificially-dangled state (invalid / valid / stale / empty / corrupt content). Tests-only release; no behavior change.

## [1.5.1] — 2026-05-12

### Added

- Added a golden-fixture test suite for the SessionStart auto-ingest scan hook, pinning the detected count, file list, exit code, and `.pending-scan` preservation across an 8-scenario corpus (empty vault, new files, excluded directories, mtime filtering, tag/glob filters, missing config). Tests-only release; no behavior change.

## [1.5.0] — 2026-05-11 (M3 envelope adoption)

### Added

- `<wiki_root>/.wiki-meta/index.json` is now wrapped in the deep-suite M3 cross-plugin envelope. The legacy `{pages, generated_at}` shape is preserved verbatim inside `payload`. Each emit carries a ULID `run_id`, producer attribution (`producer = "deep-wiki"`, `producer_version`), a schema identity, and a git/tool-version provenance snapshot, enabling cross-plugin trace and schema-drift detection.
- Added envelope-aware reader and writer helpers: the reader emits the legacy shape on stdout (whether the file is envelope-wrapped or legacy), and the writer wraps a payload and atomically writes `index.json`. Identity guards reject foreign or corrupt envelopes.

### Compatibility

- **Forward-compatible:** the reader emits the legacy `{pages, generated_at}` shape, so existing `jq` pipelines (`.pages[].file`, `.generated_at`) keep working.
- **Backward-compatible:** legacy `index.json` files pass through unchanged — no `/wiki-rebuild` is required after upgrading. Running `/wiki-rebuild` (or the next `/wiki-ingest`) re-wraps the index in envelope form with no data loss.
- Mid-write interruption cannot leave a truncated `index.json` (atomic temp + rename). A foreign-producer envelope at the index path is rejected; recover with `/wiki-rebuild`, which regenerates from page frontmatter (the source of truth).

## [1.4.2] — 2026-05-07

### Fixed

- Fixed a false-positive concurrency abort where a synthesizer that emitted truncated `existing_page_body` caused every page update to abort. The main session now re-reads page bytes from disk as the authoritative baseline for the concurrency check and for synthesis context. On detected drift, the affected pages are re-synthesized from disk bytes (preserving the loud-failure property while recovering retry correctness), and a basename-traversal guard is applied before any page read.
- Fixed the all-dropped ingest path so that when every update entry is dropped (invalid basename / missing page / read failure), the source is no longer promoted as a clean skip; it now writes the `partial_fail` retry sentinel and participates in the 3-strike `ingest-fail` recovery.
- Extended the worker-mutation dirty-scan to also bracket the single-source analysis dispatch (test-mode only; zero production cost).

### Added

- Added `phase_timing_ms` (`stage_1_analysis`, `stage_2_fanout`, `stage_3_write`, `total`) to `log.jsonl` `ingest` lines for per-phase timing. Schema-additive — omitted from non-`ingest` actions and ignored by lint.

### Migration

- No external API changes from v1.4.1. Concurrency-check hash values are not byte-identical to v1.4.1, but abort/success decisions remain equivalent for spec-compliant agents.

## [1.4.1] — 2026-05-06 (synthesizer agent split — trust-boundary closure)

### Changed

- Split the unified `wiki-synthesizer` agent into three role-scoped files — `wiki-synthesizer-analysis` (single-source analysis) and `wiki-synthesizer-worker` (multi-source worker + collision merge), both **without `Write`** in their tool declaration, plus a dormant `wiki-synthesizer-inline` that preserves the v1.3.0 inline contract for future restoration. `/wiki-ingest` now dispatches these agents by qualified namespace (`deep-wiki:<agent>`). This closes the v1.4.0 failure mode in which a worker could be downgraded to a general-purpose agent and granted write access outside the Stage 3 lock.

### Added

- Added a frontmatter lint (`scripts/lint-agent-tools.sh`) that fails if a future change re-adds `Write` to an active agent, plus a test-mode-gated in-root dirty-file scan after each agent dispatch (zero production cost).

### Removed

- Removed the old unified `wiki-synthesizer.md` agent (no compatibility shim).

### Migration

- Single-source and multi-source ingest produce the same pages, provenance, and log events as v1.4.0 (not byte-identical). External callers that dispatched `subagent_type: "wiki-synthesizer"` directly must switch to `deep-wiki:wiki-synthesizer-analysis` (single-source) or `deep-wiki:wiki-synthesizer-worker` (multi-source / collision merge); `/wiki-ingest` itself was migrated as part of this release.

### Known limitations

- Trust-boundary closure is layered defense-in-depth at the agent-metadata level plus a static lint and an in-root runtime guard — not comprehensive enforcement. The in-root scan covers `<wiki_root>/`-internal mutations only, not off-root writes (e.g. `/tmp/`). Process-level sandboxing is deferred to a later release.

## [1.4.0] — 2026-05-05 (A5 page-level fanout)

### Added

- Single-source `/wiki-ingest` now parallelizes page-body generation across N `wiki-page-writer` workers. A new analysis stage emits a `page_plan` describing which pages to create/update (with inline bodies for sub-threshold runs); a fanout stage dispatches one worker per page (default threshold: 3 pages); and the main session aggregates drafts and atomic-writes them under lock with a mandatory concurrency check. Karpathy's "10–15 page touches per source" property is preserved — fanout changes *who* writes pages, not how many.
- Added the `wiki-page-writer` agent (no file I/O; main owns writes under lock).
- Added a `partial_fail` sentinel in per-source provenance YAML, written when any page in a fanout run fails; the next session forces a repair even if source bytes are unchanged, and the sentinel is cleared on a clean re-ingest.
- Added a `pages_failed` field to `log.jsonl` `ingest` lines.
- Added the `ingest-fail` lifecycle action, emitted after 3 consecutive all-workers-fail batches on the same scan window to release the stuck window.
- Added optional `<wiki>/.wiki-meta/.config.json` knobs: `a5_fanout_threshold` (default 3) and `a5_worker_timeout_sec` (default 90, advisory). Absence means defaults — no migration needed.

### Migration

- Single-source semantics are preserved but not byte-identical (analysis-mode adds ~10–25% wall-clock variance). The multi-source path is unchanged from v1.3.0. All v1.2.0+/v1.3.0 invariants are preserved.

### Notes

- Initial real-vault dogfood measured ~17 min wall-clock under the runtime's observed ~3-concurrent-subagent cap (not the originally targeted ≤5 min, which assumed unbounded parallelism). The mechanism works as designed; per-stage timing characterization arrived in v1.4.2 (`phase_timing_ms`).

## [1.3.0] — 2026-05-02

### Added

- Multi-source `/wiki-ingest` now fans out across up to 3 parallel `wiki-synthesizer` workers (worker mode). Workers do full LLM analysis but no file writes; the main session aggregates drafts and performs all writes sequentially under the existing single lock. Cross-worker page collisions trigger a second-pass merge so the multi-source merge invariant is preserved. Expected wall-clock reduction for 3+ source batches: ~30–50%.
- Added the `ingest-fail` lifecycle action and a `.failed-sources.tsv` retry manifest plus a `.pending-scan-retry-count` counter, enabling 3-strike stuck-window recovery for multi-source batches.

### Changed

- The SessionStart hook's `auto_ingest.ignore_globs` parser now accepts block, inline (`["a", "b"]`), and dotted (`auto_ingest.ignore_globs: [...]`) forms; the same broadening applies to the lint orphan-ignore parser. This also fixes a latent bug that silently dropped block-form list items after the first.

### Fixed

- `/wiki-lint` broken-link detection no longer false-flags links inside tab-indented code blocks, and correctly resets list-continuation state after two blank lines (CommonMark).

### Migration

- Single-source `/wiki-ingest` is byte-identical to v1.2.1. Multi-source produces identical final state when there is no cross-worker collision; only wall-clock changes. Existing `auto_ingest:` block-form configs work unchanged.

### Trade-offs

- Multi-source fanout dispatches up to 3 workers in parallel, each loading the synthesizer spec (~2–3× spec context cost for 3-source batches); the global lock is held for the full analysis duration on the multi-source path. Single-source is unaffected.

## [1.2.1] — 2026-05-02

### Fixed

- Disambiguate slug collisions when two file sources share a basename, closing a silent cross-attribution risk on coincidental hash matches.
- Force an `ingest-repair` when `log.jsonl` is absent or a slug has no terminal log entry despite a present provenance YAML. (When triggered by log truncation, the repair line emits `pages_created:[]`; the per-source YAML remains the authoritative provenance record.)
- Exclude `http(s)://` targets ending in `.md` from `/wiki-lint` broken-link detection, eliminating false positives from external URLs.
- Make `/wiki-lint` code-block stripping block-context-aware so real indented code is stripped while links inside list items stay subject to detection.
- Preserve per-source attribution when two sources independently create the same page in one batch (both contributing slugs record it), while keeping the log invariant via intra-batch dedup.

### Changed

- README cloud-mirror guidance now warns that a non-vault local `wiki_root` makes the SessionStart hook watch `$HOME`, and corrects the note that removing the `auto_ingest:` block does not pause auto-ingest (set `ignore_globs: ['**']` or disable the hook instead).

## [1.2.0] — 2026-04-30

### Added

- Added an optional `auto_ingest` block to the config (`ignore_globs`, `require_tag`) so the SessionStart hook can filter high-volume, low-value paths before invoking `/wiki-ingest`. Backward compatible — absence keeps prior behavior.
- Added a re-ingest hash skip: `/wiki-ingest` compares each source's sha256 against the stored `content_hash` and drops unchanged sources before lock acquisition, recording a new `ingest-skip` log action. Hash match alone is insufficient — wiki-side state integrity is also verified, and any failure falls through to a normal ingest recorded as the new `ingest-repair` action.
- Added a documented cloud-storage mirror-and-sync workflow to the README (keep `wiki_root` on local disk; additive rsync to the vault on a schedule; manual reverse-rsync before editing on other devices).

### Changed

- Synthesizer candidate filtering now scores against frontmatter, deep-reads the top few candidates, and verifies the rest with a parallel Grep batch — measured ~20% per-page wall-clock reduction in the first dogfood.
- `/wiki-lint` gains a `[SCAN-WINDOW]` invariant check (invalid timestamps, `PENDING < LAST` regression, stalled auto-ingest) with portable tri-branch date parsing; `--fix` drops stale/invalid `.pending-scan` while the >48h case requires manual judgment.
- `/wiki-lint` `[ORPHAN]` classification now exempts pages tagged `leaf` and pages matching configured `lint.orphan_ignore` globs.
- `/wiki-lint` `[BROKEN]` detection strips fenced code blocks before scanning for `.md` link patterns.
- `/wiki-ingest` reclassifies within-batch duplicate page creates so only the first counts as created, restoring the "exactly once across log" invariant for new ingests.

### Migration

- No action required. To opt into the perf gains, add an `auto_ingest:` block, run `/wiki-lint --fix` once to clear stale `.pending-scan` and prune excess version backups, and optionally move `wiki_root` to local disk.

## [1.1.4] — 2026-04-24

### Fixed

- `content_hash` is now validated against `^[0-9a-f]{64}$` and recomputed from the source when the synthesizer returns a non-hex sentinel, so re-ingest detection and provenance auditing are reliable again (they had been unreliable since v1.1.2).
- The `.pending-scan → .last-scan` promotion no longer moves `.last-scan` backward when a stale pending file is left behind, preventing duplicate `log.jsonl` entries on the next hook run.

### Migration

- No action required. Existing `sources/<slug>.yaml` files with placeholder `content_hash` values are left as historical records; any re-ingest produces a valid digest going forward.

## [1.1.3] — 2026-04-24

### Changed

- The `wiki-synthesizer` agent now issues tool calls in parallel within each workflow phase (source read / candidate survey / backup batch / page write), cutting wall-clock time for multi-page ingests. Pure prompt change — no contract, schema, or lock/provenance behavior is modified.

### Notes

- The README now documents that a cloud-synced `wiki_root` adds a per-write latency tax (each write wakes the sync daemon); recommendation is to keep `wiki_root` on local disk.

## [1.1.2] — 2026-04-21

### Changed

- `/wiki-ingest` now always delegates page I/O to the `wiki-synthesizer` subagent (previously inline for most ingests), keeping only the small metadata footprint in the main session and materially reducing context pressure for SessionStart auto-ingests.
- Version backup (pre-overwrite snapshot to `.versions/`) moved into the synthesizer; retention pruning stays in auto-lint.
- The agent input/output contract is now formal/structured: it returns `created`/`updated` entries with `{file, title, tags, aliases, sources}` plus `versioned`, `source_hashes`, and `failed`. The caller reconciles each reported write against actual filesystem state, validates filenames, and is authoritative for `pages_created` vs `pages_updated`.
- `index.json` updates use manifest frontmatter directly (no page re-reads); per-source provenance in multi-source batches is now authoritative rather than inferred; `content_hash` is computed by the agent at fetch/read time.
- Pasted-text ingest is materialized to a `.inbox/` file before dispatch (deleted with the lock release). Overlap detection is strengthened to widen the search beyond the candidate hint, and a post-write reconciliation moves any reported-but-missing file to `failed`.
- The `--synthesize` flag is demoted to a no-op hint (synthesis is now the default); the agent's tool scope gains `WebFetch` for `type: url` sources.

### Migration

- No action required. The main observable change is reduced context usage during ingest and correct per-source provenance for multi-source batches.

## [1.1.1] — 2026-04-17

### Security

- `.gitignore` now covers `.claude/settings.local.json` and `.claude/.sensor-detection-cache.json`, which can grant repo-scoped permissions that should not propagate to other contributors.
- Replaced destructive `git rm --cached -r . && git reset --hard` guidance in the upgrade docs with a safe `git add --renormalize` flow.

### Fixed

- The SessionStart hook no longer crashes on macOS bash 3.2 when the detected-files array is empty.
- The hook writes the detected-at timestamp atomically to `.pending-scan`, and `/wiki-ingest` promotes pending → committed only after a successful batch, so concurrent hook runs cannot advance `.last-scan` past what was actually ingested.
- When the wiki lives at the vault root (`wiki_prefix: "."`), the hook excludes wiki artifacts from the scan so the wiki cannot ingest itself.
- YAML config parsing now respects block boundaries (a neighbouring `available: true` can no longer be mis-attributed to `obsidian_cli`).
- All commands now require UTC ISO 8601 timestamps with a `Z` suffix; historical `+09:00` entries remain readable.
- A `[LOG-INVARIANT]` lint check reports duplicate `pages_created` entries; a filename appears in `pages_created` at most once across the log.

### Changed

- Windows is documented as Experimental, requiring Git Bash or WSL2 (native `cmd.exe`/PowerShell unsupported for the hook). Windows-native `wiki_root` paths are rejected with a friendly POSIX-form hint; `timeout.exe` is detected and skipped (falling back to `gtimeout` or no timeout); `.gitattributes` enforces LF endings; and the README documents Google Drive mount conventions, NTFS case-insensitivity, and long-path support.

### Notes

- All changes are backward compatible. `.pending-scan` is additive; mixed-timezone log entries remain readable (only new entries require UTC).

## [1.1.0] — 2026-04-08

### Added

- Obsidian CLI integration — `/wiki-setup` auto-detects the Obsidian CLI when the wiki is inside a vault, and wiki commands then use Obsidian's full-text search, backlink graph, orphan detection, and unresolved-link tracking for more accurate results.
- `/wiki-query` adds graph-based query expansion (follows backlinks to discover related pages; Obsidian CLI only).
- The SessionStart scan supplements `find` with `obsidian recents` (union + dedupe, with mtime verification).

### Changed

- The config schema gains an optional `obsidian_cli` block; absence means filesystem-only mode (fully backward compatible).
- Re-running `/wiki-setup` removes stale `obsidian_cli` config before re-detection.
- The SessionStart hook detects `timeout`/`gtimeout` availability instead of assuming GNU coreutils.

### Design principles

- Progressive enhancement: the Obsidian CLI enhances but never replaces filesystem operations, and all vault-wide CLI results are filtered to the wiki boundary. Writes stay filesystem-based.

## [1.0.1] — 2026-04-07

### Added

- Auto-ingest SessionStart hook — automatically detects new/modified files in the Obsidian vault on every session start and ingests them. No manual action needed.
- Batch ingest support — `/wiki-ingest` processes multiple files from the auto-ingest hook with a single lock acquisition and grouped log entries.

## [1.0.0] — 2026-04-07

### Milestone

First stable release. All core features from Karpathy's LLM Wiki gist are implemented, and the plugin has been validated against a real Obsidian vault migration (700+ files → 107 wiki pages).

### Added (since 0.2.0)

- Real-world validation — full migration of a PARA-structured Obsidian vault into deep-wiki, proving the system works at scale.

## [0.2.0] — 2026-04-07

### Added

- **Query auto-filing** — When `/wiki-query` synthesizes insights across 2+ pages, the result is automatically filed back into the wiki as a `query-synthesis` page. Implements Karpathy's principle that valuable query results should compound back into the knowledge base.
- **Auto-lint after write operations** — Lint checks run automatically after every `/wiki-ingest` and `/wiki-rebuild`. Auto-fixes structural issues (index drift, excess versions) silently; only reports issues requiring human judgment. Users no longer need to remember to lint.
- **Recommended tools check in `/wiki-setup`** — Setup now checks for CLI tools (qmd, marp) and Obsidian plugins (Dataview, Marp Slides, Web Clipper) and reports installation status with install commands.
- **`recommended-tools.md` reference document** — Detailed guide for qmd, Marp, Dataview, Marp Slides, and Obsidian Web Clipper.
- **`recommended_tools` and `auto_lint` schema definitions** in `wiki-schema.yaml`.
- **CHANGELOG.md / CHANGELOG.ko.md** — This file.

### Fixed

- **`wiki-lint.md` step numbering** — Steps 8, 8, 10, 10 corrected to 8, 9, 10, 11.

### Changed

- `/wiki-query` is no longer read-only. It now writes auto-filed synthesis pages when cross-page insights are detected.
- `/wiki-ingest` now includes an auto-lint step (Step 13) before the final report.
- `/wiki-rebuild` now includes an auto-lint step (Step 5) before reporting.
- `wiki-schema` skill updated with Auto-Lint and Query Auto-Filing sections.
- `wiki-schema.yaml` updated with `auto_lint`, `query_auto_filing`, and `log.actions` definitions.
- READMEs (EN/KO) updated with recommended tools section, Obsidian auto-check description, and revised command descriptions.

## [0.1.0] — 2026-04-06

### Added

- Initial release implementing Karpathy's LLM Wiki philosophy.
- Five commands: `/wiki-setup`, `/wiki-ingest`, `/wiki-query`, `/wiki-lint`, `/wiki-rebuild`.
- `wiki-synthesizer` agent for multi-source synthesis.
- `wiki-schema` skill with page template, schema YAML, and storage layout reference.
- Source provenance tracking with content hashing.
- Concurrency locking protocol (`mkdir`-based).
- Page versioning (keep last 3).
- Dual artifacts: human-readable (`index.md`, `log.md`) + machine-readable (`index.json`, `log.jsonl`).
- Obsidian vault compatibility.
- deep-work session report integration.
- Test wiki with example pages.
- Bilingual documentation (EN/KO).
