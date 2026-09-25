'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { assertBeforeDeadline, remainingMs } = require('./deadline.js');
const {
  atomicWriteFile,
  descriptorMatchesPathIdentity,
  readMaybe,
  regularFileIdentity,
  regularFileIdentitiesMatch,
  stateError,
} = require('./fs-safe.js');
const { assertLockOwner } = require('./lock.js');

const SWEEP_RESERVE_MS = 10_000;
// Threshold principle: ≥100× a healthy store entry (~9 children) and ≤1/10 of
// the observed 65k-entry pathology. Size uses 48 bytes/dirent so cap × 48 =
// 196608 (pathology 2,097,120 is 1/10.67). nlink 512 is 512× a traditional
// Unix dir (nlink ~2); APFS reports nlink = 2 + file count, so a healthy
// 9-file dir is still nlink ~11 and cap+1 already exceeds 512 — that is a
// usable tier-1 signal, not a false positive. Option overrides exist for
// tests; four-platform CI may revise the constants, not the principle.
const PRESSURE_ENTRY_CAP = 4096;
const PRESSURE_SIZE_THRESHOLD = 196608;
const PRESSURE_NLINK_THRESHOLD = 512;
const PRESSURE_BYTES_PER_ENTRY = 48n;
const MAINTENANCE_MARKER_MAX_BYTES = 65536;
const MAINTENANCE_MARKER_BASENAME = 'scan-window-maintenance.json';
const QUARANTINE_BUNDLE_NAME_RE = /^[0-9]{8}T[0-9]{6}Z-[0-9]{1,10}-[0-9a-f]{32}$/;
const QUARANTINE_INVENTORY_DISPLAY_LIMIT = 64;
const QUARANTINE_PROMOTION_LIMIT = 8;
const QUARANTINE_BUNDLE_CAP = 64;
const PROMOTED_CAP = 32;
const SKIPPED_OVERSIZED_CAP = 32;
const PRUNE_FAILURE_CAP = 8;
const ISO_Z_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const PRUNE_FAILURE_CODE_RE = /^[A-Z_]+$/;
const MARKER_KEYS = [
  'schema', 'updated_at', 'prune_failures', 'promoted', 'skipped_oversized', 'quarantine_bundles',
];
const BUNDLE_REQUIRED_KEYS = ['bundle', 'source_name', 'state', 'at'];
const BUNDLE_OPTIONAL_KEYS = ['resume'];
const BUNDLE_STATES = new Set(['pending', 'incomplete', 'complete']);
const PRUNE_FAILURE_KEYS = ['code', 'at'];
const ISOLATABLE_NAME_RE = /^(?:scan-window-ensure-[0-9a-f]{40}|scan-window-cli-[0-9a-f]{40}|lint-repair-[0-9a-f]{40}|rollback-[0-9A-HJKMNP-TV-Z]{26})$/;
const PRUNE_SUFFIX_RE = /^[0-9]{1,10}-[0-9a-f-]{36}$/;
const ULID_FOLLOW_RE = /^rollback-([0-9A-HJKMNP-TV-Z]{26})$/;
const FILE_TYPE_MASK = 0o170000n;
const DIRECTORY_TYPE = 0o040000n;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const TOMBSTONE_KEYS = ['contract_version', 'operation_id', 'reason', 'drift'];
const TOMBSTONE_REASONS = new Set(['catalog-drift']);
const SWEEP_CLASSES = new Set(['activation', 'plain', 'cancelled', 'junk']);

// File names a desktop shell or sync client writes into any directory it touches. Treating one as
// fatal wedges every route on a vault that Finder, Explorer or a sync client has walked.
//
// The safety argument is NOT "the engine only creates directories here" — it also publishes
// ULID-named regular files directly under `.transactions/` as terminal-prune source reservations
// (`scan-window.js`). The argument is that the engine's namespace (ULID, `.activate-*`, `.prune-*`,
// `.reservation-.prune-*`, and `fs-safe`'s `.<name>.tmp.<pid>.<uuid>`) is disjoint from the junk
// namespace (exact name ∪ the AppleDouble `._` prefix). Widening either set must preserve that
// disjointness — `no engine-generated transaction store name is classified as junk` pins it.
// Anything unrecognized still demands recovery rather than being silently discarded. The same
// disjointness also covers the lock-free readers of pages/, .wiki-meta/sources/, and
// .wiki-meta/.versions/: the classifier may identify inert metadata there, but it never grants
// unlink authority outside .wiki-meta/.transactions/.
const OS_METADATA_NAMES = new Set([
  '.DS_Store', '.localized', '.apdisk', '.VolumeIcon.icns', 'Icon\r',
  'Thumbs.db', 'ehthumbs.db', 'desktop.ini',
  '.directory', '.dropbox', '.dropbox.attr',
]);
const APPLE_DOUBLE_PREFIX = '._';
// Junk is by definition written and held by a foreign process, so a refused unlink is ordinary for
// this class. It must never fail the mutation route that happened to run the sweep — the reader
// already tolerates the file, and a later pass retries.
const FOREIGN_HOLD_CODES = new Set(['EPERM', 'EACCES', 'EBUSY', 'EROFS', 'ETXTBSY']);

function isTransactionStoreJunkName(name) {
  return typeof name === 'string'
    && (OS_METADATA_NAMES.has(name) || name.startsWith(APPLE_DOUBLE_PREFIX));
}

// Junk is reclaimable only as a plain regular file. A symlink wearing a junk name is still an
// unrecognized entry: it is refused, never followed and never removed. This predicate is shared
// by lock-free catalog readers and the transaction-store sweep; `true` authorizes classification,
// not removal anywhere outside .wiki-meta/.transactions/.
function toBigInt(value) {
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number' && Number.isSafeInteger(value)) return BigInt(value);
  throw new TypeError('directory pressure stat fields must be integers');
}

function inspectDirectoryPressure(pathname, options = {}) {
  const fsImpl = options.fs || fs;
  const entryCap = options.entryCap === undefined ? PRESSURE_ENTRY_CAP : options.entryCap;
  const sizeThreshold = toBigInt(options.sizeThreshold === undefined
    ? PRESSURE_SIZE_THRESHOLD : options.sizeThreshold);
  const nlinkThreshold = toBigInt(options.nlinkThreshold === undefined
    ? PRESSURE_NLINK_THRESHOLD : options.nlinkThreshold);
  const allowEnumeration = options.allowEnumeration === true;
  const { deadline } = options;

  let stat;
  try {
    stat = fsImpl.lstatSync(pathname, { bigint: true });
  } catch (error) {
    if (error.code === 'ENOENT') return { oversized: false, method: 'none', estimatedEntries: null };
    throw stateError('WIKI_STATE_FILESYSTEM', 'directory pressure identity is unavailable', error);
  }

  const size = toBigInt(stat.size);
  const nlink = toBigInt(stat.nlink);
  const sizeHit = size > sizeThreshold;
  const nlinkHit = nlink > nlinkThreshold;
  if (sizeHit || nlinkHit) {
    return {
      oversized: true,
      method: 'stat',
      estimatedEntries: sizeHit ? Number(size / PRESSURE_BYTES_PER_ENTRY) : Number(nlink),
    };
  }

  if (!allowEnumeration) return { oversized: false, method: 'none', estimatedEntries: null };

  let dir;
  try {
    dir = fsImpl.opendirSync(pathname);
  } catch (error) {
    if (error.code === 'ENOENT') return { oversized: false, method: 'none', estimatedEntries: null };
    throw stateError('WIKI_STATE_FILESYSTEM', 'directory pressure identity is unavailable', error);
  }

  let count = 0;
  try {
    for (;;) {
      const entry = dir.readSync();
      if (entry === null) break;
      assertBeforeDeadline(deadline, `directory-pressure:${pathname}`);
      count += 1;
      if (count > entryCap) break;
    }
  } finally {
    try { dir.closeSync(); } catch { /* preserve the primary error */ }
  }

  return {
    oversized: count > entryCap,
    method: 'enumeration',
    estimatedEntries: count,
  };
}

function direntTypeUnknown(entry) {
  return !entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()
    && !entry.isBlockDevice() && !entry.isCharacterDevice()
    && !entry.isFIFO() && !entry.isSocket();
}

function kindFromStat(stat) {
  if (stat.isSymbolicLink()) return 'symlink';
  if (stat.isDirectory()) return 'directory';
  return 'other';
}

function resolveUnknownDirent(directory, entry, fsImpl = fs) {
  if (entry.isSymbolicLink()) return { kind: 'symlink' };
  if (entry.isDirectory()) return { kind: 'directory' };
  if (!direntTypeUnknown(entry)) return { kind: 'other' };
  let stat;
  try { stat = fsImpl.lstatSync(path.join(directory, entry.name)); }
  catch { return { kind: 'unresolved' }; }
  return { kind: kindFromStat(stat) };
}

function isReclaimableJunkEntry(entry, directory = null) {
  if (!isTransactionStoreJunkName(entry.name)) return false;
  if (entry.isFile() && !entry.isSymbolicLink()) return true;
  // Some filesystems return no directory-entry type at all. Falling through would make the reader
  // fatal again on exactly the vaults this change exists for, so a recognized name with an
  // unresolved type is settled with one `lstat`; a lookup failure fails closed.
  const unknownType = !entry.isFile() && !entry.isDirectory() && !entry.isSymbolicLink()
    && !entry.isBlockDevice() && !entry.isCharacterDevice()
    && !entry.isFIFO() && !entry.isSocket();
  if (!unknownType || directory === null) return false;
  let stat;
  try { stat = fs.lstatSync(path.join(directory, entry.name)); }
  catch { return false; }
  return stat.isFile() && !stat.isSymbolicLink();
}

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validWikiRelativePath(value) {
  return typeof value === 'string' && value.length > 0
    && !path.isAbsolute(value) && !value.split('/').includes('..');
}

