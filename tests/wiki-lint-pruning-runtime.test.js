'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const scanWindow = require('../hooks/scripts/runtime/scan-window.js');
const { createDeadline } = require('../hooks/scripts/runtime/deadline.js');
const { acquireLock, releaseLock } = require('../hooks/scripts/runtime/lock.js');
const wikiState = require('../hooks/scripts/runtime/wiki-state.js');
const { fixWiki } = wikiState;
const wikiRuntime = require('../scripts/wiki-runtime.js');
const {
  completedEnsureCount,
  createCompletedEnsure,
  createCompletedEnsurePair,
  createCompletedEnsures,
  createPreservedEnsureQuarantineResidue,
  createWikiRoot,
  repairClockFromJournal,
} = require('./helpers/wiki-lint-pruning-fixture.js');

const roots = new Set();

function wiki() {
  const root = createWikiRoot();
  roots.add(root);
  return root;
}

function logRows(root) {
  return fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8').trim().split('\n')
    .filter(Boolean).map((line) => JSON.parse(line));
}

function snapshotTransactionTree(root) {
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  const snapshot = [];
  const visit = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const childRelative = relative ? path.join(relative, entry.name) : entry.name;
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        snapshot.push({ path: childRelative, type: 'directory' });
        visit(pathname, childRelative);
      } else {
        snapshot.push({
          path: childRelative,
          type: entry.isSymbolicLink() ? 'symlink' : 'file',
          bytes: entry.isSymbolicLink()
            ? Buffer.from(fs.readlinkSync(pathname)).toString('hex')
            : fs.readFileSync(pathname).toString('hex'),
        });
      }
    }
  };
  visit(transactions);
  return snapshot.sort((left, right) => left.path.localeCompare(right.path));
}

function createQuarantineOnlyResidue(root, kind) {
  const operationId = `cross-kind-${kind}-residue`;
  const owner = acquireLock({
    wikiRoot: root,
    operation: `cross-kind-${kind}-seed`,
    now: new Date('2026-07-11T03:00:00Z'),
  });
  let now;
  try {
    if (kind === 'promote') {
      fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), '2026-07-11T01:00:00Z\n');
      fs.writeFileSync(path.join(root, '.wiki-meta', '.last-scan'), '2026-07-11T00:00:00Z\n');
      assert.equal(scanWindow.promotePendingScan({
        wikiRoot: root,
        token: owner.token,
        expected: '2026-07-11T01:00:00Z',
        operationId,
        now: new Date('2026-07-11T03:00:00Z'),
        deadline: createDeadline({ budgetMs: 12_000 }),
      }).status, 'promoted');
    } else {
      fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), 'invalid\n');
      const plan = scanWindow.planScanWindowTransition({
        wikiRoot: root,
        kind: 'repair',
        pendingAfter: null,
        lastAfter: null,
      });
      assert.equal(scanWindow.applyScanWindowTransition({
        wikiRoot: root,
        token: owner.token,
        plan,
        operationId,
        deadline: createDeadline({ budgetMs: 12_000 }),
      }).status, 'repaired');
    }
    const journal = path.join(
      root, '.wiki-meta', '.transactions', operationId, 'journal.json',
    );
    now = repairClockFromJournal(journal);
    let reached = false;
    const seeded = scanWindow.pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 0,
      limit: 1,
      kinds: [kind],
      now,
      deadline: createDeadline({ budgetMs: 12_000 }),
      faultInjector(boundary, context) {
        if (boundary !== 'before-reservation-destination-link'
            || context?.operationId !== operationId) return;
        reached = true;
        const error = new Error(`stop after ${kind} quarantine publication`);
        error.code = 'DEADLINE_EXCEEDED';
        throw error;
      },
    });
    assert.equal(reached, true);
    // Residue of other kinds already in the store is deferred, not blocked, by this kind-filtered seed.
    assert.deepEqual({ ...seeded, deferred_count: 0 }, { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  const quarantines = fs.readdirSync(transactions)
    .filter((name) => name.startsWith(
      `.prune-${operationId.length}-${operationId}-`,
    ));
  assert.equal(quarantines.length, 1);
  return {
    operationId,
    now,
    quarantine: path.join(transactions, quarantines[0]),
  };
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('lint fix reports only reclaimed no-op ensure evidence and preserves unpromoted created evidence', () => {
  const root = wiki();
  const journals = createCompletedEnsurePair(root);
  const statuses = new Map(journals.map((journalPath) => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    return [journal.result_status, journal.operation_id];
  }));
  const result = fixWiki({ wikiRoot: root, now: repairClockFromJournal(journals) });
  assert.equal(result.status, 'fixed');
  assert.deepEqual(result.terminal_prune, {
    processed: 1,
    removed: [statuses.get('preserved')],
    complete: true,
    skipped_oversized: [],
    blocked: [],
    blocked_count: 0,
    blocked_truncated: false,
    deferred_count: 0,
  });
  assert.equal(completedEnsureCount(root), 1);
  assert.equal(fs.existsSync(path.join(
    root, '.wiki-meta', '.transactions', statuses.get('created'),
  )), true);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
});

test('lint fix aggregates ordinary and quarantined terminal cleanup without widening removed_junk', () => {
  const root = wiki();
  const interrupted = createQuarantineOnlyResidue(root, 'repair');
  fs.writeFileSync(path.join(interrupted.quarantine, '._finder'), 'appledouble\n');
  const ensureJournals = createCompletedEnsurePair(root);
  const ordinaryJournal = ensureJournals.find((journalPath) => (
    JSON.parse(fs.readFileSync(journalPath, 'utf8')).result_status === 'preserved'
  ));
  assert.ok(ordinaryJournal);
  const ordinaryId = path.basename(path.dirname(ordinaryJournal));
  fs.writeFileSync(path.join(path.dirname(ordinaryJournal), '.DS_Store'), 'finder\n');
  const now = repairClockFromJournal([...ensureJournals, path.join(
    interrupted.quarantine,
    'journal.json',
  )]);
  const result = fixWiki({ wikiRoot: root, now });
  assert.equal(result.status, 'fixed');
  assert.deepEqual([...result.terminal_prune.removed].sort(), [
    ordinaryId,
    interrupted.operationId,
  ].sort());
  assert.equal(result.terminal_prune.processed, 2);
  assert.equal(result.terminal_prune.complete, true);
  assert.deepEqual(result.removed_junk, []);
  assert.equal(result.removed_junk_complete, true);
  assert.equal(fs.existsSync(path.dirname(ordinaryJournal)), false);
  assert.equal(fs.existsSync(interrupted.quarantine), false);
});

test('lint repair carries either initially invalid marker as whole-pass ensure suppression', async (t) => {
  for (const markerName of ['.pending-scan', '.last-scan']) {
    await t.test(markerName, () => {
      const root = wiki();
      const journals = createCompletedEnsurePair(root);
      fs.writeFileSync(path.join(root, '.wiki-meta', markerName), 'invalid\n');
      const result = fixWiki({
        wikiRoot: root,
        now: repairClockFromJournal(journals),
      });
      assert.equal(result.status, 'fixed');
      assert.equal(completedEnsureCount(root), 2);
      assert.deepEqual(result.terminal_prune, {
        processed: 0,
        removed: [],
        complete: true,
        skipped_oversized: [],
        blocked: [],
        blocked_count: 0,
        blocked_truncated: false,
        deferred_count: 0,
        suppressed_reason: 'initial-invalid-scan-marker',
      });
    });
  }
});

test('lint repair canonicalizes its text predicate and reports sticky invalid-marker suppression', () => {
  const root = wiki();
  const journals = createCompletedEnsurePair(root);
  const statuses = new Map(journals.map((journalPath) => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    return [journal.result_status, journal.operation_id];
  }));
  const pending = path.join(root, '.wiki-meta', '.pending-scan');
  fs.writeFileSync(pending, ' 2026-07-11T01:00:00Z\n');
  const now = repairClockFromJournal(journals);

  const first = fixWiki({ wikiRoot: root, now });
  assert.equal(first.status, 'fixed');
  assert.equal(fs.existsSync(pending), false);
  assert.equal(completedEnsureCount(root), 2);
  assert.deepEqual(first.terminal_prune, {
    processed: 0,
    removed: [],
    complete: true,
    skipped_oversized: [],
    blocked: [],
    blocked_count: 0,
    blocked_truncated: false,
    deferred_count: 0,
    suppressed_reason: 'initial-invalid-scan-marker',
  });

  const second = fixWiki({ wikiRoot: root, now });
  assert.deepEqual(second.terminal_prune, {
    processed: 1,
    removed: [statuses.get('preserved')],
    complete: true,
    skipped_oversized: [],
    blocked: [],
    blocked_count: 0,
    blocked_truncated: false,
    deferred_count: 0,
  });
  assert.equal(completedEnsureCount(root), 1);
  assert.equal(fs.existsSync(path.join(
    root, '.wiki-meta', '.transactions', statuses.get('created'),
  )), true);
});

