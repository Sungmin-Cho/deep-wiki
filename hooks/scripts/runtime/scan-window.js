'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const { ISO_UTC_RE } = require('./config.js');
const { atomicWriteFile, sha256 } = require('./fs-safe.js');
const { assertBeforeDeadline, createDeadline, remainingMs } = require('./deadline.js');
const {
  ScanWindowError,
  assertNestedJunkSettled,
  defaultTransactionParentGuard,
  semanticTransactionNames,
} = require('./scan-window-parent-guard.js');
const {
  acquireLock,
  assertLockOwner,
  releaseLock,
} = require('./lock.js');
const transactionDebris = require('./transaction-debris.js');
const {
  sweepTransactionDebris,
  quarantineStoreEntry: quarantineStoreEntryPrimitive,
  inspectDirectoryPressure,
  resolveUnknownDirent,
  writeMaintenanceMarker,
} = transactionDebris;

const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const STAGES = ['pending-before', 'pending-after', 'last-before', 'last-after'];
const SHA256_RE = /^[a-f0-9]{64}$/;
const TOKEN_RE = /^[a-f0-9]{32,}$/;
const FILE_TYPE_MASK = 0o170000n;
const DIRECTORY_TYPE = 0o040000n;
const REGULAR_FILE_TYPE = 0o100000n;
const DEFAULT_ADAPTER_CONTROL = Symbol('default-scan-window-adapter-control');
const INPUT_KEYS = [
  'wiki_root', 'kind', 'proposed', 'expected', 'repair_pending_after', 'repair_last_after',
];
const JOURNAL_KEYS = [
  'contract_version', 'kind', 'operation_id', 'input', 'input_sha256', 'owner_token',
  'result_status', 'states', 'stage_sha256', 'transitions',
];
const TRANSITIONS = [
  'scan-window-preflighted',
  'scan-window-staged',
  'last-scan-written',
  'pending-scan-written',
  'scan-window-committed',
  'cleaned',
];
const DAY_MS = 24 * 60 * 60 * 1000;
const AUTOMATIC_PRUNE_LIMIT = 8;
const PRUNE_RESERVE_MS = 250;

function scanError(code, message, cause) {
  return new ScanWindowError(code, message, cause);
}

// Closed vocabulary for reporting why a terminal prune entry stayed behind (issue #60). These are
// observations only: attaching one never changes whether or how an error propagates.
const PRUNE_BLOCK_STAGES = Object.freeze([
  'discovery', 'quarantine-entry', 'evidence', 'backup-publication',
  'reservation-publication', 'teardown', 'empty-quarantine', 'reservation-only',
]);
const PRUNE_BLOCK_REASONS = Object.freeze([
  'publication-ambiguous', 'publication-changed', 'publication-unavailable',
  'pending-not-regular-file', 'destination-not-regular-file', 'destination-mismatch',
  'destination-link-count', 'destination-occupied', 'link-failed', 'stage-failed',
  'hardlink-identity-differs', 'evidence-mismatch', 'evidence-set-invalid',
  'unexpected-entries', 'quarantine-identity-changed', 'backup-mismatch', 'journal-invalid',
  'journal-not-terminal', 'reservation-missing', 'reservation-mismatch',
  'matching-quarantine-not-directory', 'filesystem', 'unclassified',
]);
const BLOCKED_REPORT_CAP = 32;

function assertPruneReason(reason) {
  if (!PRUNE_BLOCK_REASONS.includes(reason)) throw new Error(`unknown prune block reason ${reason}`);
  return reason;
}

function blockedError(reason, message, cause) {
  const error = scanError('TRANSACTION_RECOVERY_REQUIRED', message, cause);
  error.prune_reason = assertPruneReason(reason);
  return error;
}

function innermostCode(error) {
  let current = error;
  let code = null;
  for (let depth = 0; current && depth < 16; depth += 1) {
    if (typeof current.code === 'string') code = current.code;
    current = current.cause;
  }
  if (code === null) return null;
  const normalized = code.replace(/[^A-Z_]/g, '');
  return normalized.length > 0 ? normalized : null;
}

function withPruneBlock(error, cursor, fallbackReason) {
  if (!error || typeof error !== 'object') return error;
  let reason = null;
  for (let current = error, depth = 0; current && depth < 16; current = current.cause, depth += 1) {
    if (typeof current.prune_reason === 'string') { reason = current.prune_reason; break; }
  }
  error.prune_block = {
    stage: cursor.stage,
    reason: assertPruneReason(reason || fallbackReason(error)),
    code: innermostCode(error),
  };
  if (cursor.residue) error.prune_name = cursor.residue;
  return error;
}

function fallbackPruneReason(error) {
  const code = innermostCode(error);
  if (code && /^E[A-Z]+$/.test(code)) return 'filesystem';
  return 'unclassified';
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value)) {
    throw scanError('SCAN_WINDOW_INVALID', `${label} must be a canonical UTC-Z timestamp`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().replace('.000Z', 'Z') !== value) {
    throw scanError('SCAN_WINDOW_INVALID', `${label} must be a real canonical UTC-Z timestamp`);
  }
  return value;
}

function timestampFromBytes(bytes) {
  if (bytes === null || bytes === undefined) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();
  } catch {
    return null;
  }
  try { return canonicalTimestamp(text, 'scan window'); } catch { return null; }
}

function readMaybe(file) {
  try { return fs.readFileSync(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

function bytesEqual(left, right) {
  if (left === null || right === null) return left === right;
  return Buffer.from(left).equals(Buffer.from(right));
}

function sealBytes(bytes) {
  const value = Buffer.from(bytes);
  return { length: value.length, sha256: sha256(value) };
}

function sealedBytesEqual(bytes, expectedBytes, expectedSeal) {
  const value = Buffer.from(bytes);
  return value.length === expectedSeal.length
    && sha256(value) === expectedSeal.sha256
    && value.equals(expectedBytes);
}

function descriptor(bytes) {
  if (bytes === null) return { exists: false, bytes_base64: null, sha256: null };
  const value = Buffer.from(bytes);
  return { exists: true, bytes_base64: value.toString('base64'), sha256: sha256(value) };
}

function bytesFromDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || !hasExactKeys(value, ['exists', 'bytes_base64', 'sha256'])) {
    throw scanError('TRANSACTION_RECOVERY_REQUIRED', 'scan-window descriptor is malformed');
  }
  if (value.exists === false) {
    if (value.bytes_base64 !== null || value.sha256 !== null) {
      throw scanError('TRANSACTION_RECOVERY_REQUIRED', 'absent scan-window descriptor carries bytes');
    }
    return null;
  }
  if (value.exists !== true || typeof value.bytes_base64 !== 'string'
      || typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)) {
    throw scanError('TRANSACTION_RECOVERY_REQUIRED', 'scan-window descriptor is malformed');
  }
  const bytes = Buffer.from(value.bytes_base64, 'base64');
  if (bytes.toString('base64') !== value.bytes_base64) {
    throw scanError('TRANSACTION_RECOVERY_REQUIRED', 'scan-window descriptor base64 is noncanonical');
  }
  if (sha256(bytes) !== value.sha256) throw scanError('TRANSACTION_RECOVERY_REQUIRED', 'scan-window descriptor hash mismatch');
  return bytes;
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function stageBytes(value) {
  return Buffer.from(`${JSON.stringify(value)}\n`);
}

function physicalWikiRoot(wikiRoot) {
  if (typeof wikiRoot !== 'string' || !path.isAbsolute(wikiRoot)) {
    throw scanError('SCAN_WINDOW_INVALID', 'wikiRoot must be absolute');
  }
  try { return fs.realpathSync.native(wikiRoot); } catch (cause) {
    throw scanError('SCAN_WINDOW_FILESYSTEM', 'cannot resolve physical wiki root', cause);
  }
}

function identityComponent(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  return null;
}

function directoryIdentity(stat) {
  const dev = identityComponent(stat?.dev);
  const ino = identityComponent(stat?.ino);
  const mode = identityComponent(stat?.mode);
  const birthtimeNs = identityComponent(stat?.birthtimeNs);
  if (dev === null || ino === null || mode === null || birthtimeNs === null
      || dev < 0n || ino <= 0n || birthtimeNs < 0n
      || (mode & FILE_TYPE_MASK) !== DIRECTORY_TYPE) return null;
  return { dev, ino, type: mode & FILE_TYPE_MASK, birthtimeNs };
}

function identitiesMatch(actual, expected) {
  return actual !== null && expected !== null
    && actual.dev === expected.dev && actual.ino === expected.ino && actual.type === expected.type
    && actual.birthtimeNs === expected.birthtimeNs;
}

function linkedRegularFileIdentity(stat) {
  const dev = identityComponent(stat?.dev);
  const ino = identityComponent(stat?.ino);
  const mode = identityComponent(stat?.mode);
  const birthtimeNs = identityComponent(stat?.birthtimeNs);
  const mtimeNs = identityComponent(stat?.mtimeNs);
  const nlink = identityComponent(stat?.nlink);
  if (dev === null || ino === null || mode === null || birthtimeNs === null
      || mtimeNs === null || nlink === null
      || dev < 0n || ino <= 0n || birthtimeNs < 0n || mtimeNs < 0n || nlink < 1n
      || (mode & FILE_TYPE_MASK) !== REGULAR_FILE_TYPE) return null;
  return { dev, ino, type: mode & FILE_TYPE_MASK, birthtimeNs, mtimeNs, nlink };
}

function regularFileIdentity(stat) {
  const identity = linkedRegularFileIdentity(stat);
  return identity !== null && identity.nlink === 1n ? identity : null;
}

function terminalJournalIsOldEnough(identity, nowMs, maxAgeDays) {
  const nowNs = BigInt(nowMs) * 1_000_000n;
  const ageNs = nowNs - identity.mtimeNs;
  return ageNs >= 0n
    && (maxAgeDays === 0
      || ageNs > BigInt(maxAgeDays) * BigInt(DAY_MS) * 1_000_000n);
}

function assertRegularFileIdentity(pathname, expected, ageGate = null) {
  let actual;
  try { actual = regularFileIdentity(fs.lstatSync(pathname, { bigint: true })); }
  catch (cause) {
    throw scanError('SCAN_WINDOW_FILESYSTEM', 'terminal journal identity is unavailable', cause);
  }
  if (!identitiesMatch(actual, expected) || actual.mtimeNs !== expected.mtimeNs
      || actual.nlink !== expected.nlink) {
    throw scanError('SCAN_WINDOW_FILESYSTEM', 'terminal journal identity changed');
  }
  if (ageGate && !terminalJournalIsOldEnough(actual, ageGate.nowMs, ageGate.maxAgeDays)) {
    throw scanError('SCAN_WINDOW_FILESYSTEM', 'terminal journal is no longer old enough');
  }
}

function regularIdentitiesMatch(actual, expected) {
  return actual !== null && expected !== null
    && identitiesMatch(actual, expected)
    && actual.mtimeNs === expected.mtimeNs
    && actual.nlink === expected.nlink;
}

function inspectPruneMarker(pathname) {
  let identity;
  try {
    identity = regularFileIdentity(fs.lstatSync(pathname, { bigint: true }));
  } catch (cause) {
    if (cause.code === 'ENOENT') {
      return { state: 'absent', invalid: false, pathname };
    }
    return { state: 'invalid', invalid: true, pathname };
  }
  if (!identity) return { state: 'invalid', invalid: true, pathname };

  let bytes;
  try {
    bytes = fs.readFileSync(pathname);
    const current = regularFileIdentity(fs.lstatSync(pathname, { bigint: true }));
    if (!regularIdentitiesMatch(current, identity)) {
      return { state: 'invalid', invalid: true, pathname };
    }
  } catch {
    return {
      state: 'invalid',
      invalid: true,
      pathname,
    };
  }

  let timestamp;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!text.endsWith('\n')) throw new Error('missing canonical newline');
    timestamp = canonicalTimestamp(text.slice(0, -1), 'scan-window prune marker');
    if (!bytes.equals(Buffer.from(`${timestamp}\n`))) {
      throw new Error('noncanonical marker bytes');
    }
  } catch {
    return {
      state: 'invalid',
      invalid: true,
      pathname,
      bytes,
      identity,
    };
  }
  return {
    state: 'accepted',
    invalid: false,
    pathname,
    timestamp,
    bytes,
    identity,
  };
}

function inspectPruneMarkers(options = {}) {
  const root = physicalWikiRoot(options.wikiRoot);
  return {
    pending: inspectPruneMarker(path.join(root, '.wiki-meta', '.pending-scan')),
    last: inspectPruneMarker(path.join(root, '.wiki-meta', '.last-scan')),
  };
}

function assertPruneMarkerSeals(markers) {
  for (const marker of [markers.pending, markers.last]) {
    if (marker.state === 'absent') {
      try {
        fs.lstatSync(marker.pathname);
      } catch (cause) {
        if (cause.code === 'ENOENT') continue;
        throw scanError(
          'TRANSACTION_RECOVERY_REQUIRED',
          'scan-window prune marker absence could not be revalidated',
          cause,
        );
      }
      throw scanError(
        'TRANSACTION_RECOVERY_REQUIRED',
        'scan-window prune marker appeared after authorization',
      );
    }
    if (marker.state !== 'accepted') {
      throw scanError(
        'TRANSACTION_RECOVERY_REQUIRED',
        'scan-window prune marker was initially invalid',
      );
    }
    let current;
    let bytes;
    try {
      current = regularFileIdentity(fs.lstatSync(marker.pathname, { bigint: true }));
      bytes = fs.readFileSync(marker.pathname);
      const after = regularFileIdentity(fs.lstatSync(marker.pathname, { bigint: true }));
      if (!regularIdentitiesMatch(current, marker.identity)
          || !regularIdentitiesMatch(after, marker.identity)
          || !bytes.equals(marker.bytes)) {
        throw scanError(
          'TRANSACTION_RECOVERY_REQUIRED',
          'scan-window prune marker physical seal changed',
        );
      }
    } catch (cause) {
      if (cause instanceof ScanWindowError) throw cause;
      throw scanError(
        'TRANSACTION_RECOVERY_REQUIRED',
        'scan-window prune marker physical seal is unavailable',
        cause,
      );
    }
  }
}

