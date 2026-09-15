'use strict';

// Reference integrity for the always-loaded instruction surfaces.
//
// Ported from the guard of the same name in deep-goal (the documentation-
// placeholder anchor model, which is this repo's situation) carrying the newer
// rules from deep-work's and deep-loop's copies: the shipped-set index derived
// from an authority rather than a skip list, PLUGIN_DIRS derived from the tree,
// malicious-workspace plants derived from that index, the landing `isFile()`
// filter, the maintainer-only sweep, and the structural expanded-root rule.
//
// ANCHOR MODEL — documentation placeholder, deliberately NOT a shell variable.
//
// This repo's plugin-root anchor is `<plugin_root>`: 35 occurrences across the
// six SKILL.md files, pinned verbatim by `isAllowedRuntimeScript` in
// scripts/lib/executable-contract.js. It is substituted by the AGENT while
// reading the skill, before any command exists — so the whole expansion axis
// deep-work carries (`nonExpandingAnchors`, `expansionState`, `fenceBlocks`,
// `quotedHeredocLines` and their tests, roughly 200 lines) asks a question that
// cannot have an answer here: there is no shell variable, so no quoting context
// can leave one unexpanded. Porting it would add four rules that can never fire,
// which is worse than absent — a rule that cannot fire still reads as coverage.
//
// What IS ported from that axis is the half that survives the model change: `the
// anchor cannot be spelled as a shell variable anywhere`, written over the SHAPE
// of an expanding reference rather than over a list of variable names — see
// VARIABLE_ROOT below. It matters here more than in the siblings, because
// `isAllowedRuntimeScript` ALSO accepts `${CLAUDE_PLUGIN_ROOT}/scripts/…` and
// `%CLAUDE_PLUGIN_ROOT%\scripts\…` as skill argv. Claude Code expands the first;
// Codex — a first-class host for this plugin — sets no such variable, so on that
// host the literal survives into Node and the path resolves against the analysed
// project. No shipped markdown uses either spelling today; this keeps it that way.
//
// `<wiki_root>` IS NOT THE PLUGIN ROOT, and conflating the two would be a large
// over-flag. It is the wiki CONTENT root inside the analysed project — the suite
// mandates the underscore spelling as the canonical wiki path prefix — and a path
// under it is *supposed* to resolve against that project: that is what this plugin
// is for. `ABSOLUTE_WIKI_ROOT` is the same concept one step further along: it is
// an argv VALUE the agent replaces with the configured absolute wiki path, and it
// carries no separator and no dot, so it never tokenises as a path at all.
//
// Neither needs a carve-out, and none was added. The structural reason is that
// `<` and `>` are NOT in PATH_TOKEN's character class (see there): a token is
// judged by the path UNDER the placeholder, not by the placeholder. So
// `<wiki_root>/log.jsonl` yields `log.jsonl`, which names no plugin file and is
// silent, while `<PLUGIN_ROOT>/scripts/wiki-runtime.js` — a foreign root spelling
// nothing here substitutes — yields `scripts/wiki-runtime.js`, which does, and is
// flagged. Both directions are pinned by `a placeholder root is judged by the path
// under it`.
//
// Fence balance is checked because a `references/` split once truncated a fenced
// template mid-block in a sibling: the entry kept the opening ``` and the first
// dozen template lines, the remainder moved behind a conditional pointer, and
// nothing failed. An odd fence count is the machine-detectable signature.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const ALWAYS_LOADED = ['AGENTS.md', 'CLAUDE.md'];

// The scan set: every `.md` under skills/, plus the two always-loaded guides. The
// plugin ships no `agents/` tree, and `npm run lint:agents` fails if one returns —
// that is what keeps this walk complete. `CLAUDE.md` is a thin `@AGENTS.md`
// wrapper here, which is a reason to scan it and not a reason to skip it: it is
// loaded on every Claude Code session, so anything it names is an instruction the
// host has already accepted.
function markdownFiles() {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.md')) out.push(p);
    }
  };
  walk(path.join(ROOT, 'skills'));
  // `ALWAYS_LOADED` is asserted to be in the scan set by its own test, so
  // dropping it here fails loudly instead of silently shrinking coverage.
  for (const doc of ALWAYS_LOADED) {
    const p = path.join(ROOT, doc);
    if (fs.existsSync(p)) out.push(p);
  }
  return out;
}

// Every `.md` under skills/ — the documents an attacker would want to
// shadow. A bare Read(`storage-layout.md`) names one of these with no basis at
// all, so it resolves against cwd, which is the target workspace.
const PLUGIN_DOCS = (() => {
  const names = new Set();
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.name.endsWith('.md')) names.add(entry.name);
    }
  };
  walk(path.join(ROOT, 'skills'));
  return names;
})();

// Workspace-shadow guard.
//
// A bare `node scripts/wiki-runtime.js` or `Read references/storage-layout.md`
// resolves against the *target workspace*, not the plugin. A repository under
// analysis can put a file at that path and have it read as instructions or run
// with the caller's Bash permissions.
//
// Parent-relative forms (`../wiki-schema/references/x.md`) are just as shadowable.
// A markdown link resolves against the source file, but a runtime read has no such
// basis — it resolves against cwd. So this guard must NOT reuse the reference-
// integrity resolution at the bottom of this file: integrity asks "does this file
// exist?" and may resolve relative to the source; the shadow guard asks "does this
// instruction name a trustworthy basis?", and only an explicit plugin-root anchor
// does.
//
// Two clauses, both required for every instruction form:
//   A. anchoring   — the path names the plugin root explicitly.
//   B. containment — the resolved path stays inside the plugin root.
// Clause B is not implied by A: `<plugin_root>/../workspace/evil.md` carries the
// anchor and still escapes.
//
// Scope: paths the plugin tells an agent to *open or run*. For `.js`/`.sh` that is
// every mention — naming an executable is only useful for running it — so those
// are checked wherever they appear. A descriptive cross-reference to a `.md` in
// prose is not a load instruction, but deny-by-default below does not try to tell
// the two apart: any token resolving to a real plugin file must be anchored
// regardless of the sentence around it.
//
// SEPARATORS. Windows is a first-class host here — AGENTS.md documents the Codex
// `%COMSPEC% /C` boundary and CI covers Windows Server 2025 — so
// `scripts\wiki-runtime.js` names the same file as `scripts/wiki-runtime.js`. A
// matcher that knows only `/` lets the whole deny-by-default invariant be bypassed
// with one character, which is what review measured in two siblings: the slash
// form produced failures and the backslash form produced none.
//
// The fix is not to teach each matcher a second shape — that leaves the mixed form
// (`scripts\lib/executable-contract.js`) open and re-opens on the next rule added.
// Instead every extracted token is normalised once, at tokenisation, so
// deny-by-default, the FORMS, bare-basename and containment all judge one
// canonical spelling without being taught anything. Runs of separators collapse,
// so an escaped `scripts\\x.js` in a string literal normalises to the same path.
// Over-normalising is the safe direction here: a token only matters once it
// resolves to a real file in the plugin, and prose containing a stray backslash
// resolves to nothing.
const SEP = String.raw`[\\/]`;
const normalizePath = (token) => token.replace(/[\\/]+/g, '/');

// Repo-relative key, in the one spelling both sides of every PLUGIN_FILES
// comparison must use. `path.relative` returns the *host's* separator, so on
// Windows it hands back `scripts\wiki-runtime.js` while the token being looked up
// has already been normalised to `scripts/wiki-runtime.js` — the two never meet
// and every membership test misses. Normalising the token but not the key
// normalises one side of a comparison, which is not normalising at all.
// `rel` is injectable so the Windows spelling can be exercised from a POSIX CI run
// — `path.win32.relative` is the same implementation that host uses. It defaults
// to the host's and disables nothing, so it is a seam for emulation rather than a
// switch that can turn the rule off.
const repoKey = (from, to, rel = path.relative) => normalizePath(rel(from, to));

// SHIPPED SET — the index deny-by-default consults.
//
// deep-work derives this from `package.json#files`, because that field is exactly
// what npm packs. This repo declares no `files` field, so that authority does not
// exist here; the one that does is git tracking. These plugins install by clone at
// a pinned SHA, so a file git does not track cannot exist in an installed plugin
// at all — which is precisely the property the index needs, and it is the same
// authority whether the reader is a maintainer's checkout or CI. A `readdirSync`
// walk with a skip list is what this replaces: in a sibling it missed five
// gitignored runtime directories and let 348 of 673 keys come from directories
// absent in a clean clone, so what deny-by-default could see differed between a
// maintainer's machine and CI, with CI on the lax side. Here that would be
// `docs/`, `.deep-review/`, `.deep-loop/`, `.deep-docs/` and `.claude/`.
//
// NOTHING is then removed — not even `tests/`. deep-loop drops it on the ground
// that no skill tells an agent to read a test file; that argument does not hold
// here, because this repo has no packing manifest and `tests/` therefore lands in
// every installed clone, and because AGENTS.md names two test files by literal
// path rather than by glob. A path that ships and is named unanchored is
// shadowable whether or not the file is a test, so the fail-closed reading is the
// one that needs no exemption argument. `docs/` falls out on its own, being
// gitignored, and is covered by the maintainer-only sweep at the bottom instead.
function trackedFiles() {
  return execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8' })
    .split('\0').filter(Boolean).map(normalizePath);
}

const TRACKED = trackedFiles();

function buildPluginFiles({ toKey = (p) => repoKey(ROOT, p), tracked = TRACKED } = {}) {
  const rel = new Set();
  for (const gitPath of tracked) rel.add(normalizePath(toKey(path.join(ROOT, gitPath))));
  return rel;
}

const PLUGIN_FILES = buildPluginFiles();

// The directory names a plugin path can start with, DERIVED from what git tracks
// rather than listed. A hand list is the same defect one level down: it matches
// the tree on the day it is written and goes quiet the first time a directory is
// added.
//
// EVERY segment, not just the top-level one. An instruction writes a path relative
// to wherever the author was standing, and AGENTS.md's own spelling is
// `references/storage-layout.md` — `references` is nested two deep under
// `skills/` — so a top-level-only derivation would leave the read-verb FORM silent
// on that shape. Deny-by-default cannot cover for it either: it needs the token to
// resolve repo-relative, and `references/…` does not.
const PLUGIN_DIRS = (() => {
  const dirs = new Set();
  for (const p of TRACKED) {
    const segments = p.split('/');
    for (let i = 0; i < segments.length - 1; i += 1) dirs.add(segments[i]);
  }
  return [...dirs].sort().map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
})();

const ANCHOR = String.raw`<plugin_root>`;
const ANCHORED_TOKEN = new RegExp(`^(?:${ANCHOR})/`);
const PATH_BODY = String.raw`[A-Za-z0-9._/\\${'{}'}|$-]+`;
const REL = String.raw`\.{1,2}${SEP}`;
const ANY_ROOT = String.raw`(?:(?:${ANCHOR})${SEP}|${REL}|(?:${PLUGIN_DIRS})${SEP})`;

// Each pattern captures the path token in group 1, so anchoring and containment
// are judged per token rather than per line — a line mixing an anchored and a bare
// path must still fail on the bare one.
// Extensions are asked of the shipped index, not listed. The listed version missed
// what the plugin actually ships: deep-wiki ships a `.py`, and all three ship a
// `.yml` that no list held. A new file type added tomorrow joins these sets by
// existing, which is the point.
const SHIPPED_EXTS = [...new Set([...PLUGIN_FILES]
  .map((k) => (k.match(/\.([A-Za-z0-9]+)$/) || [])[1]).filter(Boolean))].sort();