test('lint repair preserves a physically ambiguous invalid marker for stopped-host correction', () => {
  const root = wiki();
  const target = path.join(root, '.wiki-meta', 'hard-linked-invalid-marker');
  const pending = path.join(root, '.wiki-meta', '.pending-scan');
  fs.writeFileSync(target, 'invalid\n');
  fs.linkSync(target, pending);
  const before = fs.lstatSync(target, { bigint: true });

  const result = fixWiki({ wikiRoot: root });

  assert.equal(result.status, 'partial');
  assert.equal(fs.existsSync(pending), true);
  assert.equal(fs.readFileSync(pending, 'utf8'), 'invalid\n');
  const after = fs.lstatSync(target, { bigint: true });
  assert.equal(after.ino, before.ino);
  assert.equal(after.nlink, 2n);
  assert.deepEqual(result.terminal_prune, {
    processed: 0,
    removed: [],
    complete: true,
    skipped_oversized: [],
    blocked: [],
    blocked_count: 0,
    blocked_truncated: false,
    deferred_count: 0,
    suppressed_reason: 'initial-invalid-scan-marker',
  });
});

test('lint recovery preserves no-op ensure residue while either marker is invalid', () => {
  const root = wiki();
  const residue = createPreservedEnsureQuarantineResidue(root);
  fs.writeFileSync(path.join(root, '.wiki-meta', '.last-scan'), 'invalid\n');
  const before = snapshotTransactionTree(root);

  assert.throws(() => fixWiki({
    wikiRoot: root,
    now: residue.now,
  }), (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED'
    && /stopped-host/i.test(error.message));

  assert.deepEqual(snapshotTransactionTree(root), before);
  assert.equal(fs.existsSync(residue.quarantine), true);
  assert.equal(fs.existsSync(path.join(
    root,
    '.wiki-meta',
    '.transactions',
    residue.createdOperationId,
  )), true);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
});

test('lint recovery sends zero-progress unauthenticated prune residue to stopped-host repair', () => {
  const root = wiki();
  const quarantine = path.join(
    root,
    '.wiki-meta',
    '.transactions',
    '.prune-5-phase-debris',
  );
  fs.mkdirSync(quarantine);
  fs.writeFileSync(path.join(quarantine, 'evidence'), 'preserve\n');
  const before = snapshotTransactionTree(root);

  assert.throws(() => fixWiki({ wikiRoot: root }), (error) =>
    error.code === 'TRANSACTION_RECOVERY_REQUIRED'
    && /stopped-host/i.test(error.message));

  assert.deepEqual(snapshotTransactionTree(root), before);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
});

test('no-op ensure residue never reaches recovery deletion with an initially invalid marker', () => {
  const root = wiki();
  const residue = createPreservedEnsureQuarantineResidue(root);
  fs.writeFileSync(path.join(root, '.wiki-meta', '.last-scan'), 'invalid\n');
  const journalPath = path.join(residue.quarantine, 'journal.json');
  const journalBytes = fs.readFileSync(journalPath);
  const owner = acquireLock({
    wikiRoot: root,
    operation: 'initial-invalid-marker-residue',
    now: residue.now,
  });
  let reached = false;
  try {
    assert.throws(() => scanWindow.pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 0,
      limit: 1,
      kinds: ['ensure'],
      now: residue.now,
      deadline: createDeadline({ budgetMs: 12_000 }),
      resumableOnly: true,
      faultInjector(boundary, context) {
        if (boundary !== 'before-quarantined-journal-unlink'
            || context?.operationId !== residue.operationId) return;
        reached = true;
      },
    }), (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED'
      && error.ensurePruneProtected === true
      && /stopped-host/i.test(error.message));
    assert.equal(reached, false);
    assert.equal(fs.readFileSync(journalPath).equals(journalBytes), true);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('lint fix rejects every raw reservation-prune basename before generic debris mutation', async (t) => {
  const representations = [
    ['directory', (entry) => fs.mkdirSync(entry)],
    ['regular', (entry) => fs.writeFileSync(entry, 'legacy\n')],
    ['symlink', (entry, root) => {
      const target = path.join(root, 'legacy-target');
      fs.writeFileSync(target, 'legacy\n');
      fs.symlinkSync(target, entry);
    }],
    ['dangling symlink', (entry, root) =>
      fs.symlinkSync(path.join(root, 'missing-legacy-target'), entry)],
  ];
  for (const [name, create] of representations) {
    await t.test(name, () => {
      const root = wiki();
      const transactions = path.join(root, '.wiki-meta', '.transactions');
      const sibling = path.join(transactions, '.activate-removable-sibling');
      fs.mkdirSync(sibling);
      fs.writeFileSync(path.join(sibling, 'evidence'), 'must remain\n');
      create(path.join(
        transactions, `.reservation-.prune-malformed-${name}`,
      ), root);
      const before = fs.readdirSync(transactions, { recursive: true }).sort();
      assert.throws(() => fixWiki({ wikiRoot: root }), (error) =>
        error.code === 'TRANSACTION_RECOVERY_REQUIRED'
        && /stopped-host/i.test(error.message));
      assert.deepEqual(
        fs.readdirSync(transactions, { recursive: true }).sort(),
        before,
      );
      assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
    });
  }
});

test('lint fix recovers quarantine-only promote and repair residue before inspection', async (t) => {
  for (const kind of ['promote', 'repair']) {
    await t.test(kind, () => {
      const root = wiki();
      const residue = createQuarantineOnlyResidue(root, kind);
      const result = fixWiki({ wikiRoot: root, now: residue.now });
      assert.deepEqual(result.terminal_prune, {
        processed: 1,
        removed: [residue.operationId],
        complete: true,
        skipped_oversized: [],
        blocked: [],
        blocked_count: 0,
        blocked_truncated: false,
        deferred_count: 0,
      });
      assert.equal(fs.existsSync(residue.quarantine), false);
      assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
    });
  }
});

test('kind-filtered recovery ignores protected ensure quarantine residue', () => {
  const root = wiki();
  const ensure = createPreservedEnsureQuarantineResidue(root);
  const promoted = createQuarantineOnlyResidue(root, 'promote');
  const ensureBefore = snapshotTransactionTree(root)
    .filter((entry) => entry.path.startsWith(path.basename(ensure.quarantine)));
  const owner = acquireLock({
    wikiRoot: root,
    operation: 'kind-filtered-promote-recovery',
  });
  try {
    const result = scanWindow.pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 0,
      limit: 64,
      kinds: ['promote'],
      resumableOnly: true,
      suppressEnsurePrune: true,
      now: ensure.now,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(result, {
      processed: 1,
      removed: [promoted.operationId],
      complete: true,
      skipped_oversized: [],
      blocked: [],
      blocked_count: 0,
      blocked_truncated: false,
      deferred_count: 1,
    });
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assert.equal(fs.existsSync(promoted.quarantine), false);
  assert.equal(fs.existsSync(ensure.quarantine), true);
  assert.deepEqual(
    snapshotTransactionTree(root)
      .filter((entry) => entry.path.startsWith(path.basename(ensure.quarantine))),
    ensureBefore,
  );
});

test('cross-kind recovery rechecks writer authority after every shared destructive seam', async (t) => {
  const boundaries = [
    'before-reservation-destination-link',
    'before-reservation-staged-unlink',
    'before-quarantined-journal-unlink',
    'before-quarantined-backup-unlink',
    'before-quarantine-rmdir',
    'before-final-canonical-reservation-unlink',
  ];
  for (const kind of ['promote', 'repair']) {
    for (const boundary of boundaries) {
      await t.test(`${kind}: ${boundary}`, () => {
        const root = wiki();
        const residue = createQuarantineOnlyResidue(root, kind);
        const ownerPath = path.join(root, '.wiki-meta', '.wiki-lock', 'owner.json');
        const owner = acquireLock({
          wikiRoot: root,
          operation: `cross-kind-${kind}-${boundary}`,
          now: residue.now,
        });
        let ownerBytes;
        let atTakeover;
        let reached = false;
        try {
          assert.throws(() => scanWindow.pruneScanWindowTransactions({
            wikiRoot: root,
            token: owner.token,
            maxAgeDays: 0,
            limit: 1,
            resumableOnly: true,
            now: residue.now,
            deadline: createDeadline({ budgetMs: 12_000 }),
            faultInjector(actualBoundary, context) {
              if (reached || actualBoundary !== boundary
                  || context?.operationId !== residue.operationId) return;
              reached = true;
              atTakeover = snapshotTransactionTree(root);
              ownerBytes = fs.readFileSync(ownerPath);
              const record = JSON.parse(ownerBytes);
              fs.writeFileSync(ownerPath, `${JSON.stringify({
                ...record,
                token: 'c'.repeat(64),
              })}\n`);
            },
          }), (error) =>
            error.code === 'LOCK_TOKEN_MISMATCH'
            && error.terminal_prune?.processed === 0
            && error.terminal_prune?.complete === false);
          assert.equal(reached, true);
          assert.deepEqual(snapshotTransactionTree(root), atTakeover);
        } finally {
          if (ownerBytes) fs.writeFileSync(ownerPath, ownerBytes);
          releaseLock({ wikiRoot: root, token: owner.token });
        }
      });
    }
  }
});

test('lint fix forwards one original clock and deadline through its mandatory ensure tail', () => {
  const root = wiki();
  const now = new Date('2026-07-31T00:00:00Z');
  const deadline = createDeadline({ budgetMs: 12_000 });
  const calls = [];
  const original = scanWindow.pruneScanWindowTransactions;
  scanWindow.pruneScanWindowTransactions = (request) => {
    calls.push(request);
    return { processed: 0, removed: [], complete: true, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 };
  };
  try {
    const result = fixWiki({ wikiRoot: root, now, deadline });
    assert.equal(result.status, 'fixed');
  } finally {
    scanWindow.pruneScanWindowTransactions = original;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].wikiRoot, root);
  assert.equal(typeof calls[0].token, 'string');
  assert.equal(calls[0].now, now);
  assert.equal(calls[0].deadline, deadline);
  assert.equal(calls[0].maxAgeDays, 0);
  assert.equal(calls[0].limit, 64);
  assert.deepEqual(calls[0].kinds, ['ensure']);
  assert.equal(Object.hasOwn(calls[0], 'resumableOnly'), false);
  assert.equal(calls[0].suppressEnsurePrune, false);
});

test('fractional lint clock emits canonical seconds and same-second owners commit distinct identities', () => {
  const root = wiki();
  const journal = createCompletedEnsure(root);
  const canonical = repairClockFromJournal(journal);
  const now = new Date(canonical.getTime() + 321);
  const first = fixWiki({ wikiRoot: root, now });
  fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), 'invalid\n');
  const second = fixWiki({ wikiRoot: root, now });
  const rows = logRows(root).filter((row) => row.action === 'lint');
  assert.equal(first.status, 'fixed');
  assert.equal(second.status, 'fixed');
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ts, canonical.toISOString().replace('.000Z', 'Z'));
  assert.equal(rows[1].ts, rows[0].ts);
  assert.notEqual(first.committed.operationId, second.committed.operationId);
  assert.notEqual(first.committed.eventIds[0], second.committed.eventIds[0]);
});