function ensureDeletionAllowed(journal, markers, suppressEnsurePrune) {
  if (journal.kind !== 'ensure') return true;
  if (suppressEnsurePrune || markers.pending.invalid || markers.last.invalid) return false;
  if (journal.result_status === 'preserved' || journal.result_status === 'stale') return true;
  if (journal.result_status !== 'created') return false;
  const proposed = journal.input.proposed;
  const pendingDoesNotMatch = markers.pending.state !== 'accepted'
    || markers.pending.timestamp !== proposed;
  return pendingDoesNotMatch
    && markers.last.state === 'accepted'
    && markers.last.timestamp >= proposed;
}

function assertPruneTransactionNamesSupported(options = {}) {
  const root = physicalWikiRoot(options.wikiRoot);
  const deadline = options.deadline || createDeadline({ budgetMs: 12_000 });
  const assertBudget = () => assertBeforeDeadline(
    deadline,
    'scan-window-prune-name-preflight',
  );
  assertBudget();
  assertLockOwner({ wikiRoot: root, token: options.token });
  assertBudget();
  const meta = path.join(root, '.wiki-meta');
  const metaIdentity = inspectPhysicalDirectory(meta, meta, '.wiki-meta', true);
  assertBudget();
  if (metaIdentity === null) return;
  const transactions = path.join(meta, '.transactions');
  const transactionsIdentity = inspectPhysicalDirectory(
    transactions,
    transactions,
    '.wiki-meta/.transactions',
    true,
  );
  assertBudget();
  let names = null;
  let namesError = null;
  if (transactionsIdentity !== null) {
    try {
      names = fs.readdirSync(transactions);
    } catch (cause) {
      namesError = cause;
    }
  }
  assertBudget();
  assertLockOwner({ wikiRoot: root, token: options.token });
  assertBudget();
  const closingMetaIdentity = inspectPhysicalDirectory(meta, meta, '.wiki-meta');
  assertBudget();
  if (!identitiesMatch(closingMetaIdentity, metaIdentity)) {
    throw scanError(
      'SCAN_WINDOW_FILESYSTEM',
      '.wiki-meta directory identity changed after transaction-store observation',
    );
  }
  if (transactionsIdentity === null) return;
  const closingTransactionsIdentity = inspectPhysicalDirectory(
    transactions,
    transactions,
    '.wiki-meta/.transactions',
  );
  assertBudget();
  if (!identitiesMatch(closingTransactionsIdentity, transactionsIdentity)) {
    throw scanError(
      'SCAN_WINDOW_FILESYSTEM',
      '.wiki-meta/.transactions directory identity changed after transaction-store observation',
    );
  }
  if (namesError !== null) {
    throw scanError(
      'SCAN_WINDOW_FILESYSTEM',
      '.wiki-meta/.transactions contents are unavailable',
      namesError,
    );
  }
  if (names.some((name) => name.startsWith('.reservation-.prune-'))) {
    throw scanError(
      'TRANSACTION_RECOVERY_REQUIRED',
      'unsupported .reservation-.prune-* entry requires stopped-host intervention',
    );
  }
}

function samePhysicalPath(actual, expected) {
  return path.relative(expected, actual) === '';
}

function inspectPhysicalDirectory(pathname, expectedPhysical, label, allowMissing = false) {
  let stat;
  try {
    stat = fs.lstatSync(pathname, { bigint: true });
  } catch (cause) {
    if (allowMissing && cause.code === 'ENOENT') return null;
    throw scanError('SCAN_WINDOW_FILESYSTEM', `${label} directory identity is unavailable`, cause);
  }
  const identity = directoryIdentity(stat);
  if (!identity) throw scanError('SCAN_WINDOW_FILESYSTEM', `${label} must be a physical directory`);
  let physical;
  try {
    physical = fs.realpathSync.native(pathname);
  } catch (cause) {
    throw scanError('SCAN_WINDOW_FILESYSTEM', `${label} physical path is unavailable`, cause);
  }
  if (!samePhysicalPath(physical, expectedPhysical)) {
    throw scanError('SCAN_WINDOW_FILESYSTEM', `${label} escapes its physical wiki parent`);
  }
  return identity;
}

function pathsFor(wikiRoot, operationId) {
  const meta = path.join(wikiRoot, '.wiki-meta');
  const transactions = path.join(meta, '.transactions');
  const transaction = path.join(transactions, operationId);
  return {
    meta,
    transactions,
    transaction,
    journal: path.join(transaction, 'journal.json'),
    pending: path.join(meta, '.pending-scan'),
    last: path.join(meta, '.last-scan'),
    tombstone: path.join(transaction, 'pending.removed'),
  };
}

function validateOperationId(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,160}$/.test(value)) {
    throw scanError('SCAN_WINDOW_INVALID', 'operationId is invalid');
  }
  return value;
}

function operationIdFromPruneName(value) {
  const match = /^\.prune-([1-9][0-9]{0,2})-/.exec(value);
  if (!match) throw scanError('SCAN_WINDOW_INVALID', 'terminal quarantine name is invalid');
  const length = Number(match[1]);
  if (!Number.isSafeInteger(length) || length < 1 || length > 161) {
    throw scanError('SCAN_WINDOW_INVALID', 'terminal quarantine name is invalid');
  }
  const start = match[0].length;
  const operationId = validateOperationId(value.slice(start, start + length));
  if (operationId.length !== length || value[start + length] !== '-') {
    throw scanError('SCAN_WINDOW_INVALID', 'terminal quarantine name is invalid');
  }
  return operationId;
}

function planScanWindowTransition(options = {}) {
  const kind = options.kind;
  const pendingBytes = options.pendingBytes === undefined && options.wikiRoot
    ? readMaybe(path.join(options.wikiRoot, '.wiki-meta', '.pending-scan'))
    : (options.pendingBytes ?? null);
  const lastBytes = options.lastBytes === undefined && options.wikiRoot
    ? readMaybe(path.join(options.wikiRoot, '.wiki-meta', '.last-scan'))
    : (options.lastBytes ?? null);
  const pendingTimestamp = timestampFromBytes(pendingBytes);
  const lastTimestamp = timestampFromBytes(lastBytes);

  if (kind === 'promote') {
    if (pendingBytes !== null && pendingTimestamp === null) {
      throw scanError('SCAN_WINDOW_INVALID', '.pending-scan is not a canonical timestamp');
    }
    if (lastBytes !== null && lastTimestamp === null) {
      throw scanError('SCAN_WINDOW_INVALID', '.last-scan is not a canonical timestamp');
    }
  }

  if (kind === 'ensure') {
    const proposed = canonicalTimestamp(options.proposed, 'proposed');
    if (pendingTimestamp !== null) {
      return {
        kind, resultStatus: 'preserved', proposed,
        pending: { before: pendingBytes, after: pendingBytes },
        last: { before: lastBytes, after: lastBytes },
      };
    }
    if (lastTimestamp !== null && proposed <= lastTimestamp) {
      return {
        kind, resultStatus: 'stale', proposed,
        pending: { before: pendingBytes, after: pendingBytes },
        last: { before: lastBytes, after: lastBytes },
      };
    }
    return {
      kind, resultStatus: 'created', proposed,
      pending: { before: pendingBytes, after: Buffer.from(`${proposed}\n`) },
      last: { before: lastBytes, after: lastBytes },
    };
  }

  if (kind === 'promote') {
    const expected = canonicalTimestamp(options.expected, 'expected');
    const nextLast = lastTimestamp !== null && lastTimestamp >= expected
      ? lastBytes
      : Buffer.from(`${expected}\n`);
    const nextPending = pendingTimestamp === expected ? null : pendingBytes;
    return {
      kind, resultStatus: 'promoted', expected,
      pending: { before: pendingBytes, after: nextPending },
      last: { before: lastBytes, after: nextLast },
    };
  }

  if (kind === 'repair') {
    return {
      kind, resultStatus: 'repaired',
      pending: {
        before: pendingBytes,
        after: Object.hasOwn(options, 'pendingAfter') ? options.pendingAfter : pendingBytes,
      },
      last: {
        before: lastBytes,
        after: Object.hasOwn(options, 'lastAfter') ? options.lastAfter : lastBytes,
      },
    };
  }
  throw scanError('SCAN_WINDOW_INVALID', 'unsupported scan-window transition kind');
}

function canonicalInput(wikiRoot, plan) {
  return {
    wiki_root: wikiRoot,
    kind: plan.kind,
    proposed: plan.proposed || null,
    expected: plan.expected || null,
    repair_pending_after: plan.kind === 'repair' ? descriptor(plan.pending.after) : null,
    repair_last_after: plan.kind === 'repair' ? descriptor(plan.last.after) : null,
  };
}

function inputHash(wikiRoot, plan) {
  return sha256(Buffer.from(JSON.stringify(canonicalInput(wikiRoot, plan))));
}

