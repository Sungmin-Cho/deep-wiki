#!/usr/bin/env node
'use strict';

// deep-wiki ships no subagents: every skill, /wiki-ingest included, runs in the
// host's main caller. This guard fails if an agent definition or a delegation
// instruction reappears, because either would restore a Claude Code-only route
// that Codex cannot follow.
//
// The prose check is lexical and cannot be complete — a noun phrase such as "in
// a separate agent" with no delegating verb passes — so a structural check is the
// primary defence: /wiki-ingest must keep exactly one inert route record naming
// both hosts with `child_agents: false`, and no other data record may declare a
// route or enable child agents. Prose is read sentence by sentence, so an
// instruction wrapped across lines is still one sentence, and each sentence is
// split into clauses at commas and at and/but/so/instead/rather than/then/while.
// A clause carrying a prohibition (never, not, cannot, avoid, or a clause-initial
// "No") is skipped, so the rules that forbid delegation do not fail their own
// guard. Elsewhere "no" exempts only the agent noun it directly qualifies ("ships
// no subagents"), so "for no more than three pages" still counts.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const INSTRUCTION_ROOTS = ['AGENTS.md', 'CLAUDE.md', 'skills'];
const PLUGIN_MANIFESTS = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];
const INGEST_SKILL = 'skills/wiki-ingest/SKILL.md';