// For "is this token an instruction to RUN something", the list is INVERTED. Naming
// the executable extensions is fail-open — the extension nobody thought of is
// silently inert. Naming the inert ones is fail-closed: an unfamiliar extension is
// treated as runnable and gets flagged, and the cost of being wrong is a review
// conversation instead of a miss.
const INERT_EXTS = new Set(['md', 'mdx', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'txt',
  'csv', 'tsv', 'lock', 'html', 'css', 'xml', 'map', 'snap', 'png', 'svg', 'gif', 'ico',
  'gitkeep', 'gitignore', 'gitattributes', 'nvmrc', 'editorconfig']);
const EXEC_EXTS = SHIPPED_EXTS.filter((e) => !INERT_EXTS.has(e));
// The EXISTENCE sweep deliberately takes ANY extension. Deriving it from what the repo
// ships made it blind exactly where the reference is certainly broken: an anchored
// `…/missing-config.toml` went unchecked BECAUSE no `.toml` is shipped. The derived set
// earns its keep in EXECUTABLE_EXT below, where the question is "would this be run".
const RESOLVABLE_EXT = SHIPPED_EXTS.join('|');
const EXECUTABLE_EXT = EXEC_EXTS.join('|');

// One list, used by both rules that decide "is this token in command position".
// They had drifted: `BARE_EXEC_BASENAME` accepted `deno` and `bun`, `interpreter-exec`
// did not, in this same file — so `bun scripts/missing-tool` was silent while
// `bun missing-tool.js` was caught. This is still an enumeration and still fail-open on
// the interpreter nobody added; sharing it does not settle that, it only stops the two
// halves from disagreeing about the same question.
const INTERPRETERS = 'bash|sh|zsh|node|python3?|deno|bun|npx|pnpm|yarn|tsx|ts-node';
const FORMS = [
  // 1. interpreter exec: `node X`, `bash X`, `sh X`, `python X`
  ['interpreter-exec', new RegExp(String.raw`\b(?:${INTERPRETERS})\s+["'\`]?(${ANY_ROOT}${PATH_BODY})`, 'g')],
  // 2. read verb: `Read X`, `Follow X`, `Read("X")`
  ['read-verb', new RegExp(String.raw`\b(?:Read|Follow|read|follow)\s*\(?\s*["'\`]?(${ANY_ROOT}${PATH_BODY}\.md)`, 'g')],
  // 3. direct exec / source
  ['direct-exec', new RegExp(String.raw`(?:\b(?:source|exec)\s+|^\s*\.\s+)["'\`]?(${ANY_ROOT}${PATH_BODY})`, 'gm')],
  // 4. executable path token anywhere.
  //    The trailing boundary matters: without it `.js` matches the prefix of
  //    `hooks.json` — a real file here — and the guard reports a path that never
  //    existed. The lookbehind keeps `/` and `\` in its class so an already-matched
  //    anchored prefix does not also produce a bare hit on its own tail.
  ['executable-token', new RegExp(String.raw`(?<![A-Za-z0-9._/\\{}<>$-])((?:${ANCHOR})${SEP}|${REL}|(?:${PLUGIN_DIRS})${SEP})([A-Za-z0-9._/\\-]*\.(?:${EXECUTABLE_EXT})(?![A-Za-z0-9]))`, 'g')],
];

// DENY BY DEFAULT.
//
// Enumerating instruction syntaxes is the losing half of the problem — each round
// of the original review found a form outside the current allowlist. So the
// question is not "is this a known instruction syntax?" but "does this token
// resolve to a real file in the plugin?". Anything that does must be anchored,
// whatever the verb, extension or sentence around it. Anything that does not
// resolve is prose about the target project and passes.

// Single-segment metadata, DERIVED rather than listed. A token with no separator
// that names a root-level file of THIS repo names the same file in every project
// that has one — `README.md`, `AGENTS.md`, `package.json` — so a bare mention is
// descriptive ("package.json declares engines") rather than an instruction with a
// basis, and the reading the author intended is the project's copy anyway.
// Multi-segment paths get no such pass. Deriving it means the exemption tracks the
// repo root instead of a list that was true once.
const ROOT_METADATA = new Set([...PLUGIN_FILES].filter((k) => !k.includes('/')));

// Path-shaped tokens: multi-segment paths, plus dotted single segments.
//
// The `+` on the separator class is load-bearing. Without it a run of separators
// breaks the segment repetition, the whole-path alternative fails, and the
// tokeniser falls back to the bare-basename alternative — which resolves to
// nothing, so deny-by-default never sees the path. `.js` names survive that gap
// because the executable-token FORM's body class spans a run on its own; `.md`
// with no read verb has no such umbrella.
//
// `<`, `>`, `$`, `{` and `}` are deliberately NOT in the leading class, unlike the
// sibling this was ported from. There they were admitted so a bracketed or
// `${}`-shaped anchor would tokenise as part of the path, and a leading-bracket
// trim had to be bolted on afterwards to stop `<skills/…/x.md 첨부>` from
// extracting with the bracket attached and silently failing to resolve. Leaving
// them out makes the tokeniser judge the PATH rather than the placeholder in front
// of it, and the anchored case is recovered from context instead (see
// scopedTokens). That buys three things this repo specifically needs:
//   - `<wiki_root>/log.jsonl` yields `log.jsonl`, so a correct workspace-rooted
//     reference is silent because nothing under it is a plugin file — not because
//     the whole token was swallowed into something unresolvable;
//   - `<PLUGIN_ROOT>/scripts/wiki-runtime.js` and
//     `${CLAUDE_PLUGIN_ROOT}/scripts/wiki-runtime.js` — foreign root spellings
//     nothing here substitutes — yield `scripts/wiki-runtime.js`, which resolves,
//     so they are flagged rather than waved through;
//   - no bracket-trimming special case is needed at all.
// The residual is that a template segment INSIDE a path (`skills/<name>/SKILL.md`)
// tokenises as its tail only. That path names no file either way, so nothing that
// could resolve is lost.
const PATH_TOKEN = /[A-Za-z0-9_.@-]+(?:[\\/]+[A-Za-z0-9_.@{}|*-]+)+|[A-Za-z0-9_-]+\.[A-Za-z0-9]{1,6}\b/g;

// Written once, and consumed both by the tokeniser (to recognise that a bare-
// looking token sits under the anchor) and by the anchored-prefix test below, so
// the two cannot drift apart.
const ANCHOR_PREFIX = new RegExp(String.raw`${ANCHOR}["'\s]*${SEP}$`);