function defaultJournalAdapter(wikiRoot, operationId, nestedJunkContext = null) {
  const locations = pathsFor(wikiRoot, operationId);
  const parents = defaultTransactionParentGuard(locations, nestedJunkContext);
  const semanticNames = (directory, expectedDirectoryIdentity, label, assertDirectoryChain) => {
    if (!nestedJunkContext) return fs.readdirSync(directory).sort();
    return assertNestedJunkSettled(semanticTransactionNames({
      ...nestedJunkContext,
      directory,
      expectedDirectoryIdentity,
      label,
      assertOwnerAndParents: assertDirectoryChain,
    }));
  };
  const assertMutation = (assertOwner, assertBoundary) => {
    if (typeof assertBoundary === 'function') assertBoundary();
    if (typeof assertOwner === 'function') assertOwner();
    if (typeof assertBoundary === 'function') assertBoundary();
    parents.assertAll(assertBoundary);
    if (typeof assertBoundary === 'function') assertBoundary();
  };
  const readGuarded = (file, assertBoundary) => {
    parents.assertAll(assertBoundary);
    const value = readMaybe(file);
    if (typeof assertBoundary === 'function') assertBoundary();
    parents.assertAll(assertBoundary);
    return value;
  };
  const writeGuarded = (file, bytes, assertOwner) => {
    const assertSafe = () => assertMutation(assertOwner);
    assertSafe();
    atomicWriteFile(file, bytes, {
      createParent: false,
      beforeRename: assertSafe,
      beforePublish: assertSafe,
    });
    assertSafe();
  };
  const removeGuarded = (file, assertOwner) => {
    assertMutation(assertOwner);
    fs.rmSync(file, { force: true });
    assertMutation(assertOwner);
  };
  const finalizeTerminalQuarantine = (
    quarantine,
    expectedQuarantineIdentity,
    expectedJournal,
    expectedJournalBytes,
    expectedJournalSeal,
    expectedJournalIdentity,
    expectedBackupIdentity,
    assertOwner,
    ageGate,
    assertBudget,
    assertEnsureBoundary,
    onCommitted,
    cursor = { stage: 'evidence', residue: null },
  ) => {
    cursor.stage = 'evidence';
    const quarantinedJournal = path.join(quarantine, 'journal.json');
    const quarantinedBackup = path.join(quarantine, 'journal.backup');
    const backupPending = path.join(quarantine, 'journal.backup.pending');
    const reservationPending = path.join(quarantine, 'source.reservation.pending');
    const allowedNames = new Set([
      'journal.json',
      'journal.backup',
      'journal.backup.pending',
      'source.reservation.pending',
    ]);
    const assertPruneBudget = () => {
      if (typeof assertBudget === 'function') assertBudget();
    };
    const assertTransactionsOwner = () => {
      assertPruneBudget();
      if (typeof assertOwner === 'function') assertOwner();
      assertPruneBudget();
      parents.assertTransactions(assertPruneBudget);
      assertPruneBudget();
    };
    const inspectPublication = (pathname, allowMissing = false) => {
      assertPruneBudget();
      let identity;
      try {
        identity = linkedRegularFileIdentity(fs.lstatSync(pathname, { bigint: true }));
      } catch (cause) {
        if (allowMissing && cause.code === 'ENOENT') return null;
        throw blockedError('publication-unavailable', 'terminal prune publication is unavailable',
          cause,
        );
      }
      if (!identity) {
        throw blockedError(
          pathname === backupPending || pathname === reservationPending
            ? 'pending-not-regular-file'
            : 'destination-not-regular-file',
          'terminal prune publication identity is invalid',
        );
      }
      assertPruneBudget();
      const bytes = fs.readFileSync(pathname);
      assertPruneBudget();
      const current = linkedRegularFileIdentity(fs.lstatSync(pathname, { bigint: true }));
      if (!identitiesMatch(current, identity)
          || current.mtimeNs !== identity.mtimeNs
          || current.nlink !== identity.nlink) {
        throw blockedError('publication-changed', 'terminal prune publication identity changed',
        );
      }
      assertPruneBudget();
      return { identity, bytes };
    };
    const assertExactPublication = (
      pathname,
      expectedBytes,
      expectedIdentity = null,
      allowedLinks = [1n],
    ) => {
      const publication = inspectPublication(pathname);
      if ((expectedIdentity && !identitiesMatch(publication.identity, expectedIdentity))
          || !allowedLinks.includes(publication.identity.nlink)
          || !publication.bytes.equals(expectedBytes)) {
        throw blockedError('destination-mismatch', 'terminal prune publication is not the expected exact generation',
        );
      }
      return publication;
    };
    const assertQuarantine = (expectedNames = null) => {
      assertTransactionsOwner();
      const actual = inspectPhysicalDirectory(
        quarantine,
        quarantine,
        'terminal journal prune quarantine',
      );
      assertPruneBudget();
      if (!identitiesMatch(actual, expectedQuarantineIdentity)) {
        const error = scanError(
          'SCAN_WINDOW_FILESYSTEM',
          'terminal journal prune quarantine identity changed',
        );
        error.prune_reason = 'quarantine-identity-changed';
        throw error;
      }
      const actualNames = semanticNames(
        quarantine,
        expectedQuarantineIdentity,
        'terminal journal prune quarantine',
        assertTransactionsOwner,
      );
      assertPruneBudget();
      if ((expectedNames && (actualNames.length !== expectedNames.length
          || actualNames.some((name, index) => name !== expectedNames[index])))
          || (!expectedNames && actualNames.some((name) => !allowedNames.has(name)))) {
        throw blockedError('unexpected-entries', 'terminal journal prune quarantine contains unexpected entries',
        );
      }
      assertTransactionsOwner();
    };
    const assertSealedEvidence = (pathname, expectedIdentity, applyAgeGate = false) => {
      assertPruneBudget();
      let identity = expectedIdentity;
      if (identity === null) {
        identity = regularFileIdentity(fs.lstatSync(pathname, { bigint: true }));
        assertPruneBudget();
        if (!identity) {
          throw blockedError('evidence-mismatch', 'terminal prune evidence identity is invalid',
          );
        }
      }
      assertRegularFileIdentity(pathname, identity, applyAgeGate ? ageGate : null);
      assertPruneBudget();
      const bytes = fs.readFileSync(pathname);
      assertPruneBudget();
      assertRegularFileIdentity(pathname, identity, applyAgeGate ? ageGate : null);
      assertPruneBudget();
      if (!sealedBytesEqual(bytes, expectedJournalBytes, expectedJournalSeal)) {
        throw blockedError('evidence-mismatch', 'terminal prune evidence bytes changed',
        );
      }
      const quarantined = JSON.parse(bytes.toString('utf8'));
      validateJournal(quarantined, operationId, wikiRoot);
      if (quarantined.transitions.at(-1) !== 'cleaned'
          || !bytes.equals(stageBytes(quarantined))
          || JSON.stringify(quarantined) !== JSON.stringify(expectedJournal)) {
        throw blockedError('evidence-mismatch', 'terminal prune evidence is not the sealed cleaned journal',
        );
      }
      return identity;
    };
    const publishExactExclusive = (
      pendingPath,
      destination,
      expectedBytes,
      label,
      boundaryKey,
      expectedDestinationIdentity = null,
    ) => {
      assertQuarantine();
      let destinationState = inspectPublication(destination, true);
      let pendingState = inspectPublication(pendingPath, true);
      if (destinationState) {
        if (!destinationState.bytes.equals(expectedBytes)
            || ![1n, 2n].includes(destinationState.identity.nlink)
            || (expectedDestinationIdentity
              && !identitiesMatch(destinationState.identity, expectedDestinationIdentity))) {
          throw blockedError('destination-mismatch', `${label} destination is not the expected generation`,
          );
        }
        if (pendingState) {
          if (!pendingState.bytes.equals(expectedBytes)
              || pendingState.identity.nlink !== 2n
              || destinationState.identity.nlink !== 2n
              || !identitiesMatch(pendingState.identity, destinationState.identity)) {
            throw blockedError('publication-ambiguous', `${label} interrupted publication is ambiguous`,
            );
          }
          assertPruneBudget();
          assertQuarantine();
          assertExactPublication(pendingPath, expectedBytes, pendingState.identity, [2n]);
          assertExactPublication(destination, expectedBytes, destinationState.identity, [2n]);
          assertEnsureBoundary(`before-${boundaryKey}-pending-hardlink-unlink`);
          fs.unlinkSync(pendingPath);
          assertQuarantine();
          destinationState = assertExactPublication(
            destination,
            expectedBytes,
            destinationState.identity,
          );
        } else if (destinationState.identity.nlink !== 1n) {
          throw blockedError('destination-link-count', `${label} destination link count is ambiguous`,
          );
        }
        return destinationState.identity;
      }

      if (pendingState && (pendingState.identity.nlink !== 1n
          || !pendingState.bytes.equals(expectedBytes))) {
        assertPruneBudget();
        assertQuarantine();
        const current = inspectPublication(pendingPath);
        if (!identitiesMatch(current.identity, pendingState.identity)
            || current.identity.nlink !== 1n
            || !current.bytes.equals(pendingState.bytes)) {
          throw blockedError('publication-changed', `${label} interrupted publication changed`,
          );
        }
        assertEnsureBoundary(`before-${boundaryKey}-pending-discard`);
        fs.unlinkSync(pendingPath);
        assertQuarantine();
        pendingState = null;
      }

      if (!pendingState) {
        assertPruneBudget();
        assertQuarantine();
        let descriptor;
        try {
          descriptor = fs.openSync(pendingPath, 'wx', 0o600);
          fs.writeFileSync(descriptor, expectedBytes);
          fs.fsyncSync(descriptor);
        } catch (cause) {
          throw blockedError('stage-failed', `${label} interrupted publication could not be staged`,
            cause,
          );
        } finally {
          if (descriptor !== undefined) fs.closeSync(descriptor);
        }
        pendingState = assertExactPublication(pendingPath, expectedBytes);
      } else {
        assertPruneBudget();
        assertQuarantine();
        let descriptor;
        try {
          descriptor = fs.openSync(pendingPath, 'r');
          fs.fsyncSync(descriptor);
        } catch (cause) {
          throw blockedError('stage-failed', `${label} interrupted publication could not be synchronized`,
            cause,
          );
        } finally {
          if (descriptor !== undefined) fs.closeSync(descriptor);
        }
        pendingState = assertExactPublication(
          pendingPath,
          expectedBytes,
          pendingState.identity,
        );
      }

      assertPruneBudget();
      assertQuarantine();
      assertExactPublication(pendingPath, expectedBytes, pendingState.identity);
      assertEnsureBoundary(`before-${boundaryKey}-destination-link`);
      try {
        fs.linkSync(pendingPath, destination);
      } catch (cause) {
        throw blockedError(
            cause && cause.code === 'EEXIST' ? 'destination-occupied' : 'link-failed',
            `${label} destination could not be published exclusively`,
          cause,
        );
      }
      const linkedPending = assertExactPublication(
        pendingPath,
        expectedBytes,
        pendingState.identity,
        [2n],
      );
      const linkedDestination = assertExactPublication(
        destination,
        expectedBytes,
        pendingState.identity,
        [2n],
      );
      if (!identitiesMatch(linkedPending.identity, linkedDestination.identity)) {
        throw blockedError('hardlink-identity-differs', `${label} published hardlink identity differs`,
        );
      }
      assertPruneBudget();
      assertQuarantine();
      assertEnsureBoundary(`before-${boundaryKey}-staged-unlink`);
      fs.unlinkSync(pendingPath);
      assertQuarantine();
      return assertExactPublication(
        destination,
        expectedBytes,
        linkedDestination.identity,
      ).identity;
    };

    assertPruneBudget();
    const initialNames = semanticNames(
      quarantine,
      expectedQuarantineIdentity,
      'terminal journal prune quarantine',
      assertTransactionsOwner,
    );
    assertPruneBudget();
    const hasJournal = initialNames.includes('journal.json');
    const hasBackup = initialNames.includes('journal.backup');
    if ((!hasJournal && !hasBackup)
        || initialNames.some((name) => !allowedNames.has(name))) {
      throw blockedError('evidence-set-invalid', 'terminal quarantine evidence set is invalid',
      );
    }
    if (hasJournal) {
      assertSealedEvidence(quarantinedJournal, expectedJournalIdentity, true);
    }
    let backupIdentity = expectedBackupIdentity;
    if (hasBackup) {
      const backupState = inspectPublication(quarantinedBackup);
      if (!backupState.bytes.equals(expectedJournalBytes)
          || ![1n, 2n].includes(backupState.identity.nlink)
          || (backupIdentity && !identitiesMatch(backupState.identity, backupIdentity))) {
        throw blockedError('destination-mismatch', 'terminal prune backup generation is invalid',
        );
      }
      backupIdentity = backupState.identity;
    }

    cursor.stage = 'backup-publication';
    backupIdentity = publishExactExclusive(
      backupPending,
      quarantinedBackup,
      expectedJournalBytes,
      'terminal prune backup',
      'backup',
      backupIdentity,
    );
    assertSealedEvidence(quarantinedBackup, backupIdentity);
    cursor.stage = 'reservation-publication';
    const activeIdentity = publishExactExclusive(
      reservationPending,
      locations.transaction,
      expectedJournalBytes,
      'terminal prune source reservation',
      'reservation',
    );

    cursor.stage = 'teardown';
    assertQuarantine(hasJournal
      ? ['journal.backup', 'journal.json']
      : ['journal.backup']);
    assertExactPublication(
      locations.transaction,
      expectedJournalBytes,
      activeIdentity,
    );
    if (hasJournal) {
      assertSealedEvidence(quarantinedJournal, expectedJournalIdentity, true);
      assertPruneBudget();
      assertEnsureBoundary('before-quarantined-journal-unlink');
      assertQuarantine(['journal.backup', 'journal.json']);
      fs.unlinkSync(quarantinedJournal);
      assertExactPublication(
        locations.transaction,
        expectedJournalBytes,
        activeIdentity,
      );
    }
    assertQuarantine(['journal.backup']);
    assertSealedEvidence(quarantinedBackup, backupIdentity);
    assertExactPublication(
      locations.transaction,
      expectedJournalBytes,
      activeIdentity,
    );
    assertPruneBudget();
    assertEnsureBoundary('before-quarantined-backup-unlink');
    assertQuarantine(['journal.backup']);
    fs.unlinkSync(quarantinedBackup);
    assertExactPublication(
      locations.transaction,
      expectedJournalBytes,
      activeIdentity,
    );
    assertQuarantine([]);
    assertPruneBudget();
    assertEnsureBoundary('before-quarantine-rmdir');
    assertQuarantine([]);
    fs.rmdirSync(quarantine);
    cursor.residue = operationId;
    assertTransactionsOwner();
    assertExactPublication(
      locations.transaction,
      expectedJournalBytes,
      activeIdentity,
    );
    assertPruneBudget();
    assertEnsureBoundary('before-final-canonical-reservation-unlink');
    fs.unlinkSync(locations.transaction);
    if (typeof onCommitted === 'function') onCommitted();
    assertTransactionsOwner();
  };
  const finalizeEmptyTerminalQuarantine = (
    quarantine,
    expectedQuarantineIdentity,
    expectedReservationBytes,
    expectedReservationIdentity,
    assertOwner,
    assertBudget,
    assertEnsureBoundary,
    onCommitted,
    cursor = { stage: 'empty-quarantine', residue: null },
  ) => {
    cursor.stage = 'empty-quarantine';
    const assertPruneBudget = () => {
      if (typeof assertBudget === 'function') assertBudget();
    };
    const assertTransactionsOwner = () => {
      assertPruneBudget();
      if (typeof assertOwner === 'function') assertOwner();
      assertPruneBudget();
      parents.assertTransactions(assertPruneBudget);
      assertPruneBudget();
    };
    const assertEmptyQuarantine = () => {
      assertTransactionsOwner();
      const identity = inspectPhysicalDirectory(
        quarantine,
        quarantine,
        'terminal journal prune quarantine',
      );
      assertPruneBudget();
      const names = semanticNames(
        quarantine,
        expectedQuarantineIdentity,
        'terminal journal prune quarantine',
        assertTransactionsOwner,
      );
      assertPruneBudget();
      if (!identitiesMatch(identity, expectedQuarantineIdentity) || names.length !== 0) {
        throw blockedError('quarantine-identity-changed', 'empty terminal quarantine identity or contents changed',
        );
      }
      assertTransactionsOwner();
    };
    const assertReservation = (pathname, expectedIdentity) => {
      assertTransactionsOwner();
      assertRegularFileIdentity(pathname, expectedIdentity);
      assertPruneBudget();
      const bytes = fs.readFileSync(pathname);
      assertPruneBudget();
      assertRegularFileIdentity(pathname, expectedIdentity);
      assertPruneBudget();
      if (!bytes.equals(expectedReservationBytes)) {
        throw blockedError('reservation-mismatch', 'terminal prune reservation bytes changed',
        );
      }
      assertTransactionsOwner();
    };

    assertEmptyQuarantine();
    assertReservation(locations.transaction, expectedReservationIdentity);
    assertPruneBudget();
    assertEnsureBoundary('before-empty-quarantine-rmdir');
    assertEmptyQuarantine();
    fs.rmdirSync(quarantine);
    cursor.residue = operationId;
    assertTransactionsOwner();
    assertReservation(locations.transaction, expectedReservationIdentity);
    assertPruneBudget();
    assertEnsureBoundary('before-empty-quarantine-reservation-unlink');
    fs.unlinkSync(locations.transaction);
    if (typeof onCommitted === 'function') onCommitted();
    assertTransactionsOwner();
  };
  return {
    locations,
    activateTransaction(value, assertOwner, options) {
      parents.prepareParent(assertOwner);
      const activation = path.join(
        locations.transactions,
        `.activate-${process.pid}-${crypto.randomUUID()}`,
      );
      assertOwner();
      parents.assertTransactions();
      fs.mkdirSync(activation);
      const identity = inspectPhysicalDirectory(
        activation, activation, 'scan-window activation directory',
      );
      const assertActivation = () => {
        assertOwner();
        parents.assertTransactions();
        const current = inspectPhysicalDirectory(
          activation, activation, 'scan-window activation directory',
        );
        if (!identitiesMatch(current, identity)) {
          throw scanError('SCAN_WINDOW_FILESYSTEM', 'scan-window activation directory identity changed');
        }
        parents.assertTransactions();
      };
      atomicWriteFile(path.join(activation, 'journal.json'), `${JSON.stringify(value)}\n`, {
        createParent: false,
        beforeRename: assertActivation,
        beforePublish: assertActivation,
      });
      assertActivation();
      invokeFault(options.faultInjector, 'before-transaction-activate');
      assertActivation();
      fs.renameSync(activation, locations.transaction);
      invokeFault(options.faultInjector, 'after-transaction-activate');
    },
    readJournal() {
      if (!parents.inspectExistingOperation()) return null;
      try {
        const bytes = readGuarded(locations.journal);
        return bytes === null ? null : JSON.parse(bytes.toString('utf8'));
      }
      catch (error) {
        if (error instanceof ScanWindowError) throw error;
        if (error.code === 'ENOENT') return null;
        throw scanError('TRANSACTION_RECOVERY_REQUIRED', 'journal is unreadable', error);
      }
    },
    writeJournal(value, assertOwner) {
      writeGuarded(locations.journal, `${JSON.stringify(value)}\n`, assertOwner);
    },
    readStage(name) { return readGuarded(path.join(locations.transaction, `stage-${name}.json`)); },
    writeStage(name, bytes, assertOwner) {
      writeGuarded(path.join(locations.transaction, `stage-${name}.json`), bytes, assertOwner);
    },
    removeStage(name, assertOwner) {
      removeGuarded(path.join(locations.transaction, `stage-${name}.json`), assertOwner);
    },
    tombstonePath: locations.tombstone,
    [DEFAULT_ADAPTER_CONTROL]: {
      prepareDebrisSweep(assertOwner) {
        parents.prepareParent(assertOwner);
      },
      readDestination(file) {
        if (file !== locations.pending && file !== locations.last) {
          throw scanError('SCAN_WINDOW_FILESYSTEM', 'default adapter destination is outside .wiki-meta');
        }
        return readGuarded(file);
      },
      writeDestination(file, bytes, assertOwner) {
        if (file !== locations.pending && file !== locations.last) {
          throw scanError('SCAN_WINDOW_FILESYSTEM', 'default adapter destination is outside .wiki-meta');
        }
        writeGuarded(file, bytes, assertOwner);
      },
      prepareTombstoneParent(assertOwner) {
        assertMutation(assertOwner);
      },
      removeTombstone(file, assertOwner) {
        if (file !== locations.tombstone) {
          throw scanError('SCAN_WINDOW_FILESYSTEM', 'default adapter tombstone is outside the operation directory');
        }
        removeGuarded(file, assertOwner);
      },
      movePendingToTombstone(file, tombstone, assertOwner) {
        if ((file !== locations.pending && file !== locations.last)
            || tombstone !== locations.tombstone) {
          throw scanError('SCAN_WINDOW_FILESYSTEM', 'default adapter tombstone move escapes bound parents');
        }
        assertMutation(assertOwner);
        fs.renameSync(file, tombstone);
        assertMutation(assertOwner);
      },
      readJournalBytes(assertBoundary) {
        return readGuarded(locations.journal, assertBoundary);
      },
      removeCleanedTransaction(
        expectedJournal,
        expectedJournalBytes,
        expectedJournalSeal,
        expectedJournalIdentity,
        assertOwner,
        ageGate,
        assertBudget,
        assertEnsureBoundary,
        onCommitted,
      ) {
        assertMutation(assertOwner, assertBudget);
        if (typeof assertBudget === 'function') assertBudget();
        const names = semanticNames(
          locations.transaction,
          null,
          'scan-window operation directory',
          () => assertMutation(assertOwner, assertBudget),
        );
        if (typeof assertBudget === 'function') assertBudget();
        if (names.length !== 1 || names[0] !== 'journal.json') {
          throw blockedError(
            'unexpected-entries','cleaned transaction contains unexpected entries',
          );
        }
        let current;
        let currentBytes;
        try {
          assertRegularFileIdentity(locations.journal, expectedJournalIdentity);
          if (typeof assertBudget === 'function') assertBudget();
          currentBytes = fs.readFileSync(locations.journal);
          if (typeof assertBudget === 'function') assertBudget();
          assertRegularFileIdentity(locations.journal, expectedJournalIdentity);
          if (typeof assertBudget === 'function') assertBudget();
          current = JSON.parse(currentBytes.toString('utf8'));
        } catch (cause) {
          if (cause.code === 'DEADLINE_EXCEEDED') throw cause;
          throw blockedError('evidence-mismatch', 'cleaned journal is unreadable', cause);
        }
        validateJournal(current, operationId, wikiRoot);
        if (current.transitions.at(-1) !== 'cleaned'
            || !sealedBytesEqual(currentBytes, expectedJournalBytes, expectedJournalSeal)
            || !currentBytes.equals(stageBytes(current))
            || JSON.stringify(current) !== JSON.stringify(expectedJournal)) {
          throw blockedError('evidence-mismatch', 'cleaned journal changed before pruning');
        }

        const transactionIdentity = inspectPhysicalDirectory(
          locations.transaction,
          locations.transaction,
          'scan-window operation directory',
        );
        if (typeof assertBudget === 'function') assertBudget();
        const quarantine = path.join(
          locations.transactions,
          `.prune-${operationId.length}-${operationId}-${process.pid}-${crypto.randomUUID()}`,
        );
        const cursor = { stage: 'quarantine-entry', residue: operationId };
        try {
          assertMutation(assertOwner, assertBudget);
          if (typeof assertBudget === 'function') assertBudget();
          const finalNames = semanticNames(
            locations.transaction,
            transactionIdentity,
            'scan-window operation directory',
            () => assertMutation(assertOwner, assertBudget),
          );
          if (typeof assertBudget === 'function') assertBudget();
          if (finalNames.length !== 1 || finalNames[0] !== 'journal.json') {
            throw blockedError('unexpected-entries', 'terminal transaction changed before quarantine',
            );
          }
          assertRegularFileIdentity(locations.journal, expectedJournalIdentity, ageGate);
          if (typeof assertBudget === 'function') assertBudget();
          assertMutation(assertOwner, assertBudget);
          if (typeof assertBudget === 'function') assertBudget();
          assertEnsureBoundary('before-transaction-quarantine-rename');
          fs.renameSync(locations.transaction, quarantine);
        } catch (cause) {
          if (cause.code === 'DEADLINE_EXCEEDED'
              || cause.code === 'SCAN_WINDOW_NESTED_JUNK_DEFERRED'
              || cause.nestedJunkSafety === true
              || (typeof cause.code === 'string' && cause.code.startsWith('LOCK_'))) throw cause;
          if (cause.ensurePruneProtected) throw cause;
          const error = scanError(
            'TRANSACTION_RECOVERY_REQUIRED',
            'terminal transaction could not enter quarantine',
            cause,
          );
          throw withPruneBlock(error, cursor, fallbackPruneReason);
        }
        cursor.residue = path.basename(quarantine);

        try {
          finalizeTerminalQuarantine(
            quarantine,
            transactionIdentity,
            expectedJournal,
            expectedJournalBytes,
            expectedJournalSeal,
            expectedJournalIdentity,
            null,
            assertOwner,
            ageGate,
            assertBudget,
            assertEnsureBoundary,
            onCommitted,
            cursor,
          );
        } catch (cause) {
          if (cause.code === 'DEADLINE_EXCEEDED'
              || cause.code === 'SCAN_WINDOW_NESTED_JUNK_DEFERRED'
              || cause.nestedJunkSafety === true
              || (typeof cause.code === 'string' && cause.code.startsWith('LOCK_'))) throw cause;
          if (cause.ensurePruneProtected) throw cause;
          const error = scanError(
            'TRANSACTION_RECOVERY_REQUIRED',
            'quarantined terminal transaction requires recovery',
            cause,
          );
          throw withPruneBlock(error, cursor, fallbackPruneReason);
        }
      },
      removeCleanedQuarantine(
        quarantineName,
        expectedQuarantineIdentity,
        expectedJournal,
        expectedJournalBytes,
        expectedJournalSeal,
        expectedJournalIdentity,
        expectedBackupIdentity,
        assertOwner,
        ageGate,
        assertBudget,
        assertEnsureBoundary,
        onCommitted,
      ) {
        if (path.basename(quarantineName) !== quarantineName
            || !quarantineName.startsWith(`.prune-${operationId.length}-${operationId}-`)) {
          throw scanError('TRANSACTION_RECOVERY_REQUIRED', 'terminal quarantine name is invalid');
        }
        const quarantine = path.join(locations.transactions, quarantineName);
        const cursor = { stage: 'evidence', residue: quarantineName };
        try {
          finalizeTerminalQuarantine(
            quarantine,
            expectedQuarantineIdentity,
            expectedJournal,
            expectedJournalBytes,
            expectedJournalSeal,
            expectedJournalIdentity,
            expectedBackupIdentity,
            assertOwner,
            ageGate,
            assertBudget,
            assertEnsureBoundary,
            onCommitted,
            cursor,
          );
        } catch (cause) {
          if (cause.code === 'DEADLINE_EXCEEDED'
              || cause.code === 'SCAN_WINDOW_NESTED_JUNK_DEFERRED'
              || cause.nestedJunkSafety === true
              || (typeof cause.code === 'string' && cause.code.startsWith('LOCK_'))) throw cause;
          if (cause.ensurePruneProtected) throw cause;
          const error = scanError(
            'TRANSACTION_RECOVERY_REQUIRED',
            'terminal quarantine requires recovery',
            cause,
          );
          throw withPruneBlock(error, cursor, fallbackPruneReason);
        }
      },
      removeEmptyCleanedQuarantine(
        quarantineName,
        expectedQuarantineIdentity,
        expectedReservationBytes,
        expectedReservationIdentity,
        assertOwner,
        assertBudget,
        assertEnsureBoundary,
        onCommitted,
      ) {
        if (path.basename(quarantineName) !== quarantineName
            || !quarantineName.startsWith(`.prune-${operationId.length}-${operationId}-`)) {
          throw scanError('TRANSACTION_RECOVERY_REQUIRED', 'empty quarantine name is invalid');
        }
        const quarantine = path.join(locations.transactions, quarantineName);
        const cursor = { stage: 'empty-quarantine', residue: quarantineName };
        try {
          finalizeEmptyTerminalQuarantine(
            quarantine,
            expectedQuarantineIdentity,
            expectedReservationBytes,
            expectedReservationIdentity,
            assertOwner,
            assertBudget,
            assertEnsureBoundary,
            onCommitted,
            cursor,
          );
        } catch (cause) {
          if (cause.code === 'DEADLINE_EXCEEDED'
              || cause.code === 'SCAN_WINDOW_NESTED_JUNK_DEFERRED'
              || cause.nestedJunkSafety === true
              || (typeof cause.code === 'string' && cause.code.startsWith('LOCK_'))) throw cause;
          if (cause.ensurePruneProtected) throw cause;
          const error = scanError(
            'TRANSACTION_RECOVERY_REQUIRED',
            'empty terminal quarantine requires recovery',
            cause,
          );
          throw withPruneBlock(error, cursor, fallbackPruneReason);
        }
      },
    },
  };
}