test('zero-progress incomplete recovery preserves the initial diagnosis and exact continuation result', () => {
  const root = wiki();
  fs.writeFileSync(path.join(root, '.wiki-meta', '.transactions', 'blocking-entry'), 'blocked\n');
  const recovery = { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 };
  const original = scanWindow.pruneScanWindowTransactions;
  scanWindow.pruneScanWindowTransactions = () => recovery;
  try {
    assert.throws(() => fixWiki({ wikiRoot: root }), (error) =>
      error.code === 'TRANSACTION_RECOVERY_REQUIRED'
      && error.cause?.code === 'TRANSACTION_RECOVERY_REQUIRED'
      && error.terminal_prune === recovery
      && /recovery pass incomplete before inspection failed/.test(error.message));
  } finally {
    scanWindow.pruneScanWindowTransactions = original;
  }
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
  assert.equal(logRows(root).length, 0);
});

test('uncoded recovery failure falls back to FILESYSTEM and leaves the primary commit absent', () => {
  const root = wiki();
  fs.writeFileSync(path.join(root, '.wiki-meta', '.transactions', 'blocking-entry'), 'blocked\n');
  const injected = new Error('retained recovery failure');
  const original = scanWindow.pruneScanWindowTransactions;
  scanWindow.pruneScanWindowTransactions = () => { throw injected; };
  try {
    assert.throws(() => fixWiki({ wikiRoot: root }), (error) =>
      error.code === 'FILESYSTEM'
      && error.cause?.code === 'TRANSACTION_RECOVERY_REQUIRED'
      && /scan-window prune residue recovery failed: retained recovery failure/.test(error.message));
  } finally {
    scanWindow.pruneScanWindowTransactions = original;
  }
  assert.equal(logRows(root).length, 0);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
});