// `files` is injectable for the same reason `toKey` is: the Windows key shape has
// to be pinnable in CI, not merely checked once by hand. `rel` is injectable
// alongside it because the `fromSource` normalisation is otherwise unpinnable: on
// POSIX `relative()` already returns slashes, so removing the normalisation is a
// no-op here and no mutation can see it. Only a win32 `relative` exercises it, and
// it has to be injected into the production call site — a copy of the logic in a
// test pins the test's arithmetic, not the guard's.
function resolvesInPlugin(token, sourceFile, files = PLUGIN_FILES, rel = path.relative) {
  const clean = normalizePath(token).replace(/^\.\//, '');
  if (files.has(clean)) return true;
  try {
    const fromSource = repoKey(ROOT, path.resolve(path.dirname(sourceFile), clean), rel);
    if (files.has(fromSource)) return true;
  } catch { /* unresolvable token — prose */ }
  return false;
}

// Scope, defined once. Yields the path tokens on a line that the invariant
// governs, with the documented exemptions applied. Both the classifier and the
// malicious-workspace fixture consume this, so they cannot test different rules.
function* scopedTokens(line) {
  PATH_TOKEN.lastIndex = 0;
  let m;
  while ((m = PATH_TOKEN.exec(line))) {
    // Normalise once, here, so every consumer — the classifier, the exemption
    // lookups and the malicious-workspace fixture alike — judges the same string.
    // Doing it any later means the basename exemption below sees `SKILL.md` where
    // the whole token was `skills\wiki-lint\SKILL.md`, which is precisely the hole
    // a sibling shipped with.
    const token = normalizePath(m[0]);
    const before = line.slice(Math.max(0, m.index - 30), m.index);
    // Under the anchor. The anchor is not part of the token — PATH_TOKEN cannot
    // start on `<` — so it is re-attached here rather than dropped. Skipping
    // instead (which is what the siblings do for their context-detected anchors)
    // would hand clause B a token it never sees: an anchored `.json` or `.yaml`
    // traversal matches no FORM at all, so deny-by-default is the only layer that
    // can judge its containment.
    if (ANCHOR_PREFIX.test(before)) {
      yield `${ANCHOR}/${token}`;
      continue;
    }
    if (!token.includes('/') && ROOT_METADATA.has(token)) continue;
    // deep-loop additionally exempts a document that names its own basename, on the
    // grounds that self-reference is not a load instruction. NOT PORTED, and it was
    // measured before being left out rather than assumed away: no skill or agent
    // document here writes a bare `SKILL.md`, so the exemption could never fire —
    // and it is the wrong reading anyway. `Read SKILL.md` handed to a file tool
    // resolves against cwd, which is the analysed project, whatever the author
    // meant by it. That is the bare-basename attack, not an exception to it.
    // Markdown link target `](x.md)` — rendered navigation between documents, not
    // an instruction handed to a file tool. Markdown does not interpolate, so
    // these must stay source-relative; the link-destination test below pins that
    // they are never anchored.
    if (/\]\($/.test(before)) continue;
    yield token;
  }
}

function denyByDefaultHits(line, sourceFile, root = ROOT) {
  const out = [];
  for (const token of scopedTokens(line)) {
    if (ANCHORED_TOKEN.test(token)) {
      // Clause B is enforced here, not deferred. deep-work waves anchored tokens
      // through with a "clause B checks these" comment, which is only true where a
      // FORM also matched — a contained-looking path whose component links out of
      // the root is exactly the file an attacker wants accepted, and a `.yaml` or
      // `.json` token matches no FORM. `every referenced plugin path resolves
      // inside the root` is a second, independent backstop.
      if (escapesRoot(token)) out.push({ form: 'resolves-in-plugin', token, why: 'escapes plugin root' });
      else if (escapesViaSymlink(token, root)) out.push({ form: 'resolves-in-plugin', token, why: 'escapes via symlink' });
      continue;
    }
    // Forward defence only: a non-shipped path never resolves in the plugin, so
    // this line is unreachable today. All of the actual protection is in the two
    // maintainer-only tests below. It is kept so that adding such a path to the
    // shipped set later fails the caveat test rather than this rule silently.
    if (NON_SHIPPED_DECLARED.has(token)) continue;
    if (resolvesInPlugin(token, sourceFile)) {
      out.push({ form: 'resolves-in-plugin', token, why: 'unanchored' });
    }
  }
  return out;
}

// bare basename read: Read(`storage-layout.md`). It resolves to no repo-relative
// path, so the rule above cannot see it — yet it is the weakest form of all,
// resolving straight against cwd. Only basenames that name a real plugin document
// are flagged, so ordinary prose is untouched.
const BARE_BASENAME = /\b(?:Read|Follow|read|follow)\s*\(?\s*["'`]([A-Za-z0-9][A-Za-z0-9._-]*\.md)(?:#[^`"']*)?["'`]/g;

// The executable twin. `Read`/`Follow` on a `.md` was covered; an interpreter on a
// runnable file was not, and that shape is strictly more dangerous: `node
// wiki-runtime.js` resolves against cwd — the analysed workspace — and running a
// planted file there is arbitrary code execution with the caller's permissions.
// Membership in the shipped set is still required, so prose that merely names a
// script is untouched; it is the interpreter that makes it an instruction.
const BARE_EXEC_BASENAME =
  new RegExp(String.raw`\b(?:${INTERPRETERS})\s+["'\`]?([A-Za-z0-9][A-Za-z0-9._-]*\.(?:${EXECUTABLE_EXT}))["'\`]?`, 'g');

function bareBasenameHits(line) {
  const out = [];
  BARE_BASENAME.lastIndex = 0;
  let m;
  while ((m = BARE_BASENAME.exec(line))) {
    if (PLUGIN_DOCS.has(m[1])) out.push({ form: 'bare-basename', token: m[1], why: 'unanchored' });
  }
  const shippedBasenames = new Set([...PLUGIN_FILES].map((f) => f.split('/').pop()));
  BARE_EXEC_BASENAME.lastIndex = 0;
  while ((m = BARE_EXEC_BASENAME.exec(line))) {
    if (shippedBasenames.has(m[1])) {
      out.push({ form: 'bare-exec-basename', token: m[1], why: 'unanchored' });
    }
  }
  return out;
}

// JS module load — refused outright, in every spelling.
//
// The rule this enforces is "an instruction document does not embed a JS module
// load of a plugin file", not "anchor it properly". There is no safe textual form
// here, because `<plugin_root>` is a placeholder an *agent* substitutes while
// reading prose — no JS runtime expands it, so
// `require("<plugin_root>/scripts/wiki-runtime.js")` is a bare package specifier
// and Node searches the *workspace* node_modules; loading a planted module there
// is arbitrary code execution. `${CLAUDE_PLUGIN_ROOT}` is the same defect, and its
// backtick form additionally interpolates a local variable rather than the
// environment. A relative specifier (`./.claude-plugin/plugin.json`) is the same
// class by a shorter route: it resolves against cwd. This plugin's documented
// runtime interface is one structured argv call to `wiki-runtime.js`, so any JS
// module load naming a path inside an instruction document is a violation in every
// spelling.
const JS_MODULE_LOAD = /(?:\brequire\s*\(|\bimport\s*\(|\bimport\b[^;\n]*?\bfrom\s+)\s*["'`]([^"'`\n]+)["'`]/g;

function jsModuleLoadHits(line) {
  const out = [];
  JS_MODULE_LOAD.lastIndex = 0;
  let m;
  while ((m = JS_MODULE_LOAD.exec(line))) {
    const spec = m[1];
    if (/^node:/.test(spec)) continue;                       // built-in, no path
    out.push({
      form: 'js-module-load',
      token: spec,
      why: 'JS specifier — no runtime substitutes the documentation anchor, so the '
        + 'path resolves against the workspace (bare specifiers under its node_modules)',
    });
  }
  return out;
}

const ROOT_SENTINEL = path.sep === '/' ? '/plugin-root' : 'C:\\plugin-root';

// Clause B. Substitute the anchor with a sentinel root, resolve, and require the
// result to stay inside it. Tokens carrying a placeholder (`<slug>`, `{a|b}`,
// `$WORK_DIR`) cannot be resolved literally, so they are checked lexically for
// `..` instead. Angle brackets are in the placeholder class because they are this
// repo's placeholder convention.
const PLACEHOLDER = /[{}|$<>]/;

function escapesRoot(token) {
  const body = normalizePath(token).replace(new RegExp(`^(?:${ANCHOR})/`), '');
  if (PLACEHOLDER.test(body)) return body.split('/').includes('..');
  const resolved = path.resolve(ROOT_SENTINEL, body);
  return resolved !== ROOT_SENTINEL && !resolved.startsWith(ROOT_SENTINEL + path.sep);
}

// Symlink escape: an anchored, lexically-contained path can still point out of the
// root if a component is a symlink. Only checkable for targets that exist.
//
// `root` is a parameter rather than a closed-over constant so the fixture can use a
// throwaway root outside the repository. A sibling planted its symlink *inside* the
// real root, which raced another test file's repo-tree copy — `node --test` runs
// files in parallel processes — and made the suite fail 5 runs in 20. A flaky
// security guard is worse than a missing one: it teaches people to re-run until
// green.
function escapesViaSymlink(token, root = ROOT) {
  const body = normalizePath(token).replace(new RegExp(`^(?:${ANCHOR})/`), '');
  if (PLACEHOLDER.test(body)) return false;
  const target = path.join(root, body);
  if (!fs.existsSync(target)) return false;
  const real = fs.realpathSync(target);
  const realRoot = fs.realpathSync(root);
  return real !== realRoot && !real.startsWith(realRoot + path.sep);
}

// Resolve a token for real, from a given cwd, exactly as a runtime agent would.
// Re-running the classifier tells you only what the classifier already believes;
// this performs the resolution and asks which file the instruction lands on. It is
// the second, independent layer, and it is shared by every fixture that needs it
// so no two of them can disagree about what resolution means.
function resolveAsAgentWould(token, cwd) {
  if (ANCHORED_TOKEN.test(token)) {
    return path.resolve(ROOT, token.replace(new RegExp(`^${ANCHOR}/`), ''));
  }
  return path.resolve(cwd, token.replace(/^\.\//, ''));
}

// Returns violations on a line: {form, token, why}. Empty when the line is clean.
function shadowableTokens(line, sourceFile = path.join(ROOT, 'AGENTS.md'), root = ROOT) {
  const out = [];
  for (const [form, re] of FORMS) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line))) {
      const token = normalizePath(m[2] === undefined ? m[1] : m[1] + m[2]);
      if (!ANCHORED_TOKEN.test(token)) out.push({ form, token, why: 'unanchored' });
      else if (escapesRoot(token)) out.push({ form, token, why: 'escapes plugin root' });
      else if (escapesViaSymlink(token, root)) out.push({ form, token, why: 'escapes via symlink' });
    }
  }
  out.push(...bareBasenameHits(line));
  out.push(...jsModuleLoadHits(line));
  out.push(...denyByDefaultHits(line, sourceFile, root));
  // A token can match several FORMS plus deny-by-default; report each once.
  const seen = new Set();
  return out.filter((v) => {
    const key = `${v.token}|${v.why}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Indented too: fences nested in a list item or a numbered step are still fences.
const FENCE = /^[ \t]*```/gm;
const fenceCount = (body) => (body.match(FENCE) || []).length;

test('every skill and always-loaded markdown file has balanced code fences', () => {
  // The corpus is balanced today, so the sweep below cannot fail on its own —
  // deleting the whole parity check would leave this test green. The counter is
  // therefore pinned on the axis first, by COUNT rather than by parity: a
  // column-0-only matcher returns zero for the indented rows, and zero is even, so
  // a parity assertion would accept the very mutation this is here to catch. That
  // matcher is not hypothetical — in a sibling it left two reference files with
  // none of their fences checked.
  assert.equal(fenceCount('```js\nx\n```\n'), 2, 'a closed block is two markers');
  assert.equal(fenceCount('```js\nx\n'), 1, 'an unclosed block is one');
  assert.equal(fenceCount('1. step\n   ```bash\n   x\n   ```\n'), 2,
    'an indented fence pair must be counted, or a truncated list block reads as balanced');
  assert.equal(fenceCount('1. step\n   ```bash\n   x\n'), 1,
    'and its truncated form must read as odd');

  // Parity is a proxy, and it detects neither real failure. `skills/deep-report/SKILL.md`
  // carried fourteen markers — even, so this sweep passed — while a ```bash with an info
  // string failed to close the ```markdown template above it, a later bare marker closed
  // that template instead, and the final block was never closed at all. Half the document
  // rendered as code. So the parity count stays (it catches a truncating split cheaply)
  // and CommonMark's own rule is asserted beside it: a closer matches the opener's
  // character, is at least as long, and carries NO info string.
  //
  // CARVE-OUT, deliberate: `fenceRegions()` must NOT be made CommonMark-correct. It
  // answers a different question — whether a reader copying from a binding to its use
  // crosses a boundary, because two fenced blocks are two shell invocations — and
  // marker counting is the right model for that. The two differing readings are not an
  // inconsistency to tidy away.
  const openAtEof = (body) => {
    let open = null;
    for (const line of body.split('\n')) {
      const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
      if (!m) continue;
      const ch = m[1][0];
      const len = m[1].length;
      if (open === null) { open = { ch, len }; continue; }
      if (ch === open.ch && len >= open.len && !m[2].trim()) open = null;
    }
    return open !== null;
  };
  assert.equal(openAtEof('```js\nx\n```\n'), false, 'a closed block is closed');
  assert.equal(openAtEof('```js\nx\n'), true, 'a truncated block is open at EOF');
  // The real shape, not a shorthand for it: an info-string marker cannot close, so the
  // bare marker meant to end the NESTED block ends the outer one instead, and every
  // later marker is off by one until the last opens a block nothing closes. A
  // two-marker fixture does not reproduce this — it just closes the outer early.
  assert.equal(openAtEof('```markdown\n```bash\nx\n```\nmore\n```\n'), true,
    'same-length nesting shifts every later marker and leaves the last block open');
  assert.equal(openAtEof('````markdown\n```bash\nx\n```\nmore\n````\n'), false,
    'and a longer outer fence nests correctly, which is the fix applied to deep-report');

  const truncated = [];
  for (const file of markdownFiles()) {
    if (openAtEof(fs.readFileSync(file, 'utf8'))) truncated.push(path.relative(ROOT, file));
  }
  assert.deepEqual(truncated, [],
    'a code fence is still open at end of file — the rest of the document renders as '
    + `code:\n  ${truncated.join('\n  ')}`);

  const unbalanced = [];
  for (const file of markdownFiles()) {
    const fences = fenceCount(fs.readFileSync(file, 'utf8'));
    if (fences % 2 !== 0) unbalanced.push(`${path.relative(ROOT, file)} (${fences})`);
  }
  assert.deepEqual(unbalanced, [],
    `unclosed code fence — a split or edit truncated a fenced block:\n  ${unbalanced.join('\n  ')}`);
});

test('the always-loaded agent guides are in the scan set', () => {
  // Root-level entries in ALWAYS_LOADED have no separator, so a Windows emulation
  // over them alone cannot fail — it would be a decorative assertion. The
  // derivation is pinned against a real nested document instead, which is where
  // the spelling actually diverges. `rel` is a seam, not a switch: it defaults to
  // the host's and turns nothing off.
  const scanKeys = (rel = path.relative) =>
    markdownFiles().map((f) => normalizePath(rel(ROOT, f)));
  const scanned = scanKeys();
  for (const doc of ALWAYS_LOADED) {
    assert.ok(fs.existsSync(path.join(ROOT, doc)), `${doc} must exist to be scanned`);
    assert.ok(scanned.includes(doc), `${doc} must be in the shadow-guard scan set`);
  }
  // The skills tree must actually be walked. Asserting only that the set is
  // non-empty would pass with it dropped, because the two root guides keep the set
  // full on their own.
  assert.ok(scanned.some((k) => k.startsWith('skills/')),
    'skills/ must be in the shadow-guard scan set');
  const nested = scanned.find((k) => k.includes('/'));
  assert.ok(nested,
    'the scan set must hold a nested document, or the next assertion proves nothing');
  assert.ok(scanKeys(path.win32.relative).includes(nested),
    `the Windows spelling of ${nested} must be the same key as the host's — `
    + 'otherwise every membership check against a slash literal misses there');
});

test('no read or exec instruction can be shadowed from the target workspace', () => {
  const violations = [];
  for (const file of markdownFiles()) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      for (const v of shadowableTokens(line, file)) {
        violations.push(`${path.relative(ROOT, file)}:${i + 1}  [${v.form}] ${v.token} — ${v.why}`);
      }
    });
  }
  assert.deepEqual(violations, [],
    'plugin path read or executed outside the plugin root — anchor it at '
    + `${ANCHOR} and keep it inside the root:\n  ${violations.join('\n  ')}`);
});

// One case per instruction form, so the coverage claim is itself tested. A form
// with no case here is a form the guard does not enforce. `safe` is null for
// js-module-load: that form has no safe textual spelling in this repo, and the
// dedicated test below pins that the anchored spelling is refused too.
const FORM_CASES = [
  ['interpreter-exec', 'node scripts/wiki-runtime.js config resolve --json',
    'node "<plugin_root>/scripts/wiki-runtime.js" config resolve --json'],
  ['read-verb', 'Read `references/storage-layout.md` and apply the operation catalog',
    'Read `<plugin_root>/skills/wiki-schema/references/storage-layout.md` and apply the operation catalog'],
  ['direct-exec', 'source scripts/wiki-runtime.js',
    'source <plugin_root>/scripts/wiki-runtime.js'],
  ['executable-token', 'the runtime lives at `scripts/wiki-runtime.js`',
    'the runtime lives at `<plugin_root>/scripts/wiki-runtime.js`'],
  ['bare-basename', 'Read(`storage-layout.md`)',
    'Read(`<plugin_root>/skills/wiki-schema/references/storage-layout.md`)'],
  ['dot-relative', 'Read("../wiki-schema/references/storage-layout.md")',
    'Read("<plugin_root>/skills/wiki-schema/references/storage-layout.md")'],
  ['js-module-load', 'const c = require("scripts/lib/executable-contract.js");', null],
];

test('every enumerated instruction form is enforced', () => {
  for (const [form, unsafe, safe] of FORM_CASES) {
    assert.ok(shadowableTokens(unsafe).length > 0, `${form}: guard must flag — ${unsafe}`);
    if (safe === null) continue;
    assert.deepEqual(shadowableTokens(safe), [], `${form}: guard must accept — ${safe}`);
  }
});

test('each instruction form is the only rule that can see its own case', () => {
  // FORM_CASES proves each form's case is FLAGGED; it does not prove the form is
  // what flags it. Measured: deleting `interpreter-exec`, `direct-exec` or the
  // BARE_EXEC_BASENAME half of bareBasenameHits turned no test red, because their
  // FORM_CASES lines name a real shipped `.js` under a real plugin directory —
  // which executable-token and deny-by-default both catch on their own. Three
  // decorative rows, indistinguishable from coverage until each was removed.
  //
  // Each case below is chosen so exactly one rule can reach it. The path is
  // extensionless or bare, so executable-token cannot match it, and it names a file
  // that does not exist, so deny-by-default cannot resolve it.
  for (const [form, line] of [
    // No runnable extension: only an interpreter in front makes it an instruction.
    // This is the shape executable-token structurally cannot cover.
    ['interpreter-exec', 'node scripts/missing-tool --json'],
    // `source` is not in the interpreter list, and `sh` inside `source` is not a
    // word — so only direct-exec can see this.
    ['direct-exec', 'source scripts/missing-tool'],
    // A bare basename has no root segment at all, so no ANY_ROOT form matches and
    // the token resolves to no repo-relative path. It is the weakest form of all —
    // `wiki-runtime.js` here is a real shipped script, and cwd is the analysed
    // workspace.
    ['bare-exec-basename', 'node wiki-runtime.js lock status'],
  ]) {
    assert.deepEqual(shadowableTokens(line).map((h) => h.form), [form],
      `${form} must be the only rule that catches this: ${line}`);
  }
  // Non-vacuity for the bare-exec row: membership in the shipped set is what makes
  // it an instruction rather than prose, so an unshipped basename must stay silent.
  assert.deepEqual(shadowableTokens('node not-a-shipped-script.js --json'), [],
    'an interpreter on a basename the plugin does not ship is prose');
});

test('a JS module load is refused in every spelling, anchored or not', () => {
  for (const line of [
    'const c = require("scripts/lib/executable-contract.js");',
    'const c = require("<plugin_root>/scripts/lib/executable-contract.js");',
    'const c = require("${CLAUDE_PLUGIN_ROOT}/scripts/lib/executable-contract.js");',
    'import c from `${CLAUDE_PLUGIN_ROOT}/scripts/lib/executable-contract.js`;',
    "const v = require('./.claude-plugin/plugin.json');",
  ]) {
    assert.ok(jsModuleLoadHits(line).length > 0, `must flag JS module load: ${line}`);
  }
  assert.deepEqual(jsModuleLoadHits('const { readFileSync } = require("node:fs");'), [],
    'a Node built-in specifier names no path and must pass');

  // WIRING, isolated. Every assertion above calls `jsModuleLoadHits` directly, so
  // all of them keep passing when the rule is unhooked from the classifier —
  // measured in a sibling: removing it from `shadowableTokens` dropped the corpus
  // sweep by one finding and turned no test red. `FORM_CASES` cannot cover the gap
  // either, because its js-module-load line names a `.js` under a real plugin
  // directory and the executable-token FORM flags that on its own. This specifier
  // is reachable by nothing else: `.json` matches no FORM, and the path resolves
  // nowhere so deny-by-default cannot see it.
  assert.deepEqual(
    shadowableTokens('const cfg = require("./missing-dir/settings.json");').map((h) => h.form),
    ['js-module-load'],
    'the JS module-load rule must be wired into the classifier, alone on this line');
});

test('a placeholder root is judged by the path under it, not by the placeholder', () => {
  // The `<wiki_root>` / `<plugin_root>` distinction, stated mechanically. Both are
  // angle-bracketed placeholders an agent substitutes; only one of them stands for
  // the plugin. Getting this wrong in either direction is a real failure mode:
  // treating every bracketed root as the plugin root over-flags the plugin's whole
  // purpose, and treating every bracketed root as trustworthy accepts a spelling
  // nothing substitutes.
  //
  // Nothing enumerates either name. The tokeniser cannot start a match on `<`, so
  // what is judged is the path UNDERNEATH, and the anchor is re-attached from
  // context only for the one spelling this repo actually substitutes.

  // A. the wiki content root — workspace-side by contract, and silent because
  //    nothing under it names a plugin file.
  for (const clean of [
    'The suite advertises `<wiki_root>/log.jsonl` and `<wiki_root>/.wiki-meta/index.json`.',
    'Pages live at `<wiki_root>/pages/**/*.md`.',
    'The read path is `<wiki_root>/.wiki-meta/.pending-scan`.',
    // `ABSOLUTE_WIKI_ROOT` is an argv VALUE, not a path: no separator, no dot.
    '{"argv":["<plugin_root>/scripts/wiki-runtime.js","snapshot","--wiki-root","ABSOLUTE_WIKI_ROOT","--json"]}',
  ]) {
    assert.deepEqual(shadowableTokens(clean), [], `workspace-rooted reference must pass: ${clean}`);
  }
  // Non-vacuity for A: the silence is a property of what lies under the wiki root,
  // not of the bracket in front of it. Put a real plugin path under it and the
  // same shape must be flagged — which is also the guard's answer if a document
  // ever writes a plugin path with a workspace root.
  assert.ok(shadowableTokens('Pages live at `<wiki_root>/scripts/wiki-runtime.js`.').length > 0,
    'a plugin path under a workspace root must still be flagged');

  // B. foreign plugin-root spellings — a sibling's placeholder and two shell
  //    variables, none of which anything substitutes on either host.
  for (const foreign of [
    'node `<PLUGIN_ROOT>/scripts/wiki-runtime.js` config resolve',
    'node `<absolute-plugin-root>/scripts/wiki-runtime.js` config resolve',
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/wiki-runtime.js" config resolve',
    'node "%CLAUDE_PLUGIN_ROOT%\\scripts\\wiki-runtime.js" config resolve',
  ]) {
    const hits = shadowableTokens(foreign);
    assert.ok(hits.some((h) => h.token === 'scripts/wiki-runtime.js' && h.why === 'unanchored'),
      `a foreign root must not anchor the path under it: ${foreign} → ${JSON.stringify(hits)}`);
  }

  // C. and the one spelling this repo does substitute is accepted, in both
  //    separator shapes, so B is not passing merely because everything is flagged.
  for (const ok of [
    'node `<plugin_root>/scripts/wiki-runtime.js` config resolve',
    'node `<plugin_root>\\scripts\\wiki-runtime.js` config resolve',
  ]) {
    assert.deepEqual(shadowableTokens(ok), [], `the repo's own anchor must be accepted: ${ok}`);
  }

  // D. the anchor must be JOINED to the path, which is why ANCHOR_PREFIX requires
  //    the separator rather than treating it as optional. An anchor merely standing
  //    near a path joins nothing — a reader still resolves the path against cwd —
  //    and an optional separator would silently accept this shape. The case has to
  //    be a `.md`: with a runnable extension executable-token flags the tail on its
  //    own and the exemption change is invisible.
  assert.ok(shadowableTokens('The base is <plugin_root> skills/wiki-lint/SKILL.md today.').length > 0,
    'an anchor that is not joined to the path must not anchor it');
  // …and the quoted-argv shape, where the two are separate elements a runtime never
  // concatenates. Both cases put only quotes and spaces between anchor and path,
  // which is exactly what an optional separator would swallow.
  assert.ok(shadowableTokens('argv: "<plugin_root>" "skills/wiki-lint/SKILL.md"').length > 0,
    'two separate argv elements are not one anchored path');
});

test('the token boundaries the classifier depends on hold', () => {
  // Two small pieces that nothing else can see, because both of their failure modes
  // are extra findings on a sweep the corpus already makes noisy.

  // A. executable-token's trailing boundary. Without `(?![A-Za-z0-9])`, `.js`
  //    matches the prefix of `.json`, and `hooks/hooks.json` — a real file here,
  //    named in AGENTS.md — is reported as `hooks/hooks.js`, a path that has never
  //    existed. Pinning the token list rather than the count is what catches it:
  //    the line is a finding either way.
  const jsonHits = shadowableTokens('the SessionStart wiring is `hooks/hooks.json`');
  assert.deepEqual(jsonHits.map((h) => h.token), ['hooks/hooks.json'],
    `a .json path must not be reported as its .js prefix: ${JSON.stringify(jsonHits)}`);

  // B. ROOT_METADATA, and that it is single-segment only. A bare `package.json` in
  //    prose names the same file in every project that has one, so the reading the
  //    author intended is the project's copy; a multi-segment path gets no such
  //    pass, and asserting that half is what keeps the exemption from widening into
  //    a basename allowlist.
  assert.deepEqual(shadowableTokens('`package.json` declares the version triple'), [],
    'single-segment root metadata must be exempt');
  assert.ok(ROOT_METADATA.has('package.json'),
    'the exemption must be derived from the repo root, not from a written list');
  assert.ok(shadowableTokens('the fixture guide is `tests/fixtures/golden/README.md`').length > 0,
    'a multi-segment path ending in root metadata gets no exemption');
});

test('anchored paths that escape the plugin root are rejected (containment)', () => {
  const traversals = [
    'Read `<plugin_root>/../workspace/evil.md`',
    'node "<plugin_root>/../workspace/evil.js"',
  ];
  for (const line of traversals) {
    const hits = shadowableTokens(line);
    assert.ok(hits.length > 0, `containment must reject: ${line}`);
    assert.equal(hits[0].why, 'escapes plugin root', `wrong reason for: ${line}`);
  }
  // The form only deny-by-default can see: an anchored traversal with an extension
  // no FORM matches and no verb in front of it. This is why scopedTokens
  // re-attaches the anchor instead of skipping the token.
  const bare = shadowableTokens('증거 파일은 `<plugin_root>/../workspace/evil.json` 이다');
  assert.deepEqual(bare.map((h) => [h.form, h.why]), [['resolves-in-plugin', 'escapes plugin root']],
    `deny-by-default must judge containment on an anchored non-FORM token: ${JSON.stringify(bare)}`);

  // A `..` that stays inside the root is fine.
  assert.deepEqual(
    shadowableTokens('Read `<plugin_root>/skills/wiki-lint/../wiki-query/SKILL.md`'), [],
    'in-root traversal must be accepted');
});

test('mixed lines fail on the bare token', () => {
  const line = 'Read `<plugin_root>/skills/wiki-lint/SKILL.md` then Read `../wiki-schema/SKILL.md`';
  const hits = shadowableTokens(line);
  assert.equal(hits.length, 1, `exactly the bare token must be flagged, got ${JSON.stringify(hits)}`);
  assert.equal(hits[0].why, 'unanchored');
});

test('a malicious workspace cannot shadow any instruction the plugin issues', () => {
  // End-to-end statement of the invariant. Plant shadows in a fake target
  // workspace for every file the plugin ships, then confirm no instruction in the
  // repo would resolve to one of them. Because every instruction should be
  // anchored, cwd is irrelevant — which is the property under test, not an
  // accident of this fixture.
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'dwk-evil-workspace-'));
  try {
    // Derived, not enumerated, and at repo-relative paths ONLY. A hand-written
    // plant list covers the paths someone remembered: in a sibling, five unsafe
    // spellings fired the classifier while this layer — the only one that proves a
    // planted file is actually reached — stayed silent, because nothing had been
    // planted where they would land. Planting bare basenames as well was tried and
    // reverted: a document that merely mentions a shipped basename in prose then
    // registers as a landing. That shape is handled by detection instead
    // (BARE_EXEC_BASENAME), where an interpreter is what makes it an instruction.
    for (const rel of PLUGIN_FILES) {
      const dest = path.join(evil, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, '// SHADOW — must never be read\n');
    }
    // The landing predicate, named once and shared by the controls and the sweep,
    // so no two of them can disagree about what counts as a landing.
    const isLanding = (target) =>
      target.startsWith(evil + path.sep) && fs.existsSync(target) && fs.statSync(target).isFile();

    // Excluding directory landings is safe only while no shipped directory is a
    // Node LOAD_AS_DIRECTORY target. `<dir>/index.js`, or a `package.json` that
    // names an entry point, would make a planted DIRECTORY reachable again — the
    // same resolution path the module-load rule calls arbitrary code execution —
    // and nothing else would notice, because `isFile()` would keep skipping it.
    // Derived by asking each candidate rather than carving out the root entry by
    // name: this repo's root `package.json` declares neither `main` nor `exports`,
    // so the directory it sits in is not loadable, and if that ever changes this
    // fails.
    const loadable = [...PLUGIN_FILES].filter((k) => {
      if (/(^|\/)index\.[cm]?js$/.test(k)) return true;
      if (!/(^|\/)package\.json$/.test(k)) return false;
      const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, k), 'utf8'));
      return Boolean(pkg.main || pkg.exports);
    });
    assert.deepEqual(loadable.sort(), [],
      'a shipped directory just became loadable by name — the isFile() landing '
      + 'filter now hides a reachable shadow, and must be revisited');

    // Non-vacuity FIRST, deliberately. The sibling this came from asserts its
    // control after the landing sweep, which is unreachable the moment the sweep
    // reports anything — and a guard newly introduced to a repo reports on day one.
    // An empty landing list must be a property of the documents rather than of a
    // resolver that never finds anything, and that has to stay decidable while the
    // sweep is red.
    //
    // The control token is DERIVED from the plant loop's own source, not written by
    // name. A sibling plants one extra file specifically to be its control, which
    // keeps passing after the derived loop stops writing anything.
    const controlToken = [...PLUGIN_FILES].find((k) => k.includes('/') && k.endsWith('.js'));
    assert.ok(controlToken, 'the shipped index must contain a nested module to control on');
    assert.equal(isLanding(resolveAsAgentWould(controlToken, evil)), true,
      `fixture is vacuous — the unanchored token ${controlToken} must land on its plant`);
    assert.equal(isLanding(resolveAsAgentWould(`${ANCHOR}/${controlToken}`, evil)), false,
      'fixture is inverted — an anchored token must resolve into the plugin');

    // The `isFile()` half of the predicate, pinned rather than assumed. Planting
    // every shipped path creates the directories above it, so a token naming a
    // shipped DIRECTORY resolves to something that exists in the evil workspace —
    // and must not count, because nothing shadowable was planted there. This repo's
    // AGENTS.md does name a bare shipped directory (`hooks/scripts/`), so without
    // the filter the sweep below would report a landing that cannot be read.
    const dirToken = controlToken.replace(/\/[^/]+$/, '');
    const dirTarget = resolveAsAgentWould(dirToken, evil);
    assert.ok(dirTarget.startsWith(evil + path.sep) && fs.existsSync(dirTarget),
      'the plant loop must create the directories above each plant');
    assert.equal(isLanding(dirTarget), false,
      'a directory must be excluded by isFile(), not by happening never to exist');

    const landed = [];
    for (const file of markdownFiles()) {
      fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
        for (const token of scopedTokens(line)) {
          const target = resolveAsAgentWould(token, evil);
          if (isLanding(target)) {
            landed.push(`${path.relative(ROOT, file)}:${i + 1}  ${token} → ${target}`);
          }
        }
      });
    }
    assert.deepEqual(landed, [],
      `these instructions resolve onto a planted shadow file:\n  ${landed.join('\n  ')}`);
  } finally {
    fs.rmSync(evil, { recursive: true, force: true });
  }
});