function adapterFor(wikiRoot, operationId, provided) {
  if (!provided) return defaultJournalAdapter(wikiRoot, operationId);
  for (const method of ['readJournal', 'writeJournal', 'readStage', 'writeStage', 'removeStage']) {
    if (typeof provided[method] !== 'function') throw scanError('SCAN_WINDOW_INVALID', `journalAdapter.${method} is required`);
  }
  const locations = pathsFor(wikiRoot, operationId);
  return { ...provided, locations, tombstonePath: provided.tombstonePath || locations.tombstone };
}

function assertPersistenceDeadline(deadline, boundary) {
  if (deadline) assertBeforeDeadline(deadline, `scan-window-persistence:${boundary}`);
}

function mutateTransactionMetadata(options, boundary, mutation) {
  assertPersistenceDeadline(options.deadline, `${boundary}:before-fault`);
  invokeFault(options.faultInjector, boundary);
  assertPersistenceDeadline(options.deadline, `${boundary}:after-fault`);
  const assertOwner = () => assertLockOwner({ wikiRoot: options.wikiRoot, token: options.token });
  assertOwner();
  mutation(assertOwner);
  assertOwner();
}

function appendTransition(adapter, journal, transition, options) {
  if (!journal.transitions.includes(transition)) {
    assertPersistenceDeadline(options.deadline, `${transition}:journal-before`);
    const next = { ...journal, transitions: [...journal.transitions, transition] };
    mutateTransactionMetadata(options, `before-transition-${transition}-write`, (assertOwner) => {
      adapter.writeJournal(next, assertOwner);
    });
    journal.transitions = next.transitions;
    assertPersistenceDeadline(options.deadline, `${transition}:journal-after`);
  }
}