function validateTombstoneV1(source, requestedOperationId) {
  const reject = (message) => ({
    valid: false,
    error: stateError('TRANSACTION_RECOVERY_REQUIRED', message),
  });
  let bytes;
  let operationId = requestedOperationId;
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    bytes = Buffer.from(source);
  } else if (typeof source === 'string') {
    operationId ||= path.basename(source);
    bytes = readMaybe(path.join(source, 'cancelled.json'));
  } else {
    return reject('cancel tombstone source is invalid');
  }
  if (bytes === null) return reject('cancel tombstone is absent');
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch { return reject('cancel tombstone is unreadable'); }
  if (!hasExactKeys(value, TOMBSTONE_KEYS) || value.contract_version !== 1
      || typeof operationId !== 'string' || !ULID_RE.test(value.operation_id)
      || value.operation_id !== operationId || !TOMBSTONE_REASONS.has(value.reason)
      || !Array.isArray(value.drift) || value.drift.length < 1 || value.drift.length > 8
      || value.drift.some((entry) => !validWikiRelativePath(entry))) {
    return reject('cancel tombstone schema is invalid');
  }
  return {
    valid: true,
    value: {
      operation_id: value.operation_id,
      reason: value.reason,
      drift: [...value.drift],
    },
  };
}

function entryExists(pathname) {
  try { fs.lstatSync(pathname); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

// `readdirSync` follows a directory symlink, so without this the sweep would enumerate and delete
// through a `.wiki-meta` or `.transactions` link and escape the wiki entirely. Lock ownership
// proves who may write, never where. A missing directory is benign only for the caller that says
// so — both `.wiki-meta` and `.transactions` may be absent on a wiki that has not created them —
// but `.wiki-meta` is always anchored FIRST, so a missing child under a *symlinked* parent can
// never read as benign; the commit path would otherwise create the store outside the wiki.
//
// Every non-ENOENT failure becomes WIKI_STATE_FILESYSTEM. That is load-bearing: an `EACCES` from
// this security check must never be mistakable for the foreign-hold codes that junk reclamation
// tolerates, or the anchor would fail open exactly when the filesystem is behaving oddly.
function physicalDirectoryIdentity(pathname, label, allowMissing, fsImpl = fs) {
  let stat;
  try { stat = fsImpl.lstatSync(pathname, { bigint: true }); }
  catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw stateError('WIKI_STATE_FILESYSTEM', `${label} identity is unavailable`, error);
  }
  if ((stat.mode & FILE_TYPE_MASK) !== DIRECTORY_TYPE
      || stat.ino <= 0n || stat.dev < 0n) {
    throw stateError('WIKI_STATE_FILESYSTEM', `${label} must be a physical directory`);
  }
  const realpathSync = fsImpl.realpathSync;
  const realpathNative = realpathSync && (realpathSync.native || realpathSync);
  let physical;
  try { physical = realpathNative.call(realpathSync || fsImpl, pathname); }
  catch (cause) {
    throw stateError('WIKI_STATE_FILESYSTEM', `${label} physical path is unavailable`, cause);
  }
  if (path.relative(pathname, physical) !== '') {
    throw stateError('WIKI_STATE_FILESYSTEM', `${label} escapes its physical wiki parent`);
  }
  // birthtime is carried so a recycled inode cannot impersonate the anchored directory.
  return { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs };
}

function transactionStoreAnchor(root, transactions) {
  physicalDirectoryIdentity(path.join(root, '.wiki-meta'), '.wiki-meta', true);
  return physicalDirectoryIdentity(transactions, '.wiki-meta/.transactions', true);
}

function identityUnchanged(current, expected) {
  return current !== null && expected != null && current.dev === expected.dev && current.ino === expected.ino
    && current.birthtimeNs === expected.birthtimeNs;
}

function captureRegularFileIdentity(pathname, label, allowMissing, fsImpl) {
  let stat;
  try { stat = fsImpl.lstatSync(pathname, { bigint: true }); }
  catch (error) {
    if (allowMissing && error.code === 'ENOENT') return null;
    throw stateError('WIKI_STATE_FILESYSTEM', `${label} identity is unavailable`, error);
  }
  const identity = regularFileIdentity(stat);
  if (!identity) {
    throw stateError('WIKI_STATE_FILESYSTEM', `${label} must be a physical regular file`);
  }
  return identity;
}

function assertDirectoryFence(pathname, label, expected, fsImpl) {
  if (!identityUnchanged(physicalDirectoryIdentity(pathname, label, true, fsImpl), expected)) {
    throw stateError('WIKI_STATE_FILESYSTEM', `${label} identity changed mid-quarantine`);
  }
}

function assertRegularFileFence(pathname, label, expected, fsImpl) {
  const current = captureRegularFileIdentity(pathname, label, true, fsImpl);
  if (!regularFileIdentitiesMatch(current, expected)) {
    throw stateError('WIKI_STATE_FILESYSTEM', `${label} identity changed mid-quarantine`);
  }
}

function sourceAbsenceLabel(pathname) {
  return `.wiki-meta/.transactions/${path.basename(pathname)}`;
}

function assertExpectedSourceAbsence(pathname, fsImpl, context = 'reservation-only quarantine') {
  const label = sourceAbsenceLabel(pathname);
  const current = physicalDirectoryIdentity(pathname, label, true, fsImpl);
  if (current !== null) {
    throw stateError('WIKI_STATE_FILESYSTEM', `${label} reappeared during ${context}`);
  }
}

function assertQuarantineFence(root, token, captured, options = {}) {
  const fsImpl = options.fs || fs;
  assertLockOwner({ wikiRoot: root, token });
  assertDirectoryFence(captured.metaPath, '.wiki-meta', captured.metaIdentity, fsImpl);
  assertDirectoryFence(captured.quarantinePath, '.wiki-meta/.quarantine', captured.quarantineIdentity, fsImpl);
  if (captured.bundleIdentity) {
    assertDirectoryFence(
      captured.bundlePath,
      `.wiki-meta/.quarantine/${path.basename(captured.bundlePath)}`,
      captured.bundleIdentity,
      fsImpl,
    );
  }
  assertDirectoryFence(captured.storePath, '.wiki-meta/.transactions', captured.storeIdentity, fsImpl);
  if (captured.expectSourceAbsent) {
    assertExpectedSourceAbsence(captured.sourcePath, fsImpl, captured.sourceAbsenceContext);
  }
  // Once a leaf has been renamed into the bundle it becomes the evidence this call is about to
  // declare `complete`, so every later proof binds it. Without these two the terminal marker
  // could publish `complete` over a substituted tree or reservation.
  if (captured.movedTreeIdentity) {
    assertDirectoryFence(captured.treePath, captured.treeLabel, captured.movedTreeIdentity, fsImpl);
  }
  if (captured.movedReservationIdentity) {
    assertRegularFileFence(
      captured.movedReservationPath,
      'quarantine moved reservation',
      captured.movedReservationIdentity,
      fsImpl,
    );
  }
  if (options.includeSource) {
    assertDirectoryFence(
      captured.sourcePath,
      `.wiki-meta/.transactions/${path.basename(captured.sourcePath)}`,
      captured.sourceIdentity,
      fsImpl,
    );
  }
  if (options.includeReservation) {
    assertRegularFileFence(
      captured.reservationPath,
      'quarantine reservation',
      captured.reservationIdentity,
      fsImpl,
    );
  }
}

function unlinkIdleMaintenanceMarker(root, token, destination, fsImpl, faultInjector) {
  const meta = path.join(root, '.wiki-meta');
  const runtime = path.join(meta, '.runtime');
  const metaIdentity = physicalDirectoryIdentity(meta, '.wiki-meta', false, fsImpl);
  const runtimeIdentity = physicalDirectoryIdentity(runtime, '.wiki-meta/.runtime', false, fsImpl);
  const leafIdentity = captureRegularFileIdentity(
    destination,
    '.wiki-meta/.runtime/scan-window-maintenance.json',
    true,
    fsImpl,
  );
  if (leafIdentity === null) return;
  invokeMarkerFault(faultInjector, 'before-idle-unlink');
  assertLockOwner({ wikiRoot: root, token });
  if (!identityUnchanged(physicalDirectoryIdentity(meta, '.wiki-meta', true, fsImpl), metaIdentity)
      || !identityUnchanged(physicalDirectoryIdentity(runtime, '.wiki-meta/.runtime', true, fsImpl), runtimeIdentity)) {
    throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.runtime identity changed mid-unlink');
  }
  const currentLeaf = captureRegularFileIdentity(
    destination,
    '.wiki-meta/.runtime/scan-window-maintenance.json',
    true,
    fsImpl,
  );
  if (!regularFileIdentitiesMatch(currentLeaf, leafIdentity)) {
    throw stateError(
      'WIKI_STATE_FILESYSTEM',
      '.wiki-meta/.runtime/scan-window-maintenance.json identity changed mid-unlink',
    );
  }
  try { fsImpl.unlinkSync(destination); }
  catch (error) {
    if (error.code === 'ENOENT') {
      throw stateError(
        'WIKI_STATE_FILESYSTEM',
        '.wiki-meta/.runtime/scan-window-maintenance.json identity changed mid-unlink',
        error,
      );
    }
    throw error;
  }
  if (!identityUnchanged(physicalDirectoryIdentity(meta, '.wiki-meta', true, fsImpl), metaIdentity)
      || !identityUnchanged(physicalDirectoryIdentity(runtime, '.wiki-meta/.runtime', true, fsImpl), runtimeIdentity)) {
    throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.runtime identity changed mid-unlink');
  }
}

function assertAnchorUnchanged(root, transactions, anchor) {
  if (!identityUnchanged(transactionStoreAnchor(root, transactions), anchor)) {
    throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.transactions identity changed mid-sweep');
  }
}

// `removeEntryBounded` recurses through descendant pathnames, so re-proving only the store leaves
// the directory actually being traversed unsealed: swapping it for a symlink would make every
// child removal resolve through the link. Sealing that directory too closes the chain the sweep
// walks. Returns an `assertOwner` that proves the store, then the traversed directory.
function sealedAssertOwner(assertOwner, directory, label) {
  const expected = physicalDirectoryIdentity(directory, label, false);
  return () => {
    assertOwner();
    if (!identityUnchanged(physicalDirectoryIdentity(directory, label, true), expected)) {
      throw stateError('WIKI_STATE_FILESYSTEM', `${label} identity changed mid-sweep`);
    }
  };
}

function invokeFault(faultInjector, boundary) {
  if (typeof faultInjector === 'function') faultInjector(boundary);
}

// Removes `pathname` (file or directory tree) leaf-first, checking the sweep reserve before
// each removal. Returns true if `pathname` is fully gone when this returns; false if the sweep
// reserve ran out partway through (some descendants may remain — safe to resume on a later call,
// since the remaining filesystem state alone is what a future sweep re-discovers and classifies).
function removeEntryBounded(pathname, deadline, assertOwner, faultInjector, counter) {
  let stat;
  try { stat = fs.lstatSync(pathname); }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    invokeFault(faultInjector, `sweep-remove:${counter.value}`);
    counter.value += 1;
    if (remainingMs(deadline) < SWEEP_RESERVE_MS) return false;
    assertOwner();
    fs.rmSync(pathname, { force: true });
    return true;
  }
  let children;
  try { children = fs.readdirSync(pathname); }
  catch (error) { if (error.code === 'ENOENT') return true; throw error; }
  for (const name of children) {
    if (remainingMs(deadline) < SWEEP_RESERVE_MS) return false;
    if (!removeEntryBounded(path.join(pathname, name), deadline, assertOwner, faultInjector, counter)) return false;
  }
  invokeFault(faultInjector, `sweep-remove:${counter.value}`);
  counter.value += 1;
  if (remainingMs(deadline) < SWEEP_RESERVE_MS) return false;
  assertOwner();
  fs.rmdirSync(pathname);
  return true;
}