test('a separator run reaches the planted file, not just the classifier', () => {
  // The defect this pins is invisible to a failure count. With a one-character
  // separator element in PATH_TOKEN, a run-spelled path (`scripts\\wiki-runtime.js`)
  // still makes the classifier report — a FORM matches the raw text — while the
  // reachability fixture goes blind, because scopedTokens dies at the second
  // separator and yields only the bare basename. Counting failures reads that as
  // "caught"; it is the layer that proves an instruction *actually lands on a
  // planted file* that has stopped working, and that is the only layer that
  // demonstrates the attack rather than describing it.
  const evil = fs.mkdtempSync(path.join(os.tmpdir(), 'dwk-run-evil-'));
  try {
    fs.mkdirSync(path.join(evil, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(evil, 'scripts', 'wiki-runtime.js'), '// SHADOW\n');

    for (const [label, line] of [
      ['single slash', 'node scripts/wiki-runtime.js config resolve'],
      ['single backslash', 'node scripts\\wiki-runtime.js config resolve'],
      ['backslash run', 'node scripts\\\\wiki-runtime.js config resolve'],
      ['slash run', 'node scripts//wiki-runtime.js config resolve'],
      ['mixed run', 'node scripts\\/wiki-runtime.js config resolve'],
    ]) {
      assert.ok(shadowableTokens(line).length > 0,
        `layer 1 (classifier) must flag: ${label} — ${line}`);
      const landed = [...scopedTokens(line)]
        .map((t) => resolveAsAgentWould(t, evil))
        .filter((t) => t.startsWith(evil + path.sep) && fs.existsSync(t) && fs.statSync(t).isFile());
      assert.ok(landed.length > 0,
        `layer 2 (reachability) must land on the planted shadow: ${label} — ${line}. `
        + `scopedTokens yielded ${JSON.stringify([...scopedTokens(line)])}`);
    }

    // Non-vacuity for layer 2: an anchored spelling of the same path must NOT land
    // in the workspace, so "landed" is a property of the token and not of a
    // resolver that points everything at the evil root.
    assert.equal(
      resolveAsAgentWould(`${ANCHOR}/scripts/wiki-runtime.js`, evil).startsWith(evil + path.sep),
      false, 'an anchored token must resolve into the plugin, never the workspace');
  } finally {
    fs.rmSync(evil, { recursive: true, force: true });
  }
});

test('markdown link destinations are never a root placeholder', () => {
  // The mirror image of the anchor rule. Markdown does not interpolate, and no
  // agent substitutes inside a link target, so a placeholder-rooted link
  // destination is a literal broken URL. Link targets are an exception class in the
  // guard above; this asserts the exception is actually honoured in the documents.
  const re = () => new RegExp(String.raw`\]\(((?:${ANCHOR}|\$\{|%[A-Za-z_]|<[A-Za-z_])[^)]*)\)`, 'g');
  // The scan set holds exactly one markdown link and it is an https URL, so a
  // sweep alone would pass whatever this pattern did. Pin the pattern on the axis
  // first.
  for (const probe of [
    '[k](<plugin_root>/scripts/wiki-runtime.js)',
    '[k](${CLAUDE_PLUGIN_ROOT}/scripts/wiki-runtime.js)',
    '[k](%CLAUDE_PLUGIN_ROOT%/scripts/wiki-runtime.js)',
    '[k](<wiki_root>/pages/x.md)',
  ]) {
    assert.ok(re().exec(probe), `the link rule must see: ${probe}`);
  }
  for (const ok of ['[k](references/storage-layout.md)', '[k](https://example.test/x)']) {
    assert.equal(re().exec(ok), null, `a source-relative or URL destination must pass: ${ok}`);
  }

  const broken = [];
  for (const file of markdownFiles()) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      const pattern = re();
      let m;
      while ((m = pattern.exec(line))) broken.push(`${path.relative(ROOT, file)}:${i + 1}  ](${m[1]})`);
    });
  }
  assert.deepEqual(broken, [],
    'markdown link destination uses a root placeholder that nothing expands — use a '
    + `source-relative path instead:\n  ${broken.join('\n  ')}`);
});

