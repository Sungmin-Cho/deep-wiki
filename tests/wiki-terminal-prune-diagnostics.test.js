'use strict';

// Issue #60: a terminal prune quarantine that its safety checks refuse must be reported, not
// swallowed. These tests build the stalled states on temporary roots only.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const scanWindow = require('../hooks/scripts/runtime/scan-window.js');
const { createDeadline } = require('../hooks/scripts/runtime/deadline.js');
const { acquireLock, releaseLock } = require('../hooks/scripts/runtime/lock.js');
const { fixWiki, inspectWiki } = require('../hooks/scripts/runtime/wiki-state.js');
const {
  addQuarantineGeneration,
  createCompletedEnsures,
  createStalledQuarantine,
  createWikiRoot,
  makeBackupPublicationAmbiguous,
  productionEnsureId,
  quarantinesFor,
  reinjectCanonicalDirectory,
  repairClockFromJournal,
} = require('./helpers/wiki-lint-pruning-fixture.js');

const roots = new Set();

function wiki() {
  const root = createWikiRoot();
  roots.add(root);
  return root;
}

function transactionsOf(root) {
  return path.join(root, '.wiki-meta', '.transactions');
}

function storeTree(root) {
  const out = [];
  const visit = (directory, relative) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const child = relative ? `${relative}/${entry.name}` : entry.name;
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        out.push(`${child}/`);
        visit(pathname, child);
      } else {
        out.push(`${child}:${fs.readFileSync(pathname).toString('hex')}`);
      }
    }
  };
  visit(transactionsOf(root), '');
  return out.sort();
}

function bundleCount(root) {
  const quarantine = path.join(root, '.wiki-meta', '.quarantine');
  return fs.existsSync(quarantine) ? fs.readdirSync(quarantine).length : 0;
}

function assertVocabulary(report) {
  for (const entry of report.blocked) {
    assert.ok(scanWindow.PRUNE_BLOCK_STAGES.includes(entry.stage), entry.stage);
    assert.ok(scanWindow.PRUNE_BLOCK_REASONS.includes(entry.reason), entry.reason);
    assert.ok(['directory', 'reservation', 'file', 'absent', 'other', 'unknown']
      .includes(entry.canonical), entry.canonical);
  }
  assert.equal(report.blocked_truncated, report.blocked_count > report.blocked.length);
}

function prune(root, now, extra = {}) {
  const owner = acquireLock({ wikiRoot: root, operation: 'issue-60-prune', now });
  try {
    const result = scanWindow.pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 0,
      limit: 64,
      kinds: ['ensure'],
      now,
      deadline: createDeadline({ budgetMs: 12_000 }),
      ...extra,
    });
    assertVocabulary(result);
    return result;
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
}

function fixError(root, now) {
  let caught;
  assert.throws(() => fixWiki({ wikiRoot: root, now }), (error) => {
    caught = error;
    return true;
  });
  return caught;
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('T1 an ambiguous backup publication is reported with its stage and reason', () => {
  const root = wiki();
  const stalled = createStalledQuarantine(root);
  makeBackupPublicationAmbiguous(stalled.quarantine);
  const before = storeTree(root);
  const ownerToken = JSON.parse(
    fs.readFileSync(path.join(stalled.quarantine, 'journal.json'), 'utf8'),
  ).owner_token;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const error = fixError(root, stalled.now);
    assert.equal(error.code, 'TRANSACTION_RECOVERY_REQUIRED');
    assert.match(error.message, /recovery made no progress/);
    assert.match(error.message, /stopped-host/i);
    assertVocabulary(error.terminal_prune);
    assert.equal(error.terminal_prune.processed, 0);
    assert.equal(error.terminal_prune.blocked_count, 1);
    assert.deepEqual(error.terminal_prune.blocked, [{
      name: path.basename(stalled.quarantine),
      operation_id: stalled.operationId,
      stage: 'backup-publication',
      reason: 'publication-ambiguous',
      code: null,
      canonical: 'absent',
    }]);
    const serialized = JSON.stringify({ message: error.message, terminal_prune: error.terminal_prune });
    assert.equal(serialized.includes(ownerToken), false);
    assert.equal(serialized.includes('"transitions"'), false);
    assert.equal(serialized.includes(root), false);
  }
  // T4: retrying an unresolved generation adds no store entry and no bundle.
  assert.deepEqual(storeTree(root), before);
  assert.equal(bundleCount(root), 0);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
});