// Reclaims one junk entry. The `Dirent` from `readdirSync` only describes the entry at enumeration
// time, so the type is re-proved here and the removal is a plain `unlink` — never a recursive
// delete and never a followed link. Returns 'removed', 'skipped' (vanished, retyped, or held by a
// foreign process), or 'yielded' (the deadline reserve ran out).
function reclaimJunkEntry(pathname, boundary, deadline, assertOwner, faultInjector) {
  invokeFault(faultInjector, boundary);
  if (remainingMs(deadline) < SWEEP_RESERVE_MS) return 'yielded';
  let stat;
  try { stat = fs.lstatSync(pathname); }
  catch (error) {
    if (error.code === 'ENOENT') return 'skipped';
    throw stateError('WIKI_STATE_FILESYSTEM', 'transaction store entry identity is unavailable', error);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) return 'skipped';
  // Owner and anchor are re-proved here and are NEVER covered by the tolerance below: a validation
  // failure must fail closed even when its errno happens to be EACCES.
  assertOwner();
  invokeFault(faultInjector, boundary.replace('junk-remove:', 'junk-validated:'));
  // Validation itself costs syscalls on a slow mounted volume, so the reserve is re-checked here:
  // never start a mutation for inert debris with the budget already spent.
  if (remainingMs(deadline) < SWEEP_RESERVE_MS) return 'yielded';
  try { fs.unlinkSync(pathname); }
  catch (error) {
    if (error.code === 'ENOENT' || FOREIGN_HOLD_CODES.has(error.code)) return 'skipped';
    throw error;
  }
  invokeFault(faultInjector, boundary.replace('junk-remove:', 'junk-removed:'));
  // Detection, not prevention: Node exposes no `unlinkat`, so the anchor cannot be bound to the
  // unlink atomically. Re-proving afterwards turns a raced ancestor swap into a hard failure
  // instead of a silent success. See `docs/`-free note in the sweep comment for the residual.
  assertOwner();
  return 'removed';
}

// Returns the debris directories removed during this bounded pass in `removed`, and any reclaimed
// OS metadata files separately in `removed_junk`. The two vocabularies stay apart because callers
// surface `removed` as a list of transaction operation ids.
function sweepTransactionDebris(root, token, options = {}) {
  const { deadline, limit = 8, faultInjector } = options;
  const classes = options.classes === undefined
    ? new Set(SWEEP_CLASSES)
    : new Set(options.classes);
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError('debris sweep limit must be a nonnegative integer');
  if ([...classes].some((name) => !SWEEP_CLASSES.has(name))) throw new TypeError('unknown transaction debris class');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  const anchor = transactionStoreAnchor(root, transactions);
  if (anchor === null) return { processed: 0, removed: [], removed_junk: [], skipped_oversized: [] };
  let entries;
  try { entries = fs.readdirSync(transactions, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return { processed: 0, removed: [], removed_junk: [], skipped_oversized: [] };
    throw error;
  }
  // Every mutation in this module goes through `assertOwner`, so re-proving the store's identity
  // here also covers a parent swapped between enumeration and removal, including inside recursion.
  const assertOwner = () => {
    assertLockOwner({ wikiRoot: root, token });
    assertAnchorUnchanged(root, transactions, anchor);
  };
  let processed = 0;
  let junkAttempts = 0;
  const removed = [];
  const removedJunk = [];
  const skippedOversized = [];
  const inspectPressure = options.inspectDirectoryPressure || inspectDirectoryPressure;
  const result = () => ({
    processed, removed, removed_junk: removedJunk, skipped_oversized: skippedOversized,
  });
  // Transaction-class debris runs to completion first. Junk is inert; `cancelled` is the only class
  // that is fatal to a lock-free reader, so junk must never reach it first and spend the entry
  // budget or the deadline reserve on the way. Ordering — not a second budget — is what guarantees
  // that, so the documented per-pass cap stays a single `limit`.
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    let kind;
    let resolvedUnknown = false;
    if (entry.isDirectory()) kind = 'directory';
    else if (direntTypeUnknown(entry)) {
      kind = resolveUnknownDirent(transactions, entry, options.fs || fs).kind;
      resolvedUnknown = true;
    } else continue;
    if (kind !== 'directory') continue;
    if (resolvedUnknown && entry.name.startsWith('.activate-')) continue;
    if (deadline) {
      try { assertBeforeDeadline(deadline, `debris-pressure:${entry.name}`); }
      catch (error) {
        if (error.code === 'DEADLINE_EXCEEDED') break;
        throw error;
      }
    }
    const transaction = path.join(transactions, entry.name);
    const pressure = inspectPressure(transaction, {
      deadline,
      allowEnumeration: false,
      fs: options.fs || fs,
    });
    if (pressure.oversized) {
      skippedOversized.push(entry.name);
      continue;
    }
    if (processed >= limit) continue;
    if (entry.name.startsWith('.prune-')
        || entry.name.startsWith('.reservation-.prune-')) continue;
    const journal = path.join(transaction, 'journal.json');

    let debrisClass = null;
    if (entry.name.startsWith('.activate-')) {
      if (classes.has('activation')) debrisClass = 'activation';
    } else {
      if (entryExists(journal)) continue;
      const tombstone = path.join(transaction, 'cancelled.json');
      if (!entryExists(tombstone)) {
        if (classes.has('plain')) debrisClass = 'plain';
      } else if (classes.has('cancelled')) {
        let verdict;
        try { verdict = validateTombstoneV1(transaction, entry.name); }
        catch { continue; }
        if (verdict.valid) debrisClass = 'cancelled';
      }
    }
    if (debrisClass === null) continue;
    if (remainingMs(deadline) < SWEEP_RESERVE_MS) break;

    const sealedOwner = sealedAssertOwner(assertOwner, transaction, `.wiki-meta/.transactions/${entry.name}`);
    if (debrisClass !== 'cancelled') {
      const counter = { value: 0 };
      if (!removeEntryBounded(transaction, deadline, sealedOwner, faultInjector, counter)) {
        return result();
      }
      // Detection parity with the cancelled and junk branches: a removal is only reported once the
      // owner token and the store anchor still hold after it.
      assertOwner();
      processed += 1;
      removed.push(entry.name);
      continue;
    }

    const counter = { value: 0 };
    for (const name of fs.readdirSync(transaction)) {
      if (name === 'cancelled.json') continue;
      if (!removeEntryBounded(path.join(transaction, name), deadline, sealedOwner, faultInjector, counter)) {
        return result();
      }
    }
    // The tombstone and its directory are two more destructive syscalls, so they observe the same
    // reserve discipline and publish the same boundary shape as every other removal.
    invokeFault(faultInjector, `sweep-remove:${counter.value}`);
    counter.value += 1;
    if (remainingMs(deadline) < SWEEP_RESERVE_MS) return result();
    sealedOwner();
    fs.rmSync(path.join(transaction, 'cancelled.json'), { force: true });
    invokeFault(faultInjector, `sweep-remove:${counter.value}`);
    counter.value += 1;
    if (remainingMs(deadline) < SWEEP_RESERVE_MS) return result();
    sealedOwner();
    fs.rmdirSync(transaction);
    assertOwner();
    processed += 1;
    removed.push(entry.name);
  }

  if (!classes.has('junk')) return result();
  // Junk shares the one documented per-pass entry budget with transaction debris — it simply never
  // gets first claim on it. Every ATTEMPT counts, so a file the OS refuses to release cannot be
  // retried without bound inside a pass, and its distinct `junk-remove:<n>` boundary keeps the
  // interruption points addressable independently of `removeEntryBounded`'s per-tree counter.
  for (const entry of entries) {
    if (processed + junkAttempts >= limit) break;
    if (!isReclaimableJunkEntry(entry, transactions)) continue;
    const outcome = reclaimJunkEntry(
      path.join(transactions, entry.name), `junk-remove:${junkAttempts}`,
      deadline, assertOwner, faultInjector,
    );
    if (outcome === 'yielded') return result();
    junkAttempts += 1;
    if (outcome === 'removed') removedJunk.push(entry.name);
  }
  return result();
}