// ---------------------------------------------------------------------------
// Maintainer-only paths named in shipped documents.
//
// A gitignored directory does not exist in an installed plugin, so a path under
// one can only ever resolve against the ANALYSED PROJECT. Naming it in a shipped
// instruction hands that instruction to the project under analysis — the same
// substitution the anchoring rules exist to prevent, arriving by a route
// deny-by-default cannot see, because the path resolves nowhere in the index.
//
// Derived from `.gitignore`, not hand-listed. A hand-listed pair matched the
// ignore file exactly on the day it was written and would have leaked silently the
// first time a third entry was added.
const IGNORED_DIRS = (() => {
  const body = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
  return body.split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('!') && line.endsWith('/'))
    .map((line) => line.replace(/\/$/, ''));
})();

// Not every gitignored directory is a leak when a document names it. For a
// plugin's declared OUTPUT root, resolving against the analysed project is the
// CONTRACT.
//
// deep-work and deep-loop split this three ways. Only two of those arms have any
// input here, and both of the others were measured before being left out rather
// than assumed away — a carve-out arm that cannot fire still reads as coverage:
//
// (1) ASK THE CODE — a directory this plugin WRITES into a project is its own
//     output root. NOT PORTED, and the reason is structural rather than
//     incidental: this plugin's output root is the WIKI ROOT, a native absolute
//     path the user configures, so it is not a directory name in this repo's
//     `.gitignore` at all and the probe has nothing to match. Run against this
//     tree it returns the empty set. If deep-wiki ever gitignores a directory it
//     writes, that arm has to come back.
// (2) ASK THE CONVENTION — `.deep-*` is the suite's name for a plugin output root.
//     This deliberately covers a SIBLING's root: this repo never writes
//     `.deep-review/`, but a document telling an agent to read a sibling's report
//     there is a correct workspace-relative reference and flagging it would be an
//     over-flag. This is the arm that carries the split here.
// (3) ASK THE HOST — a tool's per-project directory. `.claude` is Claude Code's,
//     `.vscode` and `.idea` are the editors'. None belongs to any plugin, all live
//     in the analysed project, and a document may correctly name one. This arm IS
//     a small enumeration and saying so is the point: its growth condition is
//     known — a new host or editor project directory — and the alternative,
//     treating anything unproven as a workspace output, is fail-open. It is kept
//     wired rather than dropped because it costs one line, but this repo ignores
//     only individual FILES under `.claude/` and no directory at all, so its
//     intersection is empty today. That fact is asserted below rather than left
//     implicit, so the day it changes the split moves visibly.
const HOST_PROJECT_DIRS = new Set(['.claude', '.vscode', '.idea']);

