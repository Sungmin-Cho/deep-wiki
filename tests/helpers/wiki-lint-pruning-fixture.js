'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const scanWindow = require('../../hooks/scripts/runtime/scan-window.js');
const { createDeadline } = require('../../hooks/scripts/runtime/deadline.js');
const { acquireLock, releaseLock } = require('../../hooks/scripts/runtime/lock.js');
const { fixWiki } = require('../../hooks/scripts/runtime/wiki-state.js');

const PROPOSED = '2026-07-11T01:00:00Z';
const SESSION_RE = /^s-[0-9a-f]{8}$/;
const VERIFICATION_TEMP_RE =
  /^deep-work\.s-[0-9a-f]{8}\.verification-temp\.[0-9a-f]{64}$/;

function containedDirectory(root, candidate) {
  let stat;
  try { stat = fs.lstatSync(candidate); } catch { return null; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  const physical = fs.realpathSync.native(candidate);
  const relative = path.relative(root, physical);
  if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return physical;
}

function verifierTempRoot() {
  if (process.permission === undefined) return os.tmpdir();
  const root = fs.realpathSync.native(process.cwd());
  const candidates = [];
  const deepWork = path.join(root, '.deep-work');
  if (fs.existsSync(deepWork)) {
    for (const entry of fs.readdirSync(deepWork, { withFileTypes: true })) {
      if (!entry.isDirectory() || !SESSION_RE.test(entry.name)) continue;
      candidates.push(path.join(deepWork, entry.name, 'tmp'));
    }
  }
  const control = path.join(root, '.claude');
  if (fs.existsSync(control)) {
    for (const entry of fs.readdirSync(control, { withFileTypes: true })) {
      if (entry.isDirectory() && VERIFICATION_TEMP_RE.test(entry.name)) {
        candidates.push(path.join(control, entry.name));
      }
    }
  }
  const authorized = [...new Set(candidates.map((candidate) =>
    containedDirectory(root, candidate)).filter(Boolean))]
    .filter((candidate) => process.permission.has('fs.write', candidate));
  assert.equal(authorized.length, 1, 'exactly one verifier-owned temp root must be writable');
  return authorized[0];
}

function createWikiRoot() {
  const root = fs.realpathSync.native(fs.mkdtempSync(
    path.join(verifierTempRoot(), 'deep-wiki-lint-pruning-'),
  ));
  fs.mkdirSync(path.join(root, 'pages'));
  fs.mkdirSync(path.join(root, '.wiki-meta', 'sources'), { recursive: true });
  fs.mkdirSync(path.join(root, '.wiki-meta', '.versions'));
  fs.mkdirSync(path.join(root, '.wiki-meta', '.transactions'));
  fs.writeFileSync(path.join(root, 'log.jsonl'), '');
  fs.writeFileSync(path.join(root, 'log.md'), '# Wiki Log\n');
  fs.writeFileSync(path.join(root, 'index.md'), '# Wiki Index\n');
  return root;
}

function createCompletedEnsure(root) {
  const now = new Date('2026-07-11T02:00:00Z');
  const owner = acquireLock({ wikiRoot: root, operation: 'red-fixture', now });
  const operationId = `red-ensure-${crypto.createHash('sha256').update(root).digest('hex').slice(0, 40)}`;
  try {
    const plan = scanWindow.planScanWindowTransition({
      wikiRoot: root, kind: 'ensure', proposed: PROPOSED,
    });
    scanWindow.applyScanWindowTransition({
      wikiRoot: root,
      token: owner.token,
      plan,
      operationId,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  return path.join(root, '.wiki-meta', '.transactions', operationId, 'journal.json');
}

function createCompletedEnsurePair(root) {
  const now = new Date('2026-07-11T02:00:00Z');
  const owner = acquireLock({ wikiRoot: root, operation: 'red-fixture-pair', now });
  const suffix = crypto.createHash('sha256').update(root).digest('hex').slice(0, 39);
  const journalPaths = [];
  const resultStatuses = [];
  try {
    for (const discriminator of ['c', 'p']) {
      const operationId = `red-ensure-${discriminator}${suffix}`;
      const plan = scanWindow.planScanWindowTransition({
        wikiRoot: root, kind: 'ensure', proposed: PROPOSED,
      });
      resultStatuses.push(plan.resultStatus);
      scanWindow.applyScanWindowTransition({
        wikiRoot: root,
        token: owner.token,
        plan,
        operationId,
        deadline: createDeadline({ budgetMs: 12_000 }),
      });
      journalPaths.push(path.join(
        root, '.wiki-meta', '.transactions', operationId, 'journal.json',
      ));
    }
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assert.deepEqual(resultStatuses, ['created', 'preserved']);
  return journalPaths;
}

function createCompletedEnsures(root, entries) {
  const now = new Date('2026-07-11T02:00:00Z');
  const owner = acquireLock({ wikiRoot: root, operation: 'red-fixture-batch', now });
  const journals = [];
  try {
    for (const entry of entries) {
      const plan = scanWindow.planScanWindowTransition({
        wikiRoot: root,
        kind: 'ensure',
        proposed: entry.proposed || PROPOSED,
      });
      const result = scanWindow.applyScanWindowTransition({
        wikiRoot: root,
        token: owner.token,
        plan,
        operationId: entry.operationId,
        deadline: createDeadline({ budgetMs: 12_000 }),
      });
      journals.push({
        operationId: entry.operationId,
        resultStatus: result.status,
        path: path.join(
          root, '.wiki-meta', '.transactions', entry.operationId, 'journal.json',
        ),
      });
    }
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  return journals;
}

function createPreservedEnsureQuarantineResidue(root) {
  const suffix = crypto.createHash('sha256').update(root).digest('hex').slice(0, 24);
  const journals = createCompletedEnsures(root, [
    { operationId: `a-created-residue-${suffix}`, proposed: PROPOSED },
    {
      operationId: `b-preserved-residue-${suffix}`,
      proposed: '2026-07-11T02:00:00Z',
    },
  ]);
  assert.deepEqual(journals.map((entry) => entry.resultStatus), ['created', 'preserved']);
  const preserved = journals[1];
  const now = repairClockFromJournal(journals.map((entry) => entry.path));
  const owner = acquireLock({
    wikiRoot: root,
    operation: 'preserved-ensure-residue-seed',
    now,
  });
  try {
    let reached = false;
    const seeded = scanWindow.pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 0,
      limit: 64,
      kinds: ['ensure'],
      now,
      deadline: createDeadline({ budgetMs: 12_000 }),
      faultInjector(boundary, context) {
        if (boundary !== 'before-reservation-destination-link'
            || context?.operationId !== preserved.operationId) return;
        reached = true;
        const error = new Error('leave an authenticated preserved ensure quarantine');
        error.code = 'DEADLINE_EXCEEDED';
        throw error;
      },
    });
    assert.equal(reached, true);
    assert.deepEqual(seeded, { processed: 0, removed: [], complete: false, skipped_oversized: [] });
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  const quarantineNames = fs.readdirSync(transactions)
    .filter((name) => name.startsWith('.prune-'));
  assert.equal(quarantineNames.length, 1);
  return {
    createdOperationId: journals[0].operationId,
    operationId: preserved.operationId,
    now,
    quarantine: path.join(transactions, quarantineNames[0]),
  };
}

function completedEnsureCount(root) {
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  return fs.readdirSync(transactions, { withFileTypes: true }).filter((entry) => {
    if (!entry.isDirectory()) return false;
    try {
      const journal = JSON.parse(fs.readFileSync(
        path.join(transactions, entry.name, 'journal.json'), 'utf8',
      ));
      return journal.kind === 'ensure' && journal.transitions.at(-1) === 'cleaned';
    } catch {
      return false;
    }
  }).length;
}

function repairClockFromJournal(journalPathOrPaths) {
  const journalPaths = Array.isArray(journalPathOrPaths)
    ? journalPathOrPaths
    : [journalPathOrPaths];
  const identities = journalPaths.map((journalPath) =>
    fs.lstatSync(journalPath, { bigint: true }));
  const latestMtimeNs = identities.reduce(
    (latest, identity) => identity.mtimeNs > latest ? identity.mtimeNs : latest,
    0n,
  );
  const now = new Date(Number(latestMtimeNs / 1_000_000_000n + 1n) * 1000);
  assert.ok(BigInt(now.getTime()) * 1_000_000n > latestMtimeNs);
  assert.equal(now.getMilliseconds(), 0);
  return now;
}

function withPermissionModelFsyncCompatibility(callback) {
  if (process.permission === undefined) return callback();
  const original = fs.fsyncSync;
  fs.fsyncSync = () => {};
  try { return callback(); }
  finally { fs.fsyncSync = original; }
}

function observeRecoverySuppressionScopeUnsafe() {
  const root = createWikiRoot();
  try {
    const residue = createPreservedEnsureQuarantineResidue(root);
    fs.writeFileSync(path.join(root, '.wiki-meta', '.last-scan'), 'invalid\n');
    try {
      const result = fixWiki({ wikiRoot: root, now: residue.now });
      return { remaining: 0, result };
    } catch (error) {
      const preserved = fs.existsSync(residue.quarantine)
        && fs.existsSync(path.join(
          root,
          '.wiki-meta',
          '.transactions',
          residue.createdOperationId,
        ));
      return {
        remaining: error.code === 'TRANSACTION_RECOVERY_REQUIRED'
          && /stopped-host/i.test(error.message)
          && preserved ? 1 : 0,
        error,
      };
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function observeRecoverySuppressionScope() {
  return withPermissionModelFsyncCompatibility(observeRecoverySuppressionScopeUnsafe);
}

function productionEnsureId(seed) {
  return `scan-window-ensure-${crypto.createHash('sha256').update(String(seed)).digest('hex').slice(0, 40)}`;
}

function quarantinesFor(root, operationId) {
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  return fs.readdirSync(transactions)
    .filter((name) => name.startsWith(`.prune-${operationId.length}-${operationId}-`))
    .sort()
    .map((name) => path.join(transactions, name));
}

// Runs one ensure prune pass that stops, for `operationId` only, at `stopAt` — the shape an
// interrupted SessionStart prune leaves behind.
function stopPruneAt(root, operationId, stopAt, now) {
  const owner = acquireLock({ wikiRoot: root, operation: 'stalled-prune-seed', now });
  let reached = false;
  try {
    scanWindow.pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 0,
      limit: 64,
      kinds: ['ensure'],
      now,
      deadline: createDeadline({ budgetMs: 12_000 }),
      faultInjector(boundary, context) {
        if (boundary !== stopAt || context?.operationId !== operationId) return;
        reached = true;
        const error = new Error(`stop at ${stopAt}`);
        error.code = 'DEADLINE_EXCEEDED';
        throw error;
      },
    });
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assert.equal(reached, true, `prune never reached ${stopAt}`);
}

function createStalledQuarantine(root, options = {}) {
  const stopAt = options.stopAt || 'before-backup-destination-link';
  const seed = options.seed === undefined ? root : options.seed;
  const createdId = productionEnsureId(`${seed}:created`);
  const operationId = productionEnsureId(`${seed}:preserved`);
  const journals = createCompletedEnsures(root, [
    { operationId: createdId, proposed: PROPOSED },
    { operationId, proposed: '2026-07-11T02:00:00Z' },
  ]);
  assert.deepEqual(journals.map((entry) => entry.resultStatus), ['created', 'preserved']);
  const canonicalBytes = fs.readFileSync(journals[1].path);
  const now = repairClockFromJournal(journals.map((entry) => entry.path));
  stopPruneAt(root, operationId, stopAt, now);
  const quarantines = quarantinesFor(root, operationId);
  assert.equal(quarantines.length, 1);
  return { createdId, operationId, canonicalBytes, now, quarantine: quarantines[0] };
}

// A byte-identical but separately linked backup/pending pair: what a sync client re-materializing
// an already-published hardlink pair leaves behind.
function makeBackupPublicationAmbiguous(quarantine) {
  fs.copyFileSync(
    path.join(quarantine, 'journal.backup.pending'),
    path.join(quarantine, 'journal.backup'),
    fs.constants.COPYFILE_EXCL,
  );
}

function reinjectCanonicalDirectory(root, operationId, bytes) {
  const directory = path.join(root, '.wiki-meta', '.transactions', operationId);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'journal.json'), bytes);
  return directory;
}

function addQuarantineGeneration(root, operationId, canonicalBytes, now) {
  const before = new Set(quarantinesFor(root, operationId));
  reinjectCanonicalDirectory(root, operationId, canonicalBytes);
  stopPruneAt(root, operationId, 'before-backup-destination-link', now);
  const added = quarantinesFor(root, operationId).filter((entry) => !before.has(entry));
  assert.equal(added.length, 1);
  makeBackupPublicationAmbiguous(added[0]);
  return added[0];
}

module.exports = {
  addQuarantineGeneration,
  createStalledQuarantine,
  makeBackupPublicationAmbiguous,
  productionEnsureId,
  quarantinesFor,
  reinjectCanonicalDirectory,
  stopPruneAt,
  completedEnsureCount,
  createCompletedEnsure,
  createCompletedEnsurePair,
  createCompletedEnsures,
  createPreservedEnsureQuarantineResidue,
  createWikiRoot,
  observeRecoverySuppressionScope,
  repairClockFromJournal,
  verifierTempRoot,
};
