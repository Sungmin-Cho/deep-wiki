'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');

const repoRoot = path.resolve(__dirname, '..');
const scanWindowPath = path.join(repoRoot, 'hooks', 'scripts', 'runtime', 'scan-window.js');
const lockPath = path.join(repoRoot, 'hooks', 'scripts', 'runtime', 'lock.js');
const deadlinePath = path.join(repoRoot, 'hooks', 'scripts', 'runtime', 'deadline.js');
const parentGuardPath = path.join(
  repoRoot,
  'hooks',
  'scripts',
  'runtime',
  'scan-window-parent-guard.js',
);
const cliPath = path.join(repoRoot, 'scripts', 'wiki-runtime.js');
const racer = path.join(__dirname, 'fixtures', 'scan-window-racer.js');
const roots = new Set();

const T0 = '2026-07-11T00:00:00Z';
const T1 = '2026-07-11T01:00:00Z';
const T2 = '2026-07-11T02:00:00Z';
const T3 = '2026-07-11T03:00:00Z';

function modules() {
  return {
    ...require(scanWindowPath),
    ...require(lockPath),
    ...require(deadlinePath),
  };
}

function temporaryWiki(prefix = 'deep wiki scan window path with spaces ') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.add(root);
  fs.mkdirSync(path.join(root, '.wiki-meta', '.transactions'), { recursive: true });
  return root;
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function metaPath(root, name) {
  return path.join(root, '.wiki-meta', name);
}

function replaceLiveLockExternallyAtInjectedGuard(root) {
  fs.rmSync(metaPath(root, '.wiki-lock'), { recursive: true });
}

function outerPruneRoot({ withTransactions = true } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(
    path.join(os.tmpdir(), 'deep wiki outer prune red '),
  ));
  roots.add(root);
  fs.mkdirSync(metaPath(root, ''), { recursive: true });
  if (withTransactions) fs.mkdirSync(metaPath(root, '.transactions'));
  return root;
}

function releaseOuterPruneLockIfPresent(root, token) {
  if (!fs.existsSync(metaPath(root, '.wiki-lock'))) return;
  modules().releaseLock({ wikiRoot: root, token });
}

function replaceOuterPruneMeta(root, { withTransactions = false, transplantTransactions = false } = {}) {
  const meta = metaPath(root, '');
  const displaced = path.join(root, '.wiki-meta.displaced');
  fs.renameSync(meta, displaced);
  fs.mkdirSync(meta);
  fs.cpSync(path.join(displaced, '.wiki-lock'), metaPath(root, '.wiki-lock'), { recursive: true });
  if (transplantTransactions) {
    fs.renameSync(path.join(displaced, '.transactions'), metaPath(root, '.transactions'));
  } else if (withTransactions) {
    fs.mkdirSync(metaPath(root, '.transactions'));
  }
}

function replaceOuterPruneTransactions(root) {
  const transactions = metaPath(root, '.transactions');
  fs.renameSync(transactions, `${transactions}.displaced`);
  fs.mkdirSync(transactions);
}

function pruneOuterObservation(root, token, deadline = modules().createDeadline({ budgetMs: 12_000 })) {
  return modules().pruneScanWindowTransactions({
    wikiRoot: root,
    token,
    maxAgeDays: 0,
    limit: 1,
    now: new Date(T3),
    deadline,
  });
}


function blockedSummary(result) {
  return { ...result, blocked: result.blocked.map((entry) => `${entry.stage}:${entry.reason}`) };
}

test('OUTER-PRUNE-1 Case 01 missing child appearance is not complete', () => {
  const root = outerPruneRoot({ withTransactions: false });
  const transactions = metaPath(root, '.transactions');
  const owner = modules().acquireLock({ wikiRoot: root, operation: 'outer-prune-case-01' });
  const originalLstat = fs.lstatSync;
  let matchingCalls = 0;
  let injected = false;
  fs.lstatSync = (pathname, ...args) => {
    if (path.resolve(String(pathname)) !== path.resolve(transactions)) {
      return originalLstat(pathname, ...args);
    }
    matchingCalls += 1;
    let observed;
    let observationError;
    try { observed = originalLstat(pathname, ...args); }
    catch (error) { observationError = error; }
    if (matchingCalls === 2) {
      fs.mkdirSync(transactions);
      injected = true;
    }
    if (observationError) throw observationError;
    return observed;
  };
  try {
    assert.throws(() => pruneOuterObservation(root, owner.token), (error) => (
      error.code === 'TRANSACTION_RECOVERY_REQUIRED'
        && error.message === '.wiki-meta/.transactions appeared after a missing-store observation'
    ));
    assert.equal(injected, true);
    assert.equal(matchingCalls, 3);
  } finally {
    fs.lstatSync = originalLstat;
    releaseOuterPruneLockIfPresent(root, owner.token);
  }
});

test('OUTER-PRUNE-1 Case 02 missing child parent generation replacement is rejected', () => {
  const root = outerPruneRoot({ withTransactions: false });
  const transactions = metaPath(root, '.transactions');
  const owner = modules().acquireLock({ wikiRoot: root, operation: 'outer-prune-case-02' });
  const originalLstat = fs.lstatSync;
  let matchingCalls = 0;
  let injected = false;
  let replacementCompleted = false;
  fs.lstatSync = (pathname, ...args) => {
    if (path.resolve(String(pathname)) !== path.resolve(transactions)) {
      return originalLstat(pathname, ...args);
    }
    matchingCalls += 1;
    let observed;
    let observationError;
    try { observed = originalLstat(pathname, ...args); }
    catch (error) { observationError = error; }
    if (matchingCalls === 2) {
      replaceOuterPruneMeta(root, { withTransactions: true });
      injected = true;
      replacementCompleted = true;
    }
    if (observationError) throw observationError;
    return observed;
  };
  try {
    assert.throws(() => pruneOuterObservation(root, owner.token), (error) => (
      error.code === 'SCAN_WINDOW_FILESYSTEM'
        && error.message === '.wiki-meta directory identity changed after transaction-store observation'
    ));
    assert.equal(injected, true);
    assert.equal(replacementCompleted, true);
    assert.equal(matchingCalls, 2);
  } finally {
    fs.lstatSync = originalLstat;
    releaseOuterPruneLockIfPresent(root, owner.token);
  }
});

test('OUTER-PRUNE-1 Case 03 missing child closing identity error is reached', () => {
  const root = outerPruneRoot({ withTransactions: false });
  const transactions = metaPath(root, '.transactions');
  const owner = modules().acquireLock({ wikiRoot: root, operation: 'outer-prune-case-03' });
  const originalLstat = fs.lstatSync;
  let matchingCalls = 0;
  let injected = false;
  fs.lstatSync = (pathname, ...args) => {
    if (path.resolve(String(pathname)) !== path.resolve(transactions)) {
      return originalLstat(pathname, ...args);
    }
    matchingCalls += 1;
    if (matchingCalls === 3) {
      injected = true;
      throw Object.assign(new Error('closing child denied'), { code: 'EACCES' });
    }
    return originalLstat(pathname, ...args);
  };
  try {
    let observedError = null;
    try { pruneOuterObservation(root, owner.token); }
    catch (error) { observedError = error; }
    assert.ok(
      injected,
      `Case 03 closing-child injection was not reached; matchingCalls=${matchingCalls}`,
    );
    assert.ok(
      observedError
        && observedError.code === 'SCAN_WINDOW_FILESYSTEM'
        && observedError.message === '.wiki-meta/.transactions directory identity is unavailable',
      `Case 03 observed ${observedError?.code || 'no error'}: ${observedError?.message || 'complete return'}`,
    );
  } finally {
    fs.lstatSync = originalLstat;
    releaseOuterPruneLockIfPresent(root, owner.token);
  }
});

test('OUTER-PRUNE-1 Case 03b closing physical path error outranks deferred enumeration', () => {
  const root = outerPruneRoot();
  const transactions = metaPath(root, '.transactions');
  const owner = modules().acquireLock({ wikiRoot: root, operation: 'outer-prune-case-03b' });
  const originalLstat = fs.lstatSync;
  const originalRealpath = fs.realpathSync.native;
  const originalReaddir = fs.readdirSync;
  let matchingRealpaths = 0;
  let matchingReads = 0;
  let realpathInjected = false;
  let enumerationInjected = false;
  fs.realpathSync.native = (pathname, ...args) => {
    if (path.resolve(String(pathname)) !== path.resolve(transactions)) {
      return originalRealpath(pathname, ...args);
    }
    matchingRealpaths += 1;
    if (matchingRealpaths === 4) {
      realpathInjected = true;
      throw Object.assign(new Error('closing physical path denied'), { code: 'EACCES' });
    }
    return originalRealpath(pathname, ...args);
  };
  fs.readdirSync = (pathname, ...args) => {
    if (path.resolve(String(pathname)) === path.resolve(transactions)) {
      matchingReads += 1;
      if (matchingReads === 2) {
        enumerationInjected = true;
        throw Object.assign(new Error('enumerated child disappeared'), { code: 'ENOENT' });
      }
    }
    return originalReaddir(pathname, ...args);
  };
  try {
    let observedError = null;
    try { pruneOuterObservation(root, owner.token); }
    catch (error) { observedError = error; }
    assert.ok(
      realpathInjected
        && observedError?.code === 'SCAN_WINDOW_FILESYSTEM'
        && observedError.message === '.wiki-meta/.transactions physical path is unavailable',
      `Case 03b realpathInjected=${realpathInjected}; enumerationInjected=${enumerationInjected}; `
        + `observed=${observedError?.code || 'no error'}:${observedError?.message || 'complete return'}`,
    );
    assert.equal(enumerationInjected, true);
    assert.equal(matchingReads, 2);
  } finally {
    fs.realpathSync.native = originalRealpath;
    fs.readdirSync = originalReaddir;
    fs.lstatSync = originalLstat;
    releaseOuterPruneLockIfPresent(root, owner.token);
  }
});

test('OUTER-PRUNE-1 Case 04 missing child owner loss is rejected', () => {
  const root = outerPruneRoot({ withTransactions: false });
  const transactions = metaPath(root, '.transactions');
  const owner = modules().acquireLock({ wikiRoot: root, operation: 'outer-prune-case-04' });
  const originalLstat = fs.lstatSync;
  let matchingCalls = 0;
  let lockDestroyed = false;
  fs.lstatSync = (pathname, ...args) => {
    if (path.resolve(String(pathname)) !== path.resolve(transactions)) {
      return originalLstat(pathname, ...args);
    }
    matchingCalls += 1;
    let observed;
    let observationError;
    try { observed = originalLstat(pathname, ...args); }
    catch (error) { observationError = error; }
    if (matchingCalls === 2) {
      replaceLiveLockExternallyAtInjectedGuard(root);
      lockDestroyed = true;
    }
    if (observationError) throw observationError;
    return observed;
  };
  try {
    assert.throws(() => pruneOuterObservation(root, owner.token), (error) => (
      error.code === 'LOCK_TOKEN_MISMATCH'
    ));
    assert.equal(lockDestroyed, true);
    assert.equal(matchingCalls, 2);
  } finally {
    fs.lstatSync = originalLstat;
    releaseOuterPruneLockIfPresent(root, owner.token);
  }
});

test('OUTER-PRUNE-1 Case 05 missing child deadline expiry returns incomplete', () => {
  const root = outerPruneRoot({ withTransactions: false });
  const transactions = metaPath(root, '.transactions');
  const owner = modules().acquireLock({ wikiRoot: root, operation: 'outer-prune-case-05' });
  const originalLstat = fs.lstatSync;
  let matchingCalls = 0;
  let expired = false;
  const clock = { nowMs: () => (expired ? 1_000 : 0) };
  fs.lstatSync = (pathname, ...args) => {
    if (path.resolve(String(pathname)) !== path.resolve(transactions)) {
      return originalLstat(pathname, ...args);
    }
    matchingCalls += 1;
    let observed;
    let observationError;
    try { observed = originalLstat(pathname, ...args); }
    catch (error) { observationError = error; }
    if (matchingCalls === 2) expired = true;
    if (observationError) throw observationError;
    return observed;
  };
  try {
    assert.deepEqual(
      pruneOuterObservation(root, owner.token, modules().createDeadline({ clock, budgetMs: 1_000 })),
      { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 },
    );
    assert.equal(matchingCalls, 2);
  } finally {
    fs.lstatSync = originalLstat;
    releaseOuterPruneLockIfPresent(root, owner.token);
  }
});

test('OUTER-PRUNE-1 Case 06 missing child deadline wins owner loss', () => {
  const root = outerPruneRoot({ withTransactions: false });
  const transactions = metaPath(root, '.transactions');
  const owner = modules().acquireLock({ wikiRoot: root, operation: 'outer-prune-case-06' });
  const originalLstat = fs.lstatSync;
  let matchingCalls = 0;
  let expired = false;
  let lockDestroyed = false;
  const clock = { nowMs: () => (expired ? 1_000 : 0) };
  fs.lstatSync = (pathname, ...args) => {
    if (path.resolve(String(pathname)) !== path.resolve(transactions)) {
      return originalLstat(pathname, ...args);
    }
    matchingCalls += 1;
    let observed;
    let observationError;
    try { observed = originalLstat(pathname, ...args); }
    catch (error) { observationError = error; }
    if (matchingCalls === 2) {
      expired = true;
      replaceLiveLockExternallyAtInjectedGuard(root);
      lockDestroyed = true;
    }
    if (observationError) throw observationError;
    return observed;
  };
  try {
    assert.deepEqual(
      pruneOuterObservation(root, owner.token, modules().createDeadline({ clock, budgetMs: 1_000 })),
      { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 },
    );
    assert.equal(lockDestroyed, true);
    assert.equal(matchingCalls, 2);
  } finally {
    fs.lstatSync = originalLstat;
    releaseOuterPruneLockIfPresent(root, owner.token);
  }
});

test('OUTER-PRUNE-1 Case 07 present child final parent identity replacement is rejected', () => {
  const root = outerPruneRoot();
  const transactions = metaPath(root, '.transactions');
  const owner = modules().acquireLock({ wikiRoot: root, operation: 'outer-prune-case-07' });
  const originalLstat = fs.lstatSync;
  let matchingCalls = 0;
  let injected = false;
  let replacementCompleted = false;
  fs.lstatSync = (pathname, ...args) => {
    if (path.resolve(String(pathname)) !== path.resolve(transactions)) {
      return originalLstat(pathname, ...args);
    }
    matchingCalls += 1;
    if (matchingCalls !== 4) return originalLstat(pathname, ...args);
    const observed = originalLstat(pathname, ...args);
    replaceOuterPruneMeta(root, { transplantTransactions: true });
    injected = true;
    replacementCompleted = true;
    return observed;
  };
  try {
    assert.throws(() => pruneOuterObservation(root, owner.token), (error) => (
      error.code === 'SCAN_WINDOW_FILESYSTEM'
        && error.message === '.wiki-meta directory identity changed after transaction-store observation'
    ));
    assert.equal(injected, true);
    assert.equal(replacementCompleted, true);
    assert.equal(matchingCalls, 4);
  } finally {
    fs.lstatSync = originalLstat;
    releaseOuterPruneLockIfPresent(root, owner.token);
  }
});

test('OUTER-PRUNE-1 Case 08 present child replacement preserves late operation', () => {
  const root = outerPruneRoot();
  const transactions = metaPath(root, '.transactions');
  const lateOperation = path.join(transactions, 'late-operation');
  const owner = modules().acquireLock({ wikiRoot: root, operation: 'outer-prune-case-08' });
  const originalReaddir = fs.readdirSync;
  let matchingReads = 0;
  let injected = false;
  let observedError = null;
  fs.readdirSync = (pathname, ...args) => {
    if (path.resolve(String(pathname)) !== path.resolve(transactions)) {
      return originalReaddir(pathname, ...args);
    }
    matchingReads += 1;
    const observed = originalReaddir(pathname, ...args);
    if (matchingReads === 2) {
      replaceOuterPruneTransactions(root);
      fs.mkdirSync(lateOperation);
      injected = true;
    }
    return observed;
  };
  try {
    try { pruneOuterObservation(root, owner.token); }
    catch (error) { observedError = error; }
    assert.equal(fs.existsSync(lateOperation), true);
    assert.ok(
      observedError
        && observedError.code === 'SCAN_WINDOW_FILESYSTEM'
        && observedError.message === '.wiki-meta/.transactions directory identity changed after transaction-store observation',
      `Case 08 observed ${observedError?.code || 'no error'}: ${observedError?.message || 'complete return'}`,
    );
    assert.equal(injected, true);
    assert.equal(matchingReads, 2);
  } finally {
    fs.readdirSync = originalReaddir;
    releaseOuterPruneLockIfPresent(root, owner.token);
  }
});

test('OUTER-PRUNE-1 Case 09 present child owner loss is rejected', () => {
  const root = outerPruneRoot();
  const transactions = metaPath(root, '.transactions');
  const owner = modules().acquireLock({ wikiRoot: root, operation: 'outer-prune-case-09' });
  const originalReaddir = fs.readdirSync;
  let matchingReads = 0;
  let lockDestroyed = false;
  fs.readdirSync = (pathname, ...args) => {
    if (path.resolve(String(pathname)) !== path.resolve(transactions)) {
      return originalReaddir(pathname, ...args);
    }
    matchingReads += 1;
    const observed = originalReaddir(pathname, ...args);
    if (matchingReads === 2) {
      replaceLiveLockExternallyAtInjectedGuard(root);
      lockDestroyed = true;
    }
    return observed;
  };
  try {
    assert.throws(() => pruneOuterObservation(root, owner.token), (error) => (
      error.code === 'LOCK_TOKEN_MISMATCH'
    ));
    assert.equal(lockDestroyed, true);
    assert.equal(matchingReads, 2);
  } finally {
    fs.readdirSync = originalReaddir;
    releaseOuterPruneLockIfPresent(root, owner.token);
  }
});

test('OUTER-PRUNE-1 Case 10 present child deadline wins deferred enumeration error', () => {
  const root = outerPruneRoot();
  const transactions = metaPath(root, '.transactions');
  const owner = modules().acquireLock({ wikiRoot: root, operation: 'outer-prune-case-10' });
  const originalReaddir = fs.readdirSync;
  let matchingReads = 0;
  let expired = false;
  const clock = { nowMs: () => (expired ? 1_000 : 0) };
  fs.readdirSync = (pathname, ...args) => {
    if (path.resolve(String(pathname)) !== path.resolve(transactions)) {
      return originalReaddir(pathname, ...args);
    }
    matchingReads += 1;
    if (matchingReads === 2) {
      expired = true;
      throw Object.assign(new Error('enumerated child disappeared'), { code: 'ENOENT' });
    }
    return originalReaddir(pathname, ...args);
  };
  try {
    assert.deepEqual(
      pruneOuterObservation(root, owner.token, modules().createDeadline({ clock, budgetMs: 1_000 })),
      { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 },
    );
    assert.equal(matchingReads, 2);
  } finally {
    fs.readdirSync = originalReaddir;
    releaseOuterPruneLockIfPresent(root, owner.token);
  }
});

test('OUTER-PRUNE-1 Case 11 present child disappearance is unavailable', () => {
  const root = outerPruneRoot();
  const transactions = metaPath(root, '.transactions');
  const owner = modules().acquireLock({ wikiRoot: root, operation: 'outer-prune-case-11' });
  const originalReaddir = fs.readdirSync;
  let matchingReads = 0;
  let disappeared = false;
  fs.readdirSync = (pathname, ...args) => {
    if (path.resolve(String(pathname)) !== path.resolve(transactions)) {
      return originalReaddir(pathname, ...args);
    }
    matchingReads += 1;
    if (matchingReads === 2) {
      fs.rmSync(transactions, { recursive: true, force: true });
      disappeared = true;
    }
    return originalReaddir(pathname, ...args);
  };
  try {
    assert.throws(() => pruneOuterObservation(root, owner.token), (error) => (
      error.code === 'SCAN_WINDOW_FILESYSTEM'
        && error.message === '.wiki-meta/.transactions directory identity is unavailable'
    ));
    assert.equal(disappeared, true);
    assert.equal(matchingReads, 2);
  } finally {
    fs.readdirSync = originalReaddir;
    releaseOuterPruneLockIfPresent(root, owner.token);
  }
});

test('OUTER-PRUNE-1 Case 12 present child parent disappearance preserves owner fencing', () => {
  const root = outerPruneRoot();
  const transactions = metaPath(root, '.transactions');
  const owner = modules().acquireLock({ wikiRoot: root, operation: 'outer-prune-case-12' });
  const originalReaddir = fs.readdirSync;
  let matchingReads = 0;
  let parentDisappeared = false;
  fs.readdirSync = (pathname, ...args) => {
    if (path.resolve(String(pathname)) !== path.resolve(transactions)) {
      return originalReaddir(pathname, ...args);
    }
    matchingReads += 1;
    if (matchingReads === 2) {
      fs.rmSync(metaPath(root, ''), { recursive: true, force: true });
      parentDisappeared = true;
    }
    return originalReaddir(pathname, ...args);
  };
  try {
    assert.throws(() => pruneOuterObservation(root, owner.token), (error) => (
      error.code === 'LOCK_TOKEN_MISMATCH'
    ));
    assert.equal(parentDisappeared, true);
    assert.equal(matchingReads, 2);
  } finally {
    fs.readdirSync = originalReaddir;
    releaseOuterPruneLockIfPresent(root, owner.token);
  }
});

function setState(root, { pending, last } = {}) {
  if (pending === undefined || pending === null) fs.rmSync(metaPath(root, '.pending-scan'), { force: true });
  else fs.writeFileSync(metaPath(root, '.pending-scan'), pending);
  if (last === undefined || last === null) fs.rmSync(metaPath(root, '.last-scan'), { force: true });
  else fs.writeFileSync(metaPath(root, '.last-scan'), last);
}