const WORKSPACE_OUTPUT_DIRS = new Set([
  ...IGNORED_DIRS.filter((d) => d.startsWith('.deep-')),
  ...IGNORED_DIRS.filter((d) => HOST_PROJECT_DIRS.has(d)),
]);
const MAINTAINER_ONLY_DIRS = IGNORED_DIRS
  .filter((d) => !WORKSPACE_OUTPUT_DIRS.has(d) && d !== 'node_modules');

// Declared exceptions: a maintainer-only path a document may name, and the clauses
// that earn the exception. The declaration is not a waiver — the test below makes
// the naming document carry each clause, so an entry here without the sentence is a
// failure rather than a bypass.
//
// `docs/DOCS_RULE.md` is named by AGENTS.md and `docs/` is gitignored, so that path
// can resolve in exactly one place: the project being analysed. The three clauses
// are the family's, unchanged from deep-goal and deep-work, and they pin the
// PROHIBITION rather than the provenance. That distinction was measured: an earlier
// version required only "ships with nothing", which is a fact about the file rather
// than an instruction about it, and review trimmed the caveat down to that phrase
// alone — deleting the whole protective clause — while every test still passed.
// What keeps the path safe is the sentence telling a reader not to open it and why.
const NON_SHIPPED_DECLARED = new Map([
  ['docs/DOCS_RULE.md', [
    /ships with nothing/,
    /never try to open it at runtime/,
    /only place that path can resolve in an installed plugin is the project being analysed/,
  ]],
]);

// Blockquote markers and hard wraps must not decide whether a caveat counts, so the
// required clauses are matched against a flattened body.
function flatten(body) {
  return body.replace(/^[ \t]*>[ \t]?/gm, '').replace(/\s+/g, ' ');
}

function missingCaveats(declared, files = markdownFiles(), read = fs.readFileSync) {
  const missing = [];
  for (const [token, clauses] of declared) {
    assert.ok(!PLUGIN_FILES.has(token),
      `${token} is declared non-shipped but is in the shipped file set`);
    for (const file of files) {
      const body = read(file, 'utf8');
      if (!body.includes(token)) continue;
      const flat = flatten(body);
      for (const clause of clauses) {
        if (!clause.test(flat)) {
          missing.push(`${path.relative(ROOT, file)} names ${token} but is missing: ${clause.source}`);
        }
      }
    }
  }
  return missing;
}

test('a path the plugin never ships carries the sentence that makes it safe', () => {
  // The mechanism first, against a synthetic declaration and synthetic documents,
  // so the clause check is decidable independently of what the corpus happens to
  // say today.
  const fakeDocs = [path.join(ROOT, 'skills', 'fixture.md'), path.join(ROOT, 'skills', 'other.md')];
  const bodies = new Map([
    [fakeDocs[0], 'See `docs/RULES.md`. It ships with nothing, so never open it at runtime.'],
    [fakeDocs[1], 'See `docs/RULES.md` for the rest.'],
  ]);
  const fakeRead = (f) => bodies.get(f);
  const declared = new Map([['docs/RULES.md', [/ships with nothing/, /never open it at runtime/]]]);
  assert.deepEqual(missingCaveats(declared, [fakeDocs[0]], fakeRead), [],
    'a document carrying every clause must be accepted');
  assert.equal(missingCaveats(declared, fakeDocs, fakeRead).length, 2,
    'a document naming the path without the clauses must be reported, once per clause');
  // And the flattening is what makes the clause survive a rewrap or a blockquote.
  const wrapped = new Map([[fakeDocs[0],
    '> See `docs/RULES.md`. It ships\n> with nothing, so never\n> open it at runtime.']]);
  assert.deepEqual(missingCaveats(declared, [fakeDocs[0]], (f) => wrapped.get(f)), [],
    'a hard-wrapped, blockquoted caveat must still count');

  const missing = missingCaveats(NON_SHIPPED_DECLARED);
  assert.deepEqual(missing, [],
    'a non-shipped path is named without every clause that makes it safe to read:\n  '
    + missing.join('\n  '));
});

test('the workspace-output split is derived from the convention, and is two-way', () => {
  // The split is the one place this rule can be turned off, so it is asserted in
  // both directions rather than only where it happens to matter today.
  assert.ok(IGNORED_DIRS.length > 0, '.gitignore yielded no ignored directories');
  assert.ok(WORKSPACE_OUTPUT_DIRS.has('.deep-review'),
    'a sibling output root must be classed as a workspace output — naming it is correct');
  assert.ok(MAINTAINER_ONLY_DIRS.includes('docs'),
    'docs must stay maintainer-only — it is the class this rule exists for');
  for (const dir of MAINTAINER_ONLY_DIRS) {
    assert.ok(!dir.startsWith('.deep-'), `${dir} is an output root but is swept`);
  }
  // The write-probe arm's failure mode, pinned even though the arm is not ported.
  // `docs/` IS joined onto a project root elsewhere in this family — a sibling's
  // release gate reads `docs/DOCS_RULE.md` from the project it is releasing — so a
  // probe that keys on *joining* rather than on writing classifies it as an output
  // root and silences the rule for the exact class it exists for.
  assert.ok(!WORKSPACE_OUTPUT_DIRS.has('docs'),
    'docs is read, never written — a classifier that calls it an output root has '
    + 'silenced the rule');
  assert.ok(MAINTAINER_ONLY_DIRS.length < IGNORED_DIRS.length,
    'nothing was split off — the rule is unchanged, which is not what its comment claims');
  // Arm (3) is inert here, and that is recorded rather than assumed. This repo
  // gitignores individual files under `.claude/` and no directory, so the arm
  // contributes nothing; if that changes, this fails and the comment above it has
  // to be rewritten rather than quietly becoming wrong.
  assert.deepEqual(IGNORED_DIRS.filter((d) => HOST_PROJECT_DIRS.has(d)), [],
    'a host project directory became gitignored — the host arm is now live and the '
    + 'comment calling it inert is stale');
});

test('no undeclared path under a maintainer-only directory is named', () => {
  // Lexical over raw lines, never consulting the resolver: that is what makes it
  // immune to any index blind spot, and why both separators are spelled out —
  // `normalizePath` never reaches here, so with `/` alone the backslash spelling
  // walks straight past.
  //
  // Negative lookbehind rather than a prefix list. Enumerating the characters that
  // may precede a path makes every character nobody thought of a bypass:
  // `**docs/X.md**` and `[docs/Y.md](…)` are ordinary markdown and slip past a
  // space/backtick/quote/paren list.
  const escaped = MAINTAINER_ONLY_DIRS.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  const re = new RegExp(String.raw`(?<![A-Za-z0-9._\\/-])(?:\.[\\/])?((?:${escaped})[\\/][A-Za-z0-9._\\/-]+)`, 'g');

  // Both spellings and both prefix shapes, pinned on the axis rather than left to
  // whatever the corpus happens to contain today.
  for (const probe of ['See `docs/backlog.md` for the rest.', 'See `docs\\backlog.md` too.',
    '**docs/bold.md** matters', '[docs/link.md](x) matters']) {
    re.lastIndex = 0;
    assert.ok(re.exec(probe), `the sweep must see: ${probe}`);
  }
  re.lastIndex = 0;
  assert.equal(re.exec('nodocs/notapath.md is mid-token'), null,
    'a match must not start mid-token');
  // And the carve-out is honoured here too: an output root must not be swept.
  re.lastIndex = 0;
  assert.equal(re.exec('a sibling report at `.deep-review/report.md`'), null,
    'a plugin output root must not be reported as maintainer-only');

  const violations = [];
  for (const file of markdownFiles()) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(line))) {
        if (NON_SHIPPED_DECLARED.has(m[1])) continue;   // earned by the caveat test above
        violations.push(`${path.relative(ROOT, file)}:${i + 1}  ${m[1]}`);
      }
    });
  }
  assert.deepEqual(violations, [],
    'a path under a maintainer-only directory is named in a shipped document; it '
    + `resolves only against the analysed project:\n  ${violations.join('\n  ')}`);
});

test('a backslash separator does not hide a path from the guard', () => {
  // Review found the slash form producing failures and the backslash form producing
  // none in two siblings — the same unanchored reference to the same file, invisible
  // because the matchers knew only `/`. Windows is a supported host, so that is a
  // legitimate spelling and not a typo, and one character bypassed the whole
  // deny-by-default invariant.
  const TABLE = [
    ['unanchored slash', 'Run `node scripts/wiki-runtime.js` to start.'],
    ['unanchored backslash', 'Run `node scripts\\wiki-runtime.js` to start.'],
    ['read-verb slash', 'Read `skills/wiki-lint/SKILL.md`'],
    ['read-verb backslash', 'Read `skills\\wiki-lint\\SKILL.md`'],
    ['mixed separators', 'Run `node scripts\\lib/executable-contract.js` to start.'],
    ['read-verb mixed', 'Read `skills/wiki-lint\\SKILL.md` first.'],
  ];
  for (const [label, line] of TABLE) {
    assert.ok(shadowableTokens(line).length > 0, `${label} must be flagged: ${line}`);
  }

  // An anchored traversal written with backslashes is still a traversal, and must
  // be rejected for that reason rather than as "unanchored". Asserting the reason
  // is what keeps this row from passing for the wrong cause: with normalizePath
  // removed the token stays `<plugin_root>\..\…`, fails ANCHORED_TOKEN, and is
  // flagged — correctly, but as an anchoring failure.
  const traversal = shadowableTokens('node "<plugin_root>\\..\\workspace\\evil.js"');
  assert.ok(traversal.length > 0, 'anchored backslash traversal must be flagged');
  assert.equal(traversal[0].why, 'escapes plugin root',
    `traversal must fail on containment, not anchoring: ${JSON.stringify(traversal)}`);

  // PER-AXIS ISOLATION. The rows above are caught by several rules at once, so they
  // prove the bug is closed without proving which piece closed it. Each case below
  // is chosen so exactly one piece can see it.

  // PATH_TOKEN's separator run + the normalise-before-exemption ordering. No read
  // verb, so no FORM matches, and `SKILL.md` is a basename the source-relative
  // branch would resolve anyway — so if the token is not extracted whole and
  // canonicalised before the exemption lookups, nothing sees it.
  assert.ok(
    shadowableTokens('스키마 정본은 `skills\\wiki-schema\\SKILL.md` 이다.').length > 0,
    'deny-by-default must extract a backslash path whole, not just its basename');
  assert.ok(shadowableTokens('const p = "skills\\\\wiki-schema\\\\SKILL.md";').length > 0,
    'an escaped backslash path must survive tokenisation as one whole token');

  // ANY_ROOT/REL separator, isolated. Deny-by-default asks whether a token resolves
  // inside the plugin, so a path to a file that does not exist is invisible to it —
  // only a FORM can match, and only if the separator directly after the root
  // directory is accepted.
  assert.ok(shadowableTokens('Read `skills\\missing.md` before starting.').length > 0,
    'a FORM must accept a backslash directly after the root directory');

  // PATH_BODY separator, isolated. Slash after the root so ANY_ROOT matches either
  // way; the backslash is inside the body, and the file does not exist so
  // deny-by-default cannot cover for it.
  assert.ok(shadowableTokens('Read `skills/zzz\\missing.md` before starting.').length > 0,
    'a FORM must match a backslash inside the path body');

  // executable-token, isolated. It carries its own inline copy of the root and body
  // patterns rather than sharing ANY_ROOT/PATH_BODY, so the other FORMS learning
  // `\` teaches it nothing. No interpreter, no read verb, and a file that does not
  // exist, so this rule is the only one that can see it.
  for (const line of [
    'the runtime is at `scripts\\lib\\missing-helper.js`',
    'the hook `hooks\\scripts\\missing-scan.sh` runs at SessionStart',
  ]) {
    assert.deepEqual(shadowableTokens(line).map((h) => h.form), ['executable-token'],
      `executable-token must be the rule that catches this, alone: ${line}`);
  }

  assert.deepEqual(
    shadowableTokens('Read `<plugin_root>\\skills\\wiki-schema\\SKILL.md`'), [],
    'an anchored backslash path must be accepted, not flagged as unanchored');
});