test('positive recovery and post-commit maintenance failure expose both truthful outcomes', () => {
  const root = wiki();
  const blocker = path.join(root, '.wiki-meta', '.transactions', 'blocking-entry');
  fs.writeFileSync(blocker, 'blocked\n');
  const recovery = { processed: 1, removed: ['blocking-entry'], complete: true, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 };
  const injected = Object.assign(new Error('tail failure'), { code: 'TEST_PRUNER_FAILURE' });
  let call = 0;
  const original = scanWindow.pruneScanWindowTransactions;
  scanWindow.pruneScanWindowTransactions = (request) => {
    call += 1;
    if (call === 1) {
      fs.rmSync(blocker);
      assert.equal(request.resumableOnly, true);
      assert.equal(Object.hasOwn(request, 'kinds'), false);
      return recovery;
    }
    assert.equal(request.limit, 63);
    assert.deepEqual(request.kinds, ['ensure']);
    throw injected;
  };
  try {
    assert.throws(() => fixWiki({ wikiRoot: root }), (error) =>
      error.code === 'LINT_MAINTENANCE_FAILED_AFTER_COMMIT'
      && error.cause === injected
      && error.terminal_prune !== recovery
      && assert.deepEqual(error.terminal_prune, {
        processed: 1,
        removed: ['blocking-entry'],
        complete: false,
        skipped_oversized: [],
        blocked: [],
        blocked_count: null,
        blocked_truncated: false,
        deferred_count: null,
      }) === undefined
      && error.lint_result?.status === 'fixed');
  } finally {
    scanWindow.pruneScanWindowTransactions = original;
  }
  assert.equal(logRows(root).filter((row) => row.action === 'lint').length, 1);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
});

test('lint CLI emits structured post-commit maintenance and release evidence', () => {
  const root = wiki();
  const injected = Object.assign(new Error('post-commit maintenance failed'), {
    code: 'LINT_MAINTENANCE_FAILED_AFTER_COMMIT',
    lint_result: { status: 'fixed', committed: true },
    terminal_prune: {
      processed: 1,
      removed: ['completed-operation'],
      complete: false,
    },
    release_error: Object.assign(new Error('lock release failed'), {
      code: 'LOCK_TOKEN_MISMATCH',
    }),
  });
  const originalFix = wikiState.fixWiki;
  const originalWrite = process.stderr.write;
  let stderr = '';
  wikiState.fixWiki = () => { throw injected; };
  process.stderr.write = (chunk) => {
    stderr += chunk;
    return true;
  };
  try {
    assert.equal(wikiRuntime.main([
      'lint', 'fix', '--wiki-root', root, '--json',
    ]), 5);
  } finally {
    wikiState.fixWiki = originalFix;
    process.stderr.write = originalWrite;
  }
  assert.deepEqual(JSON.parse(stderr), {
    code: 'LINT_MAINTENANCE_FAILED_AFTER_COMMIT',
    message: 'post-commit maintenance failed',
    lint_result: { status: 'fixed', committed: true },
    terminal_prune: {
      processed: 1,
      removed: ['completed-operation'],
      complete: false,
    },
    release_error: {
      code: 'LOCK_TOKEN_MISMATCH',
      message: 'lock release failed',
    },
  });
});