function invokeFault(faultInjector, stage, context) {
  if (typeof faultInjector === 'function') faultInjector(stage, context);
}

function makeJournal({ operationId, ownerToken, plan, wikiRoot }) {
  const input = canonicalInput(wikiRoot, plan);
  const states = {
    pending: { before: descriptor(plan.pending.before), after: descriptor(plan.pending.after) },
    last: { before: descriptor(plan.last.before), after: descriptor(plan.last.after) },
  };
  const stageHashes = {};
  for (const name of STAGES) {
    const [target, side] = name.split('-');
    stageHashes[name] = sha256(stageBytes(states[target][side]));
  }
  return {
    contract_version: 1,
    kind: plan.kind,
    operation_id: operationId,
    input,
    input_sha256: sha256(Buffer.from(JSON.stringify(input))),
    owner_token: ownerToken,
    result_status: plan.resultStatus,
    states,
    stage_sha256: stageHashes,
    transitions: ['scan-window-preflighted'],
  };
}

function journalInvalid(message, cause) {
  throw scanError('TRANSACTION_RECOVERY_REQUIRED', message, cause);
}

function validateJournalInput(journal, wikiRoot) {
  const input = journal.input;
  if (!hasExactKeys(input, INPUT_KEYS) || input.wiki_root !== wikiRoot
      || !['ensure', 'promote', 'repair'].includes(input.kind) || journal.kind !== input.kind) {
    journalInvalid('scan-window journal canonical input is malformed');
  }
  if (!SHA256_RE.test(journal.input_sha256)
      || sha256(Buffer.from(JSON.stringify(input))) !== journal.input_sha256) {
    journalInvalid('scan-window journal canonical input hash mismatch');
  }
  try {
    if (input.kind === 'ensure') {
      canonicalTimestamp(input.proposed, 'journal proposed');
      if (input.expected !== null || input.repair_pending_after !== null || input.repair_last_after !== null) {
        journalInvalid('ensure journal contains foreign canonical input fields');
      }
    } else if (input.kind === 'promote') {
      canonicalTimestamp(input.expected, 'journal expected');
      if (input.proposed !== null || input.repair_pending_after !== null || input.repair_last_after !== null) {
        journalInvalid('promote journal contains foreign canonical input fields');
      }
    } else {
      if (input.proposed !== null || input.expected !== null) {
        journalInvalid('repair journal contains ensure or promote input');
      }
      bytesFromDescriptor(input.repair_pending_after);
      bytesFromDescriptor(input.repair_last_after);
    }
  } catch (cause) {
    if (cause.code === 'TRANSACTION_RECOVERY_REQUIRED') throw cause;
    journalInvalid('scan-window journal canonical input is invalid', cause);
  }
  return input;
}

function validateJournalStates(journal, input) {
  if (!hasExactKeys(journal.states, ['pending', 'last'])) {
    journalInvalid('scan-window journal states are malformed');
  }
  const bytes = {};
  for (const target of ['pending', 'last']) {
    const record = journal.states[target];
    if (!hasExactKeys(record, ['before', 'after'])) {
      journalInvalid(`scan-window ${target} state is malformed`);
    }
    bytes[target] = {
      before: bytesFromDescriptor(record.before),
      after: bytesFromDescriptor(record.after),
    };
  }

  let expected;
  if (input.kind === 'ensure') {
    expected = planScanWindowTransition({
      kind: 'ensure', proposed: input.proposed,
      pendingBytes: bytes.pending.before, lastBytes: bytes.last.before,
    });
  } else if (input.kind === 'promote') {
    expected = planScanWindowTransition({
      kind: 'promote', expected: input.expected,
      pendingBytes: bytes.pending.before, lastBytes: bytes.last.before,
    });
  } else {
    expected = {
      resultStatus: 'repaired',
      pending: { after: bytesFromDescriptor(input.repair_pending_after) },
      last: { after: bytesFromDescriptor(input.repair_last_after) },
    };
  }
  if (journal.result_status !== expected.resultStatus
      || !bytesEqual(bytes.pending.after, expected.pending.after)
      || !bytesEqual(bytes.last.after, expected.last.after)) {
    journalInvalid('scan-window journal result or state transition is inconsistent with canonical input');
  }
  return bytes;
}

function validateStageHashes(journal) {
  if (!hasExactKeys(journal.stage_sha256, STAGES)) {
    journalInvalid('scan-window stage hash map is malformed');
  }
  for (const name of STAGES) {
    const [target, side] = name.split('-');
    const expected = sha256(stageBytes(journal.states[target][side]));
    if (!SHA256_RE.test(journal.stage_sha256[name]) || journal.stage_sha256[name] !== expected) {
      journalInvalid(`scan-window stage hash mismatch for ${name}`);
    }
  }
}

function validateTransitions(journal, stateBytes) {
  if (!Array.isArray(journal.transitions) || journal.transitions.length === 0
      || journal.transitions[0] !== 'scan-window-preflighted') {
    journalInvalid('scan-window transition history is malformed');
  }
  let previous = -1;
  const seen = new Set();
  for (const transition of journal.transitions) {
    const rank = TRANSITIONS.indexOf(transition);
    if (rank < 0 || rank <= previous || seen.has(transition)) {
      journalInvalid('scan-window transition history has unknown, duplicate, or out-of-order entries');
    }
    previous = rank;
    seen.add(transition);
  }
  const lastChanged = !bytesEqual(stateBytes.last.before, stateBytes.last.after);
  const pendingChanged = !bytesEqual(stateBytes.pending.before, stateBytes.pending.after);
  if ((seen.has('last-scan-written') || seen.has('pending-scan-written')
       || seen.has('scan-window-committed') || seen.has('cleaned'))
      && !seen.has('scan-window-staged')) {
    journalInvalid('scan-window destination transition precedes staging');
  }
  if (seen.has('last-scan-written') !== lastChanged
      && seen.has('last-scan-written')) {
    journalInvalid('scan-window journal records an unchanged last-scan write');
  }
  if (seen.has('pending-scan-written') !== pendingChanged
      && seen.has('pending-scan-written')) {
    journalInvalid('scan-window journal records an unchanged pending-scan write');
  }
  if (seen.has('pending-scan-written') && lastChanged && !seen.has('last-scan-written')) {
    journalInvalid('pending-scan transition precedes a required last-scan transition');
  }
  if (seen.has('scan-window-committed')
      && ((lastChanged && !seen.has('last-scan-written'))
          || (pendingChanged && !seen.has('pending-scan-written')))) {
    journalInvalid('scan-window committed before all changed destinations');
  }
  if (seen.has('cleaned') && !seen.has('scan-window-committed')) {
    journalInvalid('scan-window cleaned before commit');
  }
}

function validateJournal(journal, operationId, wikiRoot) {
  if (!hasExactKeys(journal, JOURNAL_KEYS) || journal.contract_version !== 1
      || journal.operation_id !== operationId || !TOKEN_RE.test(journal.owner_token)) {
    journalInvalid('scan-window journal is malformed');
  }
  const input = validateJournalInput(journal, wikiRoot);
  const stateBytes = validateJournalStates(journal, input);
  validateStageHashes(journal);
  validateTransitions(journal, stateBytes);
  return journal;
}

function stageTransaction(adapter, journal, options = {}) {
  const { faultInjector, deadline } = options;
  for (const name of STAGES) {
    assertPersistenceDeadline(deadline, `${name}:stage-read`);
    const [target, side] = name.split('-');
    const expected = stageBytes(journal.states[target][side]);
    const existing = adapter.readStage(name);
    if (existing === null) {
      assertPersistenceDeadline(deadline, `${name}:stage-before`);
      mutateTransactionMetadata(options, `before-stage-${name}-write`, (assertOwner) => {
        adapter.writeStage(name, expected, assertOwner);
      });
      invokeFault(faultInjector, `after-stage-${name}`);
      assertPersistenceDeadline(deadline, `${name}:stage-after`);
    } else if (sha256(existing) !== journal.stage_sha256[name] || !existing.equals(expected)) {
      throw scanError('TRANSACTION_RECOVERY_REQUIRED', `corrupt staged bytes for ${name}`);
    }
  }
  appendTransition(adapter, journal, 'scan-window-staged', options);
}

function verifyStages(adapter, journal) {
  for (const name of STAGES) {
    const [target, side] = name.split('-');
    const expected = stageBytes(journal.states[target][side]);
    const actual = adapter.readStage(name);
    if (actual === null || sha256(actual) !== journal.stage_sha256[name] || !actual.equals(expected)) {
      throw scanError('TRANSACTION_RECOVERY_REQUIRED', `corrupt staged bytes for ${name}`);
    }
    try {
      bytesFromDescriptor(JSON.parse(actual.toString('utf8')));
    } catch (cause) {
      if (cause.code === 'TRANSACTION_RECOVERY_REQUIRED') throw cause;
      throw scanError('TRANSACTION_RECOVERY_REQUIRED', `staged descriptor is invalid for ${name}`, cause);
    }
  }
}

function destinationState(adapter, file, before, after) {
  const control = adapter[DEFAULT_ADAPTER_CONTROL];
  const current = control ? control.readDestination(file) : readMaybe(file);
  if (bytesEqual(current, after)) return 'after';
  if (bytesEqual(current, before)) return 'before';
  return 'conflict';
}

function verifyDestinationStates(adapter, journal, requireAfter = false) {
  for (const target of ['pending', 'last']) {
    const record = journal.states[target];
    const before = bytesFromDescriptor(record.before);
    const after = bytesFromDescriptor(record.after);
    const file = target === 'last' ? adapter.locations.last : adapter.locations.pending;
    const state = destinationState(adapter, file, before, after);
    const unchanged = bytesEqual(before, after);
    if ((requireAfter || unchanged) && state !== 'after') {
      throw scanError('TRANSACTION_RECOVERY_REQUIRED', `${target} destination does not match staged after bytes`);
    }
    if (!requireAfter && !unchanged && state === 'conflict') {
      throw scanError('TRANSACTION_RECOVERY_REQUIRED', `${target} destination diverged from staged bytes`);
    }
  }
}

function writeDestination({
  wikiRoot, token, adapter, file, bytes, beforeFault, afterFault, faultInjector, deadline,
}) {
  assertPersistenceDeadline(deadline, `${beforeFault}:before-fault`);
  invokeFault(faultInjector, beforeFault);
  assertPersistenceDeadline(deadline, `${beforeFault}:after-fault`);
  assertLockOwner({ wikiRoot, token });
  assertPersistenceDeadline(deadline, `${beforeFault}:before-write`);
  const assertOwner = () => assertLockOwner({ wikiRoot, token });
  const control = adapter[DEFAULT_ADAPTER_CONTROL];
  if (control) control.writeDestination(file, bytes, assertOwner);
  else {
    atomicWriteFile(file, bytes, {
      beforeRename: assertOwner,
      beforePublish: assertOwner,
    });
  }
  invokeFault(faultInjector, afterFault);
  assertPersistenceDeadline(deadline, `${afterFault}:after-write`);
}

function removePending({
  wikiRoot, token, adapter, file, tombstone, beforeFault, afterFault, faultInjector, deadline,
}) {
  assertPersistenceDeadline(deadline, `${beforeFault}:before-fault`);
  invokeFault(faultInjector, beforeFault);
  assertPersistenceDeadline(deadline, `${beforeFault}:after-fault`);
  assertLockOwner({ wikiRoot, token });
  const transactionOptions = { wikiRoot, token, faultInjector, deadline };
  const control = adapter[DEFAULT_ADAPTER_CONTROL];
  mutateTransactionMetadata(transactionOptions, 'before-tombstone-parent-create', (assertOwner) => {
    if (control) control.prepareTombstoneParent(assertOwner);
    else {
      assertOwner();
      fs.mkdirSync(path.dirname(tombstone), { recursive: true });
    }
  });
  mutateTransactionMetadata(transactionOptions, 'before-tombstone-prepare-remove', (assertOwner) => {
    if (control) control.removeTombstone(tombstone, assertOwner);
    else {
      assertOwner();
      fs.rmSync(tombstone, { force: true });
    }
  });
  invokeFault(faultInjector, 'before-matching-pending-destination-rename');
  assertPersistenceDeadline(deadline, 'before-matching-pending-destination-rename:after-fault');
  assertLockOwner({ wikiRoot, token });
  assertPersistenceDeadline(deadline, `${beforeFault}:before-remove`);
  if (control) {
    control.movePendingToTombstone(
      file, tombstone, () => assertLockOwner({ wikiRoot, token }),
    );
  } else fs.renameSync(file, tombstone);
  invokeFault(faultInjector, afterFault);
  assertPersistenceDeadline(deadline, `${afterFault}:after-remove`);
}

