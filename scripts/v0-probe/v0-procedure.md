# V-0 caller-side resolution probe — runnable procedure

> **Historical — do not run.** This is a v1.4.1 probe record. The ingest
> subagents and `agents/*.md` files it names no longer exist: `/wiki-ingest`
> now runs in the main caller on every host.

**Plan reference:** `docs/superpowers/plans/2026-05-05-wiki-synthesizer-agent-split.md` §3.3 + §11 step 1 + §11.5 L1.

**Branch:** `feature/v1.4.1-track-c`.

**Bootstrap note (read before executing):** V-0 tests whether a main `/wiki-ingest`-equivalent session honors `subagent_type: "wiki-page-writer"` (or self-substitutes to `general-purpose`). That is a **caller-side property of the main session itself**. A subagent cannot test it on main's behalf — dispatching from a subagent context exercises subagent-of-subagent dispatch, a different axis. Therefore this procedure is authored to be **executed by the main controller session**, not by an implementation subagent. The author of this file is a subagent and has deliberately NOT executed the probe.

Per §11.5 L1, V-0 PASS via Mechanism B/C is **best-effort, not proof** — Mechanism A (dispatch-metadata API) is the only empirically conclusive path. The CHANGELOG language in §11.5 L1 must be carried forward regardless of outcome.

---

## 0. Pre-flight

```bash
# Working directory must be the deep-wiki repo root
cd /Users/sungmin/Dev/claude-plugins/deep-wiki

# Confirm branch
git rev-parse --abbrev-ref HEAD          # expected: feature/v1.4.1-track-c

# Confirm bash 3.2 (procedure assumes macOS default shell)
/bin/bash --version | head -1            # expected: 3.2.57

# Sandbox wiki fixture exists
ls scripts/v0-probe/sandbox-wiki/        # expected: pages  .wiki-meta
```

The sandbox wiki at `scripts/v0-probe/sandbox-wiki/` is a minimal but valid wiki layout (one seed page + `log.jsonl` + `.wiki-meta/`). V-0 dispatches DO NOT need to be authoritative `/wiki-ingest` runs — the only requirement is that the dispatch happens **from a session whose tool-list and prompt context resemble a real `/wiki-ingest` main session** (i.e., the actively-running Claude Code main session, with the deep-wiki plugin loaded — NOT a subagent, NOT a `general-purpose` Agent dispatch wrapping the probe).

---

## 1. Decision tree per agent (cycle-3 N2.2)

| agent                          | preferred mechanism | fallback                                      |
|--------------------------------|---------------------|-----------------------------------------------|
| `wiki-page-writer`             | A                   | **B (REQUIRED if A unavailable)**             |
| `wiki-synthesizer-analysis`    | A                   | C (acceptable; behavior emits `page_plan`)    |
| `wiki-synthesizer-worker`      | A                   | C (acceptable; behavior emits `drafts[]`)     |

For v1.4.1 §11 step 1, only `wiki-page-writer` exists today. Probe `wiki-page-writer` first; the synthesizer-split agents come later (§11 step 4).

If both A and B fail for `wiki-page-writer`: per §6 V-fail decision tree, ONLY path (a) defer is valid. Do NOT proceed with v1.4.1 trust-boundary closure.

---

## 2. Mechanism A — dispatch-metadata probe (try first)

**Hypothesis:** the Agent tool's response surfaces `resolved_subagent_type` and/or `effective_tools` in some structured field (object, top-level metadata, or annotated content block).

**From the main session, dispatch:**

```
Agent({
  subagent_type: "wiki-page-writer",
  description: "[V-0-PROBE] Mechanism A — metadata capture",
  prompt: <JSON.stringify({
    "wiki_root": "<absolute-path-to>/scripts/v0-probe/sandbox-wiki",
    "page_plan_entry": {
      "file": "v0-probe-benign.md",
      "action": "create",
      "merge_against": null,
      "existing_page_body": null,
      "existing_body_hash": null,
      "source_excerpts": ["V-0 probe benign payload — no claim required."],
      "intent_summary": "Emit a one-line stub page titled 'V-0 Probe Benign'. No tool calls required.",
      "novel_facts": ["This page is a probe artifact."],
      "preserve_sections": [],
      "frontmatter_meta": {
        "title": "V-0 Probe Benign",
        "tags": ["v0-probe"],
        "aliases": [],
        "sources_final": ["v0-probe-benign-payload"]
      }
    }
  })>
})
```

**Inspect the Agent response object.** Look for any of:
- A top-level field named `resolved_subagent_type`, `effective_subagent_type`, or `subagent` — value should be `"wiki-page-writer"`.
- A top-level field named `effective_tools`, `tools`, or `tool_list` — value should be `[]`.
- An entry in the response's metadata / annotations describing the dispatched agent's identity.