test('T2 a canonical directory blocking reservation publication is reported and self-heals under ensure pruning', () => {
  const root = wiki();
  const stalled = createStalledQuarantine(root, { stopAt: 'before-reservation-destination-link' });
  reinjectCanonicalDirectory(root, stalled.operationId, stalled.canonicalBytes);

  const error = fixError(root, stalled.now);
  assert.deepEqual(error.terminal_prune.blocked.map((entry) => ({ ...entry, name: undefined })), [{
    name: undefined,
    operation_id: stalled.operationId,
    stage: 'reservation-publication',
    reason: 'destination-not-regular-file',
    code: null,
    canonical: 'directory',
  }]);

  const first = prune(root, stalled.now);
  assert.equal(first.processed, 1);
  assert.equal(first.blocked_count, 1);
  const second = prune(root, stalled.now);
  assert.equal(second.processed, 1);
  assert.equal(second.blocked_count, 0);
  assert.deepEqual(quarantinesFor(root, stalled.operationId), []);
  assert.equal(fs.existsSync(path.join(transactionsOf(root), stalled.operationId)), false);
});

test('T2b a destination appearing at link time is reported as occupied with its errno', () => {
  const root = wiki();
  const createdId = productionEnsureId(`${root}:t2b-created`);
  const operationId = productionEnsureId(`${root}:t2b-preserved`);
  const journals = createCompletedEnsures(root, [
    { operationId: createdId, proposed: '2026-07-11T01:00:00Z' },
    { operationId, proposed: '2026-07-11T02:00:00Z' },
  ]);
  const now = repairClockFromJournal(journals.map((entry) => entry.path));
  const result = prune(root, now, {
    faultInjector(boundary, context) {
      if (boundary !== 'before-reservation-destination-link'
          || context?.operationId !== operationId) return;
      fs.writeFileSync(path.join(transactionsOf(root), operationId), 'racing writer\n');
    },
  });
  assert.equal(result.blocked_count, 1);
  assert.equal(result.blocked[0].stage, 'reservation-publication');
  assert.equal(result.blocked[0].reason, 'destination-occupied');
  assert.equal(result.blocked[0].code, 'EEXIST');
  assert.equal(result.blocked[0].canonical, 'reservation');
});

test('T3 every generation of one operation is counted and observed against its canonical directory', () => {
  const root = wiki();
  const stalled = createStalledQuarantine(root);
  makeBackupPublicationAmbiguous(stalled.quarantine);
  addQuarantineGeneration(root, stalled.operationId, stalled.canonicalBytes, stalled.now);
  addQuarantineGeneration(root, stalled.operationId, stalled.canonicalBytes, stalled.now);
  reinjectCanonicalDirectory(root, stalled.operationId, stalled.canonicalBytes);

  const error = fixError(root, stalled.now);
  assert.equal(error.terminal_prune.blocked_count, 3);
  assert.deepEqual(
    error.terminal_prune.blocked.map((entry) => entry.name),
    quarantinesFor(root, stalled.operationId).map((entry) => path.basename(entry)),
  );
  assert.ok(error.terminal_prune.blocked.every((entry) => entry.canonical === 'directory'));
});