test('normalising separators does not promote prose into a path', () => {
  // Collapsing separator runs makes over-flagging the failure mode to watch, so the
  // text that must stay silent is pinned. But "produces no violation" has two
  // mechanisms behind it, and asserting only the outcome hides which one is
  // load-bearing. So each line declares its mechanism and is checked against it.

  // A. The tokeniser must not see a path here at all.
  for (const line of [
    'escape a quote with \\" and a backslash with \\\\',
    'Use `\\n` for a newline and `\\t` for a tab.',
    'A literal backslash is written `\\\\` in a JS string literal.',
    'The validator matches /^[A-Za-z]+\\/[a-z-]+$/ against each entry.',
  ]) {
    assert.deepEqual([...scopedTokens(line)], [], `no path token may be extracted from: ${line}`);
    assert.deepEqual(shadowableTokens(line), [], `must not be flagged: ${line}`);
  }

  // B. Here the tokeniser does extract something — a Windows path quoted inside user
  //    input is genuinely path-shaped, and this plugin's docs really do discuss
  //    Windows drive and UNC paths — and it stays silent only because it resolves to
  //    no plugin file. That is a claim about the rule, so it gets the non-vacuity
  //    check: declare those exact tokens plugin files and the line must be flagged.
  //    Nothing is stubbed; only the file set the rule consults is changed, so what
  //    runs is the real classifier.
  for (const [line, expected] of [
    ['Windows paths in user input (`C:\\Users\\me\\vault`) are preserved, not converted.',
      ['Users/me/vault']],
    ['The wiki root was at `D:\\vaults\\acme\\notes.md` on that machine.',
      ['vaults/acme/notes.md']],
    ['const p = "C:\\\\Users\\\\me\\\\notes.md";', ['Users/me/notes.md']],
  ]) {
    assert.deepEqual([...scopedTokens(line)], expected,
      `separator runs must collapse to one canonical token: ${line}`);
    assert.deepEqual(shadowableTokens(line), [], `must not be flagged: ${line}`);

    for (const t of expected) PLUGIN_FILES.add(t);
    try {
      assert.ok(shadowableTokens(line).length > 0,
        'vacuous negative — this line stays silent even when its tokens name real '
        + `plugin files, so asserting its silence proves nothing: ${line}`);
    } finally {
      for (const t of expected) PLUGIN_FILES.delete(t);
    }
  }
});

// EXPANDED ROOT.
//
// The anchor is substituted by the agent, so a `$`- or `%`-spelling of a path root
// is not a stylistic variant — it is a defect. Codex sets no `CLAUDE_PLUGIN_ROOT`,
// so `${CLAUDE_PLUGIN_ROOT}/x` survives verbatim into whatever consumes it, and the
// consumer then reads a path *named* `${CLAUDE_PLUGIN_ROOT}/x` relative to the
// workspace: a fixed reference converted into a shadowable one. This is not
// hypothetical wiring here — `isAllowedRuntimeScript` in
// scripts/lib/executable-contract.js accepts both `${CLAUDE_PLUGIN_ROOT}/scripts/
// wiki-runtime.js` and `%CLAUDE_PLUGIN_ROOT%\scripts\wiki-runtime.js` as skill
// argv, so nothing but this rule keeps a skill from being written that way.
//
// Written over the SHAPE, not over a list of names. An enumeration of spellings is
// the same trap as an enumeration of verbs — it covers what someone remembered.
// `VARIABLE_ROOT` asks the structural question instead: does any path in this
// document take its root from something a shell would expand? Both expansion
// syntaxes this plugin's hosts use are covered — POSIX `${VAR}/` and `$VAR/`, and
// the cmd.exe `%VAR%\` form that AGENTS.md documents Codex launching through.
// `EXPANDED_ANCHOR` is the narrower companion for the anchor's own identifier,
// which must be wrong even with no path after it, and it is derived from ANCHOR
// rather than written out.
const VARIABLE_ROOT = /\$\{?[A-Za-z_][A-Za-z0-9_]*\}?[\\/]|%[A-Za-z_][A-Za-z0-9_]*%[\\/]/;
const EXPANDED_ANCHOR = new RegExp(String.raw`[$%]\{?${ANCHOR.replace(/[<>]/g, '')}\}?\b`, 'i');

test('the anchor cannot be spelled as a shell variable anywhere', () => {
  // Closed by a different mechanism than deep-work uses. There it is a
  // `non-expanding-anchor` check hung off a list of commands, which misses `cp`,
  // `mv`, `install` and any wrapper — enumeration creeping back on a second axis.
  // This plugin bans the expanding spelling outright in every scanned file, because
  // the placeholder is substituted by the agent rather than by a shell, so quoting
  // cannot change the outcome either way.
  assert.ok(VARIABLE_ROOT.test("cp '${CLAUDE_PLUGIN_ROOT}/scripts/wiki-runtime.js' /tmp/x"),
    'the expanded-root rule must reject the shell spelling regardless of the command');
  assert.ok(VARIABLE_ROOT.test('node "%CLAUDE_PLUGIN_ROOT%\\scripts\\wiki-runtime.js"'),
    'and the cmd.exe spelling, which this repo\'s own argv contract still accepts');
  assert.ok(VARIABLE_ROOT.test('node $WIKI_HOME/scripts/wiki-runtime.js'),
    'and a bare $VAR root, named by nothing in this rule');
  assert.ok(EXPANDED_ANCHOR.test('export $PLUGIN_ROOT'),
    'the anchor identifier spelled as a variable counts even with no path after it');
  // Negatives: the shapes this repo legitimately writes must stay clean, or the
  // rule would ban AGENTS.md's own description of the Codex launch boundary.
  for (const clean of [
    'node "<plugin_root>/scripts/wiki-runtime.js" config resolve',
    'The Node 22 SessionStart hook uses Codex\'s host-owned `%COMSPEC% /C` boundary.',
    'Timestamps are `YYYY-MM-DDTHH:MM:SSZ` — never a local offset.',
  ]) {
    assert.ok(!VARIABLE_ROOT.test(clean) && !EXPANDED_ANCHOR.test(clean),
      `must stay clean: ${clean}`);
  }
  // And it is verb-agnostic: no command appears in this line at all.
  assert.ok(shadowableTokens('scripts/wiki-runtime.js 를 참조한다').length > 0,
    'deny-by-default must flag a bare plugin path with no command verb present');
});

function expandedRootOffenders(files = markdownFiles(), read = fs.readFileSync) {
  const offenders = [];
  for (const file of files) {
    read(file, 'utf8').split('\n').forEach((line, i) => {
      if (VARIABLE_ROOT.test(line) || EXPANDED_ANCHOR.test(line)) {
        offenders.push(`${path.relative(ROOT, file)}:${i + 1}  ${line.trim()}`);
      }
    });
  }
  return offenders;
}

test('the plugin uses exactly one anchor spelling', () => {
  // The corpus holds no expanded root today, so the sweep cannot fail by itself —
  // with the whole condition deleted this test would stay green while the rule it
  // names went away. The sweep is therefore driven over a synthetic document first,
  // through the same function the corpus goes through.
  const fake = path.join(ROOT, 'skills', 'fixture.md');
  const bodies = new Map([[fake, [
    'node "<plugin_root>/scripts/wiki-runtime.js" config resolve',   // the correct form
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/wiki-runtime.js"',          // POSIX expansion
    'node "%CLAUDE_PLUGIN_ROOT%\\scripts\\wiki-runtime.js"',         // cmd.exe expansion
    'The hook uses `%COMSPEC% /C` on Windows.',                      // not a path root
  ].join('\n')]]);
  const found = expandedRootOffenders([fake], (f) => bodies.get(f));
  assert.deepEqual(found.map((o) => o.split(':')[1].split(' ')[0]), ['2', '3'],
    `exactly the two expanded roots must be reported, got ${JSON.stringify(found)}`);

  const offenders = expandedRootOffenders();
  assert.deepEqual(offenders, [],
    'a path is rooted at something a shell would expand — this plugin anchors on the '
    + `derived ${ANCHOR} placeholder only:\n  ${offenders.join('\n  ')}`);
});