function applyDestination(adapter, journal, options, target) {
  const transition = target === 'last' ? 'last-scan-written' : 'pending-scan-written';
  const record = journal.states[target];
  const before = bytesFromDescriptor(record.before);
  const after = bytesFromDescriptor(record.after);
  const file = target === 'last' ? adapter.locations.last : adapter.locations.pending;
  if (bytesEqual(before, after)) {
    if (destinationState(adapter, file, before, after) !== 'after') {
      throw scanError('TRANSACTION_RECOVERY_REQUIRED', `${target} unchanged destination diverged from staged bytes`);
    }
    return;
  }
  const state = destinationState(adapter, file, before, after);
  if (state === 'conflict') throw scanError('TRANSACTION_RECOVERY_REQUIRED', `${target} destination diverged from staged bytes`);
  if (!journal.transitions.includes(transition) && state === 'before') {
    if (target === 'last' && after !== null) {
      writeDestination({
        ...options, adapter, file, bytes: after,
        beforeFault: 'before-last-scan-rename', afterFault: 'after-last-scan-rename',
      });
    } else if (target === 'last') {
      removePending({
        ...options, adapter, file, tombstone: adapter.tombstonePath,
        beforeFault: 'before-last-scan-remove', afterFault: 'after-last-scan-remove',
      });
    } else if (after === null) {
      removePending({
        ...options, adapter, file, tombstone: adapter.tombstonePath,
        beforeFault: 'before-matching-pending-remove', afterFault: 'after-matching-pending-remove',
      });
    } else {
      writeDestination({
        ...options, adapter, file, bytes: after,
        beforeFault: 'before-pending-rename', afterFault: 'after-pending-rename',
      });
    }
  }
  const afterState = destinationState(adapter, file, before, after);
  if (afterState !== 'after') throw scanError('TRANSACTION_RECOVERY_REQUIRED', `${target} destination did not reach staged after bytes`);
  appendTransition(adapter, journal, transition, options);
}

function cleanTransaction(adapter, journal, options = {}) {
  const { faultInjector, deadline } = options;
  if (journal.transitions.includes('cleaned')) return;
  assertPersistenceDeadline(deadline, 'cleanup:before-fault');
  invokeFault(faultInjector, 'before-cleanup');
  assertPersistenceDeadline(deadline, 'cleanup:after-fault');
  for (const name of STAGES) {
    assertPersistenceDeadline(deadline, `${name}:cleanup-before`);
    mutateTransactionMetadata(options, `before-stage-${name}-remove`, (assertOwner) => {
      adapter.removeStage(name, assertOwner);
    });
    assertPersistenceDeadline(deadline, `${name}:cleanup-after`);
  }
  assertPersistenceDeadline(deadline, 'tombstone:cleanup-before');
  mutateTransactionMetadata(options, 'before-tombstone-cleanup-remove', (assertOwner) => {
    const control = adapter[DEFAULT_ADAPTER_CONTROL];
    if (control) control.removeTombstone(adapter.tombstonePath, assertOwner);
    else {
      assertOwner();
      fs.rmSync(adapter.tombstonePath, { force: true });
    }
  });
  assertPersistenceDeadline(deadline, 'tombstone:cleanup-after');
  appendTransition(adapter, journal, 'cleaned', options);
}

function applyScanWindowTransition(options = {}) {
  const physicalRoot = physicalWikiRoot(options.wikiRoot);
  const operationId = validateOperationId(options.operationId);
  const token = options.token;
  assertLockOwner({ wikiRoot: physicalRoot, token });
  assertPersistenceDeadline(options.deadline, 'transaction-entry');
  const adapter = adapterFor(physicalRoot, operationId, options.journalAdapter);
  const control = adapter[DEFAULT_ADAPTER_CONTROL];
  let skippedOversized = [];
  if (control) {
    const assertOwner = () => assertLockOwner({ wikiRoot: physicalRoot, token });
    const maintenanceDeadline = options.deadline
      || createDeadline({ budgetMs: 12_000 });
    assertPruneTransactionNamesSupported({
      wikiRoot: physicalRoot,
      token,
      deadline: maintenanceDeadline,
    });
    control.prepareDebrisSweep(assertOwner);
    const debrisReport = sweepTransactionDebris(physicalRoot, token, {
      deadline: maintenanceDeadline,
      classes: ['activation', 'plain', 'junk'],
      inspectDirectoryPressure: options.inspectDirectoryPressure,
    });
    skippedOversized = [...(debrisReport.skipped_oversized || [])];
  }
  const selfPath = path.join(physicalRoot, '.wiki-meta', '.transactions', operationId);
  const selfPressure = (options.inspectDirectoryPressure || inspectDirectoryPressure)(selfPath, {
    deadline: options.deadline,
    allowEnumeration: false,
  });
  if (selfPressure.oversized) {
    const error = scanError('TRANSACTION_OVERSIZED', `scan-window transaction ${operationId} is oversized`);
    error.operationId = operationId;
    error.estimatedEntries = selfPressure.estimatedEntries;
    error.method = selfPressure.method;
    error.wikiRoot = physicalRoot;
    throw error;
  }
  const transactionOptions = { ...options, wikiRoot: physicalRoot, token };
  let journal = adapter.readJournal();
  const planHash = options.plan ? inputHash(physicalRoot, options.plan) : null;
  if (options.inputHash && planHash && options.inputHash !== planHash) {
    throw scanError('SCAN_WINDOW_INVALID', 'provided input hash does not match the requested scan-window plan');
  }
  const requestedHash = options.inputHash || planHash;
  if (journal) {
    journal = validateJournal(journal, operationId, physicalRoot);
    if (requestedHash && journal.input_sha256 !== requestedHash) {
      throw scanError('OPERATION_ID_COLLISION', 'operation id already belongs to different scan-window input');
    }
  } else {
    if (!options.plan || !requestedHash) throw scanError('TRANSACTION_NOT_FOUND', 'scan-window transaction does not exist');
    journal = makeJournal({ operationId, ownerToken: token, plan: options.plan, wikiRoot: physicalRoot });
    if (journal.input_sha256 !== requestedHash) {
      throw scanError('SCAN_WINDOW_INVALID', 'requested scan-window plan did not produce the canonical input hash');
    }
    assertPersistenceDeadline(options.deadline, 'journal-before-create');
    if (typeof adapter.activateTransaction === 'function') {
      mutateTransactionMetadata(transactionOptions, 'before-transaction-directory-create', () => {});
      const assertOwner = () => assertLockOwner({ wikiRoot: physicalRoot, token });
      adapter.activateTransaction(journal, assertOwner, transactionOptions);
    } else {
      mutateTransactionMetadata(transactionOptions, 'before-journal-create-write', (assertOwner) => {
        adapter.writeJournal(journal, assertOwner);
      });
      invokeFault(options.faultInjector, 'after-journal-created');
    }
    assertPersistenceDeadline(options.deadline, 'journal-after-create');
  }
  const cleaned = journal.transitions.includes('cleaned');
  verifyDestinationStates(adapter, journal, cleaned);
  if (cleaned) {
    return { status: journal.result_status, operationId, journal, maintenance: { skipped_oversized: skippedOversized } };
  }
  stageTransaction(adapter, journal, transactionOptions);
  verifyStages(adapter, journal);
  applyDestination(adapter, journal, transactionOptions, 'last');
  applyDestination(adapter, journal, transactionOptions, 'pending');
  verifyDestinationStates(adapter, journal, true);
  appendTransition(adapter, journal, 'scan-window-committed', transactionOptions);
  invokeFault(options.faultInjector, 'after-scan-window-committed');
  assertPersistenceDeadline(options.deadline, 'scan-window-committed:after-fault');
  cleanTransaction(adapter, journal, transactionOptions);
  return { status: journal.result_status, operationId, journal, maintenance: { skipped_oversized: skippedOversized } };
}

function recoverScanWindowTransaction(options = {}) {
  const physicalRoot = physicalWikiRoot(options.wikiRoot);
  const operationId = validateOperationId(options.operationId);
  assertLockOwner({ wikiRoot: physicalRoot, token: options.token });
  const recoverPath = path.join(physicalRoot, '.wiki-meta', '.transactions', operationId);
  const recoverPressure = (options.inspectDirectoryPressure || inspectDirectoryPressure)(recoverPath, {
    deadline: options.deadline,
    allowEnumeration: false,
  });
  if (recoverPressure.oversized) {
    const error = scanError('TRANSACTION_OVERSIZED', `scan-window transaction ${operationId} is oversized`);
    error.operationId = operationId;
    error.estimatedEntries = recoverPressure.estimatedEntries;
    error.method = recoverPressure.method;
    error.wikiRoot = physicalRoot;
    throw error;
  }
  const adapter = adapterFor(physicalRoot, operationId, options.journalAdapter);
  const journal = validateJournal(adapter.readJournal(), operationId, physicalRoot);
  return applyScanWindowTransition({
    ...options,
    wikiRoot: physicalRoot,
    operationId,
    inputHash: journal.input_sha256,
    journalAdapter: adapter,
  });
}

