'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  validateSkillCommands,
  SKILL_COMMAND_CONTRACTS,
} = require('../scripts/lib/executable-contract.js');
const { check } = require('../scripts/lint-agents.js');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function frontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(match);
  return match[1];
}

function dataObjects(text) {
  return [...text.matchAll(/<!-- deep-wiki:data -->\s*```json\s*([\s\S]*?)\s*```/g)]
    .map((match) => JSON.parse(match[1]));
}

function executeRoute(policy, plans) {
  assert.equal(policy.mode, 'main-caller-sequential');
  assert.equal(policy.child_agents, false);
  assert.equal(policy.input_order, 'stable');
  const trace = [];
  for (const plan of plans) {
    for (const phase of policy.per_plan_phases) trace.push(`${phase}:${plan}`);
  }
  return trace;
}

test('both hosts share one main-caller ingest route with an exact per-plan trace', () => {
  const ingest = read('skills/wiki-ingest/SKILL.md');
  const records = dataObjects(ingest);
  const routes = records.filter((value) => value.ingest_route);
  assert.equal(routes.length, 1);
  const policy = routes[0].ingest_route;
  assert.deepEqual(policy.hosts, ['claude', 'codex']);
  assert.equal(policy.mutation_gate, 'complete-manifest-validated');
  assert.equal(executeRoute(policy, ['p1', 'p2', 'p3']).join(','),
    'analyze:p1,write:p1,validate:p1,analyze:p2,write:p2,validate:p2,analyze:p3,write:p3,validate:p3');
  assert.deepEqual(records.filter((value) => value.claude_route || value.codex_route), []);
  assert.doesNotMatch(frontmatter(ingest), /agent_fanout/);
});

test('the ingest skill names no delegated worker, dispatch knob, or host-specific route', () => {
  const ingest = read('skills/wiki-ingest/SKILL.md');
  for (const forbidden of [
    /\bparallel\b/i, /subagent_type/i, /general-purpose/i, /spawn_agent/i, /Task\s*\(/,
    /deep-wiki:wiki-[a-z]/, /<plugin_root>\/agents\//, /\bdispatch/i, /\bqualified\b/i,
    /a5_fanout_threshold|a5_worker_timeout_sec/, /claude_route|codex_route/,
  ]) assert.doesNotMatch(ingest, forbidden);
});

test('the plugin ships no subagents and the guard rejects each way one could return', () => {
  assert.equal(fs.existsSync(path.join(root, 'agents')), false);
  assert.deepEqual(check(root), []);

  const fixture = (mutate) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-wiki-no-agents-'));
    const write = (relative, text) => {
      const target = path.join(dir, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, text);
    };
    for (const relative of [
      'skills/wiki-ingest/SKILL.md', '.claude-plugin/plugin.json', '.codex-plugin/plugin.json',
    ]) write(relative, read(relative));
    mutate(write);
    try {
      return check(dir);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  assert.deepEqual(fixture(() => {}), [], 'the untouched fixture must pass, or the cases below prove nothing');
  for (const [label, mutate, expected] of [
    ['agent directory', (write) => write('agents/wiki-page-writer.md', '---\nname: x\n---\n'), /^agents\//],
    ['manifest agents key',
      (write) => write('.claude-plugin/plugin.json', JSON.stringify({ name: 'deep-wiki', agents: './agents/' })),
      /must not declare agents/],
    ['removed agent name', (write) => write('CLAUDE.md', 'Use `deep-wiki:wiki-page-writer` for bodies.\n'),
      /CLAUDE\.md:1: removed ingest agent name/],
    ['agent tool call', (write) => write('skills/wiki-query/SKILL.md', 'Agent({ description: "x" })\n'),
      /wiki-query\/SKILL\.md:1: agent tool call/],
    ['delegation instruction', (write) => write('AGENTS.md', 'Ingest may fan out page bodies to workers.\n'),
      /AGENTS\.md:1: delegation instruction/],
    ['missing URL contract', (write) => write('skills/wiki-ingest/SKILL.md', '# wiki-ingest\n'),
      /URL prompt contract is missing/],
  ]) {
    const failures = fixture(mutate);
    assert.ok(failures.some((failure) => expected.test(failure)), `${label}: ${failures.join('; ')}`);
  }
});

test('all five skills expose one exact deterministic route to both hosts', () => {
  const matrix = {};
  for (const [skill, contract] of Object.entries(SKILL_COMMAND_CONTRACTS)) {
    const relative = `skills/${skill}/SKILL.md`;
    const text = read(relative);
    assert.match(frontmatter(text), /runtime_hosts:\s*\[claude, codex\]/);
    const result = validateSkillCommands(relative, text, contract);
    assert.deepEqual(result.violations, [], relative);
    const route = result.commands.map((command) => ({
      executable: command.executable,
      argv: command.argv,
      timeout_ms: command.timeout_ms,
    }));
    matrix[skill] = { claude: route, codex: structuredClone(route) };
  }
  for (const routes of Object.values(matrix)) assert.deepEqual(routes.claude, routes.codex);
});