// Public form of the store anchor for callers that mutate `.transactions` outside a sweep. Throws
// WIKI_STATE_FILESYSTEM unless `.wiki-meta` and `.wiki-meta/.transactions` are both physical
// directories at their expected physical paths.
function assertTransactionStoreAnchored(root) {
  transactionStoreAnchor(root, path.join(root, '.wiki-meta', '.transactions'));
}

function invokeMarkerFault(faultInjector, boundary) {
  if (typeof faultInjector === 'function') faultInjector(boundary);
}

function canonicalUtcZ(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function isCanonicalUtcZ(value) {
  if (typeof value !== 'string' || !ISO_Z_RE.test(value)) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && canonicalUtcZ(parsed) === value;
}

function validStoreEntryName(value) {
  return typeof value === 'string' && value.length > 0 && value === path.basename(value)
    && !value.includes('\0') && value !== '.' && value !== '..';
}

function assertNoOperationId(value) {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) assertNoOperationId(entry);
    return;
  }
  if (Object.hasOwn(value, 'operation_id')) {
    throw stateError('WIKI_STATE_INVALID', 'maintenance marker must not contain operation_id');
  }
  for (const nested of Object.values(value)) assertNoOperationId(nested);
}

function hasExactKeysAllowing(value, required, optional = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const actual = Object.keys(value);
  if (actual.some((key) => !allowed.has(key))) return false;
  return required.every((key) => Object.hasOwn(value, key));
}

function cloneMarker(marker) {
  return JSON.parse(JSON.stringify(marker));
}

function emptyMaintenanceMarker(updatedAt) {
  return {
    schema: 1,
    updated_at: updatedAt,
    prune_failures: [],
    promoted: [],
    skipped_oversized: [],
    quarantine_bundles: [],
  };
}

function validateBundleRecord(record) {
  if (!hasExactKeysAllowing(record, BUNDLE_REQUIRED_KEYS, BUNDLE_OPTIONAL_KEYS)) return false;
  if (!QUARANTINE_BUNDLE_NAME_RE.test(record.bundle)) return false;
  if (!validStoreEntryName(record.source_name)) return false;
  if (!BUNDLE_STATES.has(record.state) || !isCanonicalUtcZ(record.at)) return false;
  if (Object.hasOwn(record, 'resume') && record.resume !== true) return false;
  return true;
}

function validateMaintenanceMarker(value) {
  assertNoOperationId(value);
  if (!hasExactKeys(value, MARKER_KEYS) || value.schema !== 1 || !isCanonicalUtcZ(value.updated_at)) {
    throw stateError('WIKI_STATE_INVALID', 'maintenance marker schema is invalid');
  }
  if (!Array.isArray(value.prune_failures) || value.prune_failures.length > PRUNE_FAILURE_CAP
      || value.prune_failures.some((row) => !hasExactKeys(row, PRUNE_FAILURE_KEYS)
        || !PRUNE_FAILURE_CODE_RE.test(row.code) || !isCanonicalUtcZ(row.at))) {
    throw stateError('WIKI_STATE_INVALID', 'maintenance marker prune_failures are invalid');
  }
  if (!Array.isArray(value.promoted) || value.promoted.length > PROMOTED_CAP
      || value.promoted.some((name) => !validStoreEntryName(name))) {
    throw stateError('WIKI_STATE_INVALID', 'maintenance marker promoted names are invalid');
  }
  if (!Array.isArray(value.skipped_oversized) || value.skipped_oversized.length > SKIPPED_OVERSIZED_CAP
      || value.skipped_oversized.some((name) => !validStoreEntryName(name))) {
    throw stateError('WIKI_STATE_INVALID', 'maintenance marker skipped_oversized names are invalid');
  }
  if (!Array.isArray(value.quarantine_bundles) || value.quarantine_bundles.length > QUARANTINE_BUNDLE_CAP
      || value.quarantine_bundles.some((row) => !validateBundleRecord(row))) {
    throw stateError('WIKI_STATE_INVALID', 'maintenance marker quarantine_bundles are invalid');
  }
  return value;
}

function canonicalMaintenanceMarkerBytes(marker) {
  const canonical = {
    schema: marker.schema,
    updated_at: marker.updated_at,
    prune_failures: marker.prune_failures,
    promoted: marker.promoted,
    skipped_oversized: marker.skipped_oversized,
    quarantine_bundles: marker.quarantine_bundles,
  };
  return Buffer.from(`${JSON.stringify(canonical)}\n`, 'utf8');
}

function capMarkerArrays(marker) {
  while (marker.prune_failures.length > PRUNE_FAILURE_CAP) marker.prune_failures.shift();
  while (marker.promoted.length > PROMOTED_CAP) marker.promoted.shift();
  while (marker.skipped_oversized.length > SKIPPED_OVERSIZED_CAP) marker.skipped_oversized.shift();
  while (marker.quarantine_bundles.length > QUARANTINE_BUNDLE_CAP) marker.quarantine_bundles.shift();
}

function eventRecordCount(marker) {
  return marker.prune_failures.length + marker.promoted.length
    + marker.skipped_oversized.length + marker.quarantine_bundles.length;
}

function evictOneMarkerRecord(marker, onEvict) {
  const completeIndex = marker.quarantine_bundles.findIndex((row) => row.state === 'complete');
  if (completeIndex >= 0) {
    const [record] = marker.quarantine_bundles.splice(completeIndex, 1);
    if (typeof onEvict === 'function') onEvict('complete', record.source_name || record.bundle);
    return true;
  }
  if (marker.skipped_oversized.length > 0) {
    const record = marker.skipped_oversized.shift();
    if (typeof onEvict === 'function') onEvict('skipped_oversized', record);
    return true;
  }
  if (marker.promoted.length > 0) {
    const record = marker.promoted.shift();
    if (typeof onEvict === 'function') onEvict('promoted', record);
    return true;
  }
  if (marker.prune_failures.length > 0) {
    const record = marker.prune_failures.shift();
    if (typeof onEvict === 'function') onEvict('prune_failures', record.code);
    return true;
  }
  const activeIndex = marker.quarantine_bundles.findIndex((row) => row.state === 'pending' || row.state === 'incomplete');
  if (activeIndex >= 0) {
    const [record] = marker.quarantine_bundles.splice(activeIndex, 1);
    if (typeof onEvict === 'function') onEvict('active', record.source_name || record.bundle);
    return true;
  }
  return false;
}

function fitMarkerToBudget(marker, maxBytes, onEvict) {
  let bytes = canonicalMaintenanceMarkerBytes(marker);
  while (bytes.length > maxBytes) {
    if (eventRecordCount(marker) <= 1) {
      throw stateError('WIKI_STATE_INVALID', 'maintenance marker exceeds byte budget');
    }
    if (!evictOneMarkerRecord(marker, onEvict)) {
      throw stateError('WIKI_STATE_INVALID', 'maintenance marker exceeds byte budget');
    }
    bytes = canonicalMaintenanceMarkerBytes(marker);
  }
  return bytes;
}

function isIdleMarker(marker) {
  return eventRecordCount(marker) === 0;
}

function markerFilePath(root) {
  return path.join(root, '.wiki-meta', '.runtime', MAINTENANCE_MARKER_BASENAME);
}

function upsertQuarantineBundle(marker, record) {
  const next = cloneMarker(marker);
  if (!Array.isArray(next.quarantine_bundles)) next.quarantine_bundles = [];
  const index = next.quarantine_bundles.findIndex((row) => row.bundle === record.bundle);
  if (index >= 0) next.quarantine_bundles[index] = { ...record };
  else next.quarantine_bundles.push({ ...record });
  while (next.quarantine_bundles.length > QUARANTINE_BUNDLE_CAP) next.quarantine_bundles.shift();
  return next;
}

