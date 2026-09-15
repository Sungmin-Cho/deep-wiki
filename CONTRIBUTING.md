# Contributing to deep-wiki

Thanks for your interest in improving **deep-wiki** — an LLM-managed markdown wiki for
persistent knowledge accumulation, part of the
[deep-suite](https://github.com/Sungmin-Cho/deep-suite).

## Development setup

```bash
git clone https://github.com/Sungmin-Cho/deep-wiki.git
cd deep-wiki
```

Node 22 is required for development and CI. There are no runtime dependencies — the
repo ships the plugin (skills and hooks) plus CommonJS Node runtime and test
scripts.

## Tests

```bash
npm test                 # node --test (recursive discovery from cwd)
npm run validate-fixture # validate the envelope sample fixture
```

Hook scripts must stay portable across Node 22 on macOS, Linux, and native Windows.
Use `node:` APIs, preserve drive/UNC paths, and launch children with `shell:false`.

## Runtime and evidence boundary

- Preserve the cooperative current writer protocol and complete post-seizure owner
  and directory checks. Ambiguous locks require stopped-host intervention, and a
  concurrent old version must never write the same wiki.
- Claims are limited to mounted-filesystem and process-termination durability.
- Windows hook launch is host-owned `%COMSPEC% /C`; add no shipped shell-script
  runtime. The repository must retain no plugin MCP server or native binary and no
  runtime dependency.
- CI covers Windows Server 2025 and macOS arm64 and Intel. That is no Windows 11
  claim. The installed-Codex smoke uses an unauthenticated local Responses fixture;
  it is not production OpenAI API, login, model-quality, Windows 11,
  arbitrary-user-machine, or OS-level no-egress certification.
- A post-1.8 rollback is a backup-only downgrade after all hosts stop and 1.8
  completes recovery.
- A post-1.9 rollback is likewise backup-only: all hosts stop, 1.9 completes
  recovery, then restore the authenticated pre-upgrade backup and start 1.8.2.
  A 1.9 in-flight journal (`contract_version` 2) is unrecoverable by 1.8.x.
- A post-1.10 rollback is likewise backup-only: all hosts stop, 1.10 completes
  recovery, then restore the authenticated pre-upgrade backup and start 1.9.x.

## Conventions

- **Documentation** follows [`docs/DOCS_RULE.md`](docs/DOCS_RULE.md) (local maintainer
  guide). README is evergreen and bilingual (EN + KO); the CHANGELOG follows
  [Keep a Changelog](https://keepachangelog.com/) and is also bilingual.
- **Version triple-sync**: `.claude-plugin/plugin.json`, `.codex-plugin/plugin.json`,
  and `package.json` must always carry the same version.
- The canonical wiki path prefix is `<wiki_root>/` (underscore); the hyphen form is
  forbidden.

## Pull requests

1. Branch from `main`.
2. Keep changes focused and make sure `npm test` is green.
3. Add a `## [Unreleased]` entry (or a versioned entry) to `CHANGELOG.md` **and**
   `CHANGELOG.ko.md` for any user-observable change.
4. Explain what changed and why.

## Reporting issues

Open a GitHub issue. For security reports, see [`SECURITY.md`](SECURITY.md).
