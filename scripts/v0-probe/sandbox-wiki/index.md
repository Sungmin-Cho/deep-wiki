# V-0 Sandbox Wiki

> **Historical — do not run.** This is a v1.4.1 probe record. The ingest
> subagents and `agents/*.md` files it names no longer exist: `/wiki-ingest`
> now runs in the main caller on every host.

This is the sandbox wiki used by the V-0 caller-side resolution probe procedure (`scripts/v0-probe/v0-procedure.md`). It is a minimal but valid wiki layout: one seed page, one source provenance file, one `log.jsonl` entry.

V-0 probes dispatch `wiki-page-writer` with this directory as `wiki_root`. Workers have `tools: []` and **cannot** write here even if substituted; main session in V-0 mode does NOT call `/wiki-ingest` against this wiki — it only inspects Agent dispatch responses for resolution metadata or forced-attempt outcomes.