function removePendingQuarantineBundle(marker, bundle) {
  const next = cloneMarker(marker);
  const index = next.quarantine_bundles.findIndex((row) => row.bundle === bundle);
  if (index === -1) return next;
  if (next.quarantine_bundles[index].state !== 'pending') return next;
  next.quarantine_bundles.splice(index, 1);
  return next;
}

function readExactDescriptorBytes(fsImpl, fd, size) {
  const max = Number(size);
  const buffer = Buffer.alloc(max);
  let offset = 0;
  while (offset < max) {
    const count = fsImpl.readSync(fd, buffer, offset, max - offset, null);
    if (count === 0) {
      throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.runtime/scan-window-maintenance.json shrank during read');
    }
    offset += count;
  }
  const probe = Buffer.alloc(1);
  const extra = fsImpl.readSync(fd, probe, 0, 1, null);
  if (extra > 0) {
    throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.runtime/scan-window-maintenance.json grew during read');
  }
  return buffer;
}

function readMaintenanceMarker(root, options = {}) {
  const fsImpl = options.fs || fs;
  const { faultInjector } = options;
  const meta = path.join(root, '.wiki-meta');
  const runtime = path.join(meta, '.runtime');
  const marker = path.join(runtime, MAINTENANCE_MARKER_BASENAME);
  const metaIdentity = physicalDirectoryIdentity(meta, '.wiki-meta', true, fsImpl);
  if (metaIdentity === null) return null;
  const runtimeIdentity = physicalDirectoryIdentity(runtime, '.wiki-meta/.runtime', true, fsImpl);
  if (runtimeIdentity === null) return null;
  invokeMarkerFault(faultInjector, 'after-parent-capture');

  let pathStat;
  try { pathStat = fsImpl.lstatSync(marker, { bigint: true }); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.runtime/scan-window-maintenance.json is unavailable', error);
  }
  const pathIdentity = regularFileIdentity(pathStat);
  if (!pathIdentity) {
    throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.runtime/scan-window-maintenance.json must be a regular non-symlink file');
  }
  invokeMarkerFault(faultInjector, 'after-leaf-lstat');

  const constants = fsImpl.constants || fs.constants;
  const flags = (constants.O_RDONLY ?? 0) | (constants.O_NOFOLLOW ?? 0);
  let fd;
  try {
    fd = fsImpl.openSync(marker, flags);
    const fdStat = fsImpl.fstatSync(fd, { bigint: true });
    const fdIdentity = regularFileIdentity(fdStat);
    if (!descriptorMatchesPathIdentity(fdIdentity, pathIdentity)) {
      throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.runtime/scan-window-maintenance.json identity changed mid-read');
    }
    invokeMarkerFault(faultInjector, 'after-fstat');
    const size = typeof fdStat.size === 'bigint' ? fdStat.size : BigInt(fdStat.size);
    const maxBytes = options.maxBytes === undefined ? MAINTENANCE_MARKER_MAX_BYTES : options.maxBytes;
    if (size > BigInt(maxBytes)) {
      throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.runtime/scan-window-maintenance.json exceeds byte budget');
    }
    const bytes = readExactDescriptorBytes(fsImpl, fd, size);
    fsImpl.closeSync(fd);
    fd = undefined;
    invokeMarkerFault(faultInjector, 'after-read');
    const metaAfter = physicalDirectoryIdentity(meta, '.wiki-meta', true, fsImpl);
    const runtimeAfter = physicalDirectoryIdentity(runtime, '.wiki-meta/.runtime', true, fsImpl);
    let leafAfter;
    try { leafAfter = regularFileIdentity(fsImpl.lstatSync(marker, { bigint: true })); }
    catch (error) {
      throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.runtime/scan-window-maintenance.json identity changed mid-read', error);
    }
    if (!identityUnchanged(metaAfter, metaIdentity)
        || !identityUnchanged(runtimeAfter, runtimeIdentity)
        || !leafAfter
        || leafAfter.ino !== pathIdentity.ino
        || leafAfter.type !== pathIdentity.type
        || leafAfter.birthtimeNs !== pathIdentity.birthtimeNs
        || leafAfter.mtimeNs !== pathIdentity.mtimeNs
        || leafAfter.nlink !== pathIdentity.nlink
        || leafAfter.dev !== pathIdentity.dev) {
      throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.runtime/scan-window-maintenance.json identity changed mid-read');
    }
    let parsed;
    try { parsed = JSON.parse(bytes.toString('utf8')); }
    catch {
      throw stateError('WIKI_STATE_INVALID', 'maintenance marker is unreadable');
    }
    return validateMaintenanceMarker(parsed);
  } finally {
    if (fd !== undefined) {
      try { fsImpl.closeSync(fd); } catch { /* preserve the primary error */ }
    }
  }
}

// `mkdirSync` resolves `.wiki-meta` through whatever that name points at when the syscall runs,
// so proving the parent once and then creating `.runtime` leaves a seam where substituting
// `.wiki-meta` for a symlink creates the directory outside the wiki before the post-creation
// physical check can reject the path. Re-proving the captured parent identity and the lock owner
// immediately before and after the creation closes that seam; the residual window between the
// re-proof and the syscall itself is the platform's (Node exposes no `mkdirat`), the same class
// the marker reader accepts.
function assertRuntimeParentUnchanged(root, token, meta, expected, fsImpl) {
  if (!identityUnchanged(physicalDirectoryIdentity(meta, '.wiki-meta', true, fsImpl), expected)) {
    throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta identity changed mid-runtime-create');
  }
  assertLockOwner({ wikiRoot: root, token });
}

function ensureRuntimeDirectory(root, fsImpl, options = {}) {
  const { token, faultInjector } = options;
  const meta = path.join(root, '.wiki-meta');
  const metaIdentity = physicalDirectoryIdentity(meta, '.wiki-meta', false, fsImpl);
  const runtime = path.join(meta, '.runtime');
  invokeMarkerFault(faultInjector, 'before-runtime-mkdir');
  assertRuntimeParentUnchanged(root, token, meta, metaIdentity, fsImpl);
  try { fsImpl.mkdirSync(runtime, { recursive: false }); }
  catch (error) {
    if (error.code !== 'EEXIST') {
      throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.runtime identity is unavailable', error);
    }
  }
  invokeMarkerFault(faultInjector, 'after-runtime-mkdir');
  assertRuntimeParentUnchanged(root, token, meta, metaIdentity, fsImpl);
  return physicalDirectoryIdentity(runtime, '.wiki-meta/.runtime', false, fsImpl);
}

function writeMaintenanceMarker(root, token, mutate, options = {}) {
  const fsImpl = options.fs || fs;
  const writeFile = options.atomicWriteFile || atomicWriteFile;
  const maxBytes = options.maxBytes === undefined ? MAINTENANCE_MARKER_MAX_BYTES : options.maxBytes;
  const now = options.now || new Date();
  assertLockOwner({ wikiRoot: root, token });
  ensureRuntimeDirectory(root, fsImpl, { token, faultInjector: options.faultInjector });
  const current = readMaintenanceMarker(root, { fs: fsImpl, faultInjector: options.faultInjector })
    || emptyMaintenanceMarker(canonicalUtcZ(now));
  const draft = cloneMarker(current);
  const mutated = typeof mutate === 'function' ? mutate(draft) : draft;
  const next = mutated && typeof mutated === 'object' ? mutated : draft;
  next.schema = 1;
  next.updated_at = canonicalUtcZ(now);
  if (!Array.isArray(next.prune_failures)) next.prune_failures = [];
  if (!Array.isArray(next.promoted)) next.promoted = [];
  if (!Array.isArray(next.skipped_oversized)) next.skipped_oversized = [];
  if (!Array.isArray(next.quarantine_bundles)) next.quarantine_bundles = [];
  capMarkerArrays(next);
  const destination = markerFilePath(root);
  if (isIdleMarker(next)) {
    unlinkIdleMaintenanceMarker(root, token, destination, fsImpl, options.faultInjector);
    return next;
  }
  const bytes = fitMarkerToBudget(next, maxBytes, options.onEvict);
  validateMaintenanceMarker(next);
  const meta = path.join(root, '.wiki-meta');
  const runtime = path.join(meta, '.runtime');
  const metaIdentity = physicalDirectoryIdentity(meta, '.wiki-meta', false, fsImpl);
  const runtimeIdentity = physicalDirectoryIdentity(runtime, '.wiki-meta/.runtime', false, fsImpl);
  const seal = () => {
    assertLockOwner({ wikiRoot: root, token });
    if (!identityUnchanged(physicalDirectoryIdentity(meta, '.wiki-meta', true, fsImpl), metaIdentity)
        || !identityUnchanged(physicalDirectoryIdentity(runtime, '.wiki-meta/.runtime', true, fsImpl), runtimeIdentity)) {
      throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.runtime identity changed mid-write');
    }
    if (typeof options.beforePublish === 'function') options.beforePublish();
  };
  writeFile(destination, bytes, {
    fs: fsImpl,
    createParent: false,
    beforeRename: seal,
    beforePublish: seal,
  });
  return next;
}

function emptyInventoryResult() {
  return {
    bundles: [],
    count: 0,
    truncated: false,
    unexpected: 0,
    oversized: false,
    method: 'none',
    estimated_entries: null,
  };
}