test('T5 SessionStart ensure prunes a reinjected canonical directory and leaves the ambiguous generation alone', () => {
  const root = wiki();
  const stalled = createStalledQuarantine(root);
  makeBackupPublicationAmbiguous(stalled.quarantine);
  reinjectCanonicalDirectory(root, stalled.operationId, stalled.canonicalBytes);

  const result = scanWindow.ensurePendingScan({
    wikiRoot: root,
    proposed: '2026-07-11T03:00:00Z',
    now: new Date(stalled.now.getTime() + 1000),
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.equal(typeof result.status, 'string');
  assert.equal(fs.existsSync(path.join(transactionsOf(root), stalled.operationId)), false);
  assert.deepEqual(quarantinesFor(root, stalled.operationId), [stalled.quarantine]);

  const observed = prune(root, new Date(stalled.now.getTime() + 2000));
  assert.deepEqual(observed.blocked.map((entry) => entry.name), [path.basename(stalled.quarantine)]);
});

test('a reservation whose same-id prune name is not a directory is reported and kept', () => {
  const root = wiki();
  const createdId = productionEnsureId(`${root}:nd-created`);
  const operationId = productionEnsureId(`${root}:nd-preserved`);
  const journals = createCompletedEnsures(root, [
    { operationId: createdId, proposed: '2026-07-11T01:00:00Z' },
    { operationId, proposed: '2026-07-11T02:00:00Z' },
  ]);
  const now = repairClockFromJournal(journals.map((entry) => entry.path));
  const bytes = fs.readFileSync(journals[1].path);
  const canonical = path.join(transactionsOf(root), operationId);
  fs.rmSync(canonical, { recursive: true });
  fs.writeFileSync(canonical, bytes);
  const fakeName = `.prune-${operationId.length}-${operationId}-1-${crypto.randomUUID()}`;
  fs.writeFileSync(path.join(transactionsOf(root), fakeName), 'not a quarantine\n');

  const result = prune(root, now);
  assert.equal(fs.readFileSync(canonical).equals(bytes), true);
  assert.deepEqual(result.blocked.map(({ name, stage, reason }) => ({ name, stage, reason })), [{
    name: operationId,
    stage: 'reservation-only',
    reason: 'matching-quarantine-not-directory',
  }]);
});

test('discovery refusals carry their table reasons and a mismatched name has no operation id', () => {
  const root = wiki();
  const createdId = productionEnsureId(`${root}:disc-created`);
  const operationId = productionEnsureId(`${root}:disc-preserved`);
  const journals = createCompletedEnsures(root, [
    { operationId: createdId, proposed: '2026-07-11T01:00:00Z' },
    { operationId, proposed: '2026-07-11T02:00:00Z' },
  ]);
  const now = repairClockFromJournal(journals.map((entry) => entry.path));
  const store = transactionsOf(root);
  const debris = path.join(store, '.prune-5-phase-debris');
  fs.mkdirSync(debris);
  fs.writeFileSync(path.join(debris, 'evidence'), 'preserve\n');
  const garbageId = productionEnsureId(`${root}:garbage`);
  const garbage = path.join(store, `.prune-${garbageId.length}-${garbageId}-1-${crypto.randomUUID()}`);
  fs.mkdirSync(garbage);
  fs.writeFileSync(path.join(garbage, 'journal.json'), '{not json\n');
  const otherId = productionEnsureId(`${root}:other`);
  const mismatched = path.join(store, `.prune-${otherId.length}-${otherId}-1-${crypto.randomUUID()}`);
  fs.mkdirSync(mismatched);
  fs.copyFileSync(journals[1].path, path.join(mismatched, 'journal.json'));
  const before = storeTree(root);

  const result = prune(root, now, { resumableOnly: true, kinds: undefined });
  const byName = new Map(result.blocked.map((entry) => [entry.name, entry]));
  assert.equal(byName.get('.prune-5-phase-debris').reason, 'unexpected-entries');
  assert.equal(byName.get('.prune-5-phase-debris').operation_id, 'phase');
  assert.equal(byName.get(path.basename(garbage)).reason, 'journal-invalid');
  assert.equal(byName.get(path.basename(mismatched)).reason, 'journal-invalid');
  assert.equal(byName.get(path.basename(mismatched)).operation_id, null);
  assert.equal(byName.get(path.basename(mismatched)).canonical, 'unknown');
  assert.deepEqual(storeTree(root), before);
});

test('a failure after the quarantine is removed is reported under the surviving reservation', () => {
  const root = wiki();
  const createdId = productionEnsureId(`${root}:td-created`);
  const operationId = productionEnsureId(`${root}:td-preserved`);
  const journals = createCompletedEnsures(root, [
    { operationId: createdId, proposed: '2026-07-11T01:00:00Z' },
    { operationId, proposed: '2026-07-11T02:00:00Z' },
  ]);
  const now = repairClockFromJournal(journals.map((entry) => entry.path));
  const result = prune(root, now, {
    faultInjector(boundary, context) {
      if (boundary === 'before-final-canonical-reservation-unlink'
          && context?.operationId === operationId) {
        throw new Error('final unlink refused');
      }
    },
  });
  assert.deepEqual(quarantinesFor(root, operationId), []);
  assert.deepEqual(result.blocked.map(({ name, stage, operation_id: id, canonical }) => ({
    name, stage, id, canonical,
  })), [{ name: operationId, stage: 'teardown', id: operationId, canonical: 'reservation' }]);
});

test('the blocked list is capped while the count stays exact and observation is bounded', (t) => {
  const root = wiki();
  const store = transactionsOf(root);
  for (let index = 0; index < 40; index += 1) {
    const id = productionEnsureId(`${root}:cap-${index}`);
    const quarantine = path.join(store, `.prune-${id.length}-${id}-1-${crypto.randomUUID()}`);
    fs.mkdirSync(quarantine);
    fs.writeFileSync(path.join(quarantine, 'stray'), 'x\n');
  }
  const observed = [];
  const original = fs.lstatSync;
  t.after(() => { fs.lstatSync = original; });
  fs.lstatSync = function lstatSync(pathname, options) {
    const text = String(pathname);
    if (path.dirname(text) === store && /^scan-window-ensure-[0-9a-f]{40}$/.test(path.basename(text))) {
      observed.push(text);
      if (observed.length === 1) {
        const error = new Error('denied');
        error.code = 'EACCES';
        throw error;
      }
    }
    return original.call(fs, pathname, options);
  };
  const result = prune(root, new Date(), { resumableOnly: true, kinds: undefined });
  fs.lstatSync = original;
  assert.equal(result.blocked.length, 32);
  assert.equal(result.blocked_count, 40);
  assert.equal(result.blocked_truncated, true);
  assert.equal(observed.length, 32);
  assert.equal(result.blocked[0].canonical, 'unknown');
  assert.ok(result.blocked.slice(1).every((entry) => entry.canonical === 'absent'));
});

test('inspection names the sorted first prune entry and the count', () => {
  const root = wiki();
  const store = transactionsOf(root);
  fs.mkdirSync(path.join(store, '.prune-5-zzzzz-debris'));
  fs.mkdirSync(path.join(store, '.prune-5-aaaaa-debris'));
  assert.throws(() => inspectWiki({ wikiRoot: root }), (error) =>
    error.code === 'TRANSACTION_RECOVERY_REQUIRED'
    && error.message.includes('(2 .prune-* entries; first: .prune-5-aaaaa-debris)')
    && /stopped-host/.test(error.message));
});

const { spawnSync } = require('node:child_process');
const wikiRuntime = require('../scripts/wiki-runtime.js');

const CLI = path.join(__dirname, '..', 'scripts', 'wiki-runtime.js');
const ID_A = `scan-window-ensure-${'a'.repeat(40)}`;
const ID_B = `scan-window-ensure-${'b'.repeat(40)}`;
const pruneName = (id, suffix = '1-00000000-0000-4000-8000-000000000000') => `.prune-${id.length}-${id}-${suffix}`;

function observation(blocked, extra = {}) {
  return {
    processed: 0,
    blocked,
    blocked_count: blocked.length,
    blocked_truncated: false,
    ...extra,
  };
}

function blockedEntry(name, operationId, canonical, stage = 'backup-publication') {
  return { name, operation_id: operationId, stage, reason: 'publication-ambiguous', code: null, canonical };
}

function quarantineLines(hint) {
  return hint.split('\n').filter((line) => line.includes(' transaction quarantine '));
}

test('the preserve-first plan follows the canonical-path decision table', () => {
  const root = '/tmp/deep wiki/root';
  const first = pruneName(ID_A, '1-00000000-0000-4000-8000-000000000001');
  const second = pruneName(ID_A, '1-00000000-0000-4000-8000-000000000002');
  const directory = wikiRuntime.blockedPruneHint(observation([
    blockedEntry(second, ID_A, 'directory'),
    blockedEntry(first, ID_A, 'directory'),
  ]), root);
  const lines = quarantineLines(directory);
  assert.equal(lines.length, 3);
  assert.match(lines[0], new RegExp(`--operation-id '${ID_A}'`));
  assert.match(lines[1], new RegExp(`--operation-id '${first}'`));
  assert.match(lines[2], new RegExp(`--operation-id '${second}'`));
  assert.ok(lines.every((line) => line.includes("--wiki-root '/tmp/deep wiki/root'")));
  assert.doesNotMatch(directory, /\$\(/);
  assert.match(directory, /Stop all hosts/);
  assert.match(directory, /first result that is not "quarantined"/);

  for (const canonical of ['reservation', 'absent']) {
    const hint = wikiRuntime.blockedPruneHint(observation([blockedEntry(first, ID_A, canonical)]), root);
    assert.deepEqual(quarantineLines(hint).length, 1, canonical);
  }
  for (const canonical of ['file', 'other', 'unknown']) {
    const hint = wikiRuntime.blockedPruneHint(observation([blockedEntry(first, ID_A, canonical)]), root);
    assert.equal(quarantineLines(hint).length, 0, canonical);
    assert.match(hint, new RegExp(`canonical path is ${canonical}`));
  }
  const reservationOnly = wikiRuntime.blockedPruneHint(observation([
    blockedEntry(ID_B, ID_B, 'reservation', 'reservation-only'),
  ]), root);
  assert.equal(quarantineLines(reservationOnly).length, 0);
  const unknownOperation = wikiRuntime.blockedPruneHint(observation([
    blockedEntry(pruneName(ID_B), null, 'unknown', 'discovery'),
  ]), root);
  assert.equal(quarantineLines(unknownOperation).length, 0);
  assert.match(unknownOperation, /operation is unknown/);
  const notIsolatable = wikiRuntime.blockedPruneHint(observation([
    blockedEntry(pruneName('b-preserved-x'), 'b-preserved-x', 'directory'),
  ]), root);
  assert.equal(quarantineLines(notIsolatable).length, 0);
  assert.match(notIsolatable, /not isolatable by command/);
  const truncated = wikiRuntime.blockedPruneHint(observation(
    [blockedEntry(first, ID_A, 'absent')],
    { blocked_count: 40, blocked_truncated: true },
  ), root);
  assert.match(truncated, /rerun lint fix to list the remaining entries/);
});

test('a pass that made progress asks for a rerun instead of a quarantine plan', () => {
  const hint = wikiRuntime.blockedPruneHint(observation(
    [blockedEntry(pruneName(ID_A), ID_A, 'directory')],
    { processed: 1 },
  ), '/tmp/root');
  assert.match(hint, /Progress was made on this pass; rerun lint fix/);
  assert.equal(quarantineLines(hint).length, 0);
  assert.equal(wikiRuntime.blockedPruneHint(observation([]), '/tmp/root'), null);
  assert.equal(wikiRuntime.blockedPruneHint({ ...observation([]), blocked_count: null }, '/tmp/root'), null);
});

function runHintCommands(hint) {
  const outcomes = [];
  for (const line of quarantineLines(hint)) {
    const ran = spawnSync('/bin/sh', ['-c', line], { encoding: 'utf8' });
    assert.equal(ran.status, 0, ran.stderr);
    outcomes.push(JSON.parse(ran.stdout).status);
  }
  return outcomes;
}

test('T3/T6 executing the printed plan preserves every generation and clears inspection', { skip: process.platform === 'win32' }, () => {
  const root = wiki();
  const stalled = createStalledQuarantine(root);
  makeBackupPublicationAmbiguous(stalled.quarantine);
  addQuarantineGeneration(root, stalled.operationId, stalled.canonicalBytes, stalled.now);
  addQuarantineGeneration(root, stalled.operationId, stalled.canonicalBytes, stalled.now);
  reinjectCanonicalDirectory(root, stalled.operationId, stalled.canonicalBytes);
  const ownerToken = JSON.parse(stalled.canonicalBytes.toString('utf8')).owner_token;
  const before = storeTree(root);

  const lint = spawnSync(process.execPath, [CLI, 'lint', 'fix', '--wiki-root', root, '--json'], {
    encoding: 'utf8', shell: false,
  });
  assert.notEqual(lint.status, 0);
  assert.equal(lint.stderr.includes(ownerToken), false);
  assert.equal(lint.stderr.includes('"transitions"'), false);
  const payload = JSON.parse(lint.stderr.split('\n')[0]);
  assert.equal(payload.terminal_prune.blocked_count, 3);
  assert.equal(payload.terminal_prune.blocked.some((entry) => entry.name.includes(root)), false);
  const lines = quarantineLines(lint.stderr);
  assert.equal(lines.length, 4);
  assert.match(lines[0], new RegExp(`--operation-id '${stalled.operationId}'`));
  assert.deepEqual(storeTree(root), before);

  assert.deepEqual(runHintCommands(lint.stderr), ['quarantined', 'quarantined', 'quarantined', 'quarantined']);
  assert.equal(inspectWiki({ wikiRoot: root }).ok, true);
  const bundles = fs.readdirSync(path.join(root, '.wiki-meta', '.quarantine'));
  assert.equal(bundles.length, 4);
  for (const bundle of bundles) {
    const tree = path.join(root, '.wiki-meta', '.quarantine', bundle, 'tree', 'journal.json');
    assert.equal(fs.readFileSync(tree).equals(stalled.canonicalBytes), true);
  }
});

test('T6 a plan for an absent canonical path clears inspection after one command', { skip: process.platform === 'win32' }, () => {
  const root = wiki();
  const stalled = createStalledQuarantine(root);
  makeBackupPublicationAmbiguous(stalled.quarantine);
  const lint = spawnSync(process.execPath, [CLI, 'lint', 'fix', '--wiki-root', root, '--json'], {
    encoding: 'utf8', shell: false,
  });
  assert.notEqual(lint.status, 0);
  assert.equal(quarantineLines(lint.stderr).length, 1);
  assert.deepEqual(runHintCommands(lint.stderr), ['quarantined']);
  assert.equal(inspectWiki({ wikiRoot: root }).ok, true);
});

test('T2 CLI a progressing transaction prune pass asks for a rerun, the next pass resolves', () => {
  const root = wiki();
  const stalled = createStalledQuarantine(root, { stopAt: 'before-reservation-destination-link' });
  reinjectCanonicalDirectory(root, stalled.operationId, stalled.canonicalBytes);
  const owner = acquireLock({ wikiRoot: root, operation: 'issue-60-cli-prune' });
  try {
    const run = () => spawnSync(process.execPath, [
      CLI, 'transaction', 'prune', '--wiki-root', root,
      '--lock-token', owner.token, '--max-age-days', '0', '--json',
    ], { encoding: 'utf8', shell: false });
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    assert.equal(JSON.parse(first.stdout).blocked_count, 1);
    assert.match(first.stderr, /Progress was made on this pass; rerun lint fix/);
    const second = run();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).blocked_count, 0);
    assert.equal(second.stderr, '');
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assert.deepEqual(quarantinesFor(root, stalled.operationId), []);
});

test('T7 quarantining a prune entry before its canonical directory explains the order and moves nothing', () => {
  const root = wiki();
  const stalled = createStalledQuarantine(root);
  makeBackupPublicationAmbiguous(stalled.quarantine);
  reinjectCanonicalDirectory(root, stalled.operationId, stalled.canonicalBytes);
  const before = storeTree(root);
  const owner = acquireLock({ wikiRoot: root, operation: 'issue-60-order' });
  try {
    assert.throws(() => scanWindow.quarantineStoreEntry({
      wikiRoot: root,
      token: owner.token,
      name: path.basename(stalled.quarantine),
      classification: { method: 'none', estimated_entries: null },
      reason: 'operator',
    }), (error) => error.code === 'WIKI_STATE_FILESYSTEM'
      && error.message === `quarantine reservation path ${stalled.operationId} is a directory; `
        + `quarantine operation ${stalled.operationId} first, then retry ${path.basename(stalled.quarantine)}`);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assert.deepEqual(storeTree(root), before);
  assert.equal(bundleCount(root), 0);
});

function deadPid() {
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  return Number(child.stdout);
}

function reinjectVersions(root, stem = 'note', count = 5) {
  const versions = path.join(root, '.wiki-meta', '.versions');
  for (let index = 1; index <= count; index += 1) {
    fs.writeFileSync(path.join(versions, `${stem}.v${index}.md`), `# ${stem} v${index}\n`);
  }
}

function reinjectDeadLock(root) {
  // A structurally valid same-host owner whose process has exited.
  acquireLock({ wikiRoot: root, operation: 'ingest', pid: deadPid(), now: new Date('2026-09-21T06:59:54Z') });
}

test('T8 reinjected residue, locks and versions each keep their existing fail-closed handling', { skip: process.platform === 'win32' }, async (t) => {
  await t.test('(a) a reinjected residue group is reported again and a second plan preserves it', () => {
    const root = wiki();
    const stalled = createStalledQuarantine(root);
    makeBackupPublicationAmbiguous(stalled.quarantine);
    const firstLint = spawnSync(process.execPath, [CLI, 'lint', 'fix', '--wiki-root', root, '--json'], { encoding: 'utf8' });
    runHintCommands(firstLint.stderr);
    assert.equal(inspectWiki({ wikiRoot: root }).ok, true);
    addQuarantineGeneration(root, stalled.operationId, stalled.canonicalBytes, stalled.now);
    const error = fixError(root, stalled.now);
    assert.equal(error.terminal_prune.blocked_count, 1);
    const secondLint = spawnSync(process.execPath, [CLI, 'lint', 'fix', '--wiki-root', root, '--json'], { encoding: 'utf8' });
    runHintCommands(secondLint.stderr);
    assert.equal(inspectWiki({ wikiRoot: root }).ok, true);
    const bundles = fs.readdirSync(path.join(root, '.wiki-meta', '.quarantine'));
    assert.equal(new Set(bundles).size, 2);
  });

  await t.test('(b1) a dead same-host owner is self-healed by lint fix', () => {
    const root = wiki();
    reinjectDeadLock(root);
    const result = fixWiki({ wikiRoot: root });
    assert.notEqual(result.status, 'skipped');
    assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
  });

  await t.test('(b2) a foreign-host owner is never taken over', () => {
    const root = wiki();
    const foreign = acquireLock({ wikiRoot: root, operation: 'ingest', hostname: 'other-host', pid: 1 });
    const ownerPath = path.join(root, '.wiki-meta', '.wiki-lock', 'owner.json');
    const before = fs.readFileSync(ownerPath);
    assert.deepEqual(fixWiki({ wikiRoot: root }), { status: 'skipped', reason: 'LOCK_CONTENDED' });
    assert.equal(fs.readFileSync(ownerPath).equals(before), true);
    releaseLock({ wikiRoot: root, token: foreign.token, hostname: 'other-host' });
  });

  await t.test('(c) reinjected excess versions are diagnosed and reclaimed', () => {
    const root = wiki();
    reinjectVersions(root);
    assert.ok(inspectWiki({ wikiRoot: root }).issues.some((issue) => issue.code === 'EXCESS_VERSIONS'));
    fixWiki({ wikiRoot: root });
    assert.equal(inspectWiki({ wikiRoot: root }).issues.some((issue) => issue.code === 'EXCESS_VERSIONS'), false);
  });

  await t.test('(a)+(b1)+(c) together: the lock heals, the residue blocks, versions wait', () => {
    const root = wiki();
    const stalled = createStalledQuarantine(root);
    makeBackupPublicationAmbiguous(stalled.quarantine);
    reinjectCanonicalDirectory(root, stalled.operationId, stalled.canonicalBytes);
    reinjectVersions(root);
    reinjectDeadLock(root);
    const versionsBefore = fs.readdirSync(path.join(root, '.wiki-meta', '.versions')).sort();
    const error = fixError(root, stalled.now);
    assert.equal(error.code, 'TRANSACTION_RECOVERY_REQUIRED');
    assert.equal(error.terminal_prune.blocked_count, 1);
    assert.equal(error.terminal_prune.blocked[0].canonical, 'directory');
    assert.deepEqual(fs.readdirSync(path.join(root, '.wiki-meta', '.versions')).sort(), versionsBefore);
    assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
  });
});