test('post-commit owner-fence failure preserves prior same-pass prune progress', () => {
  const root = wiki();
  const journals = createCompletedEnsures(root, [
    { operationId: 'z-created-owner-fence', proposed: '2026-07-11T01:00:00Z' },
    { operationId: 'a-preserved-owner-fence', proposed: '2026-07-11T02:00:00Z' },
    { operationId: 'b-preserved-owner-fence', proposed: '2026-07-11T02:00:00Z' },
  ]);
  const injected = Object.assign(new Error('owner fence changed after prior prune'), {
    code: 'LOCK_TOKEN_MISMATCH',
  });
  const original = scanWindow.pruneScanWindowTransactions;
  scanWindow.pruneScanWindowTransactions = (request) => original({
    ...request,
    faultInjector(boundary, context) {
      if (boundary === 'before-transaction-quarantine-rename'
          && context?.operationId === 'b-preserved-owner-fence') {
        throw injected;
      }
    },
  });
  try {
    assert.throws(() => fixWiki({
      wikiRoot: root,
      now: repairClockFromJournal(journals.map((entry) => entry.path)),
    }), (error) =>
      error.code === 'LINT_MAINTENANCE_FAILED_AFTER_COMMIT'
      && error.cause === injected
      && error.lint_result?.status === 'fixed'
      && error.terminal_prune?.processed === 1
      && error.terminal_prune?.complete === false
      && assert.deepEqual(
        error.terminal_prune.removed,
        ['a-preserved-owner-fence'],
      ) === undefined);
  } finally {
    scanWindow.pruneScanWindowTransactions = original;
  }
  assert.equal(completedEnsureCount(root), 2);
  assert.equal(logRows(root).filter((row) => row.action === 'lint').length, 1);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
});

test('lock release failure cannot mask committed lint and terminal prune progress', () => {
  const root = wiki();
  const journals = createCompletedEnsurePair(root);
  const preserved = journals.map((journalPath) =>
    JSON.parse(fs.readFileSync(journalPath, 'utf8')))
    .find((journal) => journal.result_status === 'preserved');
  const ownerPath = path.join(root, '.wiki-meta', '.wiki-lock', 'owner.json');
  const original = scanWindow.pruneScanWindowTransactions;
  let ownerBytes;
  let owner;
  scanWindow.pruneScanWindowTransactions = (request) => original({
    ...request,
    faultInjector(boundary, context) {
      if (boundary !== 'after-final-canonical-reservation-unlink'
          || context?.operationId !== preserved.operation_id) return;
      ownerBytes = fs.readFileSync(ownerPath);
      owner = JSON.parse(ownerBytes);
      fs.writeFileSync(ownerPath, `${JSON.stringify({
        ...owner,
        token: 'b'.repeat(64),
      })}\n`);
    },
  });
  try {
    assert.throws(() => fixWiki({
      wikiRoot: root,
      now: repairClockFromJournal(journals),
    }), (error) =>
      error.code === 'LINT_MAINTENANCE_FAILED_AFTER_COMMIT'
      && error.cause?.code === 'LOCK_TOKEN_MISMATCH'
      && error.release_error?.code === 'LOCK_TOKEN_MISMATCH'
      && error.lint_result?.status === 'fixed'
      && error.terminal_prune?.processed === 1
      && error.terminal_prune?.complete === false
      && assert.deepEqual(
        error.terminal_prune.removed,
        [preserved.operation_id],
      ) === undefined);
  } finally {
    scanWindow.pruneScanWindowTransactions = original;
    if (ownerBytes) {
      fs.writeFileSync(ownerPath, ownerBytes);
      releaseLock({ wikiRoot: root, token: owner.token });
    }
  }
  assert.equal(logRows(root).filter((row) => row.action === 'lint').length, 1);
  assert.equal(completedEnsureCount(root), 1);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
});