function pruneScanWindowTransactions(options = {}) {
  const physicalRoot = physicalWikiRoot(options.wikiRoot);
  const token = options.token;
  const maxAgeDays = options.maxAgeDays;
  const limit = options.limit === undefined ? AUTOMATIC_PRUNE_LIMIT : options.limit;
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const deadline = options.deadline || createDeadline({ budgetMs: 12_000 });
  const resumableOnly = options.resumableOnly === undefined ? false : options.resumableOnly;
  const suppressEnsurePrune = options.suppressEnsurePrune === undefined
    ? false
    : options.suppressEnsurePrune;
  const faultInjector = options.faultInjector;
  if (!Number.isSafeInteger(maxAgeDays) || maxAgeDays < 0) {
    throw scanError('SCAN_WINDOW_INVALID', 'maxAgeDays must be a nonnegative integer');
  }
  if (!Number.isSafeInteger(limit) || limit < 0) {
    throw scanError('SCAN_WINDOW_INVALID', 'prune limit must be a nonnegative integer');
  }
  if (typeof resumableOnly !== 'boolean') {
    throw scanError('SCAN_WINDOW_INVALID', 'resumableOnly must be a boolean');
  }
  if (typeof suppressEnsurePrune !== 'boolean') {
    throw scanError('SCAN_WINDOW_INVALID', 'suppressEnsurePrune must be a boolean');
  }
  if (faultInjector !== undefined && typeof faultInjector !== 'function') {
    throw scanError('SCAN_WINDOW_INVALID', 'faultInjector must be a function');
  }
  if (!Number.isFinite(now.getTime())) throw scanError('SCAN_WINDOW_INVALID', 'prune time is invalid');
  const kinds = options.kinds === undefined ? null : new Set(options.kinds);
  if (kinds && [...kinds].some((kind) => !['ensure', 'promote', 'repair'].includes(kind))) {
    throw scanError('SCAN_WINDOW_INVALID', 'prune kind is invalid');
  }
  const excludeOperationId = options.excludeOperationId === undefined
    ? null
    : validateOperationId(options.excludeOperationId);

  const assertOwner = () => assertLockOwner({ wikiRoot: physicalRoot, token });
  const assertBudget = () => assertBeforeDeadline(
    deadline,
    'scan-window-transaction-prune',
  );
  const meta = path.join(physicalRoot, '.wiki-meta');
  const transactions = path.join(meta, '.transactions');
  let entries;
  let pruneMarkers;
  let metaIdentity;
  let transactionsIdentity;
  let enumerationError = null;
  try {
    assertBudget();
    assertOwner();
    assertBudget();
    assertPruneTransactionNamesSupported({
      wikiRoot: physicalRoot,
      token,
      deadline,
    });
    assertBudget();
    pruneMarkers = inspectPruneMarkers({ wikiRoot: physicalRoot });
    assertBudget();
    metaIdentity = inspectPhysicalDirectory(meta, meta, '.wiki-meta');
    assertBudget();
    transactionsIdentity = inspectPhysicalDirectory(
      transactions,
      transactions,
      '.wiki-meta/.transactions',
      true,
    );
    const closeOuterObservation = (deferredEnumerationError) => {
      assertBudget();
      assertOwner();
      assertBudget();
      const closingMetaBeforeChild = inspectPhysicalDirectory(meta, meta, '.wiki-meta');
      if (!identitiesMatch(closingMetaBeforeChild, metaIdentity)) {
        throw scanError(
          'SCAN_WINDOW_FILESYSTEM',
          '.wiki-meta directory identity changed after transaction-store observation',
        );
      }
      assertBudget();
      let appeared = false;
      if (transactionsIdentity === null) {
        const closingTransactionsIdentity = inspectPhysicalDirectory(
          transactions,
          transactions,
          '.wiki-meta/.transactions',
          true,
        );
        appeared = closingTransactionsIdentity !== null;
      } else {
        const closingTransactionsIdentity = inspectPhysicalDirectory(
          transactions,
          transactions,
          '.wiki-meta/.transactions',
        );
        if (!identitiesMatch(closingTransactionsIdentity, transactionsIdentity)) {
          throw scanError(
            'SCAN_WINDOW_FILESYSTEM',
            '.wiki-meta/.transactions directory identity changed after transaction-store observation',
          );
        }
      }
      assertBudget();
      const closingMetaAfterChild = inspectPhysicalDirectory(meta, meta, '.wiki-meta');
      if (!identitiesMatch(closingMetaAfterChild, metaIdentity)) {
        throw scanError(
          'SCAN_WINDOW_FILESYSTEM',
          '.wiki-meta directory identity changed after transaction-store observation',
        );
      }
      assertBudget();
      assertOwner();
      assertBudget();
      if (appeared) {
        throw scanError(
          'TRANSACTION_RECOVERY_REQUIRED',
          '.wiki-meta/.transactions appeared after a missing-store observation',
        );
      }
      if (deferredEnumerationError !== null) {
        throw scanError(
          'SCAN_WINDOW_FILESYSTEM',
          '.wiki-meta/.transactions contents are unavailable during prune',
          deferredEnumerationError,
        );
      }
    };
    if (transactionsIdentity === null) {
      closeOuterObservation(null);
      return { processed: 0, removed: [], complete: true, skipped_oversized: [] };
    }
    assertBudget();
    try {
      entries = fs.readdirSync(transactions, { withFileTypes: true })
        .sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    } catch (cause) {
      enumerationError = cause;
    }
    assertBudget();
    closeOuterObservation(enumerationError);
  } catch (error) {
    if (error.code === 'DEADLINE_EXCEEDED') {
      return { processed: 0, removed: [], complete: false, skipped_oversized: [] };
    }
    throw error;
  }

  const removed = [];
  const nestedJunkAttempts = {
    attempts: 0,
    attemptedPhysicalFiles: new Set(),
    budgetExhausted: false,
  };
  const assertNestedParents = () => {
    assertBudget();
    assertOwner();
    const currentMeta = inspectPhysicalDirectory(meta, meta, '.wiki-meta');
    const currentTransactions = inspectPhysicalDirectory(
      transactions,
      transactions,
      '.wiki-meta/.transactions',
    );
    if (!identitiesMatch(currentMeta, metaIdentity)
        || !identitiesMatch(currentTransactions, transactionsIdentity)) {
      throw scanError('SCAN_WINDOW_FILESYSTEM', 'transaction-store parent identity changed');
    }
    assertOwner();
    assertBudget();
  };
  const nestedJunkContext = {
    assertBudget,
    nestedJunkAttempts,
    removed,
    limit,
    deadline,
    faultInjector,
  };
  const semanticNamesForDiscovery = (directory, expectedDirectoryIdentity, label) => (
    assertNestedJunkSettled(semanticTransactionNames({
      ...nestedJunkContext,
      directory,
      expectedDirectoryIdentity,
      label,
      assertOwnerAndParents: assertNestedParents,
    }))
  );
  const recordCommittedPrune = (operationId, boundary) => {
    removed.push(operationId);
    invokeFault(faultInjector, boundary, { operationId });
  };
  const protectedEnsureResidue = (message, cause) => {
    const error = scanError(
      'TRANSACTION_RECOVERY_REQUIRED',
      `${message}; preserve it and use stopped-host intervention`,
      cause,
    );
    error.ensurePruneProtected = true;
    return error;
  };
  const ensureDeletionAuthorized = (journal) => (
    ensureDeletionAllowed(journal, pruneMarkers, suppressEnsurePrune)
  );
  const assertEnsureBoundaryFor = (journal) => {
    return (boundary) => {
      assertBudget();
      assertOwner();
      invokeFault(faultInjector, boundary, {
        operationId: journal.operation_id,
      });
      assertOwner();
      assertBudget();
      if (journal.kind !== 'ensure') return;
      try {
        if (!ensureDeletionAuthorized(journal)) {
          throw protectedEnsureResidue('ensure transaction lost semantic deletion authority');
        }
        assertPruneMarkerSeals(pruneMarkers);
      } catch (cause) {
        if (cause.ensurePruneProtected) throw cause;
        throw protectedEnsureResidue('ensure transaction marker seal changed', cause);
      }
      assertOwner();
      assertBudget();
    };
  };
  const skippedOversized = [];
  const throwWithTerminalPrune = (error) => {
    if (!error.terminal_prune) {
      error.terminal_prune = {
        processed: removed.length,
        removed: [...removed],
        complete: false,
        skipped_oversized: [...skippedOversized],
      };
    } else if (!Array.isArray(error.terminal_prune.skipped_oversized)) {
      error.terminal_prune.skipped_oversized = [...skippedOversized];
    }
    throw error;
  };
  const throwIfEnsureProtected = (error) => {
    if (!error.ensurePruneProtected) return;
    throwWithTerminalPrune(error);
  };
  const assertResidueReclaimable = (journal) => {
    if (!ensureDeletionAuthorized(journal)) {
      throw protectedEnsureResidue('protected ensure prune residue requires recovery');
    }
  };

  let complete = true;
  const inspectPressure = options.inspectDirectoryPressure || inspectDirectoryPressure;
  for (const entry of entries) {
    if (remainingMs(deadline) < PRUNE_RESERVE_MS) {
      complete = false;
      break;
    }
    const atMutationLimit = removed.length + nestedJunkAttempts.attempts >= limit;
    if (entry.isFile()) {
      if (atMutationLimit) {
        complete = false;
        continue;
      }
      const reservation = path.join(transactions, entry.name);
      let reservationIdentity;
      let reservationBytes;
      let reservationJournal;
      let operationId;
      try {
        operationId = validateOperationId(entry.name);
        reservationIdentity = regularFileIdentity(
          fs.lstatSync(reservation, { bigint: true }),
        );
        assertBudget();
        if (!reservationIdentity) continue;
        reservationBytes = fs.readFileSync(reservation);
        assertBudget();
        assertRegularFileIdentity(reservation, reservationIdentity);
        assertBudget();
        reservationJournal = JSON.parse(reservationBytes.toString('utf8'));
        validateJournal(reservationJournal, operationId, physicalRoot);
        if (reservationJournal.operation_id !== operationId
            || reservationJournal.transitions.at(-1) !== 'cleaned'
            || !reservationBytes.equals(stageBytes(reservationJournal))
            || (kinds && !kinds.has(reservationJournal.kind))) continue;
        if (operationId === excludeOperationId) continue;
        assertResidueReclaimable(reservationJournal);
      } catch (error) {
        throwIfEnsureProtected(error);
        if (error.code === 'DEADLINE_EXCEEDED') {
          complete = false;
          break;
        }
        continue;
      }
      let matchingQuarantine = false;
      try {
        matchingQuarantine = fs.readdirSync(transactions).some((name) => {
          if (!name.startsWith('.prune-')) return false;
          try { return operationIdFromPruneName(name) === operationId; }
          catch { return false; }
        });
        assertBudget();
      } catch (error) {
        if (error.code === 'DEADLINE_EXCEEDED') {
          complete = false;
          break;
        }
        continue;
      }
      if (matchingQuarantine) continue;
      try {
        invokeFault(faultInjector, 'before-canonical-reservation-only-owner-check', {
          operationId,
        });
        assertOwner();
        assertBudget();
      } catch (error) {
        if (error.code === 'DEADLINE_EXCEEDED') {
          complete = false;
          break;
        }
        throwWithTerminalPrune(error);
      }
      try {
        assertRegularFileIdentity(reservation, reservationIdentity);
        const currentBytes = fs.readFileSync(reservation);
        assertRegularFileIdentity(reservation, reservationIdentity);
        if (!currentBytes.equals(reservationBytes)) continue;
        assertBudget();
        assertEnsureBoundaryFor(reservationJournal)(
          'before-canonical-reservation-only-unlink',
        );
        fs.unlinkSync(reservation);
        recordCommittedPrune(
          operationId,
          'after-canonical-reservation-only-unlink',
        );
        assertOwner();
      } catch (error) {
        if (error.code === 'DEADLINE_EXCEEDED') {
          complete = false;
          break;
        }
        throwIfEnsureProtected(error);
        if (error.code === 'ENOENT'
            || error.code === 'TRANSACTION_RECOVERY_REQUIRED'
            || error.code === 'SCAN_WINDOW_FILESYSTEM') continue;
        throwWithTerminalPrune(error);
      }
      continue;
    }
    let kind;
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) kind = 'directory';
    else if (!entry.isFile() && !entry.isBlockDevice() && !entry.isCharacterDevice()
        && !entry.isFIFO() && !entry.isSocket()) {
      kind = resolveUnknownDirent(transactions, entry).kind;
    } else continue;
    if (kind !== 'directory') continue;
    if (entry.name === excludeOperationId) continue;
    let pressure;
    try {
      pressure = inspectPressure(path.join(transactions, entry.name), {
        deadline,
        allowEnumeration: false,
      });
    } catch (error) {
      throwWithTerminalPrune(error);
    }
    if (pressure.oversized) {
      skippedOversized.push(entry.name);
      continue;
    }
    if (atMutationLimit) {
      complete = false;
      continue;
    }
    if (entry.name.startsWith('.prune-')) {
      const quarantine = path.join(transactions, entry.name);
      const quarantinedJournal = path.join(quarantine, 'journal.json');
      const quarantinedBackup = path.join(quarantine, 'journal.backup');
      let quarantineIdentity;
      let journalIdentity;
      let backupIdentity = null;
      let journalBytes;
      let journal;
      let operationId;
      let resumedFromBackup = false;
      try {
        quarantineIdentity = inspectPhysicalDirectory(
          quarantine,
          quarantine,
          'terminal journal prune quarantine',
        );
        assertBudget();
        const names = semanticNamesForDiscovery(
          quarantine,
          quarantineIdentity,
          'terminal journal prune quarantine',
        );
        assertBudget();
        if (names.length === 0) {
          operationId = operationIdFromPruneName(entry.name);
          if (operationId === excludeOperationId) continue;
          const adapter = defaultJournalAdapter(physicalRoot, operationId, nestedJunkContext);
          const reservation = adapter.locations.transaction;
          const reservationIdentity = regularFileIdentity(
            fs.lstatSync(reservation, { bigint: true }),
          );
          assertBudget();
          if (!reservationIdentity) continue;
          const reservationBytes = fs.readFileSync(reservation);
          assertBudget();
          assertRegularFileIdentity(reservation, reservationIdentity);
          assertBudget();
          const reservationJournal = JSON.parse(reservationBytes.toString('utf8'));
          validateJournal(reservationJournal, operationId, physicalRoot);
          if (reservationJournal.operation_id !== operationId
              || reservationJournal.transitions.at(-1) !== 'cleaned'
              || !reservationBytes.equals(stageBytes(reservationJournal))
              || (kinds && !kinds.has(reservationJournal.kind))) continue;
          assertResidueReclaimable(reservationJournal);
          try {
            invokeFault(faultInjector, 'before-empty-quarantine-owner-check', {
              operationId,
            });
            assertOwner();
            assertBudget();
          } catch (error) {
            if (error.code === 'DEADLINE_EXCEEDED'
                || error.code === 'SCAN_WINDOW_NESTED_JUNK_DEFERRED') {
              complete = false;
              break;
            }
            throwWithTerminalPrune(error);
          }
          try {
            adapter[DEFAULT_ADAPTER_CONTROL].removeEmptyCleanedQuarantine(
              entry.name,
              quarantineIdentity,
              reservationBytes,
              reservationIdentity,
              assertOwner,
              assertBudget,
              assertEnsureBoundaryFor(reservationJournal),
              () => recordCommittedPrune(
                operationId,
                'after-empty-quarantine-reservation-unlink',
              ),
            );
          } catch (error) {
            if (error.code === 'DEADLINE_EXCEEDED'
                || error.code === 'SCAN_WINDOW_NESTED_JUNK_DEFERRED') {
              complete = false;
              break;
            }
            throwIfEnsureProtected(error);
            if (error.code === 'TRANSACTION_RECOVERY_REQUIRED') continue;
            throwWithTerminalPrune(error);
          }
          continue;
        }
        const hasJournal = names.includes('journal.json');
        const hasBackup = names.includes('journal.backup');
        if ((!hasJournal && !hasBackup)
            || names.some((name) => ![
              'journal.json',
              'journal.backup',
              'journal.backup.pending',
              'source.reservation.pending',
            ].includes(name))) {
          continue;
        }
        const evidencePath = hasJournal ? quarantinedJournal : quarantinedBackup;
        const evidenceIdentity = (hasJournal ? regularFileIdentity : linkedRegularFileIdentity)(
          fs.lstatSync(evidencePath, { bigint: true }),
        );
        assertBudget();
        if (!evidenceIdentity) continue;
        journalBytes = fs.readFileSync(evidencePath);
        assertBudget();
        if (hasJournal) {
          assertRegularFileIdentity(evidencePath, evidenceIdentity);
          assertBudget();
        } else {
          const currentEvidenceIdentity = linkedRegularFileIdentity(
            fs.lstatSync(evidencePath, { bigint: true }),
          );
          assertBudget();
          if (!identitiesMatch(currentEvidenceIdentity, evidenceIdentity)
              || currentEvidenceIdentity.mtimeNs !== evidenceIdentity.mtimeNs
              || currentEvidenceIdentity.nlink !== evidenceIdentity.nlink
              || ![1n, 2n].includes(evidenceIdentity.nlink)) continue;
        }
        if (hasJournal) journalIdentity = evidenceIdentity;
        else {
          journalIdentity = null;
          backupIdentity = evidenceIdentity;
          resumedFromBackup = true;
        }
        if (hasBackup && hasJournal) {
          backupIdentity = linkedRegularFileIdentity(
            fs.lstatSync(quarantinedBackup, { bigint: true }),
          );
          assertBudget();
          if (!backupIdentity) continue;
          const backupBytes = fs.readFileSync(quarantinedBackup);
          assertBudget();
          const currentBackupIdentity = linkedRegularFileIdentity(
            fs.lstatSync(quarantinedBackup, { bigint: true }),
          );
          assertBudget();
          if (!identitiesMatch(currentBackupIdentity, backupIdentity)
              || currentBackupIdentity.mtimeNs !== backupIdentity.mtimeNs
              || currentBackupIdentity.nlink !== backupIdentity.nlink) continue;
          if (!backupBytes.equals(journalBytes)) continue;
        }
        const currentQuarantineIdentity = inspectPhysicalDirectory(
          quarantine,
          quarantine,
          'terminal journal prune quarantine',
        );
        assertBudget();
        if (!identitiesMatch(currentQuarantineIdentity, quarantineIdentity)) continue;
        journal = JSON.parse(journalBytes.toString('utf8'));
        operationId = validateOperationId(journal.operation_id);
        if (!entry.name.startsWith(`.prune-${operationId.length}-${operationId}-`)
            || operationId === excludeOperationId) continue;
        validateJournal(journal, operationId, physicalRoot);
        if (!journalBytes.equals(stageBytes(journal))) continue;
      } catch (error) {
        if (error.terminal_prune) throw error;
        throwIfEnsureProtected(error);
        if (error.nestedJunkSafety === true) throwWithTerminalPrune(error);
        if (error.code === 'DEADLINE_EXCEEDED') {
          complete = false;
          break;
        }
        if (error.code === 'SCAN_WINDOW_NESTED_JUNK_DEFERRED') {
          complete = false;
          if (error.nestedJunkBudgetExhausted === true) break;
          continue;
        }
        continue;
      }
      if (journal.transitions.at(-1) !== 'cleaned'
          || (kinds && !kinds.has(journal.kind))
          || (!(resumedFromBackup || resumableOnly) && !terminalJournalIsOldEnough(
            journalIdentity,
            now.getTime(),
          maxAgeDays,
          ))) continue;
      try { assertResidueReclaimable(journal); }
      catch (error) { throwIfEnsureProtected(error); }

      const adapter = defaultJournalAdapter(physicalRoot, operationId, nestedJunkContext);
      const control = adapter[DEFAULT_ADAPTER_CONTROL];
      try {
        invokeFault(faultInjector, 'before-quarantine-owner-check', {
          operationId,
        });
        assertOwner();
        assertBudget();
      } catch (error) {
        if (error.code === 'DEADLINE_EXCEEDED'
            || error.code === 'SCAN_WINDOW_NESTED_JUNK_DEFERRED') {
          complete = false;
          break;
        }
        throwWithTerminalPrune(error);
      }
      try {
        control.removeCleanedQuarantine(
          entry.name,
          quarantineIdentity,
          journal,
          journalBytes,
          sealBytes(journalBytes),
          journalIdentity,
          backupIdentity,
          assertOwner,
          resumableOnly ? null : {
            nowMs: now.getTime(),
            maxAgeDays,
          },
          assertBudget,
          assertEnsureBoundaryFor(journal),
          () => recordCommittedPrune(
            operationId,
            'after-final-canonical-reservation-unlink',
          ),
        );
      } catch (error) {
        if (error.code === 'DEADLINE_EXCEEDED'
            || error.code === 'SCAN_WINDOW_NESTED_JUNK_DEFERRED') {
          complete = false;
          break;
        }
        throwIfEnsureProtected(error);
        if (error.code === 'TRANSACTION_RECOVERY_REQUIRED') continue;
        throwWithTerminalPrune(error);
      }
      continue;
    }
    if (resumableOnly) continue;
    let operationId;
    try { operationId = validateOperationId(entry.name); } catch { continue; }
    const adapter = defaultJournalAdapter(physicalRoot, operationId, nestedJunkContext);
    const control = adapter[DEFAULT_ADAPTER_CONTROL];
    let journal;
    let journalBytes;
    let journalIdentity;
    try {
      const journalStat = fs.lstatSync(adapter.locations.journal, { bigint: true });
      assertBudget();
      journalIdentity = regularFileIdentity(journalStat);
      if (!journalIdentity) continue;
      journalBytes = control.readJournalBytes(assertBudget);
      if (journalBytes === null) continue;
      assertRegularFileIdentity(adapter.locations.journal, journalIdentity);
      assertBudget();
      journal = JSON.parse(journalBytes.toString('utf8'));
      validateJournal(journal, operationId, physicalRoot);
      if (!journalBytes.equals(stageBytes(journal))) continue;
    } catch (error) {
      if (error.nestedJunkSafety === true) throwWithTerminalPrune(error);
      if (error.code === 'DEADLINE_EXCEEDED') {
        complete = false;
        break;
      }
      if (error.code === 'SCAN_WINDOW_NESTED_JUNK_DEFERRED') {
        complete = false;
        if (error.nestedJunkBudgetExhausted === true) break;
        continue;
      }
      continue;
    }
    if (journal.transitions.at(-1) !== 'cleaned'
        || (kinds && !kinds.has(journal.kind))) continue;
    if (!ensureDeletionAllowed(journal, pruneMarkers, suppressEnsurePrune)) continue;

    if (!terminalJournalIsOldEnough(journalIdentity, now.getTime(), maxAgeDays)) continue;
    let names;
    try {
      const transactionIdentity = inspectPhysicalDirectory(
        adapter.locations.transaction,
        adapter.locations.transaction,
        'scan-window operation directory',
      );
      names = semanticNamesForDiscovery(
        adapter.locations.transaction,
        transactionIdentity,
        'scan-window operation directory',
      );
      assertBudget();
    } catch (error) {
      if (error.nestedJunkSafety === true) throwWithTerminalPrune(error);
      if (error.code === 'DEADLINE_EXCEEDED') {
        complete = false;
        break;
      }
      if (error.code === 'SCAN_WINDOW_NESTED_JUNK_DEFERRED') {
        complete = false;
        if (error.nestedJunkBudgetExhausted === true) break;
        continue;
      }
      continue;
    }
    if (names.length !== 1 || names[0] !== 'journal.json') continue;

    try {
      invokeFault(faultInjector, 'before-cleaned-transaction-owner-check', {
        operationId,
      });
      assertOwner();
      assertBudget();
    } catch (error) {
      if (error.code === 'DEADLINE_EXCEEDED'
          || error.code === 'SCAN_WINDOW_NESTED_JUNK_DEFERRED') {
        complete = false;
        break;
      }
      throwWithTerminalPrune(error);
    }
    try {
      control.removeCleanedTransaction(
        journal,
        journalBytes,
        sealBytes(journalBytes),
        journalIdentity,
        assertOwner,
        {
          nowMs: now.getTime(),
          maxAgeDays,
        },
        assertBudget,
        assertEnsureBoundaryFor(journal),
        () => recordCommittedPrune(
          operationId,
          'after-final-canonical-reservation-unlink',
        ),
      );
    } catch (error) {
      if (error.code === 'DEADLINE_EXCEEDED'
          || error.code === 'SCAN_WINDOW_NESTED_JUNK_DEFERRED') {
        complete = false;
        break;
      }
      throwIfEnsureProtected(error);
      if (error.code === 'TRANSACTION_RECOVERY_REQUIRED') continue;
      throwWithTerminalPrune(error);
    }
  }
  return { processed: removed.length, removed, complete, skipped_oversized: skippedOversized };
}