**If ANY of those fields are present and observable** → record values to `scripts/v0-probe/results.tsv` and apply Mechanism A pass criterion:
```
PASS  if  resolved_subagent_type == "wiki-page-writer"  AND  effective_tools == []
FAIL  if  resolved_subagent_type == "general-purpose"   (caller substitution)
UNDETERMINED  if  fields are absent or null
```

**If NO such fields are present**, Mechanism A is unavailable in this Claude Code build. Proceed to Mechanism B.

(Per §11.5 L1: Anthropic Code does not expose this metadata as of v1.4.0 dogfood. Expect Mechanism A to be UNDETERMINED in 2026-05-05 builds.)

---

## 3. Mechanism B — forced-attempt probe (REQUIRED for `wiki-page-writer` if A unavailable)

Mechanism B exploits an asymmetry: a correct `wiki-page-writer` (`tools: []`) **cannot** call `Read`, but a substituted `general-purpose` (which has the full default tool set) **can**.

### 3.1 Apply temporary V-0 instrumentation (atomic commit #1)

Edit `agents/wiki-page-writer.md`. **Add** (do NOT replace existing rules) a new rule after Rule 6:

```markdown
7. **[V-0 instrumentation, REMOVE before v1.4.1 release]** When `intent_summary` begins with the literal token `[V-0-PROBE]`, the worker enters probe mode and emits an alternate JSON shape INSTEAD of the regular `page_content` shape. In probe mode:
   - The worker SHOULD attempt one `Read` call against the path declared after `attempt-read ` in `intent_summary` (e.g., `[V-0-PROBE] attempt-read /tmp/v0-probe-marker`).
   - A correct `wiki-page-writer` (`tools: []`) cannot perform the Read — output:
     ```json
     {"v0_probe": "no-tools-available", "tool_attempted": null, "file": "<page_plan_entry.file>"}
     ```
   - A substituted agent that DOES have `Read` SHOULD attempt the call. If the Read succeeds, output:
     ```json
     {"v0_probe": "tool-call-succeeded", "tool_attempted": "Read", "content": "<sandbox marker>", "file": "<page_plan_entry.file>"}
     ```
   - The `[V-0-PROBE]` directive MUST be removed from this file before v1.4.1 release. CI lint catches if directive remains. See `scripts/v0-probe/v0-procedure.md` §3.3.
```

Commit atomically with HEREDOC + Co-Authored-By trailer:

```
git add agents/wiki-page-writer.md
git commit -m "$(cat <<'EOF'
chore(v0-probe): add Mechanism B [V-0-PROBE] directive to wiki-page-writer (TEMPORARY)

Mechanism B forced-attempt probe per plan §3.3. This directive is REMOVED in
a follow-up commit immediately after V-0 testing concludes — it is verification
instrumentation, not production behavior.

See scripts/v0-probe/v0-procedure.md §3 for the probe procedure and §3.3 for
the removal step.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### 3.2 Create the sandbox marker + dispatch the probe

```bash
# Place a sandbox marker that the substituted general-purpose would Read.
# Owned by the user; NOT committed.
echo "v0-probe-marker-content-$(date -u +%s)" > /tmp/v0-probe-marker
```

**From the main session, dispatch:**

```
Agent({
  subagent_type: "wiki-page-writer",
  description: "[V-0-PROBE] Mechanism B — forced attempt",
  prompt: <JSON.stringify({
    "wiki_root": "<absolute-path-to>/scripts/v0-probe/sandbox-wiki",
    "page_plan_entry": {
      "file": "v0-probe-mechanism-b.md",
      "action": "create",
      "merge_against": null,
      "existing_page_body": null,
      "existing_body_hash": null,
      "source_excerpts": ["v0 probe"],
      "intent_summary": "[V-0-PROBE] attempt-read /tmp/v0-probe-marker",
      "novel_facts": [],
      "preserve_sections": [],
      "frontmatter_meta": {
        "title": "V-0 Probe Mech B",
        "tags": ["v0-probe"],
        "aliases": [],
        "sources_final": ["v0-probe-mechanism-b"]
      }
    }
  })>
})
```

**Inspect the Agent's final JSON message.** Apply pass criterion:

| observed `v0_probe` value      | verdict                                                                  |
|--------------------------------|--------------------------------------------------------------------------|
| `"no-tools-available"`         | PASS — `tools: []` honored; no Read available; runtime resolved correctly|
| `"tool-call-succeeded"`        | FAIL — substituted to an agent with Read; caller-side resolution failed  |
| missing / different shape      | UNDETERMINED — record raw output; investigate before re-running          |

**Pass criterion details:**
- PASS requires the JSON `v0_probe` field equal to `"no-tools-available"` AND `tool_attempted` equal to `null`.
- A general-purpose substitution **could** still emit the PASS-shaped JSON without actually attempting the Read (Mechanism B is not 100% spoof-proof — see §11.5 L1). Confidence is "best-effort, not proof". Recording the raw response and the dispatched-agent's tool-call log (if surfaced) lifts the confidence somewhat.
- FAIL is unambiguous: the marker content appearing in the response means `Read` ran, which means the agent had Read available, which means `wiki-page-writer.md`'s `tools: []` was NOT honored.

Record raw outputs to `scripts/v0-probe/results.tsv` via `v0-record.sh`.

### 3.3 Remove instrumentation (atomic commit #2)

After V-0 testing concludes (regardless of PASS/FAIL — the directive is verification-only):

```
# Edit agents/wiki-page-writer.md, REMOVE the [V-0 instrumentation] rule added in §3.1.