function readMaybe(file) {
  try { return fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function state(root) {
  return {
    pending: readMaybe(metaPath(root, '.pending-scan')),
    last: readMaybe(metaPath(root, '.last-scan')),
  };
}

function assertState(root, { pending, last }) {
  const actual = state(root);
  assert.equal(actual.pending?.toString('utf8') ?? null, pending);
  assert.equal(actual.last?.toString('utf8') ?? null, last);
  for (const name of fs.readdirSync(metaPath(root, '.transactions'), { recursive: true })) {
    assert.doesNotMatch(String(name), /\.tmp\./);
  }
}

function withOwner(root, operation, callback) {
  const { acquireLock, releaseLock } = modules();
  const owner = acquireLock({ wikiRoot: root, operation, now: new Date(T3) });
  try { return callback(owner); } finally { releaseLock({ wikiRoot: root, token: owner.token }); }
}

function promote(root, expected, operationId, extra = {}) {
  return withOwner(root, 'scan-window-promote', (owner) => modules().promotePendingScan({
    wikiRoot: root,
    token: owner.token,
    expected,
    operationId,
    now: new Date(T3),
    ...extra,
  }));
}

function certifyEnsurePromotion(root, expected, completed) {
  const operationId = `prune-proof-${completed.operationId}`;
  const result = promote(root, expected, operationId);
  assert.equal(result.status, 'promoted');
  const {
    acquireLock,
    createDeadline,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const owner = acquireLock({ wikiRoot: root, operation: 'prune-proof-cleanup' });
  try {
    assert.deepEqual(pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 0,
      limit: 1,
      kinds: ['promote'],
      now: pruneClock(root),
      deadline: createDeadline({ budgetMs: 12_000 }),
    }).removed, [operationId]);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
}

function journalFiles(root) {
  const transactions = metaPath(root, '.transactions');
  return fs.readdirSync(transactions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.activate-'))
    .map((entry) => path.join(transactions, entry.name, 'journal.json'))
    .filter((file) => fs.existsSync(file));
}

function applyEnsure(root, token, proposed, operationId) {
  const { applyScanWindowTransition, createDeadline, planScanWindowTransition } = modules();
  const plan = planScanWindowTransition({ wikiRoot: root, kind: 'ensure', proposed });
  const result = applyScanWindowTransition({
    wikiRoot: root,
    token,
    plan,
    operationId,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  return { plan, result };
}

function pruneClock(root) {
  const newestMtimeNs = journalFiles(root).reduce((latest, journalPath) => {
    const { mtimeNs } = fs.lstatSync(journalPath, { bigint: true });
    return mtimeNs > latest ? mtimeNs : latest;
  }, 0n);
  return new Date(Number(newestMtimeNs / 1_000_000_000n + 1n) * 1000);
}

function createEnsurePruneCandidate(root, resultStatus) {
  const suffix = crypto.createHash('sha256')
    .update(`${root}\0${resultStatus}`)
    .digest('hex')
    .slice(0, 16);
  const operationId = `a-prune-${resultStatus}-${suffix}`;
  if (resultStatus === 'created') {
    const completed = withOwner(root, 'prune-created-fixture', (owner) =>
      applyEnsure(root, owner.token, T1, operationId).result);
    assert.equal(completed.status, 'created');
    assert.equal(promote(root, T1, `z-promote-created-${suffix}`).status, 'promoted');
    return { operationId, markerName: '.last-scan' };
  }
  if (resultStatus === 'preserved') {
    withOwner(root, 'prune-preserved-fixture', (owner) => {
      assert.equal(applyEnsure(root, owner.token, T1, `z-seed-preserved-${suffix}`).result.status,
        'created');
      assert.equal(applyEnsure(root, owner.token, T2, operationId).result.status, 'preserved');
    });
    return { operationId, markerName: '.pending-scan' };
  }
  if (resultStatus === 'stale') {
    withOwner(root, 'prune-stale-seed', (owner) => {
      assert.equal(applyEnsure(root, owner.token, T1, `z-seed-stale-${suffix}`).result.status,
        'created');
    });
    assert.equal(promote(root, T1, `z-promote-stale-${suffix}`).status, 'promoted');
    withOwner(root, 'prune-stale-fixture', (owner) => {
      assert.equal(applyEnsure(root, owner.token, T0, operationId).result.status, 'stale');
    });
    return { operationId, markerName: '.last-scan' };
  }
  throw new Error(`unsupported ensure prune status: ${resultStatus}`);
}

function runEnsurePruneWithFault(root, token, boundary, options = {}) {
  let reached = false;
  const result = modules().pruneScanWindowTransactions({
    wikiRoot: root,
    token,
    maxAgeDays: 0,
    limit: 1,
    kinds: ['ensure'],
    now: pruneClock(root),
    deadline: modules().createDeadline({ budgetMs: 12_000 }),
    resumableOnly: options.resumableOnly === true,
    faultInjector(actualBoundary) {
      if (actualBoundary !== boundary) return;
      reached = true;
      if (options.mutate) options.mutate();
      if (options.throwError) throw new Error(`injected prune boundary: ${boundary}`);
    },
  });
  return { reached, result };
}

function prunePendingPublication(root, basename) {
  const transactions = metaPath(root, '.transactions');
  const relative = fs.readdirSync(transactions, { recursive: true })
    .find((name) => path.basename(String(name)) === basename);
  assert.ok(relative, `expected ${basename} publication residue`);
  return path.join(transactions, String(relative));
}

function seedPruneBoundaryResidue(root, token, boundary) {
  const seeds = new Map([
    ['before-backup-pending-hardlink-unlink', {
      boundary: 'before-backup-staged-unlink',
    }],
    ['before-backup-pending-discard', {
      boundary: 'before-backup-destination-link',
      corrupt: 'journal.backup.pending',
    }],
    ['before-reservation-pending-hardlink-unlink', {
      boundary: 'before-reservation-staged-unlink',
    }],
    ['before-reservation-pending-discard', {
      boundary: 'before-reservation-destination-link',
      corrupt: 'source.reservation.pending',
    }],
    ['before-empty-quarantine-rmdir', {
      boundary: 'before-quarantine-rmdir',
    }],
    ['before-empty-quarantine-reservation-unlink', {
      boundary: 'before-quarantine-rmdir',
    }],
    ['before-canonical-reservation-only-unlink', {
      boundary: 'before-final-canonical-reservation-unlink',
    }],
  ]);
  const seed = seeds.get(boundary);
  if (!seed) return false;
  const first = runEnsurePruneWithFault(root, token, seed.boundary, { throwError: true });
  assert.equal(first.reached, true, `seed boundary was not reached: ${seed.boundary}`);
  assert.deepEqual(first.result.removed, []);
  if (seed.corrupt) fs.writeFileSync(prunePendingPublication(root, seed.corrupt), 'corrupt\n');
  return true;
}

function replaceMarkerWithSameBytes(root, markerName) {
  const marker = metaPath(root, markerName);
  const held = metaPath(root, `.held-${markerName.slice(1)}-${crypto.randomUUID()}`);
  const bytes = fs.readFileSync(marker);
  fs.renameSync(marker, held);
  fs.writeFileSync(marker, bytes);
}

const ensurePruneDestructiveBoundaries = [
  'before-transaction-quarantine-rename',
  'before-backup-destination-link',
  'before-backup-pending-hardlink-unlink',
  'before-backup-pending-discard',
  'before-backup-staged-unlink',
  'before-reservation-destination-link',
  'before-reservation-pending-hardlink-unlink',
  'before-reservation-pending-discard',
  'before-reservation-staged-unlink',
  'before-quarantined-journal-unlink',
  'before-quarantined-backup-unlink',
  'before-quarantine-rmdir',
  'before-final-canonical-reservation-unlink',
  'before-empty-quarantine-rmdir',
  'before-empty-quarantine-reservation-unlink',
  'before-canonical-reservation-only-unlink',
];

test('every ensure prune destructive boundary rejects same-byte marker inode drift', async (t) => {
  for (const resultStatus of ['created', 'preserved', 'stale']) {
    for (const boundary of ensurePruneDestructiveBoundaries) {
      await t.test(`${resultStatus}: ${boundary}`, () => {
        const root = temporaryWiki(`deep wiki ${resultStatus} ${boundary} `);
        const candidate = createEnsurePruneCandidate(root, resultStatus);
        const owner = modules().acquireLock({
          wikiRoot: root,
          operation: `prune-boundary-${resultStatus}`,
          now: new Date(T3),
        });
        try {
          const resumableOnly = seedPruneBoundaryResidue(root, owner.token, boundary);
          let reached = false;
          let boundarySnapshot;
          assert.throws(() => {
            runEnsurePruneWithFault(root, owner.token, boundary, {
              resumableOnly,
              mutate() {
                reached = true;
                boundarySnapshot = snapshotTree(metaPath(root, '.transactions'));
                replaceMarkerWithSameBytes(root, candidate.markerName);
              },
            });
          }, (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED'
            && error.ensurePruneProtected === true
            && /marker seal changed/.test(error.message));
          assert.equal(reached, true, `destructive boundary was not reached: ${boundary}`);
          assert.deepEqual(snapshotTree(metaPath(root, '.transactions')), boundarySnapshot);
        } finally {
          modules().releaseLock({ wikiRoot: root, token: owner.token });
        }
      });
    }
  }
});

test('standalone scan-window activation converges a genuine v1.8.2 pre-journal crash residue', (t) => {
  const listing = spawnSync('git', [
    'ls-tree', '-r', '--name-only', '3ebe6bd', 'hooks/scripts/runtime',
  ], { cwd: repoRoot, encoding: 'utf8', shell: false });
  if (listing.status !== 0) { t.skip(`git show unavailable: ${listing.stderr.trim()}`); return; }
  const extraction = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki legacy scan-window ')));
  roots.add(extraction);
  for (const relative of listing.stdout.trim().split('\n').filter(Boolean)) {
    const shown = spawnSync('git', ['show', `3ebe6bd:${relative}`], { cwd: repoRoot, encoding: null, shell: false });
    if (shown.status !== 0) { t.skip(`git show unavailable for ${relative}`); return; }
    const destination = path.join(extraction, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, shown.stdout);
  }
  const legacy = require(path.join(extraction, 'hooks', 'scripts', 'runtime', 'scan-window.js'));

  const root = temporaryWiki('deep wiki legacy scan-window crash ');
  const operationId = 'legacy-scan-window-upgrade-probe';
  setState(root, { pending: T1, last: T0 });
  withOwner(root, 'legacy-scan-window-promote', (owner) => assert.throws(() => legacy.promotePendingScan({
    wikiRoot: root, token: owner.token, expected: T1, operationId, now: new Date(T3),
    faultInjector(boundary) { if (boundary === 'before-journal-create-write') throw new Error('legacy crash'); },
  }), /legacy crash/));
  const transaction = path.join(metaPath(root, '.transactions'), operationId);
  assert.equal(fs.existsSync(transaction), true);
  assert.equal(fs.existsSync(path.join(transaction, 'journal.json')), false);

  const promoted = promote(root, T1, operationId);
  assert.equal(promoted.status, 'promoted');
  assertState(root, { pending: null, last: `${T1}\n` });
});

function snapshotFlatDirectory(directory) {
  return Object.fromEntries(fs.readdirSync(directory).sort().map((name) => [
    name,
    fs.readFileSync(path.join(directory, name)).toString('base64'),
  ]));
}

function snapshotTree(directory) {
  const snapshot = {};
  const visit = (pathname, relative) => {
    const stat = fs.lstatSync(pathname);
    const key = relative || '.';
    if (stat.isSymbolicLink()) {
      snapshot[key] = { type: 'symlink', target: fs.readlinkSync(pathname) };
      return;
    }
    if (stat.isDirectory()) {
      snapshot[key] = { type: 'directory' };
      for (const name of fs.readdirSync(pathname).sort()) {
        visit(path.join(pathname, name), relative ? path.join(relative, name) : name);
      }
      return;
    }
    snapshot[key] = { type: 'file', bytes: fs.readFileSync(pathname).toString('base64') };
  };
  visit(directory, '');
  return snapshot;
}

function makeClock(initial = 0) {
  let value = initial;
  return {
    nowMs: () => value,
    advance(amount) { value += amount; },
  };
}

test('planScanWindowTransition validates canonical UTC-Z input and preserves the oldest pending window', () => {
  const { planScanWindowTransition } = modules();
  const plan = planScanWindowTransition({
    kind: 'ensure', proposed: T2,
    pendingBytes: Buffer.from(`${T1}\n`), lastBytes: Buffer.from(`${T0}\n`),
  });
  assert.equal(plan.pending.before.toString(), `${T1}\n`);
  assert.equal(plan.pending.after.toString(), `${T1}\n`);
  assert.equal(plan.last.before.toString(), `${T0}\n`);
  assert.equal(plan.last.after.toString(), `${T0}\n`);
  assert.throws(() => planScanWindowTransition({ kind: 'ensure', proposed: '2026-07-11T02:00:00.000Z' }),
    (error) => error.code === 'SCAN_WINDOW_INVALID');
});

test('resumable-only pruning validates its selector and preserves ordinary cleaned directories', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki resumable-only ordinary preservation ');
  const result = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    now: new Date(T2),
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(result.status, 'deferred');
  const directory = path.dirname(journalFiles(root)[0]);
  const before = snapshotTree(directory);
  const owner = acquireLock({ wikiRoot: root, operation: 'resumable-only-test', now: new Date(T3) });
  try {
    assert.throws(() => pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 0,
      limit: 8,
      now: new Date(T3),
      deadline: createDeadline({ budgetMs: 12_000 }),
      resumableOnly: 'yes',
    }), (error) => error.code === 'SCAN_WINDOW_INVALID');
    assert.deepEqual(pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 0,
      limit: 8,
      now: new Date(T3),
      deadline: createDeadline({ budgetMs: 12_000 }),
      resumableOnly: true,
    }), { processed: 0, removed: [], complete: true, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assert.deepEqual(snapshotTree(directory), before);
});

test('generic transaction debris sweep never consumes a terminal-prune phase directory', () => {
  const { acquireLock, createDeadline, releaseLock } = modules();
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = temporaryWiki('deep wiki prune debris preservation ');
  const transactions = metaPath(root, '.transactions');
  const quarantine = path.join(transactions, '.prune-5-phase-debris');
  fs.mkdirSync(quarantine);
  const owner = acquireLock({ wikiRoot: root, operation: 'debris-preservation', now: new Date(T3) });
  try {
    assert.deepEqual(sweepTransactionDebris(root, owner.token, {
      deadline: createDeadline({ budgetMs: 12_000 }),
      classes: ['plain'],
    }), { processed: 0, removed: [], removed_junk: [], skipped_oversized: [] });
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assert.equal(fs.existsSync(quarantine), true);
});

test('scan-window maintenance reclaims OS metadata from the transaction store', () => {
  // Drives the real route rather than the library, so the `junk` class at the
  // `applyScanWindowTransition` call site is what is actually pinned.
  const root = temporaryWiki('deep wiki scan window junk sweep ');
  const transactions = metaPath(root, '.transactions');
  fs.writeFileSync(path.join(transactions, '.DS_Store'), 'finder metadata\n');
  setState(root, { pending: T2, last: T1 });
  const result = promote(root, T2, 'scan-window-junk-route-op');
  assert.equal(result.status, 'promoted');
  assert.equal(fs.existsSync(path.join(transactions, '.DS_Store')), false);
});

test('ensure pruning reclaims no-op evidence but requires exact promotion proof for created evidence', () => {
  const {
    acquireLock,
    createDeadline,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki semantic ensure prune ');
  const createdId = 'semantic-created-ensure';
  const preservedId = 'semantic-preserved-ensure';
  const owner = acquireLock({ wikiRoot: root, operation: 'semantic-ensure-fixture' });
  try {
    assert.equal(applyEnsure(root, owner.token, T1, createdId).result.status, 'created');
    assert.equal(applyEnsure(root, owner.token, T2, preservedId).result.status, 'preserved');
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  const firstOwner = acquireLock({ wikiRoot: root, operation: 'semantic-ensure-first-prune' });
  try {
    assert.deepEqual(pruneScanWindowTransactions({
      wikiRoot: root,
      token: firstOwner.token,
      maxAgeDays: 0,
      limit: 8,
      kinds: ['ensure'],
      now: pruneClock(root),
      deadline: createDeadline({ budgetMs: 12_000 }),
    }).removed, [preservedId]);
  } finally {
    releaseLock({ wikiRoot: root, token: firstOwner.token });
  }
  assert.equal(fs.existsSync(path.join(metaPath(root, '.transactions'), createdId)), true);

  assert.equal(promote(root, T1, 'semantic-created-promotion').status, 'promoted');
  const secondOwner = acquireLock({ wikiRoot: root, operation: 'semantic-ensure-second-prune' });
  try {
    assert.deepEqual(pruneScanWindowTransactions({
      wikiRoot: root,
      token: secondOwner.token,
      maxAgeDays: 0,
      limit: 8,
      kinds: ['ensure'],
      now: pruneClock(root),
      deadline: createDeadline({ budgetMs: 12_000 }),
    }).removed, [createdId]);
  } finally {
    releaseLock({ wikiRoot: root, token: secondOwner.token });
  }
});

test('either invalid scan-window marker suppresses every ensure status for the whole prune invocation', () => {
  const {
    acquireLock,
    createDeadline,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  for (const invalidMarker of ['pending', 'last']) {
    const root = temporaryWiki(`deep wiki invalid ${invalidMarker} ensure suppression `);
    const owner = acquireLock({ wikiRoot: root, operation: `invalid-${invalidMarker}-fixture` });
    try {
      assert.equal(applyEnsure(
        root, owner.token, T1, `${invalidMarker}-created-ensure`,
      ).result.status, 'created');
      assert.equal(applyEnsure(
        root, owner.token, T2, `${invalidMarker}-preserved-ensure`,
      ).result.status, 'preserved');
    } finally {
      releaseLock({ wikiRoot: root, token: owner.token });
    }
    fs.writeFileSync(metaPath(root, `.${invalidMarker}-scan`), 'invalid\n');
    const before = snapshotTree(metaPath(root, '.transactions'));
    const pruneOwner = acquireLock({
      wikiRoot: root, operation: `invalid-${invalidMarker}-prune`,
    });
    try {
      assert.deepEqual(pruneScanWindowTransactions({
        wikiRoot: root,
        token: pruneOwner.token,
        maxAgeDays: 0,
        limit: 8,
        kinds: ['ensure'],
        now: pruneClock(root),
        deadline: createDeadline({ budgetMs: 12_000 }),
      }), { processed: 0, removed: [], complete: true, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
    } finally {
      releaseLock({ wikiRoot: root, token: pruneOwner.token });
    }
    assert.deepEqual(snapshotTree(metaPath(root, '.transactions')), before);
  }
});

test('scan-window prune marker classification accepts only canonical one-link regular files', async (t) => {
  const representations = [
    ['invalid UTF-8', (marker) => fs.writeFileSync(marker, Buffer.from([0xff, 0x0a]))],
    ['leading whitespace', (marker) => fs.writeFileSync(marker, ` ${T1}\n`)],
    ['CRLF', (marker) => fs.writeFileSync(marker, `${T1}\r\n`)],
    ['directory', (marker) => fs.mkdirSync(marker)],
    ['hardlink', (marker, root) => {
      fs.writeFileSync(marker, `${T1}\n`);
      fs.linkSync(marker, path.join(root, 'marker-hardlink'));
    }],
    ['symlink', (marker, root) => {
      const target = path.join(root, 'marker-target');
      fs.writeFileSync(target, `${T1}\n`);
      fs.symlinkSync(target, marker);
    }],
    ['dangling symlink', (marker, root) =>
      fs.symlinkSync(path.join(root, 'missing-marker-target'), marker)],
  ];
  for (const [name, create] of representations) {
    await t.test(name, () => {
      const { inspectPruneMarkers } = modules();
      const root = temporaryWiki(`deep wiki invalid marker ${name} `);
      const marker = metaPath(root, '.pending-scan');
      create(marker, root);
      const markers = inspectPruneMarkers({ wikiRoot: root });
      assert.equal(markers.pending.invalid, true);
      assert.equal(markers.last.invalid, false);
    });
  }

  await t.test('unreadable', () => {
    const { inspectPruneMarkers } = modules();
    const root = temporaryWiki('deep wiki unreadable marker ');
    const marker = metaPath(root, '.pending-scan');
    fs.writeFileSync(marker, `${T1}\n`);
    const originalRead = fs.readFileSync;
    fs.readFileSync = (pathname, ...args) => {
      if (pathname === marker) throw Object.assign(new Error('unreadable marker'), { code: 'EACCES' });
      return originalRead(pathname, ...args);
    };
    try {
      assert.equal(inspectPruneMarkers({ wikiRoot: root }).pending.invalid, true);
    } finally {
      fs.readFileSync = originalRead;
    }
  });

  await t.test('post-read identity failure is physical ambiguity, not syntactic invalidity', () => {
    const { inspectPruneMarkers } = modules();
    const root = temporaryWiki('deep wiki post-read marker identity failure ');
    const marker = metaPath(root, '.pending-scan');
    fs.writeFileSync(marker, 'invalid\n');
    const originalLstat = fs.lstatSync;
    let markerLstats = 0;
    fs.lstatSync = (pathname, ...args) => {
      if (pathname === marker && ++markerLstats === 2) {
        throw Object.assign(new Error('post-read marker identity unavailable'), {
          code: 'EACCES',
        });
      }
      return originalLstat(pathname, ...args);
    };
    try {
      const inspected = inspectPruneMarkers({ wikiRoot: root }).pending;
      assert.equal(inspected.state, 'invalid');
      assert.equal(Object.hasOwn(inspected, 'bytes'), false);
      assert.equal(Object.hasOwn(inspected, 'identity'), false);
    } finally {
      fs.lstatSync = originalLstat;
    }
  });

  const { inspectPruneMarkers } = modules();
  const acceptedRoot = temporaryWiki('deep wiki accepted marker ');
  fs.writeFileSync(metaPath(acceptedRoot, '.pending-scan'), `${T1}\n`);
  const accepted = inspectPruneMarkers({ wikiRoot: acceptedRoot });
  assert.equal(accepted.pending.invalid, false);
  assert.equal(accepted.pending.state, 'accepted');
  assert.equal(accepted.last.invalid, false);
  assert.equal(accepted.last.state, 'absent');
});

test('raw reservation-prune compatibility names fail before type parsing or sibling mutation', async (t) => {
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
      const {
        acquireLock,
        assertPruneTransactionNamesSupported,
        createDeadline,
        releaseLock,
      } = modules();
      const root = temporaryWiki(`deep wiki raw compatibility ${name} `);
      const transactions = metaPath(root, '.transactions');
      const raw = path.join(transactions, `.reservation-.prune-malformed-${name}`);
      const sibling = path.join(transactions, '.activate-removable-sibling');
      fs.mkdirSync(sibling);
      fs.writeFileSync(path.join(sibling, 'evidence'), 'preserve all siblings\n');
      create(raw, root);
      const before = snapshotTree(transactions);
      const owner = acquireLock({ wikiRoot: root, operation: `raw-compatibility-${name}` });
      try {
        assert.throws(() => assertPruneTransactionNamesSupported({
          wikiRoot: root,
          token: owner.token,
          deadline: createDeadline({ budgetMs: 12_000 }),
        }), (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED'
          && /stopped-host/i.test(error.message));
      } finally {
        releaseLock({ wikiRoot: root, token: owner.token });
      }
      assert.deepEqual(snapshotTree(transactions), before);
    });
  }
});

test('prune-name preflight proves .wiki-meta before accepting a missing transaction store', async (t) => {
  const {
    acquireLock,
    assertPruneTransactionNamesSupported,
    createDeadline,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();

  await t.test('symlinked .wiki-meta with a missing child fails closed', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki parent anchor ')));
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki outside meta ')));
    roots.add(root);
    roots.add(outside);
    fs.symlinkSync(outside, path.join(root, '.wiki-meta'));
    const before = snapshotTree(outside);
    const owner = acquireLock({ wikiRoot: root, operation: 'prune-parent-anchor' });
    try {
      assert.throws(() => assertPruneTransactionNamesSupported({
        wikiRoot: root,
        token: owner.token,
        deadline: createDeadline({ budgetMs: 12_000 }),
      }), (error) => error.code === 'SCAN_WINDOW_FILESYSTEM'
        && /\.wiki-meta/.test(error.message));
    } finally {
      releaseLock({ wikiRoot: root, token: owner.token });
    }
    assert.deepEqual(snapshotTree(outside), before);
  });

  await t.test('physical .wiki-meta with a missing child is benign', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki absent store ')));
    roots.add(root);
    fs.mkdirSync(path.join(root, '.wiki-meta'));
    const owner = acquireLock({ wikiRoot: root, operation: 'prune-missing-store' });
    try {
      assert.doesNotThrow(() => assertPruneTransactionNamesSupported({
        wikiRoot: root,
        token: owner.token,
        deadline: createDeadline({ budgetMs: 12_000 }),
      }));
    } finally {
      releaseLock({ wikiRoot: root, token: owner.token });
    }
  });

  await t.test('missing child observation preserves post-observation deadline precedence', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki absent store deadline ')));
    roots.add(root);
    fs.mkdirSync(path.join(root, '.wiki-meta'));
    const owner = acquireLock({ wikiRoot: root, operation: 'prune-missing-store-deadline' });
    let calls = 0;
    const clock = {
      nowMs() {
        calls += 1;
        return calls >= 5 ? 1_000 : 0;
      },
    };
    try {
      assert.throws(() => assertPruneTransactionNamesSupported({
        wikiRoot: root,
        token: owner.token,
        deadline: createDeadline({ clock, budgetMs: 1_000 }),
      }), (error) => error.code === 'DEADLINE_EXCEEDED');
    } finally {
      releaseLock({ wikiRoot: root, token: owner.token });
    }
  });

  const replaceMetaAfterChildObservation = (root, { replacementHasTransactions }) => {
    const meta = path.join(root, '.wiki-meta');
    const displaced = path.join(root, '.wiki-meta.displaced');
    fs.renameSync(meta, displaced);
    fs.mkdirSync(meta);
    fs.cpSync(
      path.join(displaced, '.wiki-lock'),
      path.join(meta, '.wiki-lock'),
      { recursive: true },
    );
    if (replacementHasTransactions) fs.mkdirSync(path.join(meta, '.transactions'));
  };

  for (const childState of ['missing', 'present']) {
    await t.test(`revalidates .wiki-meta after observing a ${childState} child`, () => {
      const root = fs.realpathSync.native(fs.mkdtempSync(path.join(
        os.tmpdir(),
        `deep wiki replaced meta ${childState} child `,
      )));
      roots.add(root);
      const meta = path.join(root, '.wiki-meta');
      const transactions = path.join(meta, '.transactions');
      fs.mkdirSync(meta);
      if (childState === 'present') fs.mkdirSync(transactions);
      const owner = acquireLock({ wikiRoot: root, operation: `prune-replaced-meta-${childState}` });
      const originalLstat = fs.lstatSync;
      let injected = false;
      let replacementCompleted = false;
      fs.lstatSync = (pathname, ...args) => {
        if (injected || path.resolve(String(pathname)) !== path.resolve(transactions)) {
          return originalLstat(pathname, ...args);
        }
        let observed;
        let observationError;
        try {
          observed = originalLstat(pathname, ...args);
        } catch (error) {
          observationError = error;
        }
        injected = true;
        replaceMetaAfterChildObservation(root, {
          replacementHasTransactions: childState === 'present',
        });
        replacementCompleted = true;
        if (observationError) throw observationError;
        return observed;
      };
      try {
        assert.throws(() => assertPruneTransactionNamesSupported({
          wikiRoot: root,
          token: owner.token,
          deadline: createDeadline({ budgetMs: 12_000 }),
        }), (error) => error.code === 'SCAN_WINDOW_FILESYSTEM'
          && error.message === '.wiki-meta directory identity changed after transaction-store observation');
      } finally {
        fs.lstatSync = originalLstat;
        releaseLock({ wikiRoot: root, token: owner.token });
      }
      assert.equal(injected, true);
      assert.equal(replacementCompleted, true);
    });
  }

  for (const replacedContainer of ['.wiki-meta', '.wiki-meta/.transactions']) {
    await t.test(`revalidates ${replacedContainer} after present-child enumeration`, () => {
      const expectedMessage = `${replacedContainer} directory identity changed after transaction-store observation`;
      const root = temporaryWiki(
        `deep wiki enumerated ${path.basename(replacedContainer)} replacement `,
      );
      const meta = path.join(root, '.wiki-meta');
      const transactions = path.join(meta, '.transactions');
      const owner = acquireLock({
        wikiRoot: root,
        operation: `prune-enumerated-${path.basename(replacedContainer)}-replacement`,
      });
      const originalReaddir = fs.readdirSync;
      let injected = false;
      let replacementCompleted = false;
      fs.readdirSync = (pathname, ...args) => {
        if (injected || path.resolve(String(pathname)) !== path.resolve(transactions)) {
          return originalReaddir(pathname, ...args);
        }
        const observed = originalReaddir(pathname, ...args);
        injected = true;
        if (replacedContainer === '.wiki-meta') {
          replaceMetaAfterChildObservation(root, { replacementHasTransactions: true });
        } else {
          fs.renameSync(transactions, path.join(meta, '.transactions.displaced'));
          fs.mkdirSync(transactions);
        }
        replacementCompleted = true;
        return observed;
      };
      try {
        assert.throws(() => assertPruneTransactionNamesSupported({
          wikiRoot: root,
          token: owner.token,
          deadline: createDeadline({ budgetMs: 12_000 }),
        }), (error) => error.code === 'SCAN_WINDOW_FILESYSTEM'
          && error.message === expectedMessage);
      } finally {
        fs.readdirSync = originalReaddir;
        releaseLock({ wikiRoot: root, token: owner.token });
      }
      assert.equal(injected, true);
      assert.equal(replacementCompleted, true);
    });
  }

  await t.test('deadline remains ahead of owner revalidation after child observation', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(
      os.tmpdir(),
      'deep wiki child observation precedence ',
    )));
    roots.add(root);
    fs.mkdirSync(path.join(root, '.wiki-meta'));
    const transactions = path.join(root, '.wiki-meta', '.transactions');
    const owner = acquireLock({ wikiRoot: root, operation: 'prune-child-observation-precedence' });
    const originalLstat = fs.lstatSync;
    let expired = false;
    let injected = false;
    const clock = { nowMs: () => (expired ? 1_000 : 0) };
    fs.lstatSync = (pathname, ...args) => {
      if (injected || path.resolve(String(pathname)) !== path.resolve(transactions)) {
        return originalLstat(pathname, ...args);
      }
      let observationError;
      try {
        originalLstat(pathname, ...args);
      } catch (error) {
        observationError = error;
      }
      injected = true;
      expired = true;
      replaceLiveLockExternallyAtInjectedGuard(root);
      throw observationError;
    };
    try {
      assert.throws(() => assertPruneTransactionNamesSupported({
        wikiRoot: root,
        token: owner.token,
        deadline: createDeadline({ clock, budgetMs: 1_000 }),
      }), (error) => error.code === 'DEADLINE_EXCEEDED');
    } finally {
      fs.lstatSync = originalLstat;
    }
    assert.equal(injected, true);
  });

  await t.test('revalidates owner after a benign missing-child observation', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(
      os.tmpdir(),
      'deep wiki missing child owner recheck ',
    )));
    roots.add(root);
    fs.mkdirSync(path.join(root, '.wiki-meta'));
    const transactions = path.join(root, '.wiki-meta', '.transactions');
    const owner = acquireLock({ wikiRoot: root, operation: 'prune-missing-child-owner-recheck' });
    const originalLstat = fs.lstatSync;
    let injected = false;
    fs.lstatSync = (pathname, ...args) => {
      if (injected || path.resolve(String(pathname)) !== path.resolve(transactions)) {
        return originalLstat(pathname, ...args);
      }
      let observationError;
      try {
        originalLstat(pathname, ...args);
      } catch (error) {
        observationError = error;
      }
      injected = true;
      replaceLiveLockExternallyAtInjectedGuard(root);
      throw observationError;
    };
    try {
      assert.throws(() => assertPruneTransactionNamesSupported({
        wikiRoot: root,
        token: owner.token,
        deadline: createDeadline({ budgetMs: 12_000 }),
      }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
    } finally {
      fs.lstatSync = originalLstat;
    }
    assert.equal(injected, true);
  });

  await t.test('present-child enumeration ENOENT is never benign completion', () => {
    const root = temporaryWiki('deep wiki present child enumeration enoent ');
    const transactions = path.join(root, '.wiki-meta', '.transactions');
    const owner = acquireLock({ wikiRoot: root, operation: 'prune-enumeration-enoent' });
    const originalReaddir = fs.readdirSync;
    let injections = 0;
    let matchingReads = 0;
    let throwOnMatchingRead = 1;
    fs.readdirSync = (pathname, ...args) => {
      if (path.resolve(String(pathname)) === path.resolve(transactions)) {
        matchingReads += 1;
        if (matchingReads === throwOnMatchingRead) {
          injections += 1;
          throw Object.assign(new Error('enumerated child disappeared'), { code: 'ENOENT' });
        }
      }
      return originalReaddir(pathname, ...args);
    };
    try {
      const invoke = () => assertPruneTransactionNamesSupported({
        wikiRoot: root,
        token: owner.token,
        deadline: createDeadline({ budgetMs: 12_000 }),
      });
      assert.throws(invoke, (error) => error.code === 'SCAN_WINDOW_FILESYSTEM'
        && error.message === '.wiki-meta/.transactions contents are unavailable');
      matchingReads = 0;
      throwOnMatchingRead = 2;
      assert.throws(() => pruneScanWindowTransactions({
        wikiRoot: root,
        token: owner.token,
        maxAgeDays: 0,
        limit: 1,
        now: new Date(T3),
        deadline: createDeadline({ budgetMs: 12_000 }),
      }), (error) => error.code === 'SCAN_WINDOW_FILESYSTEM'
        && error.message === '.wiki-meta/.transactions contents are unavailable during prune');
    } finally {
      fs.readdirSync = originalReaddir;
      releaseLock({ wikiRoot: root, token: owner.token });
    }
    assert.equal(injections, 2);
  });

  await t.test('symlinked .transactions remains rejected', () => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki linked store ')));
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki outside store ')));
    roots.add(root);
    roots.add(outside);
    fs.mkdirSync(path.join(root, '.wiki-meta'));
    fs.symlinkSync(outside, path.join(root, '.wiki-meta', '.transactions'));
    const owner = acquireLock({ wikiRoot: root, operation: 'prune-linked-store' });
    try {
      assert.throws(() => assertPruneTransactionNamesSupported({
        wikiRoot: root,
        token: owner.token,
        deadline: createDeadline({ budgetMs: 12_000 }),
      }), (error) => error.code === 'SCAN_WINDOW_FILESYSTEM');
    } finally {
      releaseLock({ wikiRoot: root, token: owner.token });
    }
  });
});

test('terminal prune reclaims regular metadata from cleaned transactions and quarantines', async (t) => {
  const seedPromote = (label, faultInjector) => {
    const root = temporaryWiki(`deep wiki nested terminal junk ${label} `);
    const operationId = `nested-junk-${label}`;
    setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
    const result = promote(root, T1, operationId, {
      faultInjector: faultInjector
        ? (boundary) => faultInjector(boundary, { root, operationId })
        : undefined,
    });
    assert.equal(result.status, 'promoted');
    return { root, operationId };
  };
  const prune = (root, operationId, extra = {}) => withOwner(
    root,
    `prune-${operationId}`,
    (owner) => modules().pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 0,
      limit: 4,
      kinds: ['promote'],
      now: pruneClock(root),
      deadline: modules().createDeadline({ budgetMs: 12_000 }),
      ...extra,
    }),
  );

  await t.test('cleaned transaction metadata is removed before terminal evidence', () => {
    let operationDirectory;
    const { root, operationId } = seedPromote('cleaned', (boundary, context) => {
      if (boundary !== 'before-transition-cleaned-write') return;
      operationDirectory = metaPath(
        context.root,
        path.join('.transactions', context.operationId),
      );
      fs.writeFileSync(path.join(operationDirectory, '.DS_Store'), 'finder\n');
    });
    const result = prune(root, operationId);
    assert.deepEqual(result, { processed: 1, removed: [operationId], complete: true, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
    assert.equal(fs.existsSync(operationDirectory), false);
  });

  await t.test('journal-bearing quarantine metadata is removed on a resumable retry', () => {
    const { root, operationId } = seedPromote('journal-quarantine');
    let quarantine;
    const interrupted = prune(root, operationId, {
      faultInjector(boundary) {
        if (boundary !== 'before-quarantined-journal-unlink') return;
        quarantine = fs.readdirSync(metaPath(root, '.transactions'), { withFileTypes: true })
          .find((entry) => entry.isDirectory() && entry.name.startsWith('.prune-'));
        assert.ok(quarantine);
        fs.writeFileSync(
          metaPath(root, path.join('.transactions', quarantine.name, '.DS_Store')),
          'finder\n',
        );
        throw new Error('leave journal-bearing quarantine');
      },
    });
    assert.deepEqual(blockedSummary(interrupted), { processed: 0, removed: [], complete: true, skipped_oversized: [], blocked: ['teardown:unclassified'], blocked_count: 1, blocked_truncated: false, deferred_count: 0 });
    const result = prune(root, operationId, { resumableOnly: true });
    assert.deepEqual(result, { processed: 1, removed: [operationId], complete: true, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
    assert.equal(fs.existsSync(metaPath(root, path.join('.transactions', quarantine.name))), false);
  });

  await t.test('evidence-empty quarantine metadata is removed on a resumable retry', () => {
    const { root, operationId } = seedPromote('empty-quarantine');
    let quarantine;
    const interrupted = prune(root, operationId, {
      faultInjector(boundary) {
        if (boundary !== 'before-quarantine-rmdir') return;
        quarantine = fs.readdirSync(metaPath(root, '.transactions'), { withFileTypes: true })
          .find((entry) => entry.isDirectory() && entry.name.startsWith('.prune-'));
        assert.ok(quarantine);
        throw new Error('leave empty quarantine');
      },
    });
    assert.deepEqual(blockedSummary(interrupted), { processed: 0, removed: [], complete: true, skipped_oversized: [], blocked: ['teardown:unclassified'], blocked_count: 1, blocked_truncated: false, deferred_count: 0 });
    fs.writeFileSync(
      metaPath(root, path.join('.transactions', quarantine.name, '._finder')),
      'appledouble\n',
    );
    const result = prune(root, operationId, { resumableOnly: true });
    assert.deepEqual(result, { processed: 1, removed: [operationId], complete: true, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
    assert.equal(fs.existsSync(metaPath(root, path.join('.transactions', quarantine.name))), false);
  });

  await t.test('a held file arriving inside empty-quarantine finalization returns incomplete', () => {
    const { root, operationId } = seedPromote('empty-quarantine-held');
    let quarantine;
    prune(root, operationId, {
      faultInjector(boundary) {
        if (boundary !== 'before-quarantine-rmdir') return;
        quarantine = fs.readdirSync(metaPath(root, '.transactions'), { withFileTypes: true })
          .find((entry) => entry.isDirectory() && entry.name.startsWith('.prune-'));
        throw new Error('leave empty quarantine for held-file retry');
      },
    });
    assert.ok(quarantine);
    const { acquireLock, releaseLock } = modules();
    const owner = acquireLock({ wikiRoot: root, operation: 'empty-quarantine-held-retry' });
    try {
      const child = spawnSync(process.execPath, [
        '-e',
        `const fs=require('node:fs');const path=require('node:path');
const sw=require(process.argv[1]);const dl=require(process.argv[2]);let injected=false;
const original=fs.unlinkSync;fs.unlinkSync=(pathname,...args)=>{
  if(path.basename(pathname)==='._finder')throw Object.assign(new Error('held'),{code:'EACCES'});
  return original(pathname,...args);
};
const result=sw.pruneScanWindowTransactions({wikiRoot:process.argv[3],token:process.argv[4],
  maxAgeDays:0,limit:4,kinds:['promote'],resumableOnly:true,now:new Date(process.argv[5]),
  deadline:dl.createDeadline({budgetMs:12000}),faultInjector(boundary){
    if(injected||boundary!=='before-empty-quarantine-rmdir')return;
    const entry=fs.readdirSync(path.join(process.argv[3],'.wiki-meta','.transactions'),{withFileTypes:true})
      .find((item)=>item.isDirectory()&&item.name.startsWith('.prune-'));
    fs.writeFileSync(path.join(process.argv[3],'.wiki-meta','.transactions',entry.name,'._finder'),'held\\n');
    injected=true;
  }});
process.stdout.write(JSON.stringify(result));`,
        scanWindowPath,
        deadlinePath,
        root,
        owner.token,
        pruneClock(root).toISOString(),
      ], { encoding: 'utf8', shell: false, timeout: 20_000 });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), {
        processed: 0,
        removed: [],
        complete: false,
        skipped_oversized: [],
        blocked: [],
        blocked_count: 0,
        blocked_truncated: false,
        deferred_count: 0,
      });
    } finally {
      releaseLock({ wikiRoot: root, token: owner.token });
    }
    assert.deepEqual(prune(root, operationId, { resumableOnly: true }), {
      processed: 1,
      removed: [operationId],
      complete: true,
      skipped_oversized: [],
      blocked: [],
      blocked_count: 0,
      blocked_truncated: false,
      deferred_count: 0,
    });
  });

  await t.test('later quarantine assertions share one monotonically increasing counter', () => {
    const { root, operationId } = seedPromote('shared-quarantine-counter');
    let quarantine;
    prune(root, operationId, {
      faultInjector(boundary) {
        if (boundary !== 'before-quarantined-journal-unlink') return;
        quarantine = fs.readdirSync(metaPath(root, '.transactions'), { withFileTypes: true })
          .find((entry) => entry.isDirectory() && entry.name.startsWith('.prune-'));
        throw new Error('leave journal quarantine for shared-counter retry');
      },
    });
    assert.ok(quarantine);
    const attempts = [];
    const semanticSnapshots = [];
    let firstInjected = false;
    let secondInjected = false;
    const result = prune(root, operationId, {
      resumableOnly: true,
      faultInjector(boundary, context) {
        if (boundary.startsWith('nested-junk-remove:')) attempts.push(boundary);
        if (boundary === 'nested-junk-semantic-names'
            && path.basename(context.directory) === quarantine.name) {
          semanticSnapshots.push(context.names);
        }
        if (!firstInjected && boundary === 'before-quarantined-journal-unlink') {
          fs.writeFileSync(
            metaPath(root, path.join('.transactions', quarantine.name, '.DS_Store')),
            'first assertion\n',
          );
          firstInjected = true;
        } else if (!secondInjected && boundary === 'before-quarantined-backup-unlink') {
          fs.writeFileSync(
            metaPath(root, path.join('.transactions', quarantine.name, '._finder')),
            'second assertion\n',
          );
          secondInjected = true;
        }
      },
    });
    assert.deepEqual(result, { processed: 1, removed: [operationId], complete: true, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
    assert.equal(firstInjected, true);
    assert.equal(secondInjected, true);
    assert.deepEqual(attempts, ['nested-junk-remove:1', 'nested-junk-remove:2']);
    assert.equal(semanticSnapshots.some((names) => (
      JSON.stringify(names) === JSON.stringify(['journal.backup', 'journal.json'])
    )), true);
    assert.equal(semanticSnapshots.some((names) => (
      JSON.stringify(names) === JSON.stringify(['journal.backup'])
    )), true);
  });

  for (const code of ['EPERM', 'EACCES', 'EBUSY', 'EROFS', 'ETXTBSY']) {
    await t.test(`foreign ${code} hold is incomplete and a fresh process can converge`, () => {
      let operationDirectory;
      const { root, operationId } = seedPromote(`held-${code.toLowerCase()}`, (
        boundary,
        context,
      ) => {
        if (boundary !== 'before-transition-cleaned-write') return;
        operationDirectory = metaPath(
          context.root,
          path.join('.transactions', context.operationId),
        );
        fs.writeFileSync(path.join(operationDirectory, '.DS_Store'), 'held\n');
      });
      const before = snapshotTree(operationDirectory);
      const { acquireLock, releaseLock } = modules();
      const owner = acquireLock({ wikiRoot: root, operation: `nested-hold-${code}` });
      try {
        const child = spawnSync(process.execPath, [
          '-e',
          `const fs=require('node:fs');const path=require('node:path');
const sw=require(process.argv[1]);const dl=require(process.argv[2]);
const original=fs.unlinkSync;fs.unlinkSync=(pathname,...args)=>{
  if(path.basename(pathname)==='.DS_Store')throw Object.assign(new Error('held'),{code:process.argv[5]});
  return original(pathname,...args);
};
const result=sw.pruneScanWindowTransactions({wikiRoot:process.argv[3],token:process.argv[4],
  maxAgeDays:0,limit:4,kinds:['promote'],now:new Date(process.argv[6]),
  deadline:dl.createDeadline({budgetMs:12000})});
process.stdout.write(JSON.stringify(result));`,
          scanWindowPath,
          deadlinePath,
          root,
          owner.token,
          code,
          pruneClock(root).toISOString(),
        ], { encoding: 'utf8', shell: false, timeout: 20_000 });
        assert.equal(child.status, 0, child.stderr);
        assert.deepEqual(JSON.parse(child.stdout), {
          processed: 0,
          removed: [],
          complete: false,
          skipped_oversized: [],
          blocked: [],
          blocked_count: 0,
          blocked_truncated: false,
          deferred_count: 0,
        });
      } finally {
        releaseLock({ wikiRoot: root, token: owner.token });
      }
      assert.deepEqual(snapshotTree(operationDirectory), before);
      assert.deepEqual(prune(root, operationId), {
        processed: 1,
        removed: [operationId],
        complete: true,
        skipped_oversized: [],
        blocked: [],
        blocked_count: 0,
        blocked_truncated: false,
        deferred_count: 0,
      });
    });
  }

  await t.test('a held discovery candidate does not starve a later independent operation', () => {
    const root = temporaryWiki('deep wiki held quarantine liveness ');
    const heldOperation = 'a-held-quarantine';
    const laterOperation = 'b-later-operation';
    setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
    assert.equal(promote(root, T1, heldOperation).status, 'promoted');
    let quarantine;
    const leaveHeld = withOwner(root, 'leave-held-quarantine', (owner) => (
      modules().pruneScanWindowTransactions({
        wikiRoot: root,
        token: owner.token,
        maxAgeDays: 0,
        limit: 4,
        kinds: ['promote'],
        now: pruneClock(root),
        deadline: modules().createDeadline({ budgetMs: 12_000 }),
        faultInjector(boundary) {
          if (boundary !== 'before-quarantined-journal-unlink') return;
          quarantine = fs.readdirSync(metaPath(root, '.transactions'), { withFileTypes: true })
            .find((entry) => entry.isDirectory() && entry.name.startsWith('.prune-'));
          throw new Error('leave first quarantine');
        },
      })
    ));
    assert.deepEqual(blockedSummary(leaveHeld), { processed: 0, removed: [], complete: true, skipped_oversized: [], blocked: ['teardown:unclassified'], blocked_count: 1, blocked_truncated: false, deferred_count: 0 });
    assert.ok(quarantine);
    fs.writeFileSync(
      metaPath(root, path.join('.transactions', quarantine.name, '.DS_Store')),
      'held first candidate\n',
    );
    setState(root, { pending: `${T2}\n`, last: `${T1}\n` });
    assert.equal(promote(root, T2, laterOperation).status, 'promoted');

    const { acquireLock, releaseLock } = modules();
    const owner = acquireLock({ wikiRoot: root, operation: 'held-quarantine-liveness' });
    try {
      const child = spawnSync(process.execPath, [
        '-e',
        `const fs=require('node:fs');const path=require('node:path');
const sw=require(process.argv[1]);const dl=require(process.argv[2]);const original=fs.unlinkSync;
fs.unlinkSync=(pathname,...args)=>{
  if(path.basename(pathname)==='.DS_Store')throw Object.assign(new Error('held'),{code:'EACCES'});
  return original(pathname,...args);
};
const result=sw.pruneScanWindowTransactions({wikiRoot:process.argv[3],token:process.argv[4],
  maxAgeDays:0,limit:4,kinds:['promote'],now:new Date(process.argv[5]),
  deadline:dl.createDeadline({budgetMs:12000})});process.stdout.write(JSON.stringify(result));`,
        scanWindowPath,
        deadlinePath,
        root,
        owner.token,
        pruneClock(root).toISOString(),
      ], { encoding: 'utf8', shell: false, timeout: 20_000 });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), {
        processed: 1,
        removed: [laterOperation],
        complete: false,
        skipped_oversized: [],
        blocked: [],
        blocked_count: 0,
        blocked_truncated: false,
        deferred_count: 0,
      });
    } finally {
      releaseLock({ wikiRoot: root, token: owner.token });
    }
    assert.deepEqual(prune(root, heldOperation, { resumableOnly: true }), {
      processed: 1,
      removed: [heldOperation],
      complete: true,
      skipped_oversized: [],
      blocked: [],
      blocked_count: 0,
      blocked_truncated: false,
      deferred_count: 0,
    });
  });

  await t.test('one successful junk attempt consumes the last shared slot', () => {
    let operationDirectory;
    const { root, operationId } = seedPromote('one-slot', (boundary, context) => {
      if (boundary !== 'before-transition-cleaned-write') return;
      operationDirectory = metaPath(
        context.root,
        path.join('.transactions', context.operationId),
      );
      fs.writeFileSync(path.join(operationDirectory, '.DS_Store'), 'one slot\n');
    });
    const boundaries = [];
    const first = prune(root, operationId, {
      limit: 1,
      faultInjector(boundary) { boundaries.push(boundary); },
    });
    assert.deepEqual(first, { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
    assert.equal(fs.existsSync(path.join(operationDirectory, '.DS_Store')), false);
    assert.equal(fs.existsSync(path.join(operationDirectory, 'journal.json')), true);
    assert.equal(boundaries.includes('before-transaction-quarantine-rename'), false);
    assert.equal(boundaries.filter((value) => value.startsWith('nested-junk-remove:')).length, 1);
    assert.deepEqual(prune(root, operationId, { limit: 1 }), {
      processed: 1,
      removed: [operationId],
      complete: true,
      skipped_oversized: [],
      blocked: [],
      blocked_count: 0,
      blocked_truncated: false,
      deferred_count: 0,
    });
  });

  await t.test('post-attempt reserve exhaustion preserves terminal evidence', () => {
    let operationDirectory;
    const { root, operationId } = seedPromote('reserve-after-attempt', (boundary, context) => {
      if (boundary !== 'before-transition-cleaned-write') return;
      operationDirectory = metaPath(
        context.root,
        path.join('.transactions', context.operationId),
      );
      fs.writeFileSync(path.join(operationDirectory, '.DS_Store'), 'reserve\n');
    });
    let nowMs = 0;
    const clock = { nowMs: () => nowMs };
    const boundaries = [];
    const result = prune(root, operationId, {
      deadline: modules().createDeadline({ clock, budgetMs: 1_000 }),
      faultInjector(boundary) {
        boundaries.push(boundary);
        if (boundary === 'after-nested-junk-unlink') nowMs = 800;
      },
    });
    assert.deepEqual(result, { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
    assert.equal(fs.existsSync(path.join(operationDirectory, '.DS_Store')), false);
    assert.equal(fs.existsSync(path.join(operationDirectory, 'journal.json')), true);
    assert.equal(boundaries.includes('before-transaction-quarantine-rename'), false);
  });

  await t.test('retyping an admitted file to a symlink preserves the outside target', () => {
    let operationDirectory;
    const { root, operationId } = seedPromote('retype-symlink', (boundary, context) => {
      if (boundary !== 'before-transition-cleaned-write') return;
      operationDirectory = metaPath(
        context.root,
        path.join('.transactions', context.operationId),
      );
      fs.writeFileSync(path.join(operationDirectory, '.DS_Store'), 'replace me\n');
    });
    const outside = path.join(root, 'outside-junk-target');
    fs.writeFileSync(outside, 'outside sentinel\n');
    let replaced = false;
    const boundaries = [];
    let semanticNames;
    const result = prune(root, operationId, {
      faultInjector(boundary, context) {
        boundaries.push(boundary);
        if (boundary === 'nested-junk-semantic-names'
            && context.directory === operationDirectory) {
          semanticNames = context.names;
        }
        if (replaced || boundary !== 'after-nested-junk-admission'
            || path.basename(context.pathname) !== '.DS_Store') return;
        fs.unlinkSync(context.pathname);
        fs.symlinkSync(outside, context.pathname);
        replaced = true;
      },
    });
    assert.equal(replaced, true);
    assert.deepEqual(result, { processed: 0, removed: [], complete: true, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
    assert.deepEqual(semanticNames, ['.DS_Store', 'journal.json']);
    assert.equal(fs.lstatSync(path.join(operationDirectory, '.DS_Store')).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'outside sentinel\n');
    assert.equal(boundaries.includes('before-transaction-quarantine-rename'), false);
  });

  await t.test('a regular replacement needs a fresh admission and obeys the same cap', () => {
    let operationDirectory;
    const { root, operationId } = seedPromote('retype-regular', (boundary, context) => {
      if (boundary !== 'before-transition-cleaned-write') return;
      operationDirectory = metaPath(
        context.root,
        path.join('.transactions', context.operationId),
      );
      fs.writeFileSync(path.join(operationDirectory, '.DS_Store'), 'first inode\n');
    });
    let replaced = false;
    const attempts = [];
    const result = prune(root, operationId, {
      limit: 2,
      faultInjector(boundary, context) {
        if (boundary.startsWith('nested-junk-remove:')) attempts.push(boundary);
        if (replaced || boundary !== 'after-nested-junk-admission') return;
        fs.unlinkSync(context.pathname);
        fs.writeFileSync(context.pathname, 'replacement inode\n');
        replaced = true;
      },
    });
    assert.deepEqual(result, { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
    assert.deepEqual(attempts, ['nested-junk-remove:1', 'nested-junk-remove:2']);
    assert.equal(fs.existsSync(path.join(operationDirectory, '.DS_Store')), false);
    assert.equal(fs.existsSync(path.join(operationDirectory, 'journal.json')), true);
    assert.deepEqual(prune(root, operationId, { limit: 1 }), {
      processed: 1,
      removed: [operationId],
      complete: true,
      skipped_oversized: [],
      blocked: [],
      blocked_count: 0,
      blocked_truncated: false,
      deferred_count: 0,
    });
  });

  await t.test('a transaction-store ancestor swap cannot redirect nested unlink', () => {
    let operationDirectory;
    const { root, operationId } = seedPromote('ancestor-swap', (boundary, context) => {
      if (boundary !== 'before-transition-cleaned-write') return;
      operationDirectory = metaPath(
        context.root,
        path.join('.transactions', context.operationId),
      );
      fs.writeFileSync(path.join(operationDirectory, '.DS_Store'), 'inside\n');
    });
    const outside = path.join(root, 'outside-transaction-store');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, '.DS_Store'), 'outside sentinel\n');
    const canonical = metaPath(root, '.transactions');
    const held = metaPath(root, '.transactions-held');
    let swapped = false;
    assert.throws(() => prune(root, operationId, {
      faultInjector(boundary) {
        if (swapped || boundary !== 'after-nested-junk-admission') return;
        fs.renameSync(canonical, held);
        fs.symlinkSync(outside, canonical);
        swapped = true;
      },
    }), (error) => error.code === 'SCAN_WINDOW_FILESYSTEM'
      && error.terminal_prune?.complete === false);
    assert.equal(swapped, true);
    assert.equal(fs.readFileSync(path.join(outside, '.DS_Store'), 'utf8'), 'outside sentinel\n');
    assert.equal(fs.readFileSync(path.join(
      held,
      operationId,
      '.DS_Store',
    ), 'utf8'), 'inside\n');
  });

  await t.test('a quarantine generation swap cannot redirect nested unlink', () => {
    const { root, operationId } = seedPromote('quarantine-swap');
    let quarantine;
    prune(root, operationId, {
      faultInjector(boundary) {
        if (boundary !== 'before-quarantined-journal-unlink') return;
        quarantine = fs.readdirSync(metaPath(root, '.transactions'), { withFileTypes: true })
          .find((entry) => entry.isDirectory() && entry.name.startsWith('.prune-'));
        fs.writeFileSync(
          metaPath(root, path.join('.transactions', quarantine.name, '.DS_Store')),
          'inside\n',
        );
        throw new Error('leave quarantine for generation-swap retry');
      },
    });
    assert.ok(quarantine);
    const quarantinePath = metaPath(root, path.join('.transactions', quarantine.name));
    assert.equal(fs.existsSync(path.join(quarantinePath, '.DS_Store')), true);
    const held = `${quarantinePath}-held`;
    const outside = path.join(root, 'outside-quarantine');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, '.DS_Store'), 'outside sentinel\n');
    let swapped = false;
    let observed;
    let observedError;
    try { observed = prune(root, operationId, {
      resumableOnly: true,
      faultInjector(boundary, context) {
        if (swapped || boundary !== 'after-nested-junk-admission') return;
        assert.equal(path.dirname(context.pathname), quarantinePath);
        fs.renameSync(quarantinePath, held);
        fs.symlinkSync(outside, quarantinePath);
        swapped = true;
      },
    }); } catch (error) { observedError = error; }
    assert.equal(swapped, true);
    assert.equal(observed, undefined);
    assert.equal(observedError?.code, 'SCAN_WINDOW_FILESYSTEM');
    assert.equal(observedError?.terminal_prune?.complete, false);
    assert.equal(fs.readFileSync(path.join(outside, '.DS_Store'), 'utf8'), 'outside sentinel\n');
    assert.equal(fs.readFileSync(path.join(held, '.DS_Store'), 'utf8'), 'inside\n');
  });

  await t.test('post-unlink quarantine and meta swaps are detected without outside mutation', () => {
    const { root, operationId } = seedPromote('post-unlink-swaps');
    let quarantine;
    prune(root, operationId, {
      faultInjector(boundary) {
        if (boundary !== 'before-quarantined-journal-unlink') return;
        quarantine = fs.readdirSync(metaPath(root, '.transactions'), { withFileTypes: true })
          .find((entry) => entry.isDirectory() && entry.name.startsWith('.prune-'));
        fs.writeFileSync(
          metaPath(root, path.join('.transactions', quarantine.name, '.DS_Store')),
          'remove before swap\n',
        );
        throw new Error('leave quarantine for post-unlink swap');
      },
    });
    const quarantinePath = metaPath(root, path.join('.transactions', quarantine.name));
    const quarantineHeld = `${quarantinePath}-held`;
    const outsideQuarantine = path.join(root, 'outside-post-unlink-quarantine');
    fs.mkdirSync(outsideQuarantine);
    fs.writeFileSync(path.join(outsideQuarantine, 'sentinel'), 'outside quarantine\n');
    assert.throws(() => prune(root, operationId, {
      resumableOnly: true,
      faultInjector(boundary) {
        if (boundary !== 'after-nested-junk-unlink') return;
        fs.renameSync(quarantinePath, quarantineHeld);
        fs.symlinkSync(outsideQuarantine, quarantinePath);
      },
    }), (error) => error.code === 'SCAN_WINDOW_FILESYSTEM'
      && error.terminal_prune?.complete === false);
    assert.equal(
      fs.readFileSync(path.join(outsideQuarantine, 'sentinel'), 'utf8'),
      'outside quarantine\n',
    );

    const metaRoot = temporaryWiki('deep wiki post unlink meta swap ');
    const metaOperation = 'post-unlink-meta-swap';
    setState(metaRoot, { pending: `${T1}\n`, last: `${T0}\n` });
    let operationDirectory;
    assert.equal(promote(metaRoot, T1, metaOperation, {
      faultInjector(boundary) {
        if (boundary !== 'before-transition-cleaned-write') return;
        operationDirectory = metaPath(metaRoot, path.join('.transactions', metaOperation));
        fs.writeFileSync(path.join(operationDirectory, '.DS_Store'), 'meta swap\n');
      },
    }).status, 'promoted');
    const canonicalMeta = metaPath(metaRoot, '');
    const heldMeta = path.join(metaRoot, '.wiki-meta-held');
    const outsideMeta = path.join(metaRoot, 'outside-meta');
    fs.mkdirSync(outsideMeta);
    fs.writeFileSync(path.join(outsideMeta, 'sentinel'), 'outside meta\n');
    const { acquireLock, releaseLock } = modules();
    const owner = acquireLock({ wikiRoot: metaRoot, operation: 'post-unlink-meta-owner' });
    let metaError;
    try {
      modules().pruneScanWindowTransactions({
        wikiRoot: metaRoot,
        token: owner.token,
        maxAgeDays: 0,
        limit: 4,
        kinds: ['promote'],
        now: pruneClock(metaRoot),
        deadline: modules().createDeadline({ budgetMs: 12_000 }),
        faultInjector(boundary) {
          if (boundary !== 'after-nested-junk-unlink') return;
          fs.renameSync(canonicalMeta, heldMeta);
          fs.symlinkSync(outsideMeta, canonicalMeta);
        },
      });
    } catch (error) {
      metaError = error;
    } finally {
      fs.unlinkSync(canonicalMeta);
      fs.renameSync(heldMeta, canonicalMeta);
      releaseLock({ wikiRoot: metaRoot, token: owner.token });
    }
    assert.equal(metaError?.terminal_prune?.complete, false);
    assert.match(metaError?.code ?? '', /^(LOCK_|SCAN_WINDOW_FILESYSTEM$)/);
    assert.equal(fs.readFileSync(path.join(outsideMeta, 'sentinel'), 'utf8'), 'outside meta\n');
    assert.equal(fs.existsSync(path.join(operationDirectory, 'journal.json')), true);
  });

  await t.test('owner takeover after admission permits zero nested or evidence mutation', () => {
    let operationDirectory;
    const { root, operationId } = seedPromote('owner-takeover', (boundary, context) => {
      if (boundary !== 'before-transition-cleaned-write') return;
      operationDirectory = metaPath(
        context.root,
        path.join('.transactions', context.operationId),
      );
      fs.writeFileSync(path.join(operationDirectory, '.DS_Store'), 'owned\n');
    });
    const before = snapshotTree(operationDirectory);
    const { acquireLock, assertLockOwner, releaseLock } = modules();
    const owner = acquireLock({ wikiRoot: root, operation: 'nested-owner-before' });
    let successor;
    assert.throws(() => modules().pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 0,
      limit: 4,
      kinds: ['promote'],
      now: pruneClock(root),
      deadline: modules().createDeadline({ budgetMs: 12_000 }),
      faultInjector(boundary) {
        if (successor || boundary !== 'after-nested-junk-admission') return;
        replaceLiveLockExternallyAtInjectedGuard(root);
        successor = acquireLock({ wikiRoot: root, operation: 'nested-owner-successor' });
      },
    }), (error) => error.code === 'LOCK_TOKEN_MISMATCH'
      && error.terminal_prune?.complete === false);
    assert.ok(successor);
    assert.deepEqual(snapshotTree(operationDirectory), before);
    assert.equal(assertLockOwner({ wikiRoot: root, token: successor.token }).operation,
      'nested-owner-successor');
    releaseLock({ wikiRoot: root, token: successor.token });
  });
});

test('default parent guard applies the nested metadata contract before empty removal', async (t) => {
  const {
    ScanWindowError,
    defaultTransactionParentGuard,
    semanticTransactionNames,
  } = require(parentGuardPath);
  const { createDeadline } = modules();
  const makeGuard = (root, operationId, extra = {}) => {
    const locations = {
      meta: metaPath(root, ''),
      transactions: metaPath(root, '.transactions'),
      transaction: metaPath(root, path.join('.transactions', operationId)),
    };
    const nestedJunkAttempts = {
      attempts: 0,
      attemptedPhysicalFiles: new Set(),
      budgetExhausted: false,
    };
    const deadline = createDeadline({ budgetMs: 12_000 });
    const guard = defaultTransactionParentGuard(locations, {
      assertBudget() {},
      nestedJunkAttempts,
      removed: [],
      limit: extra.limit ?? 2,
      deadline,
      faultInjector: extra.faultInjector,
    });
    return { guard, locations, nestedJunkAttempts };
  };

  await t.test('regular metadata is identity-checked, unlinked, then the directory is removed', () => {
    const root = temporaryWiki('deep wiki parent guard regular junk ');
    const operationId = 'parent-guard-regular-junk';
    const operation = metaPath(root, path.join('.transactions', operationId));
    fs.mkdirSync(operation);
    fs.writeFileSync(path.join(operation, '.DS_Store'), 'finder\n');
    const boundaries = [];
    const { guard, nestedJunkAttempts } = makeGuard(root, operationId, {
      faultInjector(boundary) { boundaries.push(boundary); },
    });
    assert.equal(guard.inspectExistingOperation(), true);
    guard.removeEmptyOperation(() => {});
    assert.equal(fs.existsSync(operation), false);
    assert.equal(nestedJunkAttempts.attempts, 1);
    assert.deepEqual(
      boundaries.filter((value) => value.startsWith('nested-junk-remove:')),
      ['nested-junk-remove:1'],
    );
  });

  for (const kind of ['symlink', 'directory']) {
    await t.test(`junk-named ${kind} remains a recovery condition`, () => {
      const root = temporaryWiki(`deep wiki parent guard ${kind} junk `);
      const operationId = `parent-guard-${kind}-junk`;
      const operation = metaPath(root, path.join('.transactions', operationId));
      fs.mkdirSync(operation);
      const junk = path.join(operation, '.DS_Store');
      if (kind === 'symlink') {
        const outside = path.join(root, 'outside-parent-guard');
        fs.writeFileSync(outside, 'outside\n');
        fs.symlinkSync(outside, junk);
      } else {
        fs.mkdirSync(junk);
      }
      const { guard, nestedJunkAttempts } = makeGuard(root, operationId);
      assert.equal(guard.inspectExistingOperation(), true);
      assert.throws(
        () => guard.removeEmptyOperation(() => {}),
        (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED',
      );
      assert.equal(fs.existsSync(operation), true);
      assert.equal(fs.lstatSync(junk).isSymbolicLink(), kind === 'symlink');
      assert.equal(nestedJunkAttempts.attempts, 0);
    });
  }

  await t.test('limit zero admits neither nested junk nor the terminal removal', () => {
    const root = temporaryWiki('deep wiki parent guard zero limit ');
    const operationId = 'parent-guard-zero-limit';
    const operation = metaPath(root, path.join('.transactions', operationId));
    fs.mkdirSync(operation);
    const junk = path.join(operation, '.DS_Store');
    fs.writeFileSync(junk, 'zero limit\n');
    const { guard, nestedJunkAttempts } = makeGuard(root, operationId, { limit: 0 });
    assert.equal(guard.inspectExistingOperation(), true);
    assert.throws(
      () => guard.removeEmptyOperation(() => {}),
      (error) => error.code === 'SCAN_WINDOW_NESTED_JUNK_DEFERRED'
        && error.nestedJunkBudgetExhausted === true,
    );
    assert.equal(nestedJunkAttempts.attempts, 0);
    assert.equal(fs.readFileSync(junk, 'utf8'), 'zero limit\n');
  });

  await t.test('a replacement identity already attempted is never charged or unlinked twice', () => {
    const root = temporaryWiki('deep wiki parent guard attempted replacement ');
    const operationId = 'parent-guard-attempted-replacement';
    const operation = metaPath(root, path.join('.transactions', operationId));
    fs.mkdirSync(operation);
    const junk = path.join(operation, '.DS_Store');
    fs.writeFileSync(junk, 'first identity\n');
    let context;
    let replaced = false;
    context = makeGuard(root, operationId, {
      faultInjector(boundary, faultContext) {
        if (replaced || boundary !== 'after-nested-junk-admission') return;
        fs.unlinkSync(faultContext.pathname);
        fs.writeFileSync(faultContext.pathname, 'already attempted replacement\n');
        const stat = fs.lstatSync(faultContext.pathname, { bigint: true });
        const key = [stat.dev, stat.ino, stat.mode & 0o170000n, stat.birthtimeNs]
          .map((value) => value.toString())
          .join(':');
        context.nestedJunkAttempts.attemptedPhysicalFiles.add(key);
        replaced = true;
      },
    });
    assert.equal(context.guard.inspectExistingOperation(), true);
    assert.throws(
      () => context.guard.removeEmptyOperation(() => {}),
      (error) => error.code === 'SCAN_WINDOW_NESTED_JUNK_DEFERRED',
    );
    assert.equal(replaced, true);
    assert.equal(context.nestedJunkAttempts.attempts, 1);
    assert.equal(fs.readFileSync(junk, 'utf8'), 'already attempted replacement\n');
  });

  await t.test('identity failures retain the canonical runtime error class', () => {
    const root = temporaryWiki('deep wiki parent guard canonical error ');
    const operationId = 'parent-guard-canonical-error';
    const operation = metaPath(root, path.join('.transactions', operationId));
    const held = `${operation}-held`;
    const outside = path.join(root, 'outside-parent-guard-error');
    fs.mkdirSync(operation);
    fs.mkdirSync(outside);
    const { guard } = makeGuard(root, operationId);
    assert.equal(guard.inspectExistingOperation(), true);
    fs.renameSync(operation, held);
    fs.symlinkSync(outside, operation);
    assert.throws(
      () => guard.assertAll(),
      (error) => error instanceof ScanWindowError
        && error.code === 'SCAN_WINDOW_FILESYSTEM',
    );
  });

  await t.test('the closing parent proof tags trust loss but preserves deadline polarity', () => {
    const makeSemanticOptions = (label, assertOwnerAndParents) => {
      const root = temporaryWiki(`deep wiki parent proof ${label} `);
      const directory = metaPath(root, path.join('.transactions', `parent-proof-${label}`));
      fs.mkdirSync(directory);
      fs.writeFileSync(path.join(directory, '.DS_Store'), 'proof\n');
      return {
        directory,
        label: `parent proof ${label}`,
        assertOwnerAndParents,
        assertBudget() {},
        nestedJunkAttempts: {
          attempts: 0,
          attemptedPhysicalFiles: new Set(),
          budgetExhausted: false,
        },
        removed: [],
        limit: 2,
        deadline: createDeadline({ budgetMs: 12_000 }),
      };
    };

    let closingProofs = 0;
    assert.throws(
      () => semanticTransactionNames(makeSemanticOptions('trust-loss', () => {
        closingProofs += 1;
        if (closingProofs === 2) {
          throw Object.assign(new Error('parent identity changed'), {
            code: 'SCAN_WINDOW_FILESYSTEM',
          });
        }
      })),
      (error) => error.code === 'SCAN_WINDOW_FILESYSTEM'
        && error.nestedJunkSafety === true,
    );

    assert.throws(
      () => semanticTransactionNames(makeSemanticOptions('deadline', () => {
        throw Object.assign(new Error('deadline exceeded'), { code: 'DEADLINE_EXCEEDED' });
      })),
      (error) => error.code === 'DEADLINE_EXCEEDED'
        && error.nestedJunkSafety !== true,
    );
  });
});

test('scan-window evidence names stay disjoint from the shared junk classifier', () => {
  const {
    isReclaimableJunkEntry,
    isTransactionStoreJunkName,
  } = require('../hooks/scripts/runtime/transaction-debris.js');
  const engineNames = [
    'journal.json',
    'journal.backup',
    'journal.backup.pending',
    'source.reservation.pending',
    'scan-window-operation',
    '.prune-22-scan-window-operation-1-id',
    '.reservation-.prune-22-scan-window-operation-1-id',
    `.journal.json.tmp.${process.pid}.${crypto.randomUUID()}`,
  ];
  for (const name of engineNames) assert.equal(isTransactionStoreJunkName(name), false, name);

  const root = temporaryWiki('deep wiki classifier compatibility ');
  const directory = metaPath(root, '.transactions');
  fs.writeFileSync(path.join(directory, '.DS_Store'), 'regular\n');
  fs.mkdirSync(path.join(directory, '._directory'));
  fs.symlinkSync(path.join(directory, '.DS_Store'), path.join(directory, '._symlink'));
  const entries = new Map(fs.readdirSync(directory, { withFileTypes: true })
    .map((entry) => [entry.name, entry]));
  assert.equal(isReclaimableJunkEntry(entries.get('.DS_Store'), directory), true);
  assert.equal(isReclaimableJunkEntry(entries.get('._directory'), directory), false);
  assert.equal(isReclaimableJunkEntry(entries.get('._symlink'), directory), false);

  const unknown = {
    name: '._unknown',
    isFile: () => false,
    isDirectory: () => false,
    isSymbolicLink: () => false,
    isBlockDevice: () => false,
    isCharacterDevice: () => false,
    isFIFO: () => false,
    isSocket: () => false,
  };
  assert.equal(isReclaimableJunkEntry(unknown, directory), false);
});

test('ensurePendingScan rejects every raw reservation-prune representation before debris mutation', async (t) => {
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
      const { createDeadline, ensurePendingScan } = modules();
      const root = temporaryWiki(`deep wiki ensure raw compatibility ${name} `);
      const transactions = metaPath(root, '.transactions');
      const raw = path.join(transactions, `.reservation-.prune-malformed-${name}`);
      const sibling = path.join(transactions, '.activate-removable-sibling');
      fs.mkdirSync(sibling);
      fs.writeFileSync(path.join(sibling, 'evidence'), 'preserve every sibling\n');
      create(raw, root);
      const before = snapshotTree(transactions);

      const result = ensurePendingScan({
        wikiRoot: root,
        proposed: T1,
        now: new Date(T1),
        deadline: createDeadline({ budgetMs: 12_000 }),
      });

      assert.deepEqual(result, {
        status: 'deferred',
        reason: 'TRANSACTION_RECOVERY_REQUIRED',
      });
      assert.deepEqual(snapshotTree(transactions), before);
      assertState(root, { pending: null, last: null });
    });
  }
});

test('ensurePendingScan creates one canonical line and a committed transaction', () => {
  const { ensurePendingScan, createDeadline } = modules();
  const root = temporaryWiki();
  const result = ensurePendingScan({
    wikiRoot: root, proposed: T1, now: new Date(T1), deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.equal(result.status, 'created');
  assert.match(result.operationId, /^[a-z0-9-]{20,}$/);
  assertState(root, { pending: `${T1}\n`, last: null });
  const journals = journalFiles(root);
  assert.equal(journals.length, 1);
  const journal = JSON.parse(fs.readFileSync(journals[0]));
  assert.equal(journal.kind, 'ensure');
  assert.equal(journal.operation_id, result.operationId);
  assert.deepEqual(journal.input, {
    wiki_root: root,
    kind: 'ensure',
    proposed: T1,
    expected: null,
    repair_pending_after: null,
    repair_last_after: null,
  });
  assert.equal(
    journal.input_sha256,
    crypto.createHash('sha256').update(JSON.stringify(journal.input)).digest('hex'),
  );
  assert.deepEqual(journal.transitions, [
    'scan-window-preflighted', 'scan-window-staged', 'pending-scan-written',
    'scan-window-committed', 'cleaned',
  ]);
  assert.equal(new Set(journal.transitions).size, journal.transitions.length);
});

test('ensurePendingScan keeps committed scan status if post-commit promotion throws', () => {
  const debris = require(path.join(repoRoot, 'hooks', 'scripts', 'runtime', 'transaction-debris.js'));
  const original = debris.promoteOversizedNames;
  debris.promoteOversizedNames = () => {
    throw Object.assign(new Error('injected post-commit promotion throw'), {
      code: 'PROMOTION_INJECTED',
    });
  };
  try {
    const { ensurePendingScan, createDeadline } = modules();
    const root = temporaryWiki('deep wiki promotion catch ');
    const result = ensurePendingScan({
      wikiRoot: root, proposed: T1, now: new Date(T1), deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.notEqual(result.status, 'deferred');
    assert.equal(result.status, 'created');
    assert.equal(fs.existsSync(metaPath(root, '.pending-scan')), true);
  } finally {
    debris.promoteOversizedNames = original;
  }
});

test('ensurePendingScan preserves a valid oldest pending value byte-identically', () => {
  const { ensurePendingScan, createDeadline } = modules();
  const root = temporaryWiki('deep wiki preserve pending ');
  setState(root, { pending: `${T1}\r\n`, last: `${T0}\n` });
  const before = readMaybe(metaPath(root, '.pending-scan'));
  const result = ensurePendingScan({
    wikiRoot: root, proposed: T2, now: new Date(T2), deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.equal(result.status, 'preserved');
  assert.deepEqual(readMaybe(metaPath(root, '.pending-scan')), before);
  assertState(root, { pending: `${T1}\r\n`, last: `${T0}\n` });
});

test('automatic scan-window maintenance keeps terminal transaction growth bounded', () => {
  const { ensurePendingScan, createDeadline } = modules();
  const root = temporaryWiki('deep wiki bounded ensure transactions ');
  let finalProposal;

  for (let index = 0; index < 16; index += 1) {
    finalProposal = new Date(Date.parse(T1) + index * 1000)
      .toISOString().replace('.000Z', 'Z');
    const result = ensurePendingScan({
      wikiRoot: root,
      proposed: finalProposal,
      deadline: createDeadline({ budgetMs: 3_000 }),
    });
    assert.notEqual(result.status, 'deferred');
  }

  const transactions = metaPath(root, '.transactions');
  const directories = fs.readdirSync(transactions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink());
  assert.ok(directories.length <= 2, `terminal transaction directories: ${directories.length}`);

  const beforeRetry = snapshotTree(transactions);
  const retry = ensurePendingScan({
    wikiRoot: root,
    proposed: finalProposal,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(retry.status, 'deferred');
  assert.deepEqual(snapshotTree(transactions), beforeRetry);
});

test('automatic maintenance failure never suppresses the persisted scan window', () => {
  const { createDeadline, ensurePendingScan } = modules();
  const root = temporaryWiki('deep wiki nonfatal automatic prune ');
  const first = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(first.status, 'deferred');
  fs.rmSync(metaPath(root, '.pending-scan'));
  const transactions = metaPath(root, '.transactions');
  const originalUnlink = fs.unlinkSync;
  fs.unlinkSync = (pathname) => {
    if (path.basename(pathname) === 'journal.json'
        && path.basename(path.dirname(pathname)).startsWith('.prune-')) {
      const error = new Error('injected terminal cleanup refusal');
      error.code = 'EPERM';
      throw error;
    }
    return originalUnlink(pathname);
  };
  let second;
  try {
    second = ensurePendingScan({
      wikiRoot: root,
      proposed: T2,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
  } finally {
    fs.unlinkSync = originalUnlink;
  }
  assert.equal(second.status, 'created');
  assert.equal(readMaybe(metaPath(root, '.pending-scan')).toString('utf8'), `${T2}\n`);
  const preservedJournal = fs.readdirSync(transactions, { recursive: true })
    .map((relative) => path.join(transactions, relative))
    .find((pathname) => {
      try {
        const value = JSON.parse(fs.readFileSync(pathname, 'utf8'));
        return value.operation_id === first.operationId
          && value.transitions.at(-1) === 'cleaned';
      } catch {
        return false;
      }
    });
  assert.ok(preservedJournal);
});

test('transaction pruning is token-fenced, conservative, age-gated, and exactly bounded', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki terminal prune ');
  const transactions = metaPath(root, '.transactions');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const youngTime = new Date('2026-07-27T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');

  const interrupted = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
    faultInjector(boundary) {
      if (boundary === 'after-transaction-activate') throw new Error('interrupt');
    },
  });
  assert.equal(interrupted.status, 'deferred');
  const inFlightJournalPath = journalFiles(root).find((journalPath) => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    return journal.transitions.at(-1) !== 'cleaned';
  });
  assert.ok(inFlightJournalPath);
  const inFlightJournal = JSON.parse(fs.readFileSync(inFlightJournalPath, 'utf8'));
  const inFlightDirectory = path.dirname(inFlightJournalPath);
  fs.utimesSync(inFlightJournalPath, oldTime, oldTime);
  fs.utimesSync(inFlightDirectory, oldTime, oldTime);

  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T2,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T2, completed);
  const cleanedJournalPath = journalFiles(root).find((journalPath) => {
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    return journal.transitions.at(-1) === 'cleaned';
  });
  assert.ok(cleanedJournalPath);
  const cleanedDirectory = path.dirname(cleanedJournalPath);
  fs.utimesSync(cleanedJournalPath, youngTime, youngTime);
  fs.utimesSync(cleanedDirectory, youngTime, youngTime);

  function copyCleanedTransaction(operationId, timestamp, destinationParent = transactions) {
    const destination = path.join(destinationParent, operationId);
    fs.cpSync(cleanedDirectory, destination, { recursive: true });
    const journalPath = path.join(destination, 'journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    fs.writeFileSync(journalPath, `${JSON.stringify({ ...journal, operation_id: operationId })}\n`);
    fs.utimesSync(journalPath, timestamp, timestamp);
    fs.utimesSync(destination, timestamp, timestamp);
    return destination;
  }

  const removableIds = [
    'prunable-terminal-a',
    'prunable-terminal-b',
    'prunable-terminal-c',
  ];
  const removableDirectories = removableIds.map((operationId) =>
    copyCleanedTransaction(operationId, oldTime));

  const malformedDirectory = path.join(transactions, 'malformed-terminal');
  fs.mkdirSync(malformedDirectory);
  fs.writeFileSync(path.join(malformedDirectory, 'journal.json'), '{malformed\n');
  fs.utimesSync(path.join(malformedDirectory, 'journal.json'), oldTime, oldTime);
  fs.utimesSync(malformedDirectory, oldTime, oldTime);

  const nonScanDirectory = path.join(transactions, 'foreign-operation');
  fs.mkdirSync(nonScanDirectory);
  fs.writeFileSync(path.join(nonScanDirectory, 'journal.json'), `${JSON.stringify({
    contract_version: 1,
    kind: 'ingest',
    operation_id: 'foreign-operation',
    transitions: ['cleaned'],
  })}\n`);
  fs.utimesSync(path.join(nonScanDirectory, 'journal.json'), oldTime, oldTime);
  fs.utimesSync(nonScanDirectory, oldTime, oldTime);

  const linkedTarget = path.join(root, 'external-linked-terminal');
  copyCleanedTransaction('linked-terminal', oldTime, root);
  fs.renameSync(path.join(root, 'linked-terminal'), linkedTarget);
  const linkedEntry = path.join(transactions, 'linked-terminal');
  fs.symlinkSync(linkedTarget, linkedEntry, process.platform === 'win32' ? 'junction' : 'dir');

  const preserved = [
    inFlightDirectory,
    cleanedDirectory,
    malformedDirectory,
    nonScanDirectory,
  ];
  const preservedSnapshots = new Map(preserved.map((directory) => [
    directory,
    snapshotTree(directory),
  ]));
  const linkedTargetBefore = snapshotTree(linkedTarget);
  const beforeWrongToken = snapshotTree(transactions);
  const directoryCountBefore = fs.readdirSync(transactions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).length;
  assert.equal(directoryCountBefore, 7);

  const owner = acquireLock({ wikiRoot: root, operation: 'transaction-prune' });
  try {
    assert.throws(() => pruneScanWindowTransactions({
      wikiRoot: root,
      token: '0'.repeat(64),
      maxAgeDays: 7,
      limit: 2,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
    assert.deepEqual(snapshotTree(transactions), beforeWrongToken);

    const result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 2,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(result.removed, removableIds.slice(0, 2));
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.equal(fs.existsSync(removableDirectories[0]), false);
  assert.equal(fs.existsSync(removableDirectories[1]), false);
  assert.equal(fs.existsSync(removableDirectories[2]), true);
  for (const [directory, before] of preservedSnapshots) {
    assert.deepEqual(snapshotTree(directory), before, directory);
  }
  assert.equal(inFlightJournal.operation_id, path.basename(inFlightDirectory));
  assert.equal(fs.lstatSync(linkedEntry).isSymbolicLink(), true);
  assert.deepEqual(snapshotTree(linkedTarget), linkedTargetBefore);
  const directoryCountAfter = fs.readdirSync(transactions, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink()).length;
  assert.equal(directoryCountAfter, 5);
});

test('transaction pruning preserves a hard-linked terminal journal byte-identically', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki hard linked terminal ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const journal = path.join(
    metaPath(root, '.transactions'),
    completed.operationId,
    'journal.json',
  );
  const linked = path.join(root, 'linked-terminal-journal.json');
  fs.linkSync(journal, linked);
  const before = fs.readFileSync(journal);
  const owner = acquireLock({ wikiRoot: root, operation: 'hard-link-prune' });
  try {
    const result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 0,
      limit: 1,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(result.removed, []);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assert.deepEqual(fs.readFileSync(journal), before);
  assert.deepEqual(fs.readFileSync(linked), before);
  assert.equal(fs.statSync(journal).nlink, 2);
  assert.equal(fs.statSync(linked).nlink, 2);
});

test('transaction pruning preserves noncanonical terminal journal bytes', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki noncanonical terminal journal ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const transactions = metaPath(root, '.transactions');
  const source = path.join(transactions, completed.operationId);
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  const candidates = new Map();

  for (const [operationId, mutate] of [
    ['noncanonical-trailing-whitespace', (bytes) => bytes.replace(/\n$/, ' \n')],
    ['noncanonical-duplicate-key', (bytes, journal) =>
      bytes.replace(/^\{/, `{"kind":${JSON.stringify(journal.kind)},`)],
  ]) {
    const transaction = path.join(transactions, operationId);
    fs.cpSync(source, transaction, { recursive: true });
    const journalPath = path.join(transaction, 'journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    const canonical = `${JSON.stringify({ ...journal, operation_id: operationId })}\n`;
    const noncanonical = Buffer.from(mutate(canonical, journal));
    fs.writeFileSync(journalPath, noncanonical);
    fs.utimesSync(journalPath, oldTime, oldTime);
    fs.utimesSync(transaction, oldTime, oldTime);
    candidates.set(journalPath, noncanonical);
  }
  fs.rmSync(source, { recursive: true });

  const owner = acquireLock({ wikiRoot: root, operation: 'noncanonical-prune' });
  try {
    const result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 8,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(result, { processed: 0, removed: [], complete: true, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  for (const [journalPath, before] of candidates) {
    assert.deepEqual(fs.readFileSync(journalPath), before);
  }
});

test('transaction pruning preserves a terminal journal whose mtime becomes young after eligibility', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki terminal prune mtime race ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const transaction = path.join(
    metaPath(root, '.transactions'),
    completed.operationId,
  );
  const transactions = path.dirname(transaction);
  const journal = path.join(transaction, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const youngTime = new Date('2026-07-27T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const before = fs.readFileSync(journal);

  const originalReaddir = fs.readdirSync;
  let timestampChanged = false;
  fs.readdirSync = (pathname, ...args) => {
    if (!timestampChanged && pathname === transaction) {
      fs.utimesSync(journal, youngTime, youngTime);
      timestampChanged = true;
    }
    return originalReaddir(pathname, ...args);
  };
  const owner = acquireLock({ wikiRoot: root, operation: 'mtime-race-prune' });
  let result;
  try {
    result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
  } finally {
    fs.readdirSync = originalReaddir;
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.equal(timestampChanged, true);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(fs.readFileSync(journal), before);
  assert.equal(fs.statSync(journal).mtimeMs, youngTime.getTime());
  assert.deepEqual(fs.readdirSync(transaction), ['journal.json']);
});

test('transaction pruning preserves the whole quarantine when identity changes at rename', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki terminal prune empty quarantine ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const transaction = path.join(
    metaPath(root, '.transactions'),
    completed.operationId,
  );
  const transactions = path.dirname(transaction);
  const journal = path.join(transaction, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const youngTime = new Date('2026-07-27T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const before = fs.readFileSync(journal);

  const originalRename = fs.renameSync;
  let timestampChanged = false;
  fs.renameSync = (source, destination, ...args) => {
    if (!timestampChanged
        && source === transaction
        && path.dirname(destination) === transactions
        && path.basename(destination).startsWith('.prune-')) {
      fs.utimesSync(journal, youngTime, youngTime);
      timestampChanged = true;
    }
    return originalRename(source, destination, ...args);
  };
  const owner = acquireLock({ wikiRoot: root, operation: 'identity-rename-prune' });
  let result;
  try {
    result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
  } finally {
    fs.renameSync = originalRename;
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.equal(timestampChanged, true);
  assert.deepEqual(result.removed, []);
  const preservedJournal = fs.readdirSync(transactions, { recursive: true })
    .map((relative) => path.join(transactions, relative))
    .find((pathname) => {
      try { return fs.statSync(pathname).isFile() && fs.readFileSync(pathname).equals(before); }
      catch { return false; }
    });
  assert.ok(preservedJournal);
});

test('transaction pruning preserves the journal when a late transaction entry appears', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki terminal prune late entry ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const transaction = path.join(
    metaPath(root, '.transactions'),
    completed.operationId,
  );
  const transactions = path.dirname(transaction);
  const journal = path.join(transaction, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const journalBytes = fs.readFileSync(journal);

  const originalRename = fs.renameSync;
  let lateEntryCreated = false;
  fs.renameSync = (source, destination, ...args) => {
    if (!lateEntryCreated
        && source === transaction
        && path.dirname(destination) === transactions
        && path.basename(destination).startsWith('.prune-')) {
      fs.writeFileSync(path.join(transaction, 'late-entry'), 'ambiguous\n');
      lateEntryCreated = true;
    }
    return originalRename(source, destination, ...args);
  };
  const owner = acquireLock({ wikiRoot: root, operation: 'late-entry-prune' });
  let result;
  try {
    result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
  } finally {
    fs.renameSync = originalRename;
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.equal(lateEntryCreated, true);
  assert.deepEqual(result.removed, []);
  fs.rmSync(metaPath(root, '.pending-scan'), { force: true });
  const retry = ensurePendingScan({
    wikiRoot: root,
    proposed: T2,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(retry.status, 'deferred');
  const preservedJournal = fs.readdirSync(transactions, { recursive: true })
    .map((relative) => path.join(transactions, relative))
    .find((pathname) => {
      try {
        return fs.statSync(pathname).isFile()
          && fs.readFileSync(pathname).equals(journalBytes);
      } catch {
        return false;
      }
    });
  assert.ok(preservedJournal);
});

test('transaction pruning resumes an interrupted whole-directory quarantine', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki resumable terminal quarantine ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const transactions = metaPath(root, '.transactions');
  const transaction = path.join(transactions, completed.operationId);
  const journal = path.join(transaction, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const journalBytes = fs.readFileSync(journal);

  const originalUnlink = fs.unlinkSync;
  let unlinkRefused = false;
  fs.unlinkSync = (pathname, ...args) => {
    if (!unlinkRefused
        && path.basename(pathname) === 'journal.json'
        && path.basename(path.dirname(pathname)).startsWith('.prune-')) {
      unlinkRefused = true;
      const error = new Error('injected terminal quarantine interruption');
      error.code = 'EPERM';
      throw error;
    }
    return originalUnlink(pathname, ...args);
  };

  const owner = acquireLock({ wikiRoot: root, operation: 'resumable-quarantine-prune' });
  try {
    const first = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.equal(unlinkRefused, true);
    assert.deepEqual(first.removed, []);
  } finally {
    fs.unlinkSync = originalUnlink;
  }

  const quarantinedJournal = fs.readdirSync(transactions, { recursive: true })
    .map((relative) => path.join(transactions, relative))
    .find((pathname) => {
      try {
        return path.basename(path.dirname(pathname)).startsWith('.prune-')
          && fs.statSync(pathname).isFile()
          && fs.readFileSync(pathname).equals(journalBytes);
      } catch {
        return false;
      }
    });
  assert.ok(quarantinedJournal);

  try {
    const second = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(second.removed, [completed.operationId]);
    assert.equal(fs.existsSync(path.dirname(quarantinedJournal)), false);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('transaction pruning preserves the journal when its source reservation is replaced', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki replaced terminal prune reservation ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const transactions = metaPath(root, '.transactions');
  const transaction = path.join(transactions, completed.operationId);
  const journal = path.join(transaction, 'journal.json');
  const authenticReservation = path.join(root, 'authentic-prune-reservation');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const journalBytes = fs.readFileSync(journal);

  const originalRename = fs.renameSync;
  const originalUnlink = fs.unlinkSync;
  let reservationReplaced = false;
  fs.unlinkSync = (pathname, ...args) => {
    if (!reservationReplaced
        && path.basename(pathname) === 'journal.json'
        && path.basename(path.dirname(pathname)).startsWith('.prune-')) {
      originalRename(transaction, authenticReservation);
      fs.writeFileSync(transaction, 'replacement reservation\n');
      reservationReplaced = true;
    }
    return originalUnlink(pathname, ...args);
  };
  const owner = acquireLock({ wikiRoot: root, operation: 'replaced-reservation-prune' });
  let result;
  try {
    result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
  } finally {
    fs.unlinkSync = originalUnlink;
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.equal(reservationReplaced, true);
  assert.deepEqual(result.removed, []);
  const preservedJournal = fs.readdirSync(transactions, { recursive: true })
    .map((relative) => path.join(transactions, relative))
    .find((pathname) => {
      try {
        return fs.statSync(pathname).isFile()
          && fs.readFileSync(pathname).equals(journalBytes);
      } catch {
        return false;
      }
    });
  assert.ok(preservedJournal);
  assert.equal(fs.statSync(authenticReservation).isFile(), true);
});

test('transaction pruning preserves exact evidence when its reservation is replaced during backup unlink', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki replaced reservation at backup unlink ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const transactions = metaPath(root, '.transactions');
  const transaction = path.join(transactions, completed.operationId);
  const journal = path.join(transaction, 'journal.json');
  const authenticReservation = path.join(transactions, '.authentic-prune-reservation');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const journalBytes = fs.readFileSync(journal);

  const originalRename = fs.renameSync;
  const originalUnlink = fs.unlinkSync;
  let reservationReplaced = false;
  fs.unlinkSync = (pathname, ...args) => {
    if (!reservationReplaced
        && path.basename(pathname) === 'journal.backup'
        && path.basename(path.dirname(pathname)).startsWith('.prune-')) {
      originalRename(transaction, authenticReservation);
      fs.writeFileSync(transaction, 'replacement reservation\n');
      reservationReplaced = true;
    }
    return originalUnlink(pathname, ...args);
  };
  const owner = acquireLock({ wikiRoot: root, operation: 'backup-unlink-replacement-prune' });
  let result;
  try {
    result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
  } finally {
    fs.unlinkSync = originalUnlink;
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.equal(reservationReplaced, true);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(fs.readFileSync(authenticReservation), journalBytes);
});

test('transaction pruning resumes every interrupted reservation and backup publication phase', async (t) => {
  const scenarios = [
    ['source.reservation.pending', 'after-open'],
    ['source.reservation.pending', 'partial-write'],
    ['source.reservation.pending', 'before-fsync'],
    ['journal.backup.pending', 'after-open'],
    ['journal.backup.pending', 'partial-write'],
    ['journal.backup.pending', 'before-fsync'],
  ];
  for (const [targetName, phase] of scenarios) {
    await t.test(`${targetName}:${phase}`, () => {
      const {
        acquireLock,
        createDeadline,
        ensurePendingScan,
        pruneScanWindowTransactions,
        releaseLock,
      } = modules();
      const root = temporaryWiki(`deep wiki interrupted ${targetName} ${phase} `);
      const completed = ensurePendingScan({
        wikiRoot: root,
        proposed: T1,
        deadline: createDeadline({ budgetMs: 12_000 }),
      });
      assert.notEqual(completed.status, 'deferred');
      certifyEnsurePromotion(root, T1, completed);
      const transactions = metaPath(root, '.transactions');
      const journal = path.join(transactions, completed.operationId, 'journal.json');
      const oldTime = new Date('2026-07-01T00:00:00.000Z');
      const pruneNow = new Date('2026-07-28T00:00:00.000Z');
      fs.utimesSync(journal, oldTime, oldTime);

      const originalOpen = fs.openSync;
      const originalWrite = fs.writeFileSync;
      const originalFsync = fs.fsyncSync;
      const tracked = new Set();
      let interrupted = false;
      fs.openSync = (pathname, ...args) => {
        const descriptor = originalOpen(pathname, ...args);
        if (!interrupted && path.basename(pathname) === targetName) {
          tracked.add(descriptor);
          if (phase === 'after-open') {
            fs.closeSync(descriptor);
            interrupted = true;
            const error = new Error('injected interruption after publication open');
            error.code = 'EIO';
            throw error;
          }
        }
        return descriptor;
      };
      fs.writeFileSync = (target, bytes, ...args) => {
        if (!interrupted && tracked.has(target) && phase === 'partial-write') {
          originalWrite(target, Buffer.from(bytes).subarray(0, Math.max(1, bytes.length >> 1)));
          interrupted = true;
          const error = new Error('injected partial publication write');
          error.code = 'EIO';
          throw error;
        }
        return originalWrite(target, bytes, ...args);
      };
      fs.fsyncSync = (descriptor, ...args) => {
        if (!interrupted && tracked.has(descriptor) && phase === 'before-fsync') {
          interrupted = true;
          const error = new Error('injected interruption before publication fsync');
          error.code = 'EIO';
          throw error;
        }
        return originalFsync(descriptor, ...args);
      };

      const owner = acquireLock({ wikiRoot: root, operation: 'publication-interruption-prune' });
      try {
        const first = pruneScanWindowTransactions({
          wikiRoot: root,
          token: owner.token,
          maxAgeDays: 7,
          limit: 1,
          now: pruneNow,
          deadline: createDeadline({ budgetMs: 12_000 }),
        });
        assert.equal(interrupted, true);
        assert.deepEqual(first.removed, []);
      } finally {
        fs.openSync = originalOpen;
        fs.writeFileSync = originalWrite;
        fs.fsyncSync = originalFsync;
      }

      try {
        const second = pruneScanWindowTransactions({
          wikiRoot: root,
          token: owner.token,
          maxAgeDays: 7,
          limit: 1,
          now: pruneNow,
          deadline: createDeadline({ budgetMs: 12_000 }),
        });
        assert.deepEqual(second.removed, [completed.operationId]);
        assert.equal(fs.readdirSync(transactions).length, 0);
      } finally {
        releaseLock({ wikiRoot: root, token: owner.token });
      }
    });
  }
});

test('transaction pruning resumes when only the sealed quarantine backup remains', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki resumable terminal prune backup ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const transactions = metaPath(root, '.transactions');
  const journal = path.join(transactions, completed.operationId, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const journalBytes = fs.readFileSync(journal);

  const originalUnlink = fs.unlinkSync;
  let backupUnlinkRefused = false;
  fs.unlinkSync = (pathname, ...args) => {
    if (!backupUnlinkRefused
        && path.basename(pathname) === 'journal.backup'
        && path.basename(path.dirname(pathname)).startsWith('.prune-')) {
      backupUnlinkRefused = true;
      const error = new Error('injected terminal backup cleanup refusal');
      error.code = 'EPERM';
      throw error;
    }
    return originalUnlink(pathname, ...args);
  };

  const owner = acquireLock({ wikiRoot: root, operation: 'resumable-backup-prune' });
  try {
    const first = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.equal(backupUnlinkRefused, true);
    assert.deepEqual(first.removed, []);
  } finally {
    fs.unlinkSync = originalUnlink;
  }

  const quarantinedBackup = fs.readdirSync(transactions, { recursive: true })
    .map((relative) => path.join(transactions, relative))
    .find((pathname) => {
      try {
        return path.basename(pathname) === 'journal.backup'
          && fs.statSync(pathname).isFile()
          && fs.readFileSync(pathname).equals(journalBytes);
      } catch {
        return false;
      }
    });
  assert.ok(quarantinedBackup);

  try {
    const second = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(second.removed, [completed.operationId]);
    assert.equal(fs.existsSync(path.dirname(quarantinedBackup)), false);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('transaction pruning resumes an empty quarantine under its active reservation', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki resumable empty terminal quarantine ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const transactions = metaPath(root, '.transactions');
  const journal = path.join(transactions, completed.operationId, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);

  const originalRmdir = fs.rmdirSync;
  let quarantineRemovalRefused = false;
  fs.rmdirSync = (pathname, ...args) => {
    if (!quarantineRemovalRefused
        && path.basename(pathname).startsWith('.prune-')) {
      quarantineRemovalRefused = true;
      const error = new Error('injected empty quarantine cleanup refusal');
      error.code = 'EPERM';
      throw error;
    }
    return originalRmdir(pathname, ...args);
  };

  const owner = acquireLock({ wikiRoot: root, operation: 'resumable-empty-prune' });
  let emptyQuarantine;
  try {
    const first = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.equal(quarantineRemovalRefused, true);
    assert.deepEqual(first.removed, []);
    emptyQuarantine = fs.readdirSync(transactions)
      .find((name) => name.startsWith('.prune-'));
    assert.ok(emptyQuarantine);
    assert.deepEqual(fs.readdirSync(path.join(transactions, emptyQuarantine)), []);
    assert.equal(fs.statSync(path.join(transactions, completed.operationId)).isFile(), true);
  } finally {
    fs.rmdirSync = originalRmdir;
  }

  try {
    const second = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(second.removed, [completed.operationId]);
    assert.equal(fs.existsSync(path.join(transactions, emptyQuarantine)), false);
    assert.equal(fs.existsSync(path.join(transactions, completed.operationId)), false);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('transaction pruning removes an orphaned exact source reservation on retry', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki orphaned exact prune reservation ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const transactions = metaPath(root, '.transactions');
  const transaction = path.join(transactions, completed.operationId);
  const journal = path.join(transaction, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);

  const originalUnlink = fs.unlinkSync;
  let reservationUnlinkRefused = false;
  fs.unlinkSync = (pathname, ...args) => {
    if (!reservationUnlinkRefused
        && pathname === transaction
        && fs.statSync(pathname).isFile()) {
      reservationUnlinkRefused = true;
      const error = new Error('injected exact reservation cleanup refusal');
      error.code = 'EPERM';
      throw error;
    }
    return originalUnlink(pathname, ...args);
  };
  const owner = acquireLock({ wikiRoot: root, operation: 'exact-reservation-prune' });
  try {
    const first = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.equal(reservationUnlinkRefused, true);
    assert.deepEqual(first.removed, []);
  } finally {
    fs.unlinkSync = originalUnlink;
  }

  assert.equal(fs.statSync(transaction).isFile(), true);
  try {
    const second = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(second.removed, [completed.operationId]);
    assert.equal(fs.existsSync(transaction), false);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('transaction pruning quarantines before deletion and preserves a last-check pathname replacement', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki terminal prune final identity race ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const transaction = path.join(
    metaPath(root, '.transactions'),
    completed.operationId,
  );
  const transactions = path.dirname(transaction);
  const journal = path.join(transaction, 'journal.json');
  const authentic = path.join(root, 'authenticated-terminal-journal.json');
  const replacement = Buffer.from('replacement must survive\n');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const authenticBytes = fs.readFileSync(journal);

  const originalLstat = fs.lstatSync;
  let journalChecks = 0;
  let pathnameReplaced = false;
  fs.lstatSync = (pathname, ...args) => {
    const stat = originalLstat(pathname, ...args);
    if (pathname === journal && ++journalChecks === 3) {
      fs.renameSync(journal, authentic);
      fs.writeFileSync(journal, replacement);
      pathnameReplaced = true;
    }
    return stat;
  };
  const owner = acquireLock({ wikiRoot: root, operation: 'final-identity-race-prune' });
  let result;
  try {
    result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
  } finally {
    fs.lstatSync = originalLstat;
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.equal(pathnameReplaced, true);
  assert.deepEqual(result.removed, []);
  assert.deepEqual(fs.readFileSync(authentic), authenticBytes);
  const survivingReplacement = fs.readdirSync(transactions, { recursive: true })
    .map((relative) => path.join(transactions, relative))
    .find((pathname) => {
      try { return fs.statSync(pathname).isFile() && fs.readFileSync(pathname).equals(replacement); }
      catch { return false; }
    });
  assert.ok(survivingReplacement);
});

test('transaction pruning reports incomplete traversal when its reserve expires before a late candidate', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki terminal prune incomplete deadline ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const transactions = metaPath(root, '.transactions');
  const source = path.join(transactions, completed.operationId);
  const youngId = 'a-young-terminal';
  const oldId = 'z-old-terminal';
  const young = path.join(transactions, youngId);
  const old = path.join(transactions, oldId);
  const youngTime = new Date('2026-07-27T00:00:00.000Z');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  for (const [operationId, destination, timestamp] of [
    [youngId, young, youngTime],
    [oldId, old, oldTime],
  ]) {
    fs.cpSync(source, destination, { recursive: true });
    const journal = path.join(destination, 'journal.json');
    const value = JSON.parse(fs.readFileSync(journal, 'utf8'));
    fs.writeFileSync(journal, `${JSON.stringify({ ...value, operation_id: operationId })}\n`);
    fs.utimesSync(journal, timestamp, timestamp);
  }
  fs.rmSync(source, { recursive: true });

  const clock = makeClock();
  const originalReadFile = fs.readFileSync;
  let advanced = false;
  fs.readFileSync = (pathname, ...args) => {
    const value = originalReadFile(pathname, ...args);
    if (!advanced && pathname === path.join(young, 'journal.json')) {
      clock.advance(800);
      advanced = true;
    }
    return value;
  };
  const owner = acquireLock({ wikiRoot: root, operation: 'incomplete-prune' });
  let first;
  try {
    first = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 8,
      now: pruneNow,
      deadline: createDeadline({ clock, budgetMs: 1_000 }),
    });
  } finally {
    fs.readFileSync = originalReadFile;
  }
  assert.equal(advanced, true);
  assert.deepEqual(first, { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
  assert.equal(fs.existsSync(old), true);

  try {
    const second = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 8,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(second, { processed: 1, removed: [oldId], complete: true, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('transaction prune stops between recoverable cleanup phases when cumulative work expires', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki cumulative prune deadline ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const transactions = metaPath(root, '.transactions');
  const journal = path.join(transactions, completed.operationId, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const journalBytes = fs.readFileSync(journal);
  let clockValue = -150;
  const clock = { nowMs: () => { clockValue += 150; return clockValue; } };

  const owner = acquireLock({ wikiRoot: root, operation: 'cumulative-deadline-prune' });
  try {
    const first = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ clock, budgetMs: 1_000 }),
    });
    assert.deepEqual(first, { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
    const preserved = fs.readdirSync(transactions, { recursive: true })
      .map((relative) => path.join(transactions, relative))
      .some((pathname) => {
        try {
          return fs.statSync(pathname).isFile()
            && fs.readFileSync(pathname).equals(journalBytes);
        } catch {
          return false;
        }
      });
    assert.equal(preserved, true);

    const second = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.deepEqual(second, {
      processed: 1,
      removed: [completed.operationId],
      complete: true,
      skipped_oversized: [],
      blocked: [],
      blocked_count: 0,
      blocked_truncated: false,
      deferred_count: 0,
    });
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('transaction prune bounds cumulative filesystem discovery after its deadline expires', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki bounded prune discovery ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const transaction = path.join(
    metaPath(root, '.transactions'),
    completed.operationId,
  );
  const journal = path.join(transaction, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  const pruneNow = new Date('2026-07-28T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const journalBytes = fs.readFileSync(journal);
  const clock = makeClock();
  const owner = acquireLock({ wikiRoot: root, operation: 'bounded-discovery-prune' });
  const methods = ['lstatSync', 'readFileSync', 'readdirSync'];
  const originals = new Map(methods.map((name) => [name, fs[name]]));
  for (const name of methods) {
    fs[name] = (...args) => {
      const value = originals.get(name)(...args);
      clock.advance(90);
      return value;
    };
  }

  let result;
  try {
    result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: pruneNow,
      deadline: createDeadline({ clock, budgetMs: 1_000 }),
    });
  } finally {
    for (const [name, original] of originals) fs[name] = original;
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.deepEqual(result, { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
  assert.ok(clock.nowMs() <= 2_000, `discovery stopped at ${clock.nowMs()} ms`);
  assert.deepEqual(fs.readFileSync(journal), journalBytes);
  assert.deepEqual(fs.readdirSync(transaction), ['journal.json']);
});

test('transaction prune returns incomplete when its deadline expires during owner preflight', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki bounded prune owner preflight ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const transaction = path.join(
    metaPath(root, '.transactions'),
    completed.operationId,
  );
  const journal = path.join(transaction, 'journal.json');
  const journalBytes = fs.readFileSync(journal);
  const clock = makeClock();
  const owner = acquireLock({ wikiRoot: root, operation: 'bounded-owner-preflight-prune' });
  const originalRealpath = fs.realpathSync.native;
  const originalRead = fs.readFileSync;
  fs.realpathSync.native = (...args) => {
    const value = originalRealpath(...args);
    clock.advance(700);
    return value;
  };
  fs.readFileSync = (...args) => {
    const value = originalRead(...args);
    clock.advance(700);
    return value;
  };

  let result;
  try {
    result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: new Date('2026-07-28T00:00:00.000Z'),
      deadline: createDeadline({ clock, budgetMs: 1_000 }),
    });
  } finally {
    fs.realpathSync.native = originalRealpath;
    fs.readFileSync = originalRead;
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.deepEqual(result, { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
  assert.equal(clock.nowMs(), 1_400);
  assert.deepEqual(fs.readFileSync(journal), journalBytes);
  assert.deepEqual(fs.readdirSync(transaction), ['journal.json']);
});

test('transaction prune does not wrap deadline expiry during final journal validation', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki bounded prune final journal validation ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const transaction = path.join(
    metaPath(root, '.transactions'),
    completed.operationId,
  );
  const journal = path.join(transaction, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const journalBytes = fs.readFileSync(journal);
  const clock = makeClock();
  const owner = acquireLock({ wikiRoot: root, operation: 'bounded-final-journal-prune' });
  const originalRead = fs.readFileSync;
  fs.readFileSync = (pathname, ...args) => {
    const value = originalRead(pathname, ...args);
    if (pathname === journal) clock.advance(500);
    return value;
  };

  let result;
  try {
    result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: new Date('2026-07-28T00:00:00.000Z'),
      deadline: createDeadline({ clock, budgetMs: 1_000 }),
    });
  } finally {
    fs.readFileSync = originalRead;
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.deepEqual(result, { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
  assert.equal(clock.nowMs(), 1_000);
  assert.deepEqual(fs.readFileSync(journal), journalBytes);
  assert.deepEqual(fs.readdirSync(transaction), ['journal.json']);
});

test('transaction prune checks its deadline within guarded parent validation', () => {
  const {
    acquireLock,
    createDeadline,
    ensurePendingScan,
    pruneScanWindowTransactions,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki bounded prune guarded parents ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const transactions = metaPath(root, '.transactions');
  const transaction = path.join(transactions, completed.operationId);
  const journal = path.join(transaction, 'journal.json');
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  fs.utimesSync(journal, oldTime, oldTime);
  const journalBytes = fs.readFileSync(journal);
  const clock = makeClock();
  const owner = acquireLock({ wikiRoot: root, operation: 'bounded-parent-guard-prune' });
  const guardedPaths = new Set([path.join(root, '.wiki-meta'), transactions, transaction]);
  const originalLstat = fs.lstatSync;
  fs.lstatSync = (pathname, ...args) => {
    const value = originalLstat(pathname, ...args);
    if (guardedPaths.has(pathname)) clock.advance(300);
    return value;
  };

  let result;
  try {
    result = pruneScanWindowTransactions({
      wikiRoot: root,
      token: owner.token,
      maxAgeDays: 7,
      limit: 1,
      now: new Date('2026-07-28T00:00:00.000Z'),
      deadline: createDeadline({ clock, budgetMs: 1_000 }),
    });
  } finally {
    fs.lstatSync = originalLstat;
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  assert.deepEqual(result, { processed: 0, removed: [], complete: false, skipped_oversized: [], blocked: [], blocked_count: 0, blocked_truncated: false, deferred_count: 0 });
  assert.ok(clock.nowMs() <= 1_500, `guarded validation stopped at ${clock.nowMs()} ms`);
  assert.deepEqual(fs.readFileSync(journal), journalBytes);
  assert.deepEqual(fs.readdirSync(transaction), ['journal.json']);
});

test('transaction prune CLI exposes bounded terminal cleanup under the caller lock', () => {
  const { acquireLock, createDeadline, ensurePendingScan, releaseLock } = modules();
  const root = temporaryWiki('deep wiki transaction prune cli ');
  const completed = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.notEqual(completed.status, 'deferred');
  certifyEnsurePromotion(root, T1, completed);
  const completedDirectory = path.dirname(journalFiles(root)[0]);
  const oldTime = new Date('2026-07-01T00:00:00.000Z');
  fs.utimesSync(path.join(completedDirectory, 'journal.json'), oldTime, oldTime);
  fs.utimesSync(completedDirectory, oldTime, oldTime);
  const owner = acquireLock({ wikiRoot: root, operation: 'transaction-prune-cli' });
  try {
    const result = spawnSync(process.execPath, [
      cliPath,
      'transaction', 'prune',
      '--wiki-root', root,
      '--lock-token', owner.token,
      '--max-age-days', '0',
      '--json',
    ], {
      encoding: 'utf8',
      shell: false,
      timeout: 5_000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout).removed, [completed.operationId]);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('ensurePendingScan is stale at or before last-scan and repairs corrupt pending only for a newer proposal', () => {
  const { ensurePendingScan, createDeadline } = modules();
  const root = temporaryWiki('deep wiki stale ensure ');
  setState(root, { last: `${T2}\n` });
  assert.equal(ensurePendingScan({
    wikiRoot: root, proposed: T2, now: new Date(T2), deadline: createDeadline({ budgetMs: 12_000 }),
  }).status, 'stale');
  assertState(root, { pending: null, last: `${T2}\n` });
  fs.writeFileSync(metaPath(root, '.pending-scan'), Buffer.from([0xff, 0x00]));
  assert.equal(ensurePendingScan({
    wikiRoot: root, proposed: T3, now: new Date(T3), deadline: createDeadline({ budgetMs: 12_000 }),
  }).status, 'created');
  assertState(root, { pending: `${T3}\n`, last: `${T2}\n` });
});

test('ensurePendingScan defers quietly on bounded lock contention without a lock-free fallback', () => {
  const { acquireLock, releaseLock, ensurePendingScan, createDeadline } = modules();
  const root = temporaryWiki('deep wiki ensure contention ');
  const owner = acquireLock({ wikiRoot: root, operation: 'held' });
  try {
    const result = ensurePendingScan({
      wikiRoot: root, proposed: T1, now: new Date(T1), deadline: createDeadline({ budgetMs: 25 }),
    });
    assert.deepEqual(result, { status: 'deferred', reason: 'LOCK_CONTENDED' });
    assertState(root, { pending: null, last: null });
    assert.equal(journalFiles(root).length, 0);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

for (const linkedParent of ['.wiki-meta', '.transactions', 'operation']) {
  test(`default transaction adapter rejects a ${linkedParent} directory link before external mutation`, () => {
    const { acquireLock, releaseLock, promotePendingScan } = modules();
    const root = temporaryWiki(`deep wiki linked ${linkedParent} transaction parent `);
    const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `deep wiki outside ${linkedParent} `)));
    roots.add(outside);
    const operationId = `linked-${linkedParent.replace('.', '')}-operation`;
    const meta = metaPath(root, '');
    const transactions = path.join(meta, '.transactions');
    const operation = path.join(transactions, operationId);
    let linkedPath;
    let linkedTarget;
    let externalOperation;

    if (linkedParent === '.wiki-meta') {
      linkedPath = meta;
      linkedTarget = outside;
      externalOperation = path.join(outside, '.transactions', operationId);
      fs.rmSync(meta, { recursive: true });
    } else if (linkedParent === '.transactions') {
      linkedPath = transactions;
      linkedTarget = outside;
      externalOperation = path.join(outside, operationId);
      fs.rmSync(transactions, { recursive: true });
    } else {
      linkedPath = operation;
      linkedTarget = outside;
      externalOperation = outside;
    }

    fs.mkdirSync(externalOperation, { recursive: true });
    fs.writeFileSync(path.join(outside, 'external-sentinel.bin'), Buffer.from([0x00, 0xff, 0x41, 0x0a]));
    fs.writeFileSync(path.join(externalOperation, 'pending.removed'), 'preserve external tombstone\n');
    fs.symlinkSync(linkedTarget, linkedPath, process.platform === 'win32' ? 'junction' : 'dir');

    const owner = acquireLock({ wikiRoot: root, operation: `linked-${linkedParent}-owner` });
    setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
    const beforeExternal = snapshotTree(outside);
    const beforeState = state(root);
    const boundaries = [];
    let result;
    let observedError;
    try {
      result = promotePendingScan({
        wikiRoot: root,
        token: owner.token,
        expected: T1,
        operationId,
        now: new Date(T3),
        faultInjector(boundary) { boundaries.push(boundary); },
      });
    } catch (error) {
      observedError = error;
    }
    const afterExternal = snapshotTree(outside);
    const afterState = state(root);
    releaseLock({ wikiRoot: root, token: owner.token });

    assert.equal(observedError?.code, 'SCAN_WINDOW_FILESYSTEM', JSON.stringify({
      result,
      error: observedError && { code: observedError.code, message: observedError.message },
      boundaries,
    }));
    assert.deepEqual(boundaries, []);
    assert.deepEqual(afterExternal, beforeExternal);
    assert.deepEqual(afterState, beforeState);
  });
}

test('ensurePendingScan enforces its persistence deadline at journal, stage, destination, commit, and cleanup boundaries', async (t) => {
  const boundaries = [
    'after-transaction-activate',
    'after-stage-pending-after',
    'after-pending-rename',
    'after-scan-window-committed',
    'before-cleanup',
  ];
  for (const boundary of boundaries) {
    await t.test(boundary, () => {
      const { ensurePendingScan, createDeadline } = modules();
      const root = temporaryWiki(`deep wiki persistence deadline ${boundary} `);
      const clock = makeClock();
      let advanced = false;
      const result = ensurePendingScan({
        wikiRoot: root,
        proposed: T1,
        now: new Date(T1),
        deadline: createDeadline({ clock, budgetMs: 10 }),
        faultInjector(stage) {
          if (stage === boundary && !advanced) {
            advanced = true;
            clock.advance(10);
          }
        },
      });
      assert.equal(advanced, true);
      assert.deepEqual(result, { status: 'deferred', reason: 'DEADLINE_EXCEEDED' });
      assert.equal(fs.existsSync(metaPath(root, '.wiki-lock')), false);
      const journals = journalFiles(root);
      assert.equal(journals.length, 1);
      const interrupted = JSON.parse(fs.readFileSync(journals[0], 'utf8'));
      assert.equal(interrupted.transitions[0], 'scan-window-preflighted');
      assert.equal(interrupted.transitions.includes('cleaned'), false);

      const retryClock = makeClock();
      const retry = ensurePendingScan({
        wikiRoot: root,
        proposed: T1,
        now: new Date(T1),
        deadline: createDeadline({ clock: retryClock, budgetMs: 10 }),
      });
      assert.equal(retry.status, 'created');
      assertState(root, { pending: `${T1}\n`, last: null });
      const recovered = JSON.parse(fs.readFileSync(journals[0], 'utf8'));
      assert.equal(recovered.transitions.at(-1), 'cleaned');
    });
  }
});

test('deadline deferral releases only the caller token and preserves a successor takeover', () => {
  const { ensurePendingScan, createDeadline, recoverLock, acquireLock, assertLockOwner, releaseLock } = modules();
  const root = temporaryWiki('deep wiki deadline successor takeover ');
  const clock = makeClock();
  let successor;
  const result = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    now: new Date(T1),
    deadline: createDeadline({ clock, budgetMs: 10 }),
    faultInjector(stage) {
      if (stage !== 'after-transaction-activate') return;
      clock.advance(10);
      replaceLiveLockExternallyAtInjectedGuard(root);
      successor = acquireLock({ wikiRoot: root, operation: 'deadline-successor' });
    },
  });
  assert.deepEqual(result, { status: 'deferred', reason: 'DEADLINE_EXCEEDED' });
  assert.equal(assertLockOwner({ wikiRoot: root, token: successor.token }).operation, 'deadline-successor');
  releaseLock({ wikiRoot: root, token: successor.token });
});

test('non-expired takeover after journal creation fences every later transaction metadata mutation', () => {
  const {
    ensurePendingScan, createDeadline, recoverLock, acquireLock, assertLockOwner, releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki token successor after journal ');
  let successor;
  let transaction;
  let atTakeover;
  const result = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    now: new Date(T1),
    deadline: createDeadline({ budgetMs: 12_000 }),
    faultInjector(stage) {
      if (stage !== 'after-transaction-activate') return;
      replaceLiveLockExternallyAtInjectedGuard(root);
      successor = acquireLock({ wikiRoot: root, operation: 'journal-successor' });
      transaction = path.dirname(journalFiles(root)[0]);
      atTakeover = snapshotFlatDirectory(transaction);
    },
  });
  assert.deepEqual(result, { status: 'deferred', reason: 'LOCK_TOKEN_MISMATCH' });
  assert.deepEqual(snapshotFlatDirectory(transaction), atTakeover);
  assert.equal(Object.keys(atTakeover).filter((name) => name.startsWith('stage-')).length, 0);
  assert.deepEqual(JSON.parse(Buffer.from(atTakeover['journal.json'], 'base64')), {
    ...JSON.parse(Buffer.from(atTakeover['journal.json'], 'base64')),
    transitions: ['scan-window-preflighted'],
  });
  assert.equal(assertLockOwner({ wikiRoot: root, token: successor.token }).operation, 'journal-successor');
  releaseLock({ wikiRoot: root, token: successor.token });
});

test('token takeover at every transaction publication and cleanup seam performs zero later metadata mutation', async (t) => {
  const boundaries = [
    'before-stage-pending-before-write',
    'before-stage-pending-after-write',
    'before-stage-last-before-write',
    'before-stage-last-after-write',
    'before-transition-scan-window-staged-write',
    'before-transition-last-scan-written-write',
    'before-transition-pending-scan-written-write',
    'before-transition-scan-window-committed-write',
    'before-stage-pending-before-remove',
    'before-stage-pending-after-remove',
    'before-stage-last-before-remove',
    'before-stage-last-after-remove',
    'before-tombstone-cleanup-remove',
    'before-transition-cleaned-write',
  ];
  for (const boundary of boundaries) {
    await t.test(boundary, () => {
      const { promotePendingScan, acquireLock, recoverLock, assertLockOwner, releaseLock } = modules();
      const root = temporaryWiki(`deep wiki transaction token fence ${boundary} `);
      setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
      const operationId = `token-fence-${boundary}`;
      const transaction = metaPath(root, path.join('.transactions', operationId));
      const owner = acquireLock({ wikiRoot: root, operation: 'old-promoter' });
      let successor;
      let atTakeover;
      let injected = false;
      assert.throws(() => promotePendingScan({
        wikiRoot: root,
        token: owner.token,
        expected: T1,
        operationId,
        faultInjector(stage) {
          if (injected || stage !== boundary) return;
          injected = true;
          replaceLiveLockExternallyAtInjectedGuard(root);
          successor = acquireLock({ wikiRoot: root, operation: `successor-${boundary}` });
          atTakeover = snapshotFlatDirectory(transaction);
        },
      }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
      assert.equal(injected, true);
      assert.deepEqual(snapshotFlatDirectory(transaction), atTakeover);
      assert.equal(assertLockOwner({ wikiRoot: root, token: successor.token }).operation, `successor-${boundary}`);
      releaseLock({ wikiRoot: root, token: successor.token });
    });
  }
});

test('token takeover before default transaction-directory creation performs no directory mutation', () => {
  const {
    ensurePendingScan, createDeadline, recoverLock, acquireLock, assertLockOwner, releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki transaction directory fence ');
  const transactions = metaPath(root, '.transactions');
  let successor;
  let injected = false;
  const result = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    now: new Date(T1),
    deadline: createDeadline({ budgetMs: 12_000 }),
    faultInjector(stage) {
      if (stage !== 'before-transaction-directory-create') return;
      injected = true;
      replaceLiveLockExternallyAtInjectedGuard(root);
      successor = acquireLock({ wikiRoot: root, operation: 'transaction-directory-successor' });
      assert.deepEqual(fs.readdirSync(transactions), []);
    },
  });
  assert.equal(injected, true);
  assert.deepEqual(result, { status: 'deferred', reason: 'LOCK_TOKEN_MISMATCH' });
  assert.deepEqual(fs.readdirSync(transactions), []);
  assert.equal(assertLockOwner({ wikiRoot: root, token: successor.token }).operation, 'transaction-directory-successor');
  releaseLock({ wikiRoot: root, token: successor.token });
});

test('old pending publication cannot overwrite a successor commit after temp identity validation', () => {
  const {
    ensurePendingScan, planScanWindowTransition, applyScanWindowTransition,
    createDeadline, acquireLock, assertLockOwner, releaseLock, recoverLock,
  } = modules();
  const root = temporaryWiki('deep wiki pending post-identity takeover ');
  setState(root, { last: `${T0}\n` });
  const originalLstat = fs.lstatSync;
  let injected = false;
  let successor;
  fs.lstatSync = function injectedLstat(pathname, options) {
    if (!injected && String(pathname).includes('.pending-scan.tmp.')) {
      injected = true;
      replaceLiveLockExternallyAtInjectedGuard(root);
      successor = acquireLock({ wikiRoot: root, operation: 'pending-successor' });
      const plan = planScanWindowTransition({ wikiRoot: root, kind: 'ensure', proposed: T2 });
      const committed = applyScanWindowTransition({
        wikiRoot: root,
        token: successor.token,
        plan,
        operationId: 'pending-successor-commit',
        deadline: createDeadline({ budgetMs: 12_000 }),
      });
      assert.equal(committed.status, 'created');
    }
    return originalLstat.call(fs, pathname, options);
  };
  let result;
  try {
    result = ensurePendingScan({
      wikiRoot: root,
      proposed: T1,
      deadline: createDeadline({ budgetMs: 12_000 }),
    });
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.equal(injected, true);
  assert.deepEqual(result, { status: 'deferred', reason: 'LOCK_TOKEN_MISMATCH' });
  assert.equal(readMaybe(metaPath(root, '.pending-scan')).toString('utf8'), `${T2}\n`);
  assert.equal(assertLockOwner({ wikiRoot: root, token: successor.token }).operation, 'pending-successor');
  releaseLock({ wikiRoot: root, token: successor.token });
});

test('transaction parent rejects reused dev and inode with a changed birth-time generation', () => {
  const { ensurePendingScan, createDeadline } = modules();
  const root = temporaryWiki('deep wiki transaction parent generation ');
  const meta = metaPath(root, '.');
  const originalLstat = fs.lstatSync;
  let changed = false;
  fs.lstatSync = function generationLstat(pathname, options) {
    const stat = originalLstat.call(fs, pathname, options);
    if (path.resolve(String(pathname)) !== path.resolve(meta) || options?.bigint !== true) return stat;
    return {
      ...stat,
      dev: 19n,
      ino: 23n,
      birthtimeNs: changed ? 200n : 100n,
    };
  };
  let result;
  try {
    result = ensurePendingScan({
      wikiRoot: root,
      proposed: T1,
      deadline: createDeadline({ budgetMs: 12_000 }),
      faultInjector(stage) {
        if (stage === 'before-transaction-activate') changed = true;
      },
    });
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.deepEqual(result, { status: 'deferred', reason: 'SCAN_WINDOW_FILESYSTEM' });
  assert.equal(readMaybe(metaPath(root, '.pending-scan')), null);
});

test('old last-scan publication cannot overwrite a successor repair after temp identity validation', () => {
  const {
    promotePendingScan, planScanWindowTransition, applyScanWindowTransition,
    acquireLock, assertLockOwner, releaseLock, recoverLock,
  } = modules();
  const root = temporaryWiki('deep wiki last post-identity takeover ');
  setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
  const oldOwner = acquireLock({ wikiRoot: root, operation: 'old-promoter' });
  const originalLstat = fs.lstatSync;
  let injected = false;
  let successor;
  fs.lstatSync = function injectedLstat(pathname, options) {
    if (!injected && String(pathname).includes('.last-scan.tmp.')) {
      injected = true;
      replaceLiveLockExternallyAtInjectedGuard(root);
      successor = acquireLock({ wikiRoot: root, operation: 'last-successor' });
      const pendingBytes = readMaybe(metaPath(root, '.pending-scan'));
      const plan = planScanWindowTransition({
        wikiRoot: root,
        kind: 'repair',
        pendingAfter: pendingBytes,
        lastAfter: Buffer.from(`${T2}\n`),
      });
      const committed = applyScanWindowTransition({
        wikiRoot: root,
        token: successor.token,
        plan,
        operationId: 'last-successor-commit',
      });
      assert.equal(committed.status, 'repaired');
    }
    return originalLstat.call(fs, pathname, options);
  };
  try {
    assert.throws(() => promotePendingScan({
      wikiRoot: root,
      token: oldOwner.token,
      expected: T1,
      operationId: 'old-promoter-commit',
    }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
  } finally {
    fs.lstatSync = originalLstat;
  }
  assert.equal(injected, true);
  assert.equal(readMaybe(metaPath(root, '.last-scan')).toString('utf8'), `${T2}\n`);
  assert.equal(assertLockOwner({ wikiRoot: root, token: successor.token }).operation, 'last-successor');
  releaseLock({ wikiRoot: root, token: successor.token });
});

test('promotePendingScan requires the caller token, advances last monotonically, and clears only a full-string match', () => {
  const { acquireLock, releaseLock, promotePendingScan } = modules();
  const root = temporaryWiki('deep wiki promotion contract ');
  setState(root, { pending: `${T2}\n`, last: `${T0}\n` });
  assert.throws(() => promotePendingScan({
    wikiRoot: root, token: 'wrong', expected: T1, operationId: 'wrong-owner', now: new Date(T3),
  }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
  const owner = acquireLock({ wikiRoot: root, operation: 'promote' });
  try {
    const result = promotePendingScan({
      wikiRoot: root, token: owner.token, expected: T1, operationId: 'preserve-newer', now: new Date(T3),
    });
    assert.equal(result.status, 'promoted');
    assert.equal(result.pendingPreserved, true);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assertState(root, { pending: `${T2}\n`, last: `${T1}\n` });
  promote(root, T2, 'clear-matching');
  assertState(root, { pending: null, last: `${T2}\n` });
  setState(root, { pending: `${T1}\n`, last: `${T3}\n` });
  promote(root, T1, 'never-regress');
  assertState(root, { pending: null, last: `${T3}\n` });
});

test('pending removal rechecks token ownership immediately before the destination rename', () => {
  const { acquireLock, promotePendingScan } = modules();
  const root = temporaryWiki('deep wiki pending removal takeover ');
  setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
  const owner = acquireLock({ wikiRoot: root, operation: 'promote' });
  const ownerPath = metaPath(root, path.join('.wiki-lock', 'owner.json'));
  const lockDir = metaPath(root, '.wiki-lock');
  const replacementToken = 'f'.repeat(64);
  let takeoverInjected = false;
  try {
    assert.throws(() => promotePendingScan({
      wikiRoot: root,
      token: owner.token,
      expected: T1,
      operationId: 'pending-removal-forced-takeover',
      now: new Date(T3),
      faultInjector(stage) {
        if (stage !== 'before-matching-pending-destination-rename') return;
        takeoverInjected = true;
        const replacement = {
          ...JSON.parse(fs.readFileSync(ownerPath, 'utf8')),
          token: replacementToken,
          operation: 'forced-takeover',
        };
        fs.writeFileSync(ownerPath, `${JSON.stringify(replacement)}\n`);
      },
    }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
    assert.equal(takeoverInjected, true);
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
  assert.equal(fs.readFileSync(metaPath(root, '.pending-scan'), 'utf8'), `${T1}\n`);
  const journal = JSON.parse(fs.readFileSync(journalFiles(root)[0], 'utf8'));
  assert.equal(journal.transitions.includes('pending-scan-written'), false);
  assert.equal(journal.transitions.includes('scan-window-committed'), false);
});

test('scanner-first then promotion and promotion-first then scanner produce the two serial outcomes', () => {
  const { ensurePendingScan, createDeadline } = modules();
  const scannerFirst = temporaryWiki('deep wiki scanner first ');
  setState(scannerFirst, { pending: `${T1}\n` });
  const before = readMaybe(metaPath(scannerFirst, '.pending-scan'));
  ensurePendingScan({
    wikiRoot: scannerFirst, proposed: T2, now: new Date(T2), deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assert.deepEqual(readMaybe(metaPath(scannerFirst, '.pending-scan')), before);
  promote(scannerFirst, T1, 'scanner-first-promote');
  assertState(scannerFirst, { pending: null, last: `${T1}\n` });

  const promotionFirst = temporaryWiki('deep wiki promotion first ');
  setState(promotionFirst, { pending: `${T1}\n` });
  promote(promotionFirst, T1, 'promotion-first-promote');
  ensurePendingScan({
    wikiRoot: promotionFirst, proposed: T2, now: new Date(T2), deadline: createDeadline({ budgetMs: 12_000 }),
  });
  assertState(promotionFirst, { pending: `${T2}\n`, last: `${T1}\n` });
});

async function waitForFiles(files, timeoutMs = 5_000) {
  const expires = Date.now() + timeoutMs;
  while (Date.now() < expires) {
    if (files.every((file) => fs.existsSync(file))) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${files.join(', ')}`);
}

function spawnRacer(root, mode, suffix, startFile) {
  const config = {
    mode,
    wikiRoot: root,
    proposed: mode === 'ensure' ? T2 : undefined,
    expected: mode === 'promote' ? T1 : undefined,
    operationId: mode === 'promote' ? `race-promote-${suffix}` : undefined,
    now: T3,
    timeoutMs: 10_000,
    startFile,
    readyFile: path.join(root, `${mode}-${suffix}.ready.json`),
    resultFile: path.join(root, `${mode}-${suffix}.result.json`),
  };
  const configPath = path.join(root, `${mode}-${suffix}.config.json`);
  fs.writeFileSync(configPath, `${JSON.stringify(config)}\n`);
  const child = spawn(process.execPath, [racer, configPath], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: false,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  return { child, config, stdout: () => stdout, stderr: () => stderr };
}

for (const order of ['ensure-first', 'promote-first']) {
  test(`real process race is serializable with ${order} spawn order`, async () => {
    const root = temporaryWiki(`deep wiki process race ${order} `);
    setState(root, { pending: `${T1}\n` });
    const start = path.join(root, 'start.barrier');
    const firstMode = order === 'ensure-first' ? 'ensure' : 'promote';
    const secondMode = firstMode === 'ensure' ? 'promote' : 'ensure';
    const first = spawnRacer(root, firstMode, 'first', start);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = spawnRacer(root, secondMode, 'second', start);
    await waitForFiles([first.config.readyFile, second.config.readyFile]);
    fs.writeFileSync(start, 'go\n');
    const [[firstCode], [secondCode]] = await Promise.all([once(first.child, 'exit'), once(second.child, 'exit')]);
    assert.equal(firstCode, 0, `${first.stdout()}\n${first.stderr()}`);
    assert.equal(secondCode, 0, `${second.stdout()}\n${second.stderr()}`);
    const firstResult = JSON.parse(fs.readFileSync(first.config.resultFile));
    const secondResult = JSON.parse(fs.readFileSync(second.config.resultFile));
    assert.equal(firstResult.ok, true);
    assert.equal(secondResult.ok, true);
    assert.notEqual(firstResult.result?.status, 'deferred', JSON.stringify(firstResult));
    assert.notEqual(secondResult.result?.status, 'deferred', JSON.stringify(secondResult));
    const final = state(root);
    const serialOne = final.last?.toString() === `${T1}\n` && final.pending === null;
    const serialTwo = final.last?.toString() === `${T1}\n` && final.pending?.toString() === `${T2}\n`;
    assert.equal(serialOne || serialTwo, true, JSON.stringify({
      last: final.last?.toString(), pending: final.pending?.toString(),
    }));
    assert.equal(fs.existsSync(metaPath(root, '.wiki-lock')), false);
    assert.equal(journalFiles(root).length, 2, JSON.stringify({ firstResult, secondResult }));
  });
}

const ensureFaults = [
  'after-transaction-activate',
  'after-stage-pending-before',
  'after-stage-pending-after',
  'after-stage-last-before',
  'after-stage-last-after',
  'before-pending-rename',
  'after-pending-rename',
  'after-scan-window-committed',
  'before-cleanup',
];

for (const faultPoint of ensureFaults) {
  test(`ensure crash/retry converges after ${faultPoint}`, () => {
    const { ensurePendingScan, createDeadline } = modules();
    const root = temporaryWiki(`deep wiki ensure fault ${faultPoint} `);
    const first = ensurePendingScan({
      wikiRoot: root,
      proposed: T1,
      now: new Date(T1),
      deadline: createDeadline({ budgetMs: 12_000 }),
      faultInjector(stage) {
        if (stage === faultPoint) {
          const error = new Error(`injected ${stage}`);
          error.code = 'INJECTED_CRASH';
          throw error;
        }
      },
    });
    assert.equal(first.status, 'deferred');
    const retry = ensurePendingScan({
      wikiRoot: root, proposed: T1, now: new Date(T1), deadline: createDeadline({ budgetMs: 12_000 }),
    });
    assert.notEqual(retry.status, 'deferred');
    assertState(root, { pending: `${T1}\n`, last: null });
    const journals = journalFiles(root);
    assert.equal(journals.length, 1);
    const journal = JSON.parse(fs.readFileSync(journals[0]));
    assert.equal(journal.transitions.at(-1), 'cleaned');
    assert.equal(new Set(journal.transitions).size, journal.transitions.length);
  });
}

const promoteFaults = [
  'after-transaction-activate',
  'after-stage-pending-before',
  'after-stage-pending-after',
  'after-stage-last-before',
  'after-stage-last-after',
  'before-last-scan-rename',
  'after-last-scan-rename',
  'before-matching-pending-remove',
  'after-matching-pending-remove',
  'after-scan-window-committed',
  'before-cleanup',
];

for (const faultPoint of promoteFaults) {
  test(`promotion crash/retry converges after ${faultPoint}`, () => {
    const { acquireLock, releaseLock, promotePendingScan } = modules();
    const root = temporaryWiki(`deep wiki promote fault ${faultPoint} `);
    setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
    let owner = acquireLock({ wikiRoot: root, operation: 'promote' });
    try {
      assert.throws(() => promotePendingScan({
        wikiRoot: root,
        token: owner.token,
        expected: T1,
        operationId: `promote-fault-${faultPoint}`,
        now: new Date(T3),
        faultInjector(stage) {
          if (stage === faultPoint) {
            const error = new Error(`injected ${stage}`);
            error.code = 'INJECTED_CRASH';
            throw error;
          }
        },
      }), /injected/);
    } finally {
      releaseLock({ wikiRoot: root, token: owner.token });
    }
    owner = acquireLock({ wikiRoot: root, operation: 'promote-retry' });
    try {
      const retry = promotePendingScan({
        wikiRoot: root, token: owner.token, expected: T1,
        operationId: `promote-fault-${faultPoint}`, now: new Date(T3),
      });
      assert.equal(retry.status, 'promoted');
    } finally {
      releaseLock({ wikiRoot: root, token: owner.token });
    }
    assertState(root, { pending: null, last: `${T1}\n` });
    const journal = JSON.parse(fs.readFileSync(journalFiles(root)[0]));
    assert.equal(journal.transitions.at(-1), 'cleaned');
    assert.equal(new Set(journal.transitions).size, journal.transitions.length);
  });
}

test('same operation retry is byte-identical and an operation-id collision fails before mutation', () => {
  const root = temporaryWiki('deep wiki operation collision ');
  setState(root, { pending: `${T1}\n` });
  promote(root, T1, 'stable-operation');
  const afterFirst = state(root);
  const journal = journalFiles(root)[0];
  const journalAfterFirst = fs.readFileSync(journal);
  promote(root, T1, 'stable-operation');
  assert.deepEqual(state(root), afterFirst);
  assert.deepEqual(fs.readFileSync(journal), journalAfterFirst);
  setState(root, { pending: `${T2}\n`, last: `${T1}\n` });
  const beforeCollision = state(root);
  assert.throws(() => promote(root, T2, 'stable-operation'), (error) => error.code === 'OPERATION_ID_COLLISION');
  assert.deepEqual(state(root), beforeCollision);
  assert.equal(journalFiles(root).length, 1);
});

test('corrupt staged bytes require manual recovery and preserve both scan-window files', () => {
  const { ensurePendingScan, recoverScanWindowTransaction, createDeadline, acquireLock, releaseLock } = modules();
  const root = temporaryWiki('deep wiki corrupt stage ');
  setState(root, { last: `${T0}\n` });
  const result = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    now: new Date(T1),
    deadline: createDeadline({ budgetMs: 12_000 }),
    faultInjector(stage) {
      if (stage === 'before-pending-rename') {
        const error = new Error('injected before rename');
        error.code = 'INJECTED_CRASH';
        throw error;
      }
    },
  });
  assert.equal(result.status, 'deferred');
  const journalPath = journalFiles(root)[0];
  const journal = JSON.parse(fs.readFileSync(journalPath));
  const txDir = path.dirname(journalPath);
  fs.writeFileSync(path.join(txDir, 'stage-pending-after.json'), 'corrupt\n');
  const before = state(root);
  const owner = acquireLock({ wikiRoot: root, operation: 'recover' });
  try {
    assert.throws(() => recoverScanWindowTransaction({
      wikiRoot: root, token: owner.token, operationId: journal.operation_id,
    }), (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED');
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assert.deepEqual(state(root), before);
});

test('recovery rejects a forged cleaned journal when recorded after bytes were never published', () => {
  const { ensurePendingScan, recoverScanWindowTransaction, createDeadline, acquireLock, releaseLock } = modules();
  const root = temporaryWiki('deep wiki forged cleaned journal ');
  setState(root, { last: `${T0}\n` });
  const interrupted = ensurePendingScan({
    wikiRoot: root,
    proposed: T1,
    now: new Date(T1),
    deadline: createDeadline({ budgetMs: 12_000 }),
    faultInjector(stage) {
      if (stage === 'before-pending-rename') {
        const error = new Error('injected before pending rename');
        error.code = 'INJECTED_CRASH';
        throw error;
      }
    },
  });
  assert.equal(interrupted.status, 'deferred');
  const journalPath = journalFiles(root)[0];
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  journal.transitions = [
    'scan-window-preflighted',
    'scan-window-staged',
    'pending-scan-written',
    'scan-window-committed',
    'cleaned',
  ];
  fs.writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
  const beforeState = state(root);
  const transactionDir = path.dirname(journalPath);
  const beforeTransaction = snapshotFlatDirectory(transactionDir);
  const owner = acquireLock({ wikiRoot: root, operation: 'recover-forged-cleaned' });
  try {
    assert.throws(() => recoverScanWindowTransaction({
      wikiRoot: root,
      token: owner.token,
      operationId: journal.operation_id,
    }), (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED');
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assert.deepEqual(state(root), beforeState);
  assert.deepEqual(snapshotFlatDirectory(transactionDir), beforeTransaction);
});

test('recovery rejects a diverged unchanged target before writing a changed destination', () => {
  const { acquireLock, releaseLock, promotePendingScan, recoverScanWindowTransaction } = modules();
  const root = temporaryWiki('deep wiki diverged unchanged destination ');
  setState(root, { pending: `${T2}\n`, last: `${T0}\n` });
  let owner = acquireLock({ wikiRoot: root, operation: 'promote-interrupted' });
  try {
    assert.throws(() => promotePendingScan({
      wikiRoot: root,
      token: owner.token,
      expected: T1,
      operationId: 'diverged-unchanged-target',
      now: new Date(T3),
      faultInjector(stage) {
        if (stage === 'before-last-scan-rename') {
          const error = new Error('injected before last rename');
          error.code = 'INJECTED_CRASH';
          throw error;
        }
      },
    }), /injected before last rename/);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }

  const journalPath = journalFiles(root)[0];
  const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
  fs.writeFileSync(metaPath(root, '.pending-scan'), `${T3}\n`);
  const beforeState = state(root);
  const transactionDir = path.dirname(journalPath);
  const beforeTransaction = snapshotFlatDirectory(transactionDir);
  owner = acquireLock({ wikiRoot: root, operation: 'recover-diverged-unchanged' });
  try {
    assert.throws(() => recoverScanWindowTransaction({
      wikiRoot: root,
      token: owner.token,
      operationId: journal.operation_id,
    }), (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED');
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assert.deepEqual(state(root), beforeState);
  assert.deepEqual(snapshotFlatDirectory(transactionDir), beforeTransaction);
});

test('journal recovery rejects canonical-input, schema, descriptor, hash, and transition mutations without destination writes', async (t) => {
  const mutations = [
    ['input hash', (journal) => { journal.input_sha256 = 'f'.repeat(64); }],
    ['canonical input', (journal) => {
      journal.input.proposed = T2;
      journal.input_sha256 = crypto.createHash('sha256').update(JSON.stringify(journal.input)).digest('hex');
    }],
    ['kind', (journal) => { journal.kind = 'foreign-kind'; }],
    ['result status', (journal) => { journal.result_status = 'foreign-status'; }],
    ['descriptor', (journal) => { journal.states.pending.after.sha256 = '0'.repeat(64); }],
    ['stage hash', (journal) => { journal.stage_sha256['pending-after'] = '0'.repeat(64); }],
    ['unknown transition', (journal) => { journal.transitions.push('foreign-transition'); }],
    ['duplicate transition', (journal) => { journal.transitions.push('scan-window-preflighted'); }],
    ['out-of-order transitions', (journal) => {
      journal.transitions = ['scan-window-preflighted', 'scan-window-committed', 'scan-window-staged'];
    }],
  ];

  for (const [name, mutate] of mutations) {
    await t.test(name, () => {
      const { ensurePendingScan, recoverScanWindowTransaction, createDeadline, acquireLock, releaseLock } = modules();
      const root = temporaryWiki(`deep wiki journal mutation ${name} `);
      setState(root, { last: `${T0}\n` });
      const interrupted = ensurePendingScan({
        wikiRoot: root,
        proposed: T1,
        now: new Date(T1),
        deadline: createDeadline({ budgetMs: 12_000 }),
        faultInjector(stage) {
          if (stage === 'before-pending-rename') {
            const error = new Error('injected before pending rename');
            error.code = 'INJECTED_CRASH';
            throw error;
          }
        },
      });
      assert.equal(interrupted.status, 'deferred');
      const journalPath = journalFiles(root)[0];
      const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
      journal.input ||= {
        wiki_root: root,
        kind: 'ensure',
        proposed: T1,
        expected: null,
        repair_pending_after: null,
        repair_last_after: null,
      };
      mutate(journal);
      fs.writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
      const before = state(root);
      const owner = acquireLock({ wikiRoot: root, operation: 'recover-mutated-journal' });
      try {
        assert.throws(() => recoverScanWindowTransaction({
          wikiRoot: root,
          token: owner.token,
          operationId: journal.operation_id,
        }), (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED');
      } finally {
        releaseLock({ wikiRoot: root, token: owner.token });
      }
      assert.deepEqual(state(root), before);
    });
  }
});

function memoryJournalAdapter() {
  let journal = null;
  const stages = new Map();
  return {
    readJournal() { return journal ? structuredClone(journal) : null; },
    writeJournal(value) { journal = structuredClone(value); },
    readStage(name) { return stages.has(name) ? Buffer.from(stages.get(name)) : null; },
    writeStage(name, bytes) { stages.set(name, Buffer.from(bytes)); },
    removeStage(name) { stages.delete(name); },
    snapshot() { return { journal: structuredClone(journal), stages: new Map(stages) }; },
  };
}

for (const scenario of [
  {
    name: 'parent creation',
    boundary: 'before-tombstone-parent-create',
    seed(tombstone) {
      assert.equal(fs.existsSync(path.dirname(tombstone)), false);
    },
    verify(tombstone) {
      assert.equal(fs.existsSync(path.dirname(tombstone)), false);
    },
  },
  {
    name: 'existing-file removal',
    boundary: 'before-tombstone-prepare-remove',
    seed(tombstone) {
      fs.mkdirSync(path.dirname(tombstone), { recursive: true });
      fs.writeFileSync(tombstone, 'preserve-tombstone\n');
    },
    verify(tombstone) {
      assert.equal(fs.readFileSync(tombstone, 'utf8'), 'preserve-tombstone\n');
    },
  },
]) {
  test(`caller tombstone ${scenario.name} is token-fenced before filesystem mutation`, () => {
    const { acquireLock, releaseLock, recoverLock, promotePendingScan, assertLockOwner } = modules();
    const root = temporaryWiki(`deep wiki ${scenario.name} token fence `);
    setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
    const adapter = memoryJournalAdapter();
    const tombstone = metaPath(root, path.join('.caller-tombstones', scenario.boundary, 'pending.removed'));
    adapter.tombstonePath = tombstone;
    scenario.seed(tombstone);
    const owner = acquireLock({ wikiRoot: root, operation: 'old-tombstone-owner' });
    let successor;
    let injected = false;
    try {
      assert.throws(() => promotePendingScan({
        wikiRoot: root,
        token: owner.token,
        expected: T1,
        operationId: `caller-${scenario.boundary}`,
        journalAdapter: adapter,
        faultInjector(stage) {
          if (stage !== scenario.boundary) return;
          injected = true;
          replaceLiveLockExternallyAtInjectedGuard(root);
          successor = acquireLock({ wikiRoot: root, operation: `successor-${scenario.boundary}` });
          scenario.verify(tombstone);
        },
      }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
      assert.equal(injected, true);
      scenario.verify(tombstone);
      assert.equal(fs.readFileSync(metaPath(root, '.pending-scan'), 'utf8'), `${T1}\n`);
      assert.equal(assertLockOwner({ wikiRoot: root, token: successor.token }).operation, `successor-${scenario.boundary}`);
    } finally {
      if (successor) releaseLock({ wikiRoot: root, token: successor.token });
      else {
        try { releaseLock({ wikiRoot: root, token: owner.token }); } catch { /* RED cleanup */ }
      }
    }
  });
}

test('journalAdapter embeds the same staged bytes and transition vocabulary for a caller-owned transaction', () => {
  const { acquireLock, releaseLock, promotePendingScan } = modules();
  const root = temporaryWiki('deep wiki journal adapter ');
  setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
  const adapter = memoryJournalAdapter();
  const owner = acquireLock({ wikiRoot: root, operation: 'outer-commit' });
  try {
    promotePendingScan({
      wikiRoot: root,
      token: owner.token,
      expected: T1,
      operationId: 'outer-commit-operation',
      journalAdapter: adapter,
      now: new Date(T3),
    });
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  const snapshot = adapter.snapshot();
  assert.equal(snapshot.journal.operation_id, 'outer-commit-operation');
  assert.equal(snapshot.journal.transitions.includes('scan-window-staged'), true);
  assert.equal(snapshot.journal.transitions.includes('scan-window-committed'), true);
  assert.equal(snapshot.journal.transitions.at(-1), 'cleaned');
  assert.equal(snapshot.stages.size, 0);
  assert.equal(journalFiles(root).length, 0);
  assertState(root, { pending: null, last: `${T1}\n` });
});

test('caller-owned journal adapters are token-fenced at write, transition, removal, and cleanup seams', async (t) => {
  const boundaries = [
    'before-stage-pending-before-write',
    'before-transition-scan-window-staged-write',
    'before-stage-pending-before-remove',
    'before-tombstone-cleanup-remove',
    'before-transition-cleaned-write',
  ];
  for (const boundary of boundaries) {
    await t.test(boundary, () => {
      const { acquireLock, releaseLock, recoverLock, promotePendingScan, assertLockOwner } = modules();
      const root = temporaryWiki(`deep wiki caller adapter token fence ${boundary} `);
      setState(root, { pending: `${T1}\n`, last: `${T0}\n` });
      const adapter = memoryJournalAdapter();
      const owner = acquireLock({ wikiRoot: root, operation: 'caller-adapter-old-owner' });
      let successor;
      let atTakeover;
      let injected = false;
      assert.throws(() => promotePendingScan({
        wikiRoot: root,
        token: owner.token,
        expected: T1,
        operationId: `caller-adapter-${boundary}`,
        journalAdapter: adapter,
        faultInjector(stage) {
          if (injected || stage !== boundary) return;
          injected = true;
          replaceLiveLockExternallyAtInjectedGuard(root);
          successor = acquireLock({ wikiRoot: root, operation: `caller-successor-${boundary}` });
          atTakeover = adapter.snapshot();
        },
      }), (error) => error.code === 'LOCK_TOKEN_MISMATCH');
      assert.equal(injected, true);
      assert.deepEqual(adapter.snapshot(), atTakeover);
      assert.equal(assertLockOwner({ wikiRoot: root, token: successor.token }).operation, `caller-successor-${boundary}`);
      releaseLock({ wikiRoot: root, token: successor.token });
    });
  }
});

test('recovery safely reuses one tombstone across interrupted last and pending removals', () => {
  const {
    acquireLock,
    applyScanWindowTransition,
    planScanWindowTransition,
    recoverScanWindowTransaction,
    releaseLock,
  } = modules();
  const root = temporaryWiki('deep wiki sequential tombstone recovery ');
  const operationId = 'sequential-tombstone-recovery';
  const tombstone = metaPath(
    root,
    path.join('.transactions', operationId, 'pending.removed'),
  );
  setState(root, { pending: `${T2}\n`, last: `${T1}\n` });
  const plan = planScanWindowTransition({
    wikiRoot: root,
    kind: 'repair',
    pendingAfter: null,
    lastAfter: null,
  });

  let owner = acquireLock({ wikiRoot: root, operation: 'remove-last-first' });
  try {
    assert.throws(() => applyScanWindowTransition({
      wikiRoot: root,
      token: owner.token,
      operationId,
      plan,
      faultInjector(stage) {
        if (stage !== 'after-last-scan-remove') return;
        const error = new Error('stop after last marker entered tombstone');
        error.code = 'INJECTED_CRASH';
        throw error;
      },
    }), (error) => error.code === 'INJECTED_CRASH');
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assertState(root, { pending: `${T2}\n`, last: null });
  assert.equal(fs.readFileSync(tombstone, 'utf8'), `${T1}\n`);

  owner = acquireLock({ wikiRoot: root, operation: 'replace-tombstone-with-pending' });
  try {
    assert.throws(() => recoverScanWindowTransaction({
      wikiRoot: root,
      token: owner.token,
      operationId,
      faultInjector(stage) {
        if (stage !== 'before-matching-pending-destination-rename') return;
        const error = new Error('stop after obsolete tombstone removal');
        error.code = 'INJECTED_CRASH';
        throw error;
      },
    }), (error) => error.code === 'INJECTED_CRASH');
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assertState(root, { pending: `${T2}\n`, last: null });
  assert.equal(fs.existsSync(tombstone), false);
  let journal = JSON.parse(fs.readFileSync(journalFiles(root)[0], 'utf8'));
  assert.equal(journal.transitions.includes('last-scan-written'), true);
  assert.equal(journal.transitions.includes('pending-scan-written'), false);

  owner = acquireLock({ wikiRoot: root, operation: 'finish-pending-removal' });
  try {
    const recovered = recoverScanWindowTransaction({
      wikiRoot: root,
      token: owner.token,
      operationId,
    });
    assert.equal(recovered.status, 'repaired');
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
  assertState(root, { pending: null, last: null });
  assert.equal(fs.existsSync(tombstone), false);
  journal = JSON.parse(fs.readFileSync(journalFiles(root)[0], 'utf8'));
  assert.equal(journal.transitions.at(-1), 'cleaned');
});
