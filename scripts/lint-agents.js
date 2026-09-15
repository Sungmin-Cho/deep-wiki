#!/usr/bin/env node
'use strict';

// deep-wiki ships no subagents: every skill, /wiki-ingest included, runs in the
// host's main caller. This guard fails if an agent definition or a delegation
// instruction reappears, because either would restore a Claude Code-only route
// that Codex cannot follow.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const INSTRUCTION_ROOTS = ['AGENTS.md', 'CLAUDE.md', 'skills'];
const PLUGIN_MANIFESTS = ['.claude-plugin/plugin.json', '.codex-plugin/plugin.json'];

const DELEGATION_PATTERNS = [
  [/wiki-synthesizer|wiki-page-writer/, 'removed ingest agent name'],
  [/<plugin_root>\/agents\//, 'agent definition path'],
  [/subagent_type|spawn_agent/i, 'agent dispatch parameter'],
  [/\b(?:Task|Agent)\s*\(\s*\{/, 'agent tool call'],
  [/\bgeneral-purpose\b/i, 'generic agent'],
  [/\b(?:dispatch(?:es|ed)?|fan(?:s|ned)?[- ]?out|delegat\w*)\b[^\n]*\b(?:sub-?agents?|workers?|child agents?)\b/i,
    'delegation instruction'],
];

// Matched against whitespace-collapsed text, so a phrase may wrap across lines.
const URL_CONTRACT = [
  /URL allowlist is a source-origin prompt contract/,
  /not a claim of runtime capability enforcement/,
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
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, index) => {
      for (const [pattern, label] of DELEGATION_PATTERNS) {
        if (pattern.test(line)) failures.push(`${relative}:${index + 1}: ${label}`);
      }
    });
  }
  const ingest = path.join(root, 'skills', 'wiki-ingest', 'SKILL.md');
  const ingestText = fs.existsSync(ingest) ? fs.readFileSync(ingest, 'utf8').replace(/\s+/g, ' ') : '';
  if (!URL_CONTRACT.every((pattern) => pattern.test(ingestText))) {
    failures.push('skills/wiki-ingest/SKILL.md: source-origin URL prompt contract is missing');
  }
  return failures;
}

function main() {
  const failures = check();
  if (failures.length > 0) {
    for (const failure of failures) process.stderr.write(`FAIL: ${failure}\n`);
    return 1;
  }
  process.stdout.write('OK: no subagent definitions or delegation instructions; ingest URL contract is present.\n');
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = { check, main };