function listQuarantineBundleNames(root, options = {}) {
  const fsImpl = options.fs || fs;
  const { deadline, faultInjector } = options;
  const meta = path.join(root, '.wiki-meta');
  const quarantine = path.join(meta, '.quarantine');
  const metaIdentity = physicalDirectoryIdentity(meta, '.wiki-meta', true, fsImpl);
  if (metaIdentity === null) return emptyInventoryResult();
  const quarantineIdentity = physicalDirectoryIdentity(quarantine, '.wiki-meta/.quarantine', true, fsImpl);
  if (quarantineIdentity === null) return emptyInventoryResult();

  const pressure = inspectDirectoryPressure(quarantine, {
    deadline,
    allowEnumeration: false,
    fs: fsImpl,
  });
  if (pressure.oversized) {
    return {
      bundles: [],
      count: 0,
      truncated: false,
      unexpected: 0,
      oversized: true,
      method: pressure.method,
      estimated_entries: pressure.estimatedEntries,
    };
  }

  invokeMarkerFault(faultInjector, 'before-readdir');
  const metaBeforeRead = physicalDirectoryIdentity(meta, '.wiki-meta', true, fsImpl);
  const quarantineBeforeRead = physicalDirectoryIdentity(quarantine, '.wiki-meta/.quarantine', true, fsImpl);
  if (!identityUnchanged(metaBeforeRead, metaIdentity)
      || !identityUnchanged(quarantineBeforeRead, quarantineIdentity)) {
    throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.quarantine identity changed mid-inventory');
  }

  let entries;
  try { entries = fsImpl.readdirSync(quarantine, { withFileTypes: true }); }
  catch (error) {
    if (error.code === 'ENOENT') {
      throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.quarantine identity changed mid-inventory', error);
    }
    throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.quarantine identity is unavailable', error);
  }
  invokeMarkerFault(faultInjector, 'after-readdir');

  const bundles = [];
  let unexpected = 0;
  for (const entry of entries) {
    assertBeforeDeadline(deadline, `quarantine-inventory:${entry.name}`);
    if (entry.isSymbolicLink()) continue;
    let kind;
    if (entry.isDirectory()) kind = 'directory';
    else if (direntTypeUnknown(entry)) kind = resolveUnknownDirent(quarantine, entry, fsImpl).kind;
    else {
      unexpected += 1;
      continue;
    }
    if (kind !== 'directory') {
      if (kind === 'symlink') continue;
      unexpected += 1;
      continue;
    }
    if (QUARANTINE_BUNDLE_NAME_RE.test(entry.name)) bundles.push(entry.name);
    else unexpected += 1;
  }

  const metaAfter = physicalDirectoryIdentity(meta, '.wiki-meta', true, fsImpl);
  const quarantineAfter = physicalDirectoryIdentity(quarantine, '.wiki-meta/.quarantine', true, fsImpl);
  if (!identityUnchanged(metaAfter, metaIdentity) || !identityUnchanged(quarantineAfter, quarantineIdentity)) {
    throw stateError('WIKI_STATE_FILESYSTEM', '.wiki-meta/.quarantine identity changed mid-inventory');
  }

  bundles.sort();
  const truncated = bundles.length > QUARANTINE_INVENTORY_DISPLAY_LIMIT;
  return {
    bundles: truncated ? bundles.slice(0, QUARANTINE_INVENTORY_DISPLAY_LIMIT) : bundles,
    count: bundles.length,
    truncated,
    unexpected,
    oversized: false,
    method: 'none',
    estimated_entries: null,
  };
}

function isIsolatableStoreName(name, parsePruneName) {
  try {
    classifyQuarantineName(name, parsePruneName);
    return true;
  } catch (error) {
    if (error.code === 'WIKI_STATE_INVALID' || error.code === 'SCAN_WINDOW_INVALID') return false;
    throw error;
  }
}

function classifyQuarantineName(name, parsePruneName) {
  if (typeof name !== 'string' || name.length === 0 || path.basename(name) !== name) {
    throw stateError('WIKI_STATE_INVALID', 'quarantine target name is invalid');
  }
  if (ISOLATABLE_NAME_RE.test(name)) {
    return { kind: 'direct', sourceName: name, embeddedId: name };
  }
  if (!name.startsWith('.prune-')) {
    throw stateError('WIKI_STATE_INVALID', 'quarantine target is not an isolatable class');
  }
  if (typeof parsePruneName !== 'function') {
    throw stateError('WIKI_STATE_INVALID', 'prune-name parser is required');
  }
  const operationId = parsePruneName(name);
  const prefix = `.prune-${operationId.length}-${operationId}-`;
  if (!name.startsWith(prefix)) {
    throw stateError('WIKI_STATE_INVALID', 'terminal quarantine name is invalid');
  }
  if (!PRUNE_SUFFIX_RE.test(name.slice(prefix.length))) {
    throw stateError('WIKI_STATE_INVALID', 'terminal quarantine name is invalid');
  }
  if (!ISOLATABLE_NAME_RE.test(operationId)) {
    throw stateError('WIKI_STATE_INVALID', 'terminal quarantine embedded id is not isolatable');
  }
  return { kind: 'prune', sourceName: name, embeddedId: operationId };
}

function quarantineStamp(date) {
  return canonicalUtcZ(date).replaceAll('-', '').replaceAll(':', '');
}

function makeBundleName(now, pid, randomUUID) {
  const uuid = String(randomUUID()).replaceAll('-', '');
  const bundle = `${quarantineStamp(now)}-${pid}-${uuid}`;
  if (!QUARANTINE_BUNDLE_NAME_RE.test(bundle)) {
    throw stateError('WIKI_STATE_INVALID', 'quarantine bundle name is invalid');
  }
  return bundle;
}

function powershellQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function shellQuote(value) {
  if (process.platform === 'win32') return powershellQuote(value);
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function followUpRecoverArgv(wikiRoot, operationId) {
  return [
    'transaction', 'recover',
    '--wiki-root', path.resolve(wikiRoot),
    '--operation-id', operationId,
    '--json',
  ];
}

function renderFollowUpCommand(argv) {
  const root = argv[argv.indexOf('--wiki-root') + 1];
  const operationId = argv[argv.indexOf('--operation-id') + 1];
  const runtime = path.resolve(__dirname, '../../../scripts/wiki-runtime.js');
  const command = `node ${shellQuote(runtime)} transaction recover --wiki-root ${shellQuote(root)} --operation-id ${shellQuote(operationId)} --json`;
  if (process.platform === 'win32') return `resume with (PowerShell):\n${command}`;
  return command;
}

function followUpRecoverCommand(wikiRoot, operationId) {
  return renderFollowUpCommand(followUpRecoverArgv(wikiRoot, operationId));
}

function followUpFor(name, wikiRoot) {
  const match = ULID_FOLLOW_RE.exec(name);
  if (!match || typeof wikiRoot !== 'string' || wikiRoot.length === 0) return undefined;
  const followUpArgv = followUpRecoverArgv(wikiRoot, match[1]);
  return {
    follow_up: renderFollowUpCommand(followUpArgv),
    follow_up_argv: followUpArgv,
  };
}

function attachFollowUpMetadata(payload, followUp, followUpArgv) {
  if (Array.isArray(followUpArgv) && followUpArgv.length > 0) {
    payload.follow_up_argv = [...followUpArgv];
  }
  if (followUp) payload.follow_up = followUp;
  return payload;
}

function ensureSealedQuarantineRoot(root, token, captured, options = {}) {
  const fsImpl = options.fs || fs;
  invokeMarkerFault(options.faultInjector, 'before-root-mkdir');
  assertDirectoryFence(captured.metaPath, '.wiki-meta', captured.metaIdentity, fsImpl);
  assertDirectoryFence(captured.storePath, '.wiki-meta/.transactions', captured.storeIdentity, fsImpl);
  if (captured.expectSourceAbsent) {
    assertExpectedSourceAbsence(captured.sourcePath, fsImpl);
  }
  if (captured.reservationIdentity) {
    assertRegularFileFence(
      captured.reservationPath,
      'quarantine reservation',
      captured.reservationIdentity,
      fsImpl,
    );
  }
  assertLockOwner({ wikiRoot: root, token });
  try { fsImpl.mkdirSync(captured.quarantinePath, { recursive: false }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  return directoryIdentity(captured.quarantinePath, '.wiki-meta/.quarantine', fsImpl);
}

function attachIncompleteQuarantine(error, bundle, sourceName) {
  if (error && typeof error === 'object') {
    error.quarantine = {
      committed: true,
      state: 'incomplete',
      bundle,
      source_name: sourceName,
    };
  }
  return error;
}

function isCommittedIncomplete(error) {
  return Boolean(error && error.quarantine
    && error.quarantine.committed === true
    && error.quarantine.state === 'incomplete');
}

function directoryIdentity(pathname, label, fsImpl) {
  return physicalDirectoryIdentity(pathname, label, false, fsImpl);
}

function writeQuarantineMeta(destination, payload, token, root, fsImpl, seal) {
  const bytes = Buffer.from(`${JSON.stringify(payload)}\n`, 'utf8');
  const runSeal = typeof seal === 'function'
    ? seal
    : () => assertLockOwner({ wikiRoot: root, token });
  atomicWriteFile(destination, bytes, {
    fs: fsImpl,
    createParent: false,
    beforeRename: runSeal,
    beforePublish: runSeal,
  });
}

function reservationPath(store, embeddedId) {
  return path.join(store, embeddedId);
}

function quarantineStoreEntry(options = {}) {
  const root = options.wikiRoot;
  const token = options.token;
  const fsImpl = options.fs || fs;
  const now = options.now || new Date();
  const pid = String(options.pid === undefined ? process.pid : options.pid);
  const randomUUID = options.randomUUID || crypto.randomUUID;
  const { faultInjector } = options;
  const classified = classifyQuarantineName(options.name, options.parsePruneName);
  const reason = options.reason === 'oversized' || options.reason === 'operator' ? options.reason : 'operator';
  const classification = options.classification || { method: 'none', estimated_entries: null };
  const follow = followUpFor(classified.kind === 'prune' ? classified.embeddedId : classified.sourceName, root)
    || followUpFor(classified.sourceName, root);
  const followUp = follow && follow.follow_up;
  const followUpArgv = follow && follow.follow_up_argv;

  assertLockOwner({ wikiRoot: root, token });
  const store = path.join(root, '.wiki-meta', '.transactions');
  assertTransactionStoreAnchored(root);
  const metaPathname = path.join(root, '.wiki-meta');
  const metaIdentity = directoryIdentity(metaPathname, '.wiki-meta', fsImpl);
  const storeIdentity = directoryIdentity(store, '.wiki-meta/.transactions', fsImpl);
  const source = path.join(store, classified.sourceName);
  const reservation = classified.kind === 'prune' ? reservationPath(store, classified.embeddedId) : null;

  const sourceIdentity = physicalDirectoryIdentity(
    source, `.wiki-meta/.transactions/${classified.sourceName}`, true, fsImpl,
  );
  if (reservation) {
    let reservationStat = null;
    try { reservationStat = fsImpl.lstatSync(reservation); }
    catch { reservationStat = null; }
    if (reservationStat && reservationStat.isDirectory()) {
      // The canonical path still holds its own operation directory: that directory is not this
      // quarantine's reservation, so it has to be preserved first (issue #60).
      throw stateError(
        'WIKI_STATE_FILESYSTEM',
        `quarantine reservation path ${classified.embeddedId} is a directory; quarantine operation `
          + `${classified.embeddedId} first, then retry ${classified.sourceName}`,
      );
    }
  }
  const reservationIdentity = reservation
    ? captureRegularFileIdentity(reservation, 'quarantine reservation', true, fsImpl)
    : null;

  if (sourceIdentity === null && classified.kind === 'prune' && reservationIdentity) {
    return resumeReservationOnly({
      root, token, fsImpl, now, pid, randomUUID, faultInjector,
      classified, reason, classification, followUp, followUpArgv,
      metaIdentity, storeIdentity, reservation, reservationIdentity,
    });
  }
  if (sourceIdentity === null) {
    throw stateError('TRANSACTION_NOT_FOUND', 'wiki-state transaction does not exist');
  }

  const bundle = makeBundleName(now, pid, randomUUID);
  const at = canonicalUtcZ(now);
  const quarantineRoot = path.join(root, '.wiki-meta', '.quarantine');
  const quarantineIdentity = ensureSealedQuarantineRoot(root, token, {
    metaPath: metaPathname,
    metaIdentity,
    quarantinePath: quarantineRoot,
    storePath: store,
    storeIdentity,
    reservationPath: reservation,
    reservationIdentity,
  }, { fs: fsImpl, faultInjector });

  writeMaintenanceMarker(root, token, (marker) => upsertQuarantineBundle(marker, {
    bundle, source_name: classified.sourceName, state: 'pending', at,
  }), { fs: fsImpl });
  invokeMarkerFault(faultInjector, 'after-write-ahead');

  const bundleDir = path.join(quarantineRoot, bundle);
  const tree = path.join(bundleDir, 'tree');
  const captured = {
    metaPath: metaPathname,
    metaIdentity,
    quarantinePath: quarantineRoot,
    quarantineIdentity,
    bundlePath: bundleDir,
    bundleIdentity: null,
    storePath: store,
    storeIdentity,
    sourcePath: source,
    sourceIdentity,
    reservationPath: reservation,
    reservationIdentity,
  };
  const fence = (extras = {}) => assertQuarantineFence(root, token, captured, { fs: fsImpl, ...extras });
  const metaPayload = {
    schema: 1,
    quarantined_at: at,
    source_name: classified.sourceName,
    classification: {
      method: classification.method,
      estimated_entries: classification.estimated_entries ?? null,
    },
    reason,
    paired_reservation: false,
  };
  attachFollowUpMetadata(metaPayload, followUp, followUpArgv);

  try {
    invokeMarkerFault(faultInjector, 'before-bundle-mkdir');
    fence({ includeSource: true });
    fsImpl.mkdirSync(bundleDir, { recursive: false });
    captured.bundleIdentity = directoryIdentity(
      bundleDir, `.wiki-meta/.quarantine/${bundle}`, fsImpl,
    );
    invokeMarkerFault(faultInjector, 'after-bundle-mkdir');
    invokeMarkerFault(faultInjector, 'before-meta-write');
    fence({ includeSource: true });
    writeQuarantineMeta(
      path.join(bundleDir, 'quarantine.meta.json'), metaPayload, token, root, fsImpl,
      () => fence({ includeSource: true }),
    );
    invokeMarkerFault(faultInjector, 'after-meta-write');
    fence({ includeSource: true });
    invokeMarkerFault(faultInjector, 'before-rename');
    fence({ includeSource: true });
    try { fsImpl.renameSync(source, tree); }
    catch (error) {
      if (error.code === 'EXDEV') {
        throw stateError('WIKI_STATE_FILESYSTEM', 'quarantine rename cannot cross filesystems', error);
      }
      throw error;
    }
  } catch (error) {
    try {
      writeMaintenanceMarker(root, token, (marker) => removePendingQuarantineBundle(marker, bundle), { fs: fsImpl });
    } catch { /* pending residual is harmless */ }
    throw error;
  }

  // The rename is the commit point: from here the source must be absent and the moved tree is
  // the captured identity, so the fence switches expectations rather than keeping the pre-rename
  // source proof that no longer describes the disk.
  captured.sourceIdentity = null;
  captured.expectSourceAbsent = true;
  captured.sourceAbsenceContext = 'quarantine';
  invokeMarkerFault(faultInjector, 'after-rename');

  try {
    fence();
    const treeIdentity = directoryIdentity(tree, `.wiki-meta/.quarantine/${bundle}/tree`, fsImpl);
    if (!identityUnchanged(treeIdentity, sourceIdentity)) {
      throw stateError('WIKI_STATE_FILESYSTEM', 'quarantine tree identity does not match the captured source');
    }
    captured.treePath = tree;
    captured.treeLabel = `.wiki-meta/.quarantine/${bundle}/tree`;
    captured.movedTreeIdentity = treeIdentity;
    invokeMarkerFault(faultInjector, 'after-tree-identity');
    invokeMarkerFault(faultInjector, 'before-reservation-rename');

    let paired = false;
    if (reservationIdentity) {
      fence({ includeReservation: true });
      const destination = path.join(bundleDir, 'reservation');
      fsImpl.renameSync(reservation, destination);
      assertRegularFileFence(destination, 'quarantine reservation', reservationIdentity, fsImpl);
      captured.movedReservationPath = destination;
      captured.movedReservationIdentity = reservationIdentity;
      captured.reservationPath = null;
      captured.reservationIdentity = null;
      fence();
      paired = true;
    }
    if (paired) {
      writeQuarantineMeta(path.join(bundleDir, 'quarantine.meta.json'), {
        ...metaPayload,
        paired_reservation: true,
      }, token, root, fsImpl, () => fence());
    }

    writeMaintenanceMarker(root, token, (marker) => upsertQuarantineBundle(marker, {
      bundle, source_name: classified.sourceName, state: 'complete', at: canonicalUtcZ(now),
    }), { fs: fsImpl, beforePublish: () => fence() });
    const result = { status: 'quarantined', bundle };
    if (followUp) result.follow_up = followUp;
    if (followUpArgv) result.follow_up_argv = followUpArgv;
    return result;
  } catch (error) {
    try {
      writeMaintenanceMarker(root, token, (marker) => upsertQuarantineBundle(marker, {
        bundle, source_name: classified.sourceName, state: 'incomplete', at: canonicalUtcZ(now),
      }), { fs: fsImpl });
    } catch { /* inventory remains the source of truth */ }
    throw attachIncompleteQuarantine(error, bundle, classified.sourceName);
  }
}

function resumeReservationOnly(context) {
  const {
    root, token, fsImpl, now, pid, randomUUID, faultInjector,
    classified, reason, classification, followUp, followUpArgv,
    metaIdentity, storeIdentity, reservation, reservationIdentity,
  } = context;
  const bundle = makeBundleName(now, pid, randomUUID);
  const at = canonicalUtcZ(now);
  let renamed = false;
  try {
    const metaPathname = path.join(root, '.wiki-meta');
    const store = path.join(metaPathname, '.transactions');
    const sourcePath = path.join(store, classified.sourceName);
    const quarantineRoot = path.join(metaPathname, '.quarantine');
    const quarantineIdentity = ensureSealedQuarantineRoot(root, token, {
      metaPath: metaPathname,
      metaIdentity,
      quarantinePath: quarantineRoot,
      storePath: store,
      storeIdentity,
      sourcePath,
      expectSourceAbsent: true,
      reservationPath: reservation,
      reservationIdentity,
    }, { fs: fsImpl, faultInjector });
    writeMaintenanceMarker(root, token, (marker) => upsertQuarantineBundle(marker, {
      bundle, source_name: classified.sourceName, state: 'pending', at, resume: true,
    }), { fs: fsImpl });
    invokeMarkerFault(faultInjector, 'after-write-ahead');
    const bundleDir = path.join(quarantineRoot, bundle);
    const captured = {
      metaPath: metaPathname,
      metaIdentity,
      quarantinePath: quarantineRoot,
      quarantineIdentity,
      bundlePath: bundleDir,
      bundleIdentity: null,
      storePath: store,
      storeIdentity,
      sourcePath,
      sourceIdentity: null,
      expectSourceAbsent: true,
      reservationPath: reservation,
      reservationIdentity,
    };
    const fence = (extras = {}) => assertQuarantineFence(root, token, captured, { fs: fsImpl, ...extras });
    invokeMarkerFault(faultInjector, 'before-bundle-mkdir');
    fence({ includeReservation: true });
    fsImpl.mkdirSync(bundleDir, { recursive: false });
    captured.bundleIdentity = directoryIdentity(bundleDir, `.wiki-meta/.quarantine/${bundle}`, fsImpl);
    invokeMarkerFault(faultInjector, 'after-bundle-mkdir');
    const metaPayload = {
      schema: 1,
      quarantined_at: at,
      source_name: classified.sourceName,
      classification: {
        method: classification.method,
        estimated_entries: classification.estimated_entries ?? null,
      },
      reason,
      // The reservation rename below is this bundle's commit point, so the durable metadata must
      // not claim the pairing before it exists: an interrupted resume leaves a directly
      // inventoried bundle, and that bundle's meta is the only account of what it holds.
      paired_reservation: false,
      resume: true,
    };
    attachFollowUpMetadata(metaPayload, followUp, followUpArgv);
    invokeMarkerFault(faultInjector, 'before-meta-write');
    fence({ includeReservation: true });
    writeQuarantineMeta(
      path.join(bundleDir, 'quarantine.meta.json'), metaPayload, token, root, fsImpl,
      () => fence({ includeReservation: true }),
    );
    invokeMarkerFault(faultInjector, 'after-meta-write');
    fence({ includeReservation: true });
    invokeMarkerFault(faultInjector, 'before-rename');
    invokeMarkerFault(faultInjector, 'before-reservation-rename');
    fence({ includeReservation: true });
    const destination = path.join(bundleDir, 'reservation');
    fsImpl.renameSync(reservation, destination);
    renamed = true;
    assertRegularFileFence(destination, 'quarantine reservation', reservationIdentity, fsImpl);
    captured.movedReservationPath = destination;
    captured.movedReservationIdentity = reservationIdentity;
    captured.reservationPath = null;
    captured.reservationIdentity = null;
    fence();
    writeQuarantineMeta(
      path.join(bundleDir, 'quarantine.meta.json'),
      { ...metaPayload, paired_reservation: true },
      token, root, fsImpl, () => fence(),
    );
    writeMaintenanceMarker(root, token, (marker) => upsertQuarantineBundle(marker, {
      bundle, source_name: classified.sourceName, state: 'complete', at: canonicalUtcZ(now), resume: true,
    }), { fs: fsImpl, beforePublish: () => fence() });
    const result = { status: 'quarantined', bundle, resumed: true };
    if (followUp) result.follow_up = followUp;
    if (followUpArgv) result.follow_up_argv = followUpArgv;
    return result;
  } catch (error) {
    if (!renamed) {
      try {
        writeMaintenanceMarker(root, token, (marker) => removePendingQuarantineBundle(marker, bundle), { fs: fsImpl });
      } catch { /* pending residual is harmless */ }
    } else {
      try {
        writeMaintenanceMarker(root, token, (marker) => upsertQuarantineBundle(marker, {
          bundle, source_name: classified.sourceName, state: 'incomplete', at: canonicalUtcZ(now), resume: true,
        }), { fs: fsImpl });
      } catch { /* inventory remains the source of truth */ }
      throw attachIncompleteQuarantine(error, bundle, classified.sourceName);
    }
    throw error;
  }
}

function promoteOversizedNames(options = {}) {
  const root = options.wikiRoot;
  const token = options.token;
  const names = Array.isArray(options.names) ? options.names : [];
  const parsePruneName = options.parsePruneName;
  const classification = options.classification || { method: 'stat', estimated_entries: null };
  const reason = options.reason === 'operator' ? 'operator' : 'oversized';
  const { deadline, faultInjector } = options;
  const cap = options.limit === undefined ? QUARANTINE_PROMOTION_LIMIT : options.limit;
  const promoted = [];
  const remaining = [];
  const incomplete = [];
  const failures = [];
  const attemptedNames = [];
  let attempted = 0;
  let telemetryError = null;
  const seen = new Set();

  for (const name of names) {
    if (typeof name !== 'string' || seen.has(name)) continue;
    seen.add(name);
    if (deadline) {
      try { assertBeforeDeadline(deadline, `quarantine-promote:${name}`); }
      catch (error) {
        if (error.code === 'DEADLINE_EXCEEDED') {
          remaining.push(name);
          continue;
        }
        throw error;
      }
    }
    if (attempted >= cap || !isIsolatableStoreName(name, parsePruneName)) {
      remaining.push(name);
      continue;
    }
    attempted += 1;
    attemptedNames.push(name);
    try {
      quarantineStoreEntry({
        wikiRoot: root,
        token,
        name,
        parsePruneName,
        classification,
        reason,
        now: options.now,
        pid: options.pid,
        randomUUID: options.randomUUID,
        fs: options.fs,
        faultInjector,
      });
    } catch (error) {
      if (isCommittedIncomplete(error)) {
        incomplete.push({
          name,
          bundle: error.quarantine.bundle,
          state: 'incomplete',
          committed: true,
          code: error.code || 'QUARANTINE_INCOMPLETE',
        });
        failures.push({ name, code: error.code || 'QUARANTINE_INCOMPLETE' });
        continue;
      }
      remaining.push(name);
      failures.push({ name, code: error.code || 'PROMOTION_FAIL' });
      continue;
    }
    promoted.push(name);
    try { invokeMarkerFault(faultInjector, 'after-promote-move'); }
    catch (error) {
      telemetryError = error.message || error.code || 'PROMOTION_TELEMETRY';
    }
  }

  const result = {
    promoted,
    skipped_oversized: remaining,
    incomplete,
    failures,
    attempted,
    attempted_names: attemptedNames,
    telemetry_error: telemetryError,
  };
  if (promoted.length === 0 && remaining.length === 0 && incomplete.length === 0
      && failures.length === 0 && !telemetryError) {
    return result;
  }

  try {
    writeMaintenanceMarker(root, token, (marker) => {
      for (const name of promoted) {
        if (!marker.promoted.includes(name)) marker.promoted.push(name);
        marker.skipped_oversized = marker.skipped_oversized.filter((entry) => entry !== name);
      }
      for (const item of incomplete) {
        marker.skipped_oversized = marker.skipped_oversized.filter((entry) => entry !== item.name);
        const code = String(item.code || 'QUARANTINE_INCOMPLETE').replace(/[^A-Z_]/g, '_') || 'QUARANTINE_INCOMPLETE';
        marker.prune_failures.push({ code, at: canonicalUtcZ(options.now || new Date()) });
      }
      for (const name of remaining) {
        if (!marker.skipped_oversized.includes(name)) marker.skipped_oversized.push(name);
      }
      for (const failure of failures) {
        if (incomplete.some((item) => item.name === failure.name)) continue;
        const code = String(failure.code || 'PROMOTION_FAIL').replace(/[^A-Z_]/g, '_') || 'PROMOTION_FAIL';
        marker.prune_failures.push({ code, at: canonicalUtcZ(options.now || new Date()) });
      }
      if (telemetryError) {
        marker.prune_failures.push({
          code: 'PROMOTION_TELEMETRY',
          at: canonicalUtcZ(options.now || new Date()),
        });
      }
      return marker;
    }, { fs: options.fs });
  } catch (error) {
    telemetryError = telemetryError || error.code || error.message || 'PROMOTION_TELEMETRY';
    result.telemetry_error = telemetryError;
    try {
      writeMaintenanceMarker(root, token, (marker) => {
        marker.prune_failures.push({
          code: 'PROMOTION_TELEMETRY',
          at: canonicalUtcZ(options.now || new Date()),
        });
        return marker;
      }, { fs: options.fs });
    } catch { /* held lock; caller still sees telemetry_error */ }
  }

  return result;
}

module.exports = {
  SWEEP_RESERVE_MS,
  PRESSURE_ENTRY_CAP,
  PRESSURE_SIZE_THRESHOLD,
  PRESSURE_NLINK_THRESHOLD,
  MAINTENANCE_MARKER_MAX_BYTES,
  QUARANTINE_BUNDLE_NAME_RE,
  QUARANTINE_PROMOTION_LIMIT,
  assertTransactionStoreAnchored,
  inspectDirectoryPressure,
  resolveUnknownDirent,
  readMaintenanceMarker,
  writeMaintenanceMarker,
  upsertQuarantineBundle,
  removePendingQuarantineBundle,
  listQuarantineBundleNames,
  isIsolatableStoreName,
  promoteOversizedNames,
  quarantineStoreEntry,
  validateTombstoneV1,
  sweepTransactionDebris,
  isTransactionStoreJunkName,
  isReclaimableJunkEntry,
  followUpRecoverCommand,
  followUpRecoverArgv,
};