test('direct pre-delete owner fences preserve prior same-pass prune progress', async (t) => {
  await t.test('ordinary cleaned transaction', () => {
    const root = wiki();
    const journals = createCompletedEnsures(root, [
      { operationId: 'z-owner-ordinary', proposed: '2026-07-11T01:00:00Z' },
      { operationId: 'a-owner-ordinary', proposed: '2026-07-11T02:00:00Z' },
      { operationId: 'b-owner-ordinary', proposed: '2026-07-11T02:00:00Z' },
    ]);
    const injected = Object.assign(new Error('ordinary direct owner fence'), {
      code: 'LOCK_TOKEN_MISMATCH',
    });
    const owner = acquireLock({ wikiRoot: root, operation: 'ordinary-direct-owner' });
    try {
      assert.throws(() => scanWindow.pruneScanWindowTransactions({
        wikiRoot: root,
        token: owner.token,
        maxAgeDays: 0,
        limit: 64,
        kinds: ['ensure'],
        now: repairClockFromJournal(journals.map((entry) => entry.path)),
        deadline: createDeadline({ budgetMs: 12_000 }),
        faultInjector(boundary, context) {
          if (boundary === 'before-cleaned-transaction-owner-check'
              && context?.operationId === 'b-owner-ordinary') throw injected;
        },
      }), (error) => error === injected
        && error.terminal_prune?.processed === 1
        && error.terminal_prune?.complete === false
        && assert.deepEqual(
          error.terminal_prune.removed,
          ['a-owner-ordinary'],
        ) === undefined);
    } finally {
      releaseLock({ wikiRoot: root, token: owner.token });
    }
  });

  await t.test('canonical reservation-only residue', () => {
    const root = wiki();
    const initial = createCompletedEnsures(root, [
      { operationId: 'z-owner-reservation', proposed: '2026-07-11T01:00:00Z' },
      { operationId: 'b-owner-reservation', proposed: '2026-07-11T02:00:00Z' },
    ]);
    const seedOwner = acquireLock({ wikiRoot: root, operation: 'reservation-seed' });
    const seedNow = repairClockFromJournal(initial.map((entry) => entry.path));
    try {
      const seeded = scanWindow.pruneScanWindowTransactions({
        wikiRoot: root,
        token: seedOwner.token,
        maxAgeDays: 0,
        limit: 1,
        kinds: ['ensure'],
        now: seedNow,
        deadline: createDeadline({ budgetMs: 12_000 }),
        faultInjector(boundary, context) {
          if (boundary !== 'before-final-canonical-reservation-unlink'
              || context?.operationId !== 'b-owner-reservation') return;
          const error = new Error('leave canonical reservation-only residue');
          error.code = 'DEADLINE_EXCEEDED';
          throw error;
        },
      });
      assert.deepEqual(seeded, { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
    } finally {
      releaseLock({ wikiRoot: root, token: seedOwner.token });
    }
    const [ordinary] = createCompletedEnsures(root, [{
      operationId: 'a-owner-reservation',
      proposed: '2026-07-11T02:00:00Z',
    }]);
    assert.equal(ordinary.resultStatus, 'preserved');
    const injected = Object.assign(new Error('reservation direct owner fence'), {
      code: 'LOCK_TOKEN_MISMATCH',
    });
    const owner = acquireLock({ wikiRoot: root, operation: 'reservation-direct-owner' });
    try {
      assert.throws(() => scanWindow.pruneScanWindowTransactions({
        wikiRoot: root,
        token: owner.token,
        maxAgeDays: 0,
        limit: 64,
        kinds: ['ensure'],
        now: repairClockFromJournal(ordinary.path),
        deadline: createDeadline({ budgetMs: 12_000 }),
        faultInjector(boundary, context) {
          if (boundary === 'before-canonical-reservation-only-owner-check'
              && context?.operationId === 'b-owner-reservation') throw injected;
        },
      }), (error) => error === injected
        && error.terminal_prune?.processed === 1
        && error.terminal_prune?.complete === false
        && assert.deepEqual(
          error.terminal_prune.removed,
          ['a-owner-reservation'],
        ) === undefined);
    } finally {
      releaseLock({ wikiRoot: root, token: owner.token });
    }
  });

  await t.test('journal-bearing quarantine residue', () => {
    const root = wiki();
    const promoted = createQuarantineOnlyResidue(root, 'promote');
    const ensureJournals = createCompletedEnsures(root, [
      {
        operationId: 'zzzz-created-owner-evidence',
        proposed: '2026-07-11T02:00:00Z',
      },
      {
        operationId: 'zross-kind-ensurex-residue',
        proposed: '2026-07-11T02:00:00Z',
      },
    ]);
    const seedOwner = acquireLock({ wikiRoot: root, operation: 'quarantine-seed' });
    const seedNow = repairClockFromJournal(
      ensureJournals.map((entry) => entry.path),
    );
    try {
      const seeded = scanWindow.pruneScanWindowTransactions({
        wikiRoot: root,
        token: seedOwner.token,
        maxAgeDays: 0,
        limit: 1,
        kinds: ['ensure'],
        now: seedNow,
        deadline: createDeadline({ budgetMs: 12_000 }),
        faultInjector(boundary, context) {
          if (boundary !== 'before-reservation-destination-link'
              || context?.operationId !== 'zross-kind-ensurex-residue') return;
          const error = new Error('leave second journal-bearing quarantine');
          error.code = 'DEADLINE_EXCEEDED';
          throw error;
        },
      });
      assert.deepEqual(seeded, { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 1 });
    } finally {
      releaseLock({ wikiRoot: root, token: seedOwner.token });
    }
    const injected = Object.assign(new Error('quarantine direct owner fence'), {
      code: 'LOCK_TOKEN_MISMATCH',
    });
    const owner = acquireLock({ wikiRoot: root, operation: 'quarantine-direct-owner' });
    try {
      assert.throws(() => scanWindow.pruneScanWindowTransactions({
        wikiRoot: root,
        token: owner.token,
        maxAgeDays: 0,
        limit: 64,
        resumableOnly: true,
        now: seedNow,
        deadline: createDeadline({ budgetMs: 12_000 }),
        faultInjector(boundary, context) {
          if (boundary === 'before-quarantine-owner-check'
              && context?.operationId === 'zross-kind-ensurex-residue') {
            throw injected;
          }
        },
      }), (error) => error === injected
        && error.terminal_prune?.processed === 1
        && error.terminal_prune?.complete === false
        && assert.deepEqual(
          error.terminal_prune.removed,
          [promoted.operationId],
        ) === undefined,
      'empty quarantine owner fence must propagate after prior prune progress');
    } finally {
      releaseLock({ wikiRoot: root, token: owner.token });
    }
  });

  await t.test('empty quarantine residue', () => {
    const root = wiki();
    const promoted = createQuarantineOnlyResidue(root, 'promote');
    const promoteOwner = acquireLock({
      wikiRoot: root,
      operation: 'empty-promote-quarantine-seed',
    });
    try {
      const seeded = scanWindow.pruneScanWindowTransactions({
        wikiRoot: root,
        token: promoteOwner.token,
        maxAgeDays: 0,
        limit: 1,
        kinds: ['promote'],
        resumableOnly: true,
        now: promoted.now,
        deadline: createDeadline({ budgetMs: 12_000 }),
        faultInjector(boundary, context) {
          if (boundary !== 'before-quarantine-rmdir'
              || context?.operationId !== promoted.operationId) return;
          const error = new Error('leave first empty quarantine');
          error.code = 'DEADLINE_EXCEEDED';
          throw error;
        },
      });
      assert.deepEqual(seeded, { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
    } finally {
      releaseLock({ wikiRoot: root, token: promoteOwner.token });
    }
    const ensureJournals = createCompletedEnsures(root, [
      {
        operationId: 'zzzz-created-empty-evidence',
        proposed: '2026-07-11T02:00:00Z',
      },
      {
        operationId: 'zross-kind-ensurex-residue',
        proposed: '2026-07-11T02:00:00Z',
      },
    ]);
    const seedNow = repairClockFromJournal(
      ensureJournals.map((entry) => entry.path),
    );
    const ensureOwner = acquireLock({
      wikiRoot: root,
      operation: 'empty-ensure-quarantine-seed',
    });
    try {
      const seeded = scanWindow.pruneScanWindowTransactions({
        wikiRoot: root,
        token: ensureOwner.token,
        maxAgeDays: 0,
        limit: 1,
        kinds: ['ensure'],
        now: seedNow,
        deadline: createDeadline({ budgetMs: 12_000 }),
        faultInjector(boundary, context) {
          if (boundary !== 'before-quarantine-rmdir'
              || context?.operationId !== 'zross-kind-ensurex-residue') return;
          const error = new Error('leave second empty quarantine');
          error.code = 'DEADLINE_EXCEEDED';
          throw error;
        },
      });
      assert.deepEqual(seeded, { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 1 });
    } finally {
      releaseLock({ wikiRoot: root, token: ensureOwner.token });
    }
    const injected = Object.assign(new Error('empty quarantine direct owner fence'), {
      code: 'LOCK_TOKEN_MISMATCH',
    });
    const owner = acquireLock({ wikiRoot: root, operation: 'empty-direct-owner' });
    try {
      assert.throws(() => scanWindow.pruneScanWindowTransactions({
        wikiRoot: root,
        token: owner.token,
        maxAgeDays: 0,
        limit: 64,
        resumableOnly: true,
        now: seedNow,
        deadline: createDeadline({ budgetMs: 12_000 }),
        faultInjector(boundary, context) {
          if (boundary === 'before-empty-quarantine-owner-check'
              && context?.operationId === 'zross-kind-ensurex-residue') {
            throw injected;
          }
        },
      }), (error) => error === injected
        && error.terminal_prune?.processed === 1
        && error.terminal_prune?.complete === false
        && assert.deepEqual(
          error.terminal_prune.removed,
          [promoted.operationId],
        ) === undefined);
    } finally {
      releaseLock({ wikiRoot: root, token: owner.token });
    }
  });
});

test('post-final-unlink fences report the current committed prune', async (t) => {
  const faultKinds = [
    ['deadline', 'DEADLINE_EXCEEDED'],
    ['owner', 'LOCK_TOKEN_MISMATCH'],
  ];
  const assertOutcome = (run, faultKind, injected, operationId) => {
    if (faultKind === 'deadline') {
      assert.deepEqual(run(), {
        processed: 1,
        removed: [operationId],
        complete: false,
        skipped_oversized: [],
        blocked: [],
        blocked_count: 0,
        blocked_truncated: false,
        deferred_count: 0,
      });
      return;
    }
    assert.throws(run, (error) => error === injected
      && error.terminal_prune?.processed === 1
      && error.terminal_prune?.complete === false
      && assert.deepEqual(error.terminal_prune.removed, [operationId]) === undefined);
  };

  for (const [faultKind, code] of faultKinds) {
    await t.test(`ordinary cleaned transaction: ${faultKind}`, () => {
      const root = wiki();
      const operationId = `a-post-unlink-ordinary-${faultKind}`;
      const journals = createCompletedEnsures(root, [
        { operationId: `z-post-unlink-created-${faultKind}` },
        { operationId, proposed: '2026-07-11T02:00:00Z' },
      ]);
      const injected = Object.assign(new Error(`ordinary ${faultKind} after unlink`), {
        code,
      });
      const owner = acquireLock({ wikiRoot: root, operation: `ordinary-${faultKind}` });
      try {
        assertOutcome(() => scanWindow.pruneScanWindowTransactions({
          wikiRoot: root,
          token: owner.token,
          maxAgeDays: 0,
          limit: 64,
          kinds: ['ensure'],
          now: repairClockFromJournal(journals.map((entry) => entry.path)),
          deadline: createDeadline({ budgetMs: 12_000 }),
          faultInjector(boundary, context) {
            if (boundary === 'after-final-canonical-reservation-unlink'
                && context?.operationId === operationId) throw injected;
          },
        }), faultKind, injected, operationId);
      } finally {
        releaseLock({ wikiRoot: root, token: owner.token });
      }
    });

    await t.test(`journal-bearing quarantine: ${faultKind}`, () => {
      const root = wiki();
      const residue = createQuarantineOnlyResidue(root, 'promote');
      const injected = Object.assign(new Error(`quarantine ${faultKind} after unlink`), {
        code,
      });
      const owner = acquireLock({ wikiRoot: root, operation: `quarantine-${faultKind}` });
      try {
        assertOutcome(() => scanWindow.pruneScanWindowTransactions({
          wikiRoot: root,
          token: owner.token,
          maxAgeDays: 0,
          limit: 64,
          kinds: ['promote'],
          resumableOnly: true,
          now: residue.now,
          deadline: createDeadline({ budgetMs: 12_000 }),
          faultInjector(boundary, context) {
            if (boundary === 'after-final-canonical-reservation-unlink'
                && context?.operationId === residue.operationId) throw injected;
          },
        }), faultKind, injected, residue.operationId);
      } finally {
        releaseLock({ wikiRoot: root, token: owner.token });
      }
    });

    await t.test(`empty quarantine: ${faultKind}`, () => {
      const root = wiki();
      const residue = createQuarantineOnlyResidue(root, 'promote');
      const seedOwner = acquireLock({
        wikiRoot: root,
        operation: `empty-quarantine-seed-${faultKind}`,
      });
      try {
        const seeded = scanWindow.pruneScanWindowTransactions({
          wikiRoot: root,
          token: seedOwner.token,
          maxAgeDays: 0,
          limit: 64,
          kinds: ['promote'],
          resumableOnly: true,
          now: residue.now,
          deadline: createDeadline({ budgetMs: 12_000 }),
          faultInjector(boundary, context) {
            if (boundary !== 'before-quarantine-rmdir'
                || context?.operationId !== residue.operationId) return;
            const error = new Error('leave empty quarantine after evidence cleanup');
            error.code = 'DEADLINE_EXCEEDED';
            throw error;
          },
        });
        assert.deepEqual(seeded, { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
      } finally {
        releaseLock({ wikiRoot: root, token: seedOwner.token });
      }
      const injected = Object.assign(new Error(`empty ${faultKind} after unlink`), {
        code,
      });
      const owner = acquireLock({ wikiRoot: root, operation: `empty-${faultKind}` });
      try {
        assertOutcome(() => scanWindow.pruneScanWindowTransactions({
          wikiRoot: root,
          token: owner.token,
          maxAgeDays: 0,
          limit: 64,
          kinds: ['promote'],
          resumableOnly: true,
          now: residue.now,
          deadline: createDeadline({ budgetMs: 12_000 }),
          faultInjector(boundary, context) {
            if (boundary === 'after-empty-quarantine-reservation-unlink'
                && context?.operationId === residue.operationId) throw injected;
          },
        }), faultKind, injected, residue.operationId);
      } finally {
        releaseLock({ wikiRoot: root, token: owner.token });
      }
    });

    await t.test(`canonical reservation-only: ${faultKind}`, () => {
      const root = wiki();
      const operationId = `a-post-unlink-reservation-${faultKind}`;
      const journals = createCompletedEnsures(root, [
        { operationId: `z-post-unlink-reservation-created-${faultKind}` },
        { operationId, proposed: '2026-07-11T02:00:00Z' },
      ]);
      const now = repairClockFromJournal(journals.map((entry) => entry.path));
      const seedOwner = acquireLock({
        wikiRoot: root,
        operation: `reservation-only-seed-${faultKind}`,
      });
      try {
        const seeded = scanWindow.pruneScanWindowTransactions({
          wikiRoot: root,
          token: seedOwner.token,
          maxAgeDays: 0,
          limit: 64,
          kinds: ['ensure'],
          now,
          deadline: createDeadline({ budgetMs: 12_000 }),
          faultInjector(boundary, context) {
            if (boundary !== 'before-final-canonical-reservation-unlink'
                || context?.operationId !== operationId) return;
            const error = new Error('leave canonical reservation-only residue');
            error.code = 'DEADLINE_EXCEEDED';
            throw error;
          },
        });
        assert.deepEqual(seeded, { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
      } finally {
        releaseLock({ wikiRoot: root, token: seedOwner.token });
      }
      const injected = Object.assign(new Error(`reservation ${faultKind} after unlink`), {
        code,
      });
      const owner = acquireLock({ wikiRoot: root, operation: `reservation-${faultKind}` });
      try {
        assertOutcome(() => scanWindow.pruneScanWindowTransactions({
          wikiRoot: root,
          token: owner.token,
          maxAgeDays: 0,
          limit: 64,
          kinds: ['ensure'],
          now,
          deadline: createDeadline({ budgetMs: 12_000 }),
          faultInjector(boundary, context) {
            if (boundary === 'after-canonical-reservation-only-unlink'
                && context?.operationId === operationId) throw injected;
          },
        }), faultKind, injected, operationId);
      } finally {
        releaseLock({ wikiRoot: root, token: owner.token });
      }
    });
  }
});

test('late protected ensure boundary reports prior same-invocation prune progress', () => {
  const root = wiki();
  const journals = createCompletedEnsures(root, [
    { operationId: 'z-created-progress', proposed: '2026-07-11T01:00:00Z' },
    { operationId: 'a-preserved-progress', proposed: '2026-07-11T02:00:00Z' },
    { operationId: 'b-preserved-progress', proposed: '2026-07-11T02:00:00Z' },
  ]);
  assert.deepEqual(
    journals.map((entry) => entry.resultStatus),
    ['created', 'preserved', 'preserved'],
  );
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  const marker = path.join(root, '.wiki-meta', '.pending-scan');
  const held = path.join(root, '.wiki-meta', '.pending-scan.progress-held');
  const owner = acquireLock({ wikiRoot: root, operation: 'progress-prune' });
  let boundarySnapshot;
  try {
    assert.throws(() => scanWindow.pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 0,
      limit: 64,
      kinds: ['ensure'],
      now: repairClockFromJournal(journals.map((entry) => entry.path)),
      deadline: createDeadline({ budgetMs: 12_000 }),
      faultInjector(boundary, context) {
        if (boundary !== 'before-transaction-quarantine-rename'
            || context?.operationId !== 'b-preserved-progress') return;
        boundarySnapshot = fs.readdirSync(transactions, { recursive: true }).sort();
        const bytes = fs.readFileSync(marker);
        fs.renameSync(marker, held);
        fs.writeFileSync(marker, bytes);
      },
    }), (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED'
      && error.ensurePruneProtected === true
      && error.terminal_prune?.processed === 1
      && error.terminal_prune?.complete === false
      && assert.deepEqual(error.terminal_prune.removed, ['a-preserved-progress']) === undefined);
    assert.deepEqual(
      fs.readdirSync(transactions, { recursive: true }).sort(),
      boundarySnapshot,
    );
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('lint recovery plus ordinary tail share one aggregate limit of 64 real transitions', () => {
  const root = wiki();
  const preservedIds = Array.from(
    { length: 64 },
    (_, index) => `a-preserved-${String(index).padStart(3, '0')}`,
  );
  const journals = createCompletedEnsures(root, [
    { operationId: 'z-created-aggregate', proposed: '2026-07-11T01:00:00Z' },
    ...preservedIds.map((operationId) => ({
      operationId,
      proposed: '2026-07-11T02:00:00Z',
    })),
  ]);
  assert.deepEqual(
    journals.map((entry) => entry.resultStatus),
    ['created', ...Array(64).fill('preserved')],
  );
  const now = repairClockFromJournal(journals.map((entry) => entry.path));
  const owner = acquireLock({ wikiRoot: root, operation: 'aggregate-residue-seed' });
  let residueCreated = false;
  try {
    const seeded = scanWindow.pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 0,
      limit: 1,
      kinds: ['ensure'],
      now,
      deadline: createDeadline({ budgetMs: 12_000 }),
      faultInjector(boundary) {
        if (residueCreated || boundary !== 'before-quarantined-journal-unlink') return;
        residueCreated = true;
        const error = new Error('stop after authenticated residue publication');
        error.code = 'DEADLINE_EXCEEDED';
        throw error;
      },
    });
    assert.equal(residueCreated, true);
    assert.deepEqual(seeded, { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  const first = fixWiki({ wikiRoot: root, now });
  assert.deepEqual(first.terminal_prune, {
    processed: 64,
    removed: preservedIds,
    complete: false,
    skipped_oversized: [],
    blocked: [],
    blocked_count: 0,
    blocked_truncated: false,
    deferred_count: 0,
  });
  assert.equal(completedEnsureCount(root), 1);

  const second = fixWiki({ wikiRoot: root, now });
  assert.deepEqual(second.terminal_prune, {
    processed: 0,
    removed: [],
    complete: true,
    skipped_oversized: [],
    blocked: [],
    blocked_count: 0,
    blocked_truncated: false,
    deferred_count: 0,
  });
  assert.equal(completedEnsureCount(root), 1);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
});