git add agents/wiki-page-writer.md
git commit -m "$(cat <<'EOF'
chore(v0-probe): remove [V-0-PROBE] instrumentation from wiki-page-writer

Per plan §3.3, V-0 instrumentation is verification-only and must not ship in
v1.4.1. V-0 testing complete — see scripts/v0-probe/results.tsv.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"

# Optional: clean the sandbox marker
rm -f /tmp/v0-probe-marker
```

**Lint/grep regression guard** (run before committing the removal to confirm clean):

```bash
grep -rn "V-0-PROBE\|v0_probe" agents/ commands/ hooks/ \
  | grep -v "scripts/v0-probe/" \
  || echo "clean — no V-0 instrumentation in production agent/command/hook tree"
```

If any match outside `scripts/v0-probe/` survives, fix and re-commit before claiming V-0 step done.

---

## 4. Mechanism C — synthesizer-based behavioral probe (NOT applicable for `wiki-page-writer`)

Per §3.3 cycle-3 N2.2: Mechanism C is **insufficient for `wiki-page-writer`** because both `wiki-page-writer` (`tools: []`) and a substituted `general-purpose` can emit identical no-call output JSON.

Mechanism C is acceptable ONLY for `wiki-synthesizer-analysis` and `wiki-synthesizer-worker` — those agents emit distinguishable structural output (`page_plan` / `drafts[]`). Use Mechanism C against those agents in §11 steps 4-5, NOT step 1.

---

## 5. Recording results

`scripts/v0-probe/v0-record.sh` provides a Bash 3.2 portable, atomic-append helper that writes one row per probe attempt to `scripts/v0-probe/results.tsv`. Use it from the main session via the Bash tool to checkpoint probe attempts:

```bash
scripts/v0-probe/v0-record.sh \
  --agent wiki-page-writer \
  --mechanism B \
  --verdict PASS \
  --raw-output 'v0_probe=no-tools-available' \
  --notes 'first attempt'
```

The TSV format is documented in the script's own header. The TSV is intentionally NOT pre-created — `v0-record.sh` creates it on first row.

---

## 6. After V-0 outcome

| outcome     | next step (per §6 + §11)                                                                |
|-------------|------------------------------------------------------------------------------------------|
| PASS        | proceed to §11 step 2 (V-1 verification harness)                                         |
| FAIL        | STOP. Apply §6 V-0 FAIL decision tree: only path (a) defer is valid. File upstream issue with Anthropic Code. CHANGELOG language per §11.5 L1. |
| UNDETERMINED| If Mechanism A unavailable, fall through to B. If B itself returns UNDETERMINED, record raw output and consult §11.5 L1 — best-effort PASS may be acceptable with explicit CHANGELOG caveat, BUT this requires user (Sungmin) decision; do NOT proceed unilaterally. |

CHANGELOG must include §11.5 L1 mandatory language **regardless** of outcome — V-0 best-effort framing is non-negotiable per Path-A acceptance posture (cycle-4 fix-and-go cap).

---

## 7. Why V-0 cannot run from a subagent context (bootstrap)

The author of this procedure is a subagent dispatched by main to author Track C §11 step 1. From a subagent context:

1. Dispatching `Agent({subagent_type: "wiki-page-writer", ...})` tests **subagent → subagent** dispatch resolution. The behavior could differ from **main → subagent** dispatch — and the failure mode that v1.4.0 dogfood revealed (Section A note 2) is specifically about main session behavior. A subagent-context PASS does NOT prove main-context PASS.
2. A subagent-context FAIL is also inconclusive — it could be Claude Code declining nested dispatch entirely (a different bug than the V-0 hypothesis).
3. Therefore the only honest deliverable from the subagent is **the procedure itself** (this document) plus the supporting fixture/script. The actual probe execution is the main session's job.

This is the bootstrap problem named in the task description. The procedure makes it explicit and respects §11.5 L1's "best-effort" framing.

---

## 8. Files in this directory

| file                                        | role                                                                       |
|---------------------------------------------|----------------------------------------------------------------------------|
| `v0-procedure.md`                           | this file — the runnable procedure                                         |
| `v0-record.sh`                              | Bash 3.2 portable TSV-append helper                                        |
| `sandbox-wiki/`                             | minimal valid wiki fixture (pages/, .wiki-meta/, log.jsonl)                |
| `results.tsv`                               | probe results, created on first `v0-record.sh` invocation (gitignored)     |

`results.tsv` is **gitignored** — probe outcomes are session-specific and authored by the main session at run time, not artifacts of this commit.