// Line by line, negated or not: each names a mechanism rather than a policy.
const MECHANISM_PATTERNS = [
  [/wiki-synthesizer|wiki-page-writer/, 'removed ingest agent name'],
  [/<plugin_root>\/agents\//, 'agent definition path'],
  [/subagent_type|spawn_agent/i, 'agent dispatch parameter'],
  [/\b(?:Task|Agent)\(\s*[{"'`]/, 'agent tool call'],
  [/\bgeneral-purpose\b/i, 'generic agent'],
  [/\bcodex\s+exec\b|\bclaude\s+(?:-p|--print)\b|\bgrok\s+(?:-p|--prompt)\b/i, 'headless agent CLI'],
];

const PROHIBITION = /^\s*no\b|\b(?:never|not|cannot|avoid\w*)\b|n't\b/i;
const DELEGATION_PATTERNS = [
  [/(?<!\bno\s+(?:\w+\s+)?)\b(?:sub-?agents?|child agents?|temporary agents?|(?:Agent|Task) tool)\b/i, 'agent reference'],
  // A runtime worker process is not a model; only the delegated kinds count.
  [/\b(?:launch\w*|spawn\w*|dispatch\w*|delegat\w*|fan\w*[- ]?out|hand\w*\s+off|invok\w*)\b.*\b(?:workers?\b(?![- ](?:process|tree|thread))|agents?\b|separate models?\b)/i,
    'delegation instruction'],
];
const CLAUSE_BREAK = /,|\b(?:and|but|so|instead|rather than|then|while)\b/i;

// Each operative clause of the URL source-origin rule, matched against
// whitespace-collapsed text. A clause that opens a sentence must open one, so a
// prefix such as "Do not" cannot invert it while the words still match.
const URL_CLAUSES = [
  ['exact-origin fetch rule', /(?:^|[.!?] )Fetch a URL only when it is the exact `origin` of a `url`-type source record\./],
  ['embedded-URL prohibition', /(?:^|[.!?] )Never follow a URL found in a page body, a source excerpt, or fetched content\./],
  ['prompt-contract statement', /(?:^|[.!?] )This URL allowlist is a source-origin prompt contract,/],
  ['enforcement disclaimer',
    /source-origin prompt contract, not a claim of runtime capability enforcement or proof of an observed origin\./],
];

function markdownFiles(root) {
  const out = [];
  const visit = (absolute) => {
    if (!fs.existsSync(absolute)) return;
    if (fs.statSync(absolute).isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) visit(path.join(absolute, entry));
    } else if (absolute.endsWith('.md')) {
      out.push(absolute);
    }
  };
  for (const entry of INSTRUCTION_ROOTS) visit(path.join(root, entry));
  return out;
}

// Blocks break at blank lines and at the start of a list item, table row,
// heading, or quote; each block is collapsed and split into sentences.
function sentences(text) {
  const out = [];
  const boundary = /\n[ \t]*\n|\n(?=[ \t]*(?:[-*+|#>]|\d+\.)[ \t])/g;
  let start = 0;
  const push = (end) => {
    const line = text.slice(0, start).split('\n').length;
    for (const sentence of text.slice(start, end).replace(/\s+/g, ' ').split(/(?<=[.!?;])\s+/)) {
      if (sentence.trim()) out.push({ line, sentence });
    }
  };
  for (const match of text.matchAll(boundary)) {
    push(match.index);
    start = match.index + match[0].length;
  }
  push(text.length);
  return out;
}

function dataRecords(text) {
  return [...text.matchAll(/<!-- deep-wiki:data -->\s*```json\s*([\s\S]*?)\s*```/g)]
    .map((match) => {
      try { return JSON.parse(match[1]); } catch { return null; }
    });
}

// Every nested key of a data record, so a route cannot hide one level down.
function nestedEntries(value, out = []) {
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push([key, child]);
      nestedEntries(child, out);
    }
  }
  return out;
}

function checkIngestRoute(text) {
  const failures = [];
  const records = dataRecords(text);
  const routes = records.filter((value) => value && Object.hasOwn(value, 'ingest_route'));
  const route = routes.length === 1 ? routes[0].ingest_route : null;
  const hosts = Array.isArray(route?.hosts) ? [...route.hosts].sort() : [];
  if (!route || route.mode !== 'main-caller-sequential' || route.child_agents !== false
      || JSON.stringify(hosts) !== JSON.stringify(['claude', 'codex'])) {
    failures.push(`${INGEST_SKILL}: exactly one ingest_route record must name claude and codex, `
      + 'main-caller-sequential, and child_agents false');
  }
  for (const [key, value] of records.flatMap((record) => nestedEntries(record))) {
    if (key !== 'ingest_route' && /(?:^|_)route$|^agent_contracts$/.test(key)) {
      failures.push(`${INGEST_SKILL}: additional route record \`${key}\` is not allowed`);
    }
    if (key === 'child_agents' && value !== false) {
      failures.push(`${INGEST_SKILL}: a data record enables child_agents`);
    }
  }
  const collapsed = text.replace(/\s+/g, ' ');
  for (const [label, pattern] of URL_CLAUSES) {
    if (!pattern.test(collapsed)) failures.push(`${INGEST_SKILL}: URL contract ${label} is missing`);
  }
  return failures;
}

function check(root = DEFAULT_ROOT) {
  const failures = [];
  if (fs.existsSync(path.join(root, 'agents'))) {
    failures.push('agents/: deep-wiki ships no subagents; remove the directory');
  }
  for (const manifest of PLUGIN_MANIFESTS) {
    const absolute = path.join(root, manifest);
    if (!fs.existsSync(absolute)) continue;
    if (Object.hasOwn(JSON.parse(fs.readFileSync(absolute, 'utf8')), 'agents')) {
      failures.push(`${manifest}: must not declare agents`);
    }
  }
  for (const file of markdownFiles(root)) {
    const relative = path.relative(root, file).split(path.sep).join('/');
    const text = fs.readFileSync(file, 'utf8');
    text.split(/\r?\n/).forEach((line, index) => {
      for (const [pattern, label] of MECHANISM_PATTERNS) {
        if (pattern.test(line)) failures.push(`${relative}:${index + 1}: ${label}`);
      }
    });
    for (const { line, sentence } of sentences(text)) {
      const labels = new Set();
      for (const clause of sentence.split(CLAUSE_BREAK)) {
        if (PROHIBITION.test(clause)) continue;
        for (const [pattern, label] of DELEGATION_PATTERNS) {
          if (pattern.test(clause)) labels.add(label);
        }
      }
      for (const label of labels) failures.push(`${relative}:${line}: ${label}`);
    }
  }
  const ingest = path.join(root, INGEST_SKILL);
  failures.push(...checkIngestRoute(fs.existsSync(ingest) ? fs.readFileSync(ingest, 'utf8') : ''));
  return failures;
}

function main() {
  const failures = check();
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
    return 1;
  }
  process.stdout.write('OK: no subagent definitions or delegation instructions; ingest route and URL contract are intact.\n');
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { check, main };