function deterministicEnsureId(wikiRoot, proposed) {
  return `scan-window-ensure-${sha256(Buffer.from(`${wikiRoot}\0${proposed}`)).slice(0, 40)}`;
}

function ensurePendingScan(options = {}) {
  let physicalRoot;
  let owner;
  let result;
  let lockContended = false;
  let recoveryAttempted = false;
  try {
    physicalRoot = physicalWikiRoot(options.wikiRoot);
    canonicalTimestamp(options.proposed, 'proposed');
    if (!options.deadline) throw scanError('SCAN_WINDOW_INVALID', 'ensurePendingScan requires a deadline');
    while (!owner) {
      try {
        assertBeforeDeadline(options.deadline, 'scan-window-lock');
      } catch (error) {
        if (lockContended && error.code === 'DEADLINE_EXCEEDED') {
          throw scanError('LOCK_CONTENDED', 'scan-window lock remained contended until the deadline', error);
        }
        throw error;
      }
      try {
        owner = acquireLock({
          wikiRoot: physicalRoot,
          operation: 'scan-window-ensure',
          now: options.now,
          recoverDeadOwner: !recoveryAttempted,
        });
        recoveryAttempted = true;
      } catch (error) {
        recoveryAttempted = true;
        if (error.code !== 'LOCK_CONTENDED') throw error;
        lockContended = true;
        Atomics.wait(sleepArray, 0, 0, 2);
      }
    }
    assertBeforeDeadline(options.deadline, 'scan-window-preflight');
    const operationId = deterministicEnsureId(physicalRoot, options.proposed);
    const plan = planScanWindowTransition({
      wikiRoot: physicalRoot,
      kind: 'ensure',
      proposed: options.proposed,
    });
    let applied;
    try {
      applied = applyScanWindowTransition({
        wikiRoot: physicalRoot,
        token: owner.token,
        plan,
        operationId,
        faultInjector: options.faultInjector,
        deadline: options.deadline,
        inspectDirectoryPressure: options.inspectDirectoryPressure,
      });
    } catch (error) {
      if (error.code === 'TRANSACTION_OVERSIZED' && error.operationId === operationId) {
        quarantineStoreEntry({
          wikiRoot: physicalRoot,
          token: owner.token,
          name: operationId,
          classification: { method: error.method || 'stat', estimated_entries: error.estimatedEntries ?? null },
          reason: 'oversized',
        });
        applied = applyScanWindowTransition({
          wikiRoot: physicalRoot,
          token: owner.token,
          plan,
          operationId,
          faultInjector: options.faultInjector,
          deadline: options.deadline,
          inspectDirectoryPressure: options.inspectDirectoryPressure,
        });
      } else throw error;
    }
    result = { status: applied.status, operationId };
    let pruneResult = { skipped_oversized: [] };
    try {
      pruneResult = pruneScanWindowTransactions({
        wikiRoot: physicalRoot,
        token: owner.token,
        maxAgeDays: 0,
        limit: AUTOMATIC_PRUNE_LIMIT,
        now: options.now,
        deadline: options.deadline,
        kinds: ['ensure'],
        excludeOperationId: operationId,
        inspectDirectoryPressure: options.inspectDirectoryPressure,
      });
    } catch (error) {
      result.prune_failure = error.code || 'SCAN_WINDOW_FILESYSTEM';
      if (error.terminal_prune) {
        pruneResult = {
          skipped_oversized: Array.isArray(error.terminal_prune.skipped_oversized)
            ? [...error.terminal_prune.skipped_oversized]
            : [],
        };
      }
      try {
        writeMaintenanceMarker(physicalRoot, owner.token, (marker) => {
          marker.prune_failures.push({ code: String(error.code || 'SCAN_WINDOW_FILESYSTEM').replace(/[^A-Z_]/g, '_') || 'PRUNE_FAIL', at: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') });
          return marker;
        });
      } catch { /* marker is best-effort */ }
    }
    const skipped = [
      ...((applied.maintenance && applied.maintenance.skipped_oversized) || []),
      ...(pruneResult.skipped_oversized || []),
    ];
    try {
      transactionDebris.promoteOversizedNames({
        wikiRoot: physicalRoot,
        token: owner.token,
        names: skipped,
        parsePruneName: operationIdFromPruneName,
        classification: { method: 'stat', estimated_entries: null },
        reason: 'oversized',
        deadline: options.deadline,
        limit: AUTOMATIC_PRUNE_LIMIT,
      });
    } catch {
      /* post-commit promotion must not demote an already persisted scan */
    }
  } catch (error) {
    result = { status: 'deferred', reason: error.code || 'SCAN_WINDOW_FILESYSTEM' };
  } finally {
    if (owner) {
      try { releaseLock({ wikiRoot: physicalRoot, token: owner.token }); }
      catch (error) {
        if (!result || result.status !== 'deferred') {
          result = { status: 'deferred', reason: error.code || 'LOCK_FILESYSTEM' };
        }
      }
    }
  }
  return result;
}

function promotePendingScan(options = {}) {
  const physicalRoot = physicalWikiRoot(options.wikiRoot);
  const operationId = validateOperationId(options.operationId);
  assertLockOwner({ wikiRoot: physicalRoot, token: options.token });
  const plan = planScanWindowTransition({
    wikiRoot: physicalRoot,
    kind: 'promote',
    expected: options.expected,
  });
  const applied = applyScanWindowTransition({
    wikiRoot: physicalRoot,
    token: options.token,
    plan,
    operationId,
    journalAdapter: options.journalAdapter,
    faultInjector: options.faultInjector,
    deadline: options.deadline,
  });
  const lastBytes = bytesFromDescriptor(applied.journal.states.last.after);
  const pendingBytes = bytesFromDescriptor(applied.journal.states.pending.after);
  return {
    status: applied.status,
    operationId,
    lastScan: timestampFromBytes(lastBytes),
    pendingPreserved: pendingBytes !== null,
    maintenance: applied.maintenance || { skipped_oversized: [] },
  };
}

function quarantineStoreEntry(options = {}) {
  return quarantineStoreEntryPrimitive({
    ...options,
    parsePruneName: options.parsePruneName || operationIdFromPruneName,
  });
}

function promoteOversizedNames(options = {}) {
  return transactionDebris.promoteOversizedNames({
    ...options,
    parsePruneName: options.parsePruneName || operationIdFromPruneName,
  });
}

module.exports = {
  assertPruneTransactionNamesSupported,
  ensurePendingScan,
  inspectPruneMarkers,
  operationIdFromPruneName,
  promotePendingScan,
  promoteOversizedNames,
  PRUNE_BLOCK_REASONS,
  PRUNE_BLOCK_STAGES,
  pruneScanWindowTransactions,
  recoverScanWindowTransaction,
  planScanWindowTransition,
  applyScanWindowTransition,
  quarantineStoreEntry,
};