test('an anchored path that leaves the root through a symlink is rejected', (t) => {
  // `escapes via symlink` is produced on two code paths and, until this test,
  // asserted on neither: containment only ever exercised the lexical `..` form.
  // `path.resolve` is lexical, so an anchored, `..`-free path whose component is a
  // symlink passes every other check and still lands outside the plugin.
  //
  // The fixture works in throwaway roots outside the repository, never inside it: a
  // sibling planted its symlink in the real root, which raced another test file's
  // repo-tree copy and made the suite fail 5 runs in 20.
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'dwk-symlink-outside-'));
  const fakeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dwk-symlink-root-'));
  try {
    fs.writeFileSync(path.join(outside, 'evil.md'), '# SHADOW — outside the plugin root\n');
    fs.mkdirSync(path.join(fakeRoot, 'skills'), { recursive: true });
    try {
      fs.symlinkSync(path.join(outside, 'evil.md'), path.join(fakeRoot, 'skills', 'evil.md'));
    } catch {
      // EPERM on unprivileged Windows. Probed rather than inferred from
      // process.platform: a Windows host with Developer Mode should still run this,
      // and a Linux CI that somehow lost the capability should not silently skip a
      // security test — the skip reason is a string so it prints.
      t.skip('this host cannot create symlinks (unprivileged Windows)');
      return;
    }
    fs.writeFileSync(path.join(fakeRoot, 'skills', 'ok.md'), '# in-root\n');
    const token = `${ANCHOR}/skills/evil.md`;

    // Non-vacuity: the token is anchored and lexically contained, so every other
    // clause accepts it. Only the symlink check can reject it.
    assert.ok(ANCHORED_TOKEN.test(token), 'fixture token must be anchored');
    assert.equal(escapesRoot(token), false, 'fixture token must be lexically contained');

    // Both production sites: the FORMS path and the deny-by-default path.
    const viaForm = shadowableTokens(`Read \`${token}\``, undefined, fakeRoot);
    assert.ok(viaForm.some((v) => v.why === 'escapes via symlink'),
      `read-verb path must reject the symlink: ${JSON.stringify(viaForm)}`);
    const viaDeny = denyByDefaultHits(`증명은 \`${token}\` 를 따른다`, path.join(ROOT, 'AGENTS.md'), fakeRoot);
    assert.ok(viaDeny.some((v) => v.why === 'escapes via symlink'),
      `deny-by-default path must reject the symlink: ${JSON.stringify(viaDeny)}`);

    // A real in-root target of the same shape is still accepted, so the rule is
    // about where the link points and not about the directory it sits in.
    assert.deepEqual(
      shadowableTokens(`Read \`${ANCHOR}/skills/ok.md\``, undefined, fakeRoot), [],
      'a real in-root file must still be accepted');
  } finally {
    fs.rmSync(fakeRoot, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('the plugin file index and the tokens looked up in it use one spelling', () => {
  // Normalising the token but not the index normalises one side of a comparison,
  // which is not normalising at all. `path.relative` returns the host's separator,
  // so on Windows every PLUGIN_FILES key would read `scripts\wiki-runtime.js` while
  // every token looked up in it reads `scripts/wiki-runtime.js` — deny-by-default
  // would then resolve nothing at all, and the isolating cases above would fail on
  // Windows only. Silently green is the worst state a guard can be in, and this
  // plugin's CI covers Windows Server 2025, so it is pinned rather than checked by
  // hand.
  assert.deepEqual([...PLUGIN_FILES].filter((k) => k.includes('\\')), [],
    'PLUGIN_FILES keys must be canonicalised at construction');

  const winRel = path.win32.relative('C:\\plugin-root', 'C:\\plugin-root\\scripts\\wiki-runtime.js');
  assert.equal(winRel, 'scripts\\wiki-runtime.js',
    'precondition — win32 relative must produce the backslash spelling');
  assert.ok(PLUGIN_FILES.has(normalizePath(winRel)),
    'the canonical spelling must be a key in the index');
  assert.equal(PLUGIN_FILES.has(winRel), false,
    'the host-shaped spelling must not be — otherwise this test proves nothing');
  assert.equal(
    repoKey('C:\\plugin-root', 'C:\\plugin-root\\scripts\\wiki-runtime.js', path.win32.relative),
    'scripts/wiki-runtime.js',
    'repoKey must canonicalise whatever separator its host relative() returns');

  // End-to-end: rebuild the entire index the way a Windows host would spell it —
  // every real plugin file, re-rooted under a win32 path, run back through the same
  // derivation — and require the result to be identical. This is what makes the
  // whole axis provable from a POSIX runner: with the normalisation removed from
  // repoKey, every one of these keys comes back with backslashes.
  const winRoot = 'C:\\plugin-root';
  const rebuilt = new Set([...PLUGIN_FILES].map((key) =>
    repoKey(winRoot, path.win32.join(winRoot, ...key.split('/')), path.win32.relative)));
  assert.deepEqual([...rebuilt].sort(), [...PLUGIN_FILES].sort(),
    'the index a Windows host builds must be key-for-key identical to this one');
  assert.ok(rebuilt.size > 50,
    `emulation swept only ${rebuilt.size} keys — the index is too small to be real`);

  // Both call sites, driven behaviourally rather than pinned by source text. A
  // source-text assertion pins the spelling of a call; it cannot see the
  // normalisation being removed from inside the function that call names.
  const winKeys = buildPluginFiles({
    toKey: (p) => path.relative(ROOT, p).split(path.sep).join('\\'),
  });
  assert.ok(winKeys.has('scripts/wiki-runtime.js'),
    'key generation must normalise, not merely store what the platform produced');

  // Nested source on purpose: from a root-level document `dirname` is ROOT, so the
  // source-relative branch reproduces the direct branch and would rescue an
  // un-normalised token, hiding what these assertions claim to pin.
  const nested = path.join(ROOT, 'skills', 'wiki-schema', 'SKILL.md');
  assert.equal(resolvesInPlugin('scripts/wiki-runtime.js', nested, winKeys), true,
    'a slash-shaped lookup must resolve against Windows-shaped keys');
  assert.equal(resolvesInPlugin('scripts\\wiki-runtime.js', nested, winKeys), true,
    'a backslash-shaped lookup must resolve too');

  // The `fromSource` half, exercised through the production call site with a win32
  // `relative`. On POSIX `relative()` already returns slashes, so removing
  // repoKey's normalisation there is a no-op no local mutation can see.
  const nestedTarget = [...winKeys].find((k) => k.includes('/'));
  const dir = nestedTarget.slice(0, nestedTarget.lastIndexOf('/'));
  const base = nestedTarget.slice(nestedTarget.lastIndexOf('/') + 1);
  const winRelative = (from, to) => path.relative(from, to).split('/').join('\\');
  // This pin is vacuous unless the DIRECT branch misses. `resolvesInPlugin` strips
  // the leading `./` and looks the bare basename up first; if a file of that name
  // sits at the repo root it returns there and the source-relative branch — the
  // thing being pinned — never runs, while the assertion still sees `true`.
  assert.equal(winKeys.has(base), false,
    `a root-level ${base} would make the next assertion vacuous`);
  assert.equal(
    resolvesInPlugin(`./${base}`, path.join(ROOT, dir, 'sibling.md'), winKeys, winRelative), true,
    'the source-relative branch must normalise its own result before looking it up');

  // Non-vacuity, with a backslash token on purpose. A slash token makes this pair
  // decorative — the un-normalised key set misses either way, so it passes however
  // the token was handled. The backslash spelling discriminates. It is *dominated*
  // today by the backslash lookup above, which fails first on the same mutation; it
  // is kept as a backstop because the assertion that dominates it is an enumeration
  // of spellings, and enumerations get trimmed.
  const rawKeys = new Set([...winKeys].map((k) => k.split('/').join('\\')));
  assert.equal(resolvesInPlugin('scripts\\wiki-runtime.js', nested, rawKeys), false,
    'un-normalised keys must not be reachable by an un-normalised token');
});

test('every referenced plugin path resolves inside the root', () => {
  const patterns = [
    // Trailing boundary, same reason as the guard: without it `.js` matches the
    // prefix of `.json` — and `hooks/hooks.json` is a real file here — so the
    // resolver would report paths that never existed.
    [new RegExp(String.raw`${ANCHOR}[\\/]([A-Za-z0-9._\\/-]+\.(?:[A-Za-z0-9]+)(?![A-Za-z0-9]))`, 'g'), false],
    [/`(\.\.[\\/][A-Za-z0-9._\\/-]+\.md)(?:#[a-z0-9-]+)?`/g, true],
    [/\]\((\.\.?[\\/][A-Za-z0-9._\\/-]+\.md)\)/g, true],
    // Read("../x/y.md") — the double-quoted call form. Outside the backtick pattern.
    [/Read\("(\.\.[\\/][A-Za-z0-9._\\/-]+\.md)(?:#[a-z0-9-]+)?"\)/g, true],
  ];

  // Either separator in every pattern. This resolver reads the raw body on purpose,
  // so normalizePath never reaches it and each pattern has to accept `\` itself.
  // Slash-only left the backslash spelling of an out-of-root reference visible to
  // the classifier but INVISIBLE here — the layer that actually checks containment.
  // A failure count hides exactly that. Every pattern gets a sample, because three
  // of the four match nothing in the current corpus and a real-file sweep gives
  // them no coverage at all.
  const samples = [
    [`${ANCHOR}/../workspace/evil.json`, `${ANCHOR}\\..\\workspace\\evil.json`],
    ['`../wiki-schema/x.md`', '`..\\wiki-schema\\x.md`'],
    ['[l](../wiki-schema/x.md)', '[l](..\\wiki-schema\\x.md)'],
    ['Read("../wiki-schema/x.md")', 'Read("..\\wiki-schema\\x.md")'],
  ];
  patterns.forEach(([re], i) => {
    for (const spelling of samples[i]) {
      re.lastIndex = 0;
      assert.ok(re.exec(spelling), `pattern ${i} must see both spellings: ${spelling}`);
    }
  });
  // And both extensions the corpus actually anchors, so trimming either from the
  // set fails here rather than silently shrinking the sweep.
  for (const spelling of [`${ANCHOR}/scripts/wiki-runtime.js`,
    `${ANCHOR}/skills/wiki-schema/references/storage-layout.md`]) {
    patterns[0][0].lastIndex = 0;
    assert.ok(patterns[0][0].exec(spelling), `pattern 0 must see: ${spelling}`);
  }

  const broken = [];
  let resolved = 0;
  const realRoot = fs.realpathSync(ROOT);
  for (const file of markdownFiles()) {
    const body = fs.readFileSync(file, 'utf8');
    for (const [re, isRelative] of patterns) {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(body))) {
        const spelling = normalizePath(m[1]);
        const target = isRelative
          ? path.resolve(path.dirname(file), spelling)
          : path.join(ROOT, spelling);
        if (!fs.existsSync(target)) {
          broken.push(`${path.relative(ROOT, file)} -> ${m[1]} (missing)`);
          continue;
        }
        // Existing is not enough: a target that resolves outside the plugin root —
        // lexically or through a symlinked component — is exactly the file an
        // attacker wants accepted. Containment is checked here too, so the two tests
        // cannot disagree about what counts as in-root.
        const real = fs.realpathSync(target);
        if (real !== realRoot && !real.startsWith(realRoot + path.sep)) {
          broken.push(`${path.relative(ROOT, file)} -> ${m[1]} (resolves outside the plugin root: ${real})`);
          continue;
        }
        resolved += 1;
      }
    }
  }
  assert.deepEqual(broken, [], `unresolvable or out-of-root reference:\n  ${broken.join('\n  ')}`);
  assert.ok(resolved > 0, 'sweep matched no references at all — the patterns have rotted');
});

test('wiki-schema instruction surfaces document the wiki-local config and home authority boundaries', () => {
  const storageLayout = fs.readFileSync(
    path.join(ROOT, 'skills', 'wiki-schema', 'references', 'storage-layout.md'),
    'utf8',
  ).replace(/\s+/g, ' ');
  const schemaSkill = fs.readFileSync(path.join(ROOT, 'skills', 'wiki-schema', 'SKILL.md'), 'utf8')
    .replace(/\s+/g, ' ');
  const setupSkill = fs.readFileSync(path.join(ROOT, 'skills', 'wiki-setup', 'SKILL.md'), 'utf8')
    .replace(/\s+/g, ' ');

  assert.match(storageLayout, /\.wiki-meta\/ \s*├── \.config\.json\s+wiki-local auto-ingest and A5 knob config/);
  assert.match(storageLayout, /`\.deep-wiki-setup-authority\.json` and `\.deep-wiki-setup\.reserve` are home authority artifacts, never SessionStart config candidates; they live in the physical user home/);
  assert.match(schemaSkill, /Invalid wiki-local config is fail-closed before any legacy fallback/);
  assert.match(schemaSkill, /Remove legacy YAML only after `policy_source=wiki_local_migrated`/);
  assert.match(setupSkill, /A pending rebind resume must use the same `CODEX_HOME` and `DEEP_WIKI_CONFIG` spelling/);
});
