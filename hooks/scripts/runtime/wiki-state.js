'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const envelope = require('../envelope.js');
const { readIndexPayload } = require('../read-index-envelope.js');
const {
  atomicWriteFile, parsePageFrontmatter, readMaybe, sha256, stateError, SHA_RE,
} = require('./fs-safe.js');
const { ISO_UTC_RE } = require('./config.js');
const { migrateAutoIngestPolicy } = require('./config-migration.js');
const { coordinateSetup } = require('./setup-authority.js');
const {
  createDeadline, assertBeforeDeadline, remainingMs, DeadlineExceeded,
} = require('./deadline.js');
const { acquireLock, assertLockOwner, releaseLock } = require('./lock.js');
const scanWindow = require('./scan-window.js');
const {
  sweepTransactionDebris, validateTombstoneV1, isReclaimableJunkEntry,
  assertTransactionStoreAnchored, quarantineStoreEntry: quarantineStoreEntryPrimitive,
  inspectDirectoryPressure, resolveUnknownDirent, readMaintenanceMarker,
  listQuarantineBundleNames, isIsolatableStoreName, promoteOversizedNames,
  QUARANTINE_PROMOTION_LIMIT,
} = require('./transaction-debris.js');

const { promotePendingScan } = scanWindow;
const ULID_RE = envelope.ULID_RE;
const PAGE_RE = /^[a-z0-9][a-z0-9-]*\.md$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const MANIFEST_KEYS = [
  'operation', 'operation_id', 'pages', 'sources', 'events', 'refresh_index',
  'promote_pending_scan',
];
const PAGE_KEYS = ['file', 'action', 'expected_sha256', 'content'];
const SOURCE_KEYS = ['slug', 'content'];
const EVENT_KEYS = [
  'event_id', 'ts', 'action', 'source', 'pages_created', 'pages_updated',
];
const OPERATIONS = new Set([
  'setup', 'ingest', 'ingest-repair', 'query-autofile', 'rebuild', 'lint',
  'inbox-cleanup', 'scan-window-promote', 'ingest-fail',
]);
const EVENT_ACTIONS = new Set([
  'setup', 'ingest', 'ingest-repair', 'query-filed', 'rebuild', 'lint',
  'inbox-cleanup', 'scan-window-promote', 'ingest-fail',
]);
const OPERATION_EVENT = Object.freeze({
  setup: 'setup',
  ingest: 'ingest',
  'ingest-repair': 'ingest-repair',
  'query-autofile': 'query-filed',
  rebuild: 'rebuild',
  lint: 'lint',
  'inbox-cleanup': 'inbox-cleanup',
  'scan-window-promote': 'scan-window-promote',
  'ingest-fail': 'ingest-fail',
});
const WIKI_WIDE = new Set(['setup', 'rebuild', 'lint']);
const TRANSITIONS = [
  'preflighted', 'journaled', 'staged', 'versions-written', 'pages-written',
  'sources-written', 'index-json-written', 'index-md-written', 'log-jsonl-written',
  'log-md-written', 'scan-window-staged', 'pending-promoted', 'committed', 'cleaned',
];
const JOURNAL_KEYS = [
  'engine', 'contract_version', 'wiki_root', 'operation_id', 'manifest_sha256',
  'manifest', 'owner_token', 'transitions', 'artifacts', 'artifacts_sha256',
  'event_ids', 'scan_window_journal', 'result', 'result_sha256',
];
const JOURNAL_KEYS_V2 = [
  ...JOURNAL_KEYS, 'catalog_seal', 'catalog_seal_sha256', 'catalog_seal_cursor', 'verify_stage_cursor',
];
const CATALOG_SEAL_KEYS = ['relative_path', 'sha256'];
const SCAN_YIELD_MARGIN_MS = 250;
const RECEIPT_KEYS = [
  'contract_version', 'operation_id', 'manifest_sha256', 'result', 'result_sha256',
];
const SETUP_INTENT_KEYS = [
  'contract_version', 'wiki_root', 'manifest_sha256', 'manifest',
];

function hasExactKeys(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function canonicalTimestamp(value, label) {
  if (typeof value !== 'string' || !ISO_UTC_RE.test(value)) {
    throw stateError('MANIFEST_INVALID', `${label} must be canonical UTC-Z`);
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().replace('.000Z', 'Z') !== value) {
    throw stateError('MANIFEST_INVALID', `${label} must be a real canonical UTC-Z timestamp`);
  }
  return value;
}

function physicalRoot(wikiRoot) {
  if (typeof wikiRoot !== 'string' || !path.isAbsolute(wikiRoot)) {
    throw stateError('WIKI_STATE_INVALID', 'wikiRoot must be absolute');
  }
  try { return fs.realpathSync.native(wikiRoot); }
  catch (cause) { throw stateError('WIKI_STATE_FILESYSTEM', 'wiki root is unavailable', cause); }
}

function ensureDirectory(directory) {
  try {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw stateError('WIKI_STATE_FILESYSTEM', `${directory} must be a physical directory`);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    fs.mkdirSync(directory);
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw stateError('WIKI_STATE_FILESYSTEM', `${directory} was not created as a physical directory`);
    }
  }
}

function invokeFault(faultInjector, boundary) {
  if (typeof faultInjector === 'function') faultInjector(boundary);
}

function descriptor(bytes) {
  if (bytes === null) return { exists: false, bytes_base64: null, sha256: null };
  const value = Buffer.from(bytes);
  return { exists: true, bytes_base64: value.toString('base64'), sha256: sha256(value) };
}

function descriptorBytes(value) {
  if (!hasExactKeys(value, ['exists', 'bytes_base64', 'sha256'])) {
    throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'artifact descriptor is malformed');
  }
  if (value.exists === false) {
    if (value.bytes_base64 !== null || value.sha256 !== null) {
      throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'absent artifact descriptor carries bytes');
    }
    return null;
  }
  if (value.exists !== true || typeof value.bytes_base64 !== 'string'
      || typeof value.sha256 !== 'string' || !SHA_RE.test(value.sha256)) {
    throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'artifact descriptor is malformed');
  }
  const bytes = Buffer.from(value.bytes_base64, 'base64');
  if (bytes.toString('base64') !== value.bytes_base64 || sha256(bytes) !== value.sha256) {
    throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'artifact descriptor bytes do not match their hash');
  }
  return bytes;
}

function bytesEqual(left, right) {
  if (left === null || right === null) return left === right;
  return Buffer.from(left).equals(Buffer.from(right));
}

function operationDeadline(options = {}) {
  return options.deadline || createDeadline({ budgetMs: 12_000 });
}

function validateManifestSchema(input) {
  if (!hasExactKeys(input, MANIFEST_KEYS) || !OPERATIONS.has(input.operation)
      || !ULID_RE.test(input.operation_id) || !Array.isArray(input.pages)
      || !Array.isArray(input.sources) || !Array.isArray(input.events)
      || input.refresh_index !== true
      || !(input.promote_pending_scan === null || typeof input.promote_pending_scan === 'string')) {
    throw stateError('MANIFEST_INVALID', 'manifest schema or keys are invalid');
  }
  if (input.promote_pending_scan !== null) {
    canonicalTimestamp(input.promote_pending_scan, 'promote_pending_scan');
  }
  if (WIKI_WIDE.has(input.operation) && input.events.length !== 1) {
    throw stateError('MANIFEST_INVALID', 'wiki-wide operations require exactly one event');
  }
  if (['rebuild', 'lint'].includes(input.operation)
      && (input.pages.length !== 0 || input.sources.length !== 0)) {
    throw stateError('MANIFEST_INVALID', `${input.operation} cannot carry page or source mutations`);
  }
  if (input.operation === 'ingest-fail') {
    if (input.pages.length !== 0 || input.sources.length !== 1 || input.events.length !== 1
        || input.promote_pending_scan === null) {
      throw stateError('MANIFEST_INVALID', 'ingest-fail requires one source/event, no pages, and pending promotion');
    }
  }
  if (input.operation === 'scan-window-promote'
      && (input.pages.length !== 0 || input.sources.length !== 0
        || input.events.length !== 1 || input.promote_pending_scan === null)) {
    throw stateError('MANIFEST_INVALID', 'scan-window-promote requires one event and no content mutations');
  }
  const pageFiles = new Set();
  for (const page of input.pages) {
    if (!hasExactKeys(page, PAGE_KEYS) || !PAGE_RE.test(page.file)
        || !['create', 'update'].includes(page.action) || typeof page.content !== 'string'
        || !(page.expected_sha256 === null || (typeof page.expected_sha256 === 'string' && SHA_RE.test(page.expected_sha256)))) {
      throw stateError('MANIFEST_INVALID', 'page entry schema, basename, or action is invalid');
    }
    if (pageFiles.has(page.file)) throw stateError('MANIFEST_INVALID', 'duplicate page entry');
    if ((page.action === 'create') !== (page.expected_sha256 === null)) {
      throw stateError('MANIFEST_INVALID', 'create requires null expected hash and update requires a hash');
    }
    pageFiles.add(page.file);
  }
  const sourceSlugs = new Set();
  for (const source of input.sources) {
    if (!hasExactKeys(source, SOURCE_KEYS) || !SLUG_RE.test(source.slug) || typeof source.content !== 'string') {
      throw stateError('MANIFEST_INVALID', 'source entry schema or slug is invalid');
    }
    if (sourceSlugs.has(source.slug)) throw stateError('MANIFEST_INVALID', 'duplicate source entry');
    sourceSlugs.add(source.slug);
  }
  const eventIds = new Set();
  const eventSources = new Set();
  const created = [];
  const updated = [];
  for (const event of input.events) {
    if (!hasExactKeys(event, EVENT_KEYS) || !ULID_RE.test(event.event_id)
        || !EVENT_ACTIONS.has(event.action) || !Array.isArray(event.pages_created)
        || !Array.isArray(event.pages_updated)) {
      throw stateError('MANIFEST_INVALID', 'event schema, action, or event id is invalid');
    }
    canonicalTimestamp(event.ts, 'event timestamp');
    if (event.action !== OPERATION_EVENT[input.operation]) {
      throw stateError('MANIFEST_INVALID', 'event action does not match manifest operation');
    }
    if (eventIds.has(event.event_id)) throw stateError('MANIFEST_INVALID', 'duplicate event id');
    eventIds.add(event.event_id);
    const wikiWide = WIKI_WIDE.has(event.action);
    if ((wikiWide && event.source !== null)
        || (!wikiWide && (typeof event.source !== 'string' || !SLUG_RE.test(event.source)))) {
      throw stateError('MANIFEST_INVALID', 'event source does not match action scope');
    }
    if (event.source !== null) {
      if (eventSources.has(event.source)) throw stateError('MANIFEST_INVALID', 'duplicate source event');
      eventSources.add(event.source);
    }
    for (const file of [...event.pages_created, ...event.pages_updated]) {
      if (!PAGE_RE.test(file)) throw stateError('MANIFEST_INVALID', 'event page basename is invalid');
    }
    created.push(...event.pages_created);
    updated.push(...event.pages_updated);
  }
  for (const source of sourceSlugs) {
    if (['ingest', 'ingest-repair'].includes(input.operation) && !eventSources.has(source)) {
      throw stateError('MANIFEST_INVALID', 'every supplied source requires exactly one source event');
    }
  }
  if (input.operation === 'ingest-fail'
      && (!eventSources.has(input.sources[0].slug) || eventSources.size !== 1)) {
    throw stateError('MANIFEST_INVALID', 'ingest-fail source and event must match');
  }
  const expectedCreated = input.pages.filter((page) => page.action === 'create').map((page) => page.file).sort();
  const expectedUpdated = input.pages.filter((page) => page.action === 'update').map((page) => page.file).sort();
  if (new Set(created).size !== created.length || new Set(updated).size !== updated.length
      || JSON.stringify([...created].sort()) !== JSON.stringify(expectedCreated)
      || JSON.stringify([...updated].sort()) !== JSON.stringify(expectedUpdated)) {
    throw stateError('MANIFEST_INVALID', 'event page lists do not match create/update entries');
  }
  return structuredClone(input);
}

function transactionPaths(root, operationId) {
  const meta = path.join(root, '.wiki-meta');
  const transactions = path.join(meta, '.transactions');
  const transaction = path.join(transactions, operationId);
  return {
    meta, transactions, transaction,
    receipts: path.join(meta, '.transaction-receipts'),
    receipt: path.join(meta, '.transaction-receipts', `${operationId}.json`),
    before: path.join(transaction, 'before'),
    after: path.join(transaction, 'after'),
    journal: path.join(transaction, 'journal.json'),
    tombstone: path.join(transaction, 'cancelled.json'),
  };
}

function readJournal(file) {
  const bytes = readMaybe(file);
  if (bytes === null) return null;
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (cause) { throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'wiki-state journal is unreadable', cause); }
}

function readReceipt(locations, manifestHash) {
  const bytes = readMaybe(locations.receipt);
  if (bytes === null) return null;
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); }
  catch (cause) { throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'transaction receipt is unreadable', cause); }
  if (!hasExactKeys(receipt, RECEIPT_KEYS) || receipt.contract_version !== 1
      || receipt.operation_id !== path.basename(locations.receipt, '.json')
      || typeof receipt.manifest_sha256 !== 'string' || !SHA_RE.test(receipt.manifest_sha256)
      || !receipt.result || typeof receipt.result !== 'object' || Array.isArray(receipt.result)
      || typeof receipt.result_sha256 !== 'string' || !SHA_RE.test(receipt.result_sha256)
      || sha256(Buffer.from(JSON.stringify(receipt.result))) !== receipt.result_sha256) {
    throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'transaction receipt seal is invalid');
  }
  if (receipt.manifest_sha256 !== manifestHash) {
    throw stateError('OPERATION_ID_COLLISION', 'operation id belongs to a different manifest');
  }
  return receipt;
}

function assertTransactionNotOversized(root, name, options = {}) {
  const pathname = path.join(root, '.wiki-meta', '.transactions', name);
  const pressure = (options.inspectDirectoryPressure || inspectDirectoryPressure)(pathname, {
    deadline: options.deadline,
    allowEnumeration: false,
  });
  if (!pressure.oversized) return pressure;
  const error = stateError('TRANSACTION_OVERSIZED', `transaction directory ${name} is oversized`);
  error.operationId = name;
  error.estimatedEntries = pressure.estimatedEntries;
  error.method = pressure.method;
  error.wikiRoot = root;
  throw error;
}

function compactReceiptTransaction(root, token, locations, receipt) {
  if (!fs.existsSync(locations.transaction)) return;
  assertTransactionNotOversized(root, path.basename(locations.transaction));
  assertTransactionStoreAnchored(root);
  const journal = readJournal(locations.journal);
  if (!journal) {
    assertLockOwner({ wikiRoot: root, token });
    fs.rmSync(locations.transaction, { recursive: true, force: true });
    assertLockOwner({ wikiRoot: root, token });
    return;
  }
  if (journal.engine !== 'wiki-state'
      || journal.manifest_sha256 !== receipt.manifest_sha256
      || !journal.transitions?.includes('cleaned')) {
    throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'receipt has a nonterminal transaction directory');
  }
  assertLockOwner({ wikiRoot: root, token });
  fs.rmSync(locations.transaction, { recursive: true, force: true });
  assertLockOwner({ wikiRoot: root, token });
}

function inspectTransactions(root, allowedOperationId = null, deadline = operationDeadline()) {
  const directory = path.join(root, '.wiki-meta', '.transactions');
  // Readers are lock-free and never mutate, but `readdirSync` still follows a symlinked store, and
  // the junk skip below would let an escaped store pass inspection outright. Proving the anchor is
  // itself read-only, so it costs the reader nothing it is not allowed to do.
  assertTransactionStoreAnchored(root);
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const entry of entries) {
    assertBeforeDeadline(deadline, `wiki-state:inspect-transaction:${entry.name}`);
    let kind;
    if (entry.isSymbolicLink()) kind = 'symlink';
    else if (entry.isDirectory()) kind = 'directory';
    else if (!entry.isFile() && !entry.isBlockDevice() && !entry.isCharacterDevice()
        && !entry.isFIFO() && !entry.isSocket()) {
      kind = resolveUnknownDirent(directory, entry).kind;
    } else kind = 'other';
    if (kind === 'directory' && entry.name.startsWith('.activate-')) continue;
    if (kind !== 'directory') {
      // Recognized OS/sync-client metadata is inert debris, not lost transaction state. Readers
      // run lock-free and cannot remove it; the lock-held debris sweep reclaims it.
      if (isReclaimableJunkEntry(entry, directory)) continue;
      throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'transaction store contains a non-directory entry');
    }
    const transaction = path.join(directory, entry.name);
    if (entry.name.startsWith('.prune-')) {
      const prunePressure = inspectDirectoryPressure(transaction, {
        deadline,
        allowEnumeration: false,
      });
      if (prunePressure.oversized) {
        const error = stateError('TRANSACTION_OVERSIZED', `transaction directory ${entry.name} is oversized`);
        error.operationId = entry.name;
        error.estimatedEntries = prunePressure.estimatedEntries;
        error.method = prunePressure.method;
        error.wikiRoot = root;
        throw error;
      }
      const pruneNames = entries
        .filter((candidate) => candidate.name.startsWith('.prune-') && candidate.isDirectory())
        .map((candidate) => candidate.name)
        .sort();
      throw stateError(
        'TRANSACTION_RECOVERY_REQUIRED',
        'a terminal scan-window prune quarantine requires recovery '
          + `(${pruneNames.length} .prune-* entries; first: ${pruneNames[0] || entry.name}); `
          + 'run wiki-lint --fix, and if it makes no progress stop all hosts and follow the stopped-host procedure',
      );
    }
    const livePressure = inspectDirectoryPressure(transaction, {
      deadline,
      allowEnumeration: true,
    });
    if (livePressure.oversized) {
      const error = stateError('TRANSACTION_OVERSIZED', `transaction directory ${entry.name} is oversized`);
      error.operationId = entry.name;
      error.estimatedEntries = livePressure.estimatedEntries;
      error.method = livePressure.method;
      error.wikiRoot = root;
      throw error;
    }
    const journalPath = path.join(transaction, 'journal.json');
    let journal;
    try { journal = readJournal(journalPath); }
    catch (error) {
      if (error.code === 'DEADLINE_EXCEEDED' || error.code === 'TRANSACTION_RECOVERY_REQUIRED') throw error;
      throw stateError(
        'TRANSACTION_RECOVERY_REQUIRED',
        `transaction journal is unreadable at ${journalPath}; `
          + 'stop all hosts, restore filesystem readability, then rerun snapshot before recovery',
        error,
      );
    }
    if (!journal) {
      const tombstoneBytes = readMaybe(path.join(transaction, 'cancelled.json'));
      if (tombstoneBytes === null) continue;
      const verdict = validateTombstoneV1(tombstoneBytes, entry.name);
      if (!verdict.valid) throw verdict.error;
      if (entry.name !== allowedOperationId) {
        throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'a cancelled transaction requires teardown');
      }
      continue;
    }
    const terminal = journal.engine === 'wiki-state'
      ? journal.transitions?.includes('committed')
      : journal.transitions?.includes('scan-window-committed');
    if (!terminal && entry.name !== allowedOperationId) {
      throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'a nonterminal wiki-state transaction requires recovery');
    }
  }
}

function parseLog(bytes, deadline = operationDeadline()) {
  if (bytes === null || bytes.length === 0) return [];
  const rows = [];
  for (const line of bytes.toString('utf8').split('\n')) {
    assertBeforeDeadline(deadline, `wiki-state:parse-log:${rows.length + 1}`);
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); }
    catch (cause) { throw stateError('WIKI_STATE_INVALID', 'log.jsonl contains invalid JSON', cause); }
  }
  return rows;
}

function readDirectoryFiles(directory, suffix = null, deadline = operationDeadline()) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return new Map(); throw error; }
  const result = new Map();
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  for (const entry of entries) {
    assertBeforeDeadline(deadline, `wiki-state:read-directory:${entry.name}`);
    if (isReclaimableJunkEntry(entry, directory)) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) {
      throw stateError('WIKI_STATE_FILESYSTEM', `${directory} contains a non-regular entry`);
    }
    if (suffix && !entry.name.endsWith(suffix)) continue;
    result.set(entry.name, fs.readFileSync(path.join(directory, entry.name)));
  }
  return result;
}

function indexArtifacts(finalPages, manifest, root, now, deadline) {
  const pages = [...finalPages.entries()].sort(([left], [right]) => left.localeCompare(right, 'en'))
    .map(([file, bytes]) => {
      assertBeforeDeadline(deadline, `wiki-state:index-page:${file}`);
      const frontmatter = parsePageFrontmatter(bytes);
      if (typeof frontmatter.title !== 'string' || !Array.isArray(frontmatter.sources)) {
        throw stateError('MANIFEST_INVALID', `page ${file} requires title and sources frontmatter`);
      }
      return {
        file,
        title: frontmatter.title,
        tags: Array.isArray(frontmatter.tags) ? frontmatter.tags : [],
        aliases: Array.isArray(frontmatter.aliases) ? frontmatter.aliases : [],
      };
    });
  const generatedAt = manifest.events.map((event) => event.ts).sort().at(-1)
    || now.toISOString().replace('.000Z', 'Z');
  const payload = { pages, generated_at: generatedAt };
  const wrapped = envelope.wrapEnvelope({
    artifactKind: 'index', payload, runId: manifest.operation_id,
    generatedAt, git: envelope.detectGit(root),
    sourceArtifacts: pages.map((page) => ({ path: `pages/${page.file}` })),
  });
  const json = Buffer.from(`${JSON.stringify(wrapped, null, 2)}\n`);
  const markdown = Buffer.from([
    '# Wiki Index', '',
    ...pages.map((page) => `- [${page.title}](pages/${page.file})`),
    '', `Generated: ${generatedAt}`, '',
  ].join('\n'));
  return { json, markdown };
}

function logArtifacts(beforeJson, beforeMarkdown, events, deadline) {
  const rows = parseLog(beforeJson, deadline);
  const finalRows = [...rows, ...events];
  const json = Buffer.from(finalRows.map((row) => JSON.stringify(row)).join('\n') + (finalRows.length ? '\n' : ''));
  let markdown = beforeMarkdown === null ? '# Wiki Log\n' : beforeMarkdown.toString('utf8');
  if (markdown && !markdown.endsWith('\n')) markdown += '\n';
  for (const event of events) {
    assertBeforeDeadline(deadline, `wiki-state:log-event:${event.event_id}`);
    markdown += [
      '', `<!-- deep-wiki:event:${event.event_id} -->`,
      `## ${event.ts} — ${event.action}`,
      `- Source: ${event.source === null ? '(wiki)' : event.source}`,
      `- Created: ${event.pages_created.join(', ') || '(none)'}`,
      `- Updated: ${event.pages_updated.join(', ') || '(none)'}`, '',
    ].join('\n');
  }
  return { json, markdown: Buffer.from(markdown) };
}

function artifact(key, phase, relativePath, before, after) {
  return {
    key, phase, relative_path: relativePath,
    before: descriptor(before), after: descriptor(after),
  };
}

function buildPlan(root, manifest, now, deadline) {
  const pageDirectory = path.join(root, 'pages');
  const sourceDirectory = path.join(root, '.wiki-meta', 'sources');
  const versionDirectory = path.join(root, '.wiki-meta', '.versions');
  const existingPages = readDirectoryFiles(pageDirectory, '.md', deadline);
  const existingSources = readDirectoryFiles(sourceDirectory, '.yaml', deadline);
  const existingVersions = readDirectoryFiles(versionDirectory, '.md', deadline);
  const finalPages = new Map(existingPages);
  const finalSources = new Map(existingSources);
  const artifacts = [];
  const catalogSeal = [];

  const beforeLogJson = readMaybe(path.join(root, 'log.jsonl'));
  const beforeLogMd = readMaybe(path.join(root, 'log.md'));
  const priorEvents = parseLog(beforeLogJson, deadline);
  const priorEventIds = new Set(priorEvents.map((row) => row.event_id).filter(Boolean));
  const priorCreated = new Set(priorEvents.flatMap((row) => Array.isArray(row.pages_created) ? row.pages_created : []));
  for (const event of manifest.events) {
    if (priorEventIds.has(event.event_id)) throw stateError('EVENT_ALREADY_EXISTS', 'event id must be exactly-once');
    const priorMarker = `<!-- deep-wiki:event:${event.event_id} -->`;
    if (beforeLogMd !== null && beforeLogMd.toString('utf8').includes(priorMarker)) {
      throw stateError('EVENT_ALREADY_EXISTS', 'event id already exists in Markdown log');
    }
    for (const file of event.pages_created) {
      if (priorCreated.has(file)) throw stateError('PAGE_ALREADY_CREATED', 'pages_created is exactly-once across log history');
    }
  }

  for (const entry of manifest.pages) {
    const before = existingPages.get(entry.file) || null;
    if (entry.action === 'create' && before !== null) {
      throw stateError('EXPECTED_HASH_CONFLICT', `create target already exists: ${entry.file}`);
    }
    if (entry.action === 'update' && (before === null || sha256(before) !== entry.expected_sha256)) {
      throw stateError('EXPECTED_HASH_CONFLICT', `expected hash differs for ${entry.file}`);
    }
    const after = Buffer.from(entry.content);
    finalPages.set(entry.file, after);
    artifacts.push(artifact(`page-${entry.file}`, 'pages', `pages/${entry.file}`, before, after));

    if (entry.action === 'update') {
      const stem = entry.file.slice(0, -3);
      const versions = [...existingVersions.keys()]
        .map((file) => ({ file, match: file.match(new RegExp(`^${stem}\\.v(\\d+)\\.md$`)) }))
        .filter((item) => item.match)
        .map((item) => ({ file: item.file, number: Number(item.match[1]) }))
        .sort((left, right) => left.number - right.number);
      const next = (versions.at(-1)?.number || 0) + 1;
      const nextFile = `${stem}.v${next}.md`;
      artifacts.push(artifact(`version-${nextFile}`, 'versions', `.wiki-meta/.versions/${nextFile}`, null, before));
      versions.push({ file: nextFile, number: next });
      while (versions.length > 3) {
        const removed = versions.shift();
        const removedBytes = existingVersions.get(removed.file) || null;
        artifacts.push(artifact(
          `version-prune-${removed.file}`, 'versions', `.wiki-meta/.versions/${removed.file}`,
          removedBytes, null,
        ));
      }
    }
  }

  for (const entry of manifest.sources) {
    const file = `${entry.slug}.yaml`;
    const before = existingSources.get(file) || null;
    const after = Buffer.from(entry.content);
    finalSources.set(file, after);
    artifacts.push(artifact(`source-${entry.slug}`, 'sources', `.wiki-meta/sources/${file}`, before, after));
  }

  if (manifest.operation === 'lint') {
    const groups = new Map();
    for (const [file, bytes] of existingVersions) {
      const match = file.match(/^(.*)\.v(\d+)\.md$/);
      if (!match) continue;
      const entries = groups.get(match[1]) || [];
      entries.push({ file, number: Number(match[2]), bytes });
      groups.set(match[1], entries);
    }
    for (const entries of groups.values()) {
      entries.sort((left, right) => left.number - right.number);
      while (entries.length > 3) {
        const removed = entries.shift();
        artifacts.push(artifact(
          `version-prune-${removed.file}`, 'versions', `.wiki-meta/.versions/${removed.file}`,
          removed.bytes, null,
        ));
      }
    }
  }

  const availableSources = new Set([...finalSources.keys()].map((file) => file.slice(0, -5)));
  for (const [file, bytes] of finalPages) {
    assertBeforeDeadline(deadline, `wiki-state:validate-page:${file}`);
    const frontmatter = parsePageFrontmatter(bytes);
    if (!Array.isArray(frontmatter.sources) || frontmatter.sources.some((slug) => !availableSources.has(slug))) {
      throw stateError('MANIFEST_INVALID', `page/source correspondence failed for ${file}`);
    }
  }

  const represented = new Set(artifacts.map((item) => item.relative_path));
  const sealUnchanged = (entries, prefix) => {
    for (const [file, bytes] of entries) {
      assertBeforeDeadline(deadline, `wiki-state:seal:${prefix}${file}`);
      const relative = `${prefix}${file}`;
      if (!represented.has(relative)) {
        catalogSeal.push({ relative_path: relative, sha256: sha256(bytes) });
        represented.add(relative);
      }
    }
  };
  sealUnchanged(existingVersions, '.wiki-meta/.versions/');
  sealUnchanged(existingPages, 'pages/');
  sealUnchanged(existingSources, '.wiki-meta/sources/');

  const indexes = indexArtifacts(finalPages, manifest, root, now, deadline);
  artifacts.push(artifact(
    'index-json', 'index-json', '.wiki-meta/index.json',
    readMaybe(path.join(root, '.wiki-meta', 'index.json')), indexes.json,
  ));
  artifacts.push(artifact(
    'index-md', 'index-md', 'index.md', readMaybe(path.join(root, 'index.md')), indexes.markdown,
  ));
  const logs = logArtifacts(beforeLogJson, beforeLogMd, manifest.events, deadline);
  artifacts.push(artifact('log-jsonl', 'log-jsonl', 'log.jsonl', beforeLogJson, logs.json));
  artifacts.push(artifact('log-md', 'log-md', 'log.md', beforeLogMd, logs.markdown));
  return { artifacts, catalogSeal };
}

function validJournalRelativePath(relativePath) {
  return typeof relativePath === 'string' && !path.isAbsolute(relativePath)
    && !relativePath.split('/').includes('..');
}

function validateJournal(journal, root, operationId, manifestHash) {
  const legacyShape = journal?.contract_version === 1 && hasExactKeys(journal, JOURNAL_KEYS);
  const currentShape = journal?.contract_version === 2 && hasExactKeys(journal, JOURNAL_KEYS_V2);
  if ((!legacyShape && !currentShape)
      || journal.engine !== 'wiki-state'
      || journal.wiki_root !== root || journal.operation_id !== operationId
      || typeof journal.manifest_sha256 !== 'string' || !SHA_RE.test(journal.manifest_sha256)
      || typeof journal.artifacts_sha256 !== 'string' || !SHA_RE.test(journal.artifacts_sha256)
      || typeof journal.result_sha256 !== 'string' || !SHA_RE.test(journal.result_sha256)
      || !journal.manifest || typeof journal.manifest !== 'object' || Array.isArray(journal.manifest)
      || !Array.isArray(journal.transitions) || !Array.isArray(journal.artifacts)
      || !Array.isArray(journal.event_ids)
      || !journal.result || typeof journal.result !== 'object' || Array.isArray(journal.result)) {
    throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'wiki-state journal is malformed');
  }
  if (journal.manifest_sha256 !== manifestHash) {
    throw stateError('OPERATION_ID_COLLISION', 'operation id belongs to a different manifest');
  }
  if (sha256(Buffer.from(JSON.stringify(journal.manifest))) !== journal.manifest_sha256) {
    throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'journal manifest seal is invalid');
  }
  if (sha256(Buffer.from(JSON.stringify(journal.artifacts))) !== journal.artifacts_sha256) {
    throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'journal artifact seal is invalid');
  }
  if (sha256(Buffer.from(JSON.stringify(journal.result))) !== journal.result_sha256) {
    throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'journal result seal is invalid');
  }
  let prior = -1;
  for (const transition of journal.transitions) {
    const rank = TRANSITIONS.indexOf(transition);
    if (rank <= prior) throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'journal transitions are out of order');
    prior = rank;
  }
  for (const item of journal.artifacts) {
    if (typeof item.key !== 'string' || typeof item.phase !== 'string'
        || !validJournalRelativePath(item.relative_path)) {
      throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'journal artifact path is invalid');
    }
    descriptorBytes(item.before);
    descriptorBytes(item.after);
  }
  if (currentShape) {
    if (!Array.isArray(journal.catalog_seal)
        || typeof journal.catalog_seal_sha256 !== 'string'
        || !SHA_RE.test(journal.catalog_seal_sha256)
        || sha256(Buffer.from(JSON.stringify(journal.catalog_seal))) !== journal.catalog_seal_sha256
        || !Number.isInteger(journal.catalog_seal_cursor)
        || journal.catalog_seal_cursor < 0
        || journal.catalog_seal_cursor > journal.catalog_seal.length
        || !Number.isInteger(journal.verify_stage_cursor)
        || journal.verify_stage_cursor < 0
        || journal.verify_stage_cursor > journal.artifacts.length) {
      throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'journal catalog seal is malformed');
    }
    const artifactPaths = new Set(journal.artifacts.map((item) => item.relative_path));
    const sealPaths = new Set();
    for (const entry of journal.catalog_seal) {
      if (!hasExactKeys(entry, CATALOG_SEAL_KEYS)
          || !validJournalRelativePath(entry.relative_path)
          || typeof entry.sha256 !== 'string' || !SHA_RE.test(entry.sha256)
          || sealPaths.has(entry.relative_path) || artifactPaths.has(entry.relative_path)) {
        throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'journal catalog seal entry is invalid');
      }
      sealPaths.add(entry.relative_path);
    }
  }
  return journal;
}

function persistJournal(root, token, locations, journal, faultInjector, boundary) {
  invokeFault(faultInjector, `before-${boundary}`);
  const assertOwner = () => assertLockOwner({ wikiRoot: root, token });
  assertOwner();
  atomicWriteFile(locations.journal, `${JSON.stringify(journal)}\n`, {
    createParent: false, beforeRename: assertOwner, beforePublish: assertOwner,
  });
  assertOwner();
  invokeFault(faultInjector, `after-${boundary}`);
}

function appendTransition(root, token, locations, journal, transition, faultInjector) {
  if (journal.transitions.includes(transition)) return;
  const expected = TRANSITIONS.indexOf(journal.transitions.at(-1)) + 1;
  if (TRANSITIONS[expected] !== transition) {
    throw stateError('TRANSACTION_RECOVERY_REQUIRED', `cannot advance journal to ${transition}`);
  }
  journal.transitions.push(transition);
  try { persistJournal(root, token, locations, journal, faultInjector, `transition-${transition}`); }
  catch (error) {
    if (!readJournal(locations.journal)?.transitions?.includes(transition)) journal.transitions.pop();
    throw error;
  }
}

function stageTransaction(root, token, locations, journal, faultInjector, deadline) {
  assertLockOwner({ wikiRoot: root, token });
  ensureDirectory(locations.transactions);
  ensureDirectory(locations.transaction);
  ensureDirectory(locations.before);
  ensureDirectory(locations.after);
  appendTransition(root, token, locations, journal, 'journaled', faultInjector);
  journal.artifacts.forEach((item, index) => {
    assertBeforeDeadline(deadline, `wiki-state:stage:${item.key}`);
    for (const side of ['before', 'after']) {
      const staged = Buffer.from(`${JSON.stringify(item[side])}\n`);
      const destination = path.join(locations[side], `${String(index).padStart(4, '0')}.json`);
      const existing = readMaybe(destination);
      if (existing) {
        if (!existing.equals(staged)) {
          throw stateError('TRANSACTION_RECOVERY_REQUIRED', `staged ${side} bytes are corrupt for ${item.key}`);
        }
        continue;
      }
      invokeFault(faultInjector, `before-stage-${index}-${side}`);
      const assertOwner = () => assertLockOwner({ wikiRoot: root, token });
      assertOwner();
      atomicWriteFile(destination, staged, {
        createParent: false, beforeRename: assertOwner, beforePublish: assertOwner,
      });
      invokeFault(faultInjector, `after-stage-${index}-${side}`);
    }
  });
  appendTransition(root, token, locations, journal, 'staged', faultInjector);
}

function prepareTransaction(root, token, locations, journal, faultInjector, deadline) {
  assertLockOwner({ wikiRoot: root, token });
  // The debris sweep's anchor expires when the sweep returns, so creation re-proves it here: the
  // lock says who may write, never where, and `ensureDirectory` alone would happily build the
  // store inside a `.wiki-meta` that became a symlink after the sweep.
  invokeFault(faultInjector, 'precreate-transaction-store');
  assertTransactionStoreAnchored(root);
  ensureDirectory(locations.transactions);
  invokeFault(faultInjector, 'postcreate-transaction-store');
  assertTransactionStoreAnchored(root);
  const activation = path.join(
    locations.transactions,
    `.activate-${process.pid}-${crypto.randomUUID()}`,
  );
  assertLockOwner({ wikiRoot: root, token });
  fs.mkdirSync(activation);
  const activationLocations = {
    ...locations,
    transaction: activation,
    before: path.join(activation, 'before'),
    after: path.join(activation, 'after'),
    journal: path.join(activation, 'journal.json'),
  };
  const assertOwner = () => assertLockOwner({ wikiRoot: root, token });
  assertOwner();
  ensureDirectory(activationLocations.before);
  assertOwner();
  ensureDirectory(activationLocations.after);
  assertOwner();
  atomicWriteFile(activationLocations.journal, `${JSON.stringify(journal)}\n`, {
    createParent: false, beforeRename: assertOwner, beforePublish: assertOwner,
  });
  assertOwner();
  invokeFault(faultInjector, 'before-transaction-activate');
  assertOwner();
  assertTransactionStoreAnchored(root);
  fs.renameSync(activation, locations.transaction);
  invokeFault(faultInjector, 'after-transaction-activate');
  assertOwner();
  stageTransaction(root, token, locations, journal, faultInjector, deadline);
}

function verifyStages(root, token, locations, journal, faultInjector, deadline) {
  if (journal.contract_version !== 2) {
    journal.artifacts.forEach((item, index) => {
      assertBeforeDeadline(deadline, `wiki-state:verify-stage:${item.key}`);
      for (const side of ['before', 'after']) {
        const expected = Buffer.from(`${JSON.stringify(item[side])}\n`);
        const actual = readMaybe(path.join(locations[side], `${String(index).padStart(4, '0')}.json`));
        if (!actual || !actual.equals(expected)) {
          throw stateError('TRANSACTION_RECOVERY_REQUIRED', `staged ${side} bytes are corrupt for ${item.key}`);
        }
      }
    });
    return;
  }
  const initialCursor = journal.verify_stage_cursor;
  while (journal.verify_stage_cursor < journal.artifacts.length) {
    const index = journal.verify_stage_cursor;
    const item = journal.artifacts[index];
    invokeFault(faultInjector, `verify-stage-scan:${item.key}`);
    if (remainingMs(deadline) < SCAN_YIELD_MARGIN_MS) {
      if (journal.verify_stage_cursor !== initialCursor) {
        persistJournal(
          root, token, locations, journal, faultInjector,
          `verify-stage-cursor-${journal.verify_stage_cursor}`,
        );
      }
      throw new DeadlineExceeded(`wiki-state:verify-stage:${item.key}`);
    }
    for (const side of ['before', 'after']) {
      const expected = Buffer.from(`${JSON.stringify(item[side])}\n`);
      const actual = readMaybe(path.join(locations[side], `${String(index).padStart(4, '0')}.json`));
      if (!actual || !actual.equals(expected)) {
        throw stateError('TRANSACTION_RECOVERY_REQUIRED', `staged ${side} bytes are corrupt for ${item.key}`);
      }
    }
    journal.verify_stage_cursor += 1;
  }
  if (journal.verify_stage_cursor !== initialCursor) {
    persistJournal(
      root, token, locations, journal, faultInjector,
      `verify-stage-cursor-${journal.verify_stage_cursor}`,
    );
  }
}

function publishArtifact(root, token, item, faultInjector) {
  const destination = path.join(root, ...item.relative_path.split('/'));
  const before = descriptorBytes(item.before);
  const after = descriptorBytes(item.after);
  const current = readMaybe(destination);
  if (bytesEqual(current, after)) return;
  if (!bytesEqual(current, before)) {
    throw stateError('TRANSACTION_RECOVERY_REQUIRED', `destination diverged for ${item.key}`);
  }
  invokeFault(faultInjector, `before-publish-${item.key}`);
  const assertOwner = () => assertLockOwner({ wikiRoot: root, token });
  assertOwner();
  if (after === null) {
    fs.rmSync(destination, { force: true });
  } else {
    ensureDirectory(path.dirname(destination));
    atomicWriteFile(destination, after, { beforeRename: assertOwner, beforePublish: assertOwner });
  }
  assertOwner();
  invokeFault(faultInjector, `after-publish-${item.key}`);
}

function publishPhase(root, token, locations, journal, phase, transition, faultInjector, deadline) {
  if (!journal.transitions.includes(transition)) {
    for (const item of journal.artifacts.filter((candidate) => candidate.phase === phase)) {
      assertBeforeDeadline(deadline, `wiki-state:publish:${phase}:${item.key}`);
      publishArtifact(root, token, item, faultInjector);
    }
    appendTransition(root, token, locations, journal, transition, faultInjector);
  }
}

function scanJournalAdapter(root, token, locations, outer, faultInjector) {
  const scanStage = (name) => path.join(locations.transaction, `scan-${name}.json`);
  return {
    readJournal() { return outer.scan_window_journal ? structuredClone(outer.scan_window_journal) : null; },
    writeJournal(value, assertOwner) {
      assertOwner();
      outer.scan_window_journal = structuredClone(value);
      persistJournal(root, token, locations, outer, faultInjector, 'scan-window-journal');
    },
    readStage(name) { return readMaybe(scanStage(name)); },
    writeStage(name, bytes, assertOwner) {
      assertOwner();
      atomicWriteFile(scanStage(name), bytes, { createParent: false, beforeRename: assertOwner, beforePublish: assertOwner });
    },
    removeStage(name, assertOwner) { assertOwner(); fs.rmSync(scanStage(name), { force: true }); },
    tombstonePath: path.join(locations.transaction, 'pending.removed'),
  };
}

function resultFromJournal(journal) {
  return structuredClone(journal.result);
}

function rollbackTransaction(root, token, journal, deadline) {
  const assertOwner = () => assertLockOwner({ wikiRoot: root, token });
  if (journal.scan_window_journal?.states) {
    const pendingBefore = descriptorBytes(journal.scan_window_journal.states.pending.before);
    const lastBefore = descriptorBytes(journal.scan_window_journal.states.last.before);
    const plan = scanWindow.planScanWindowTransition({
      wikiRoot: root,
      kind: 'repair',
      pendingAfter: pendingBefore,
      lastAfter: lastBefore,
    });
    scanWindow.applyScanWindowTransition({
      wikiRoot: root,
      token,
      plan,
      operationId: `rollback-${journal.operation_id}`,
      deadline,
    });
  }
  for (const item of [...journal.artifacts].reverse()) {
    assertBeforeDeadline(deadline, `wiki-state:rollback:${item.key}`);
    const destination = path.join(root, ...item.relative_path.split('/'));
    const before = descriptorBytes(item.before);
    assertOwner();
    if (before === null) fs.rmSync(destination, { force: true });
    else {
      ensureDirectory(path.dirname(destination));
      atomicWriteFile(destination, before, { beforeRename: assertOwner, beforePublish: assertOwner });
    }
    assertOwner();
  }
}

function readValidatedTombstone(locations, operationId) {
  const bytes = readMaybe(locations.tombstone);
  if (bytes === null) return null;
  const verdict = validateTombstoneV1(bytes, operationId);
  if (!verdict.valid) throw verdict.error;
  return verdict.value;
}

function transactionCancelled(tombstone) {
  return stateError(
    'TRANSACTION_CANCELLED',
    `transaction cancelled after catalog drift at ${tombstone.drift.join(', ')}`,
  );
}

function teardownCancelledTransaction(root, token, locations, tombstone, faultInjector) {
  assertTransactionNotOversized(root, path.basename(locations.transaction));
  const assertOwner = () => assertLockOwner({ wikiRoot: root, token });
  for (const entry of fs.readdirSync(locations.transaction)) {
    if (entry === 'cancelled.json') continue;
    assertOwner();
    fs.rmSync(path.join(locations.transaction, entry), { recursive: true, force: true });
    assertOwner();
    invokeFault(faultInjector, `during-cancel-teardown:${entry}`);
  }
  assertOwner();
  fs.rmSync(locations.tombstone, { force: true });
  assertOwner();
  invokeFault(faultInjector, 'after-cancel-tombstone-removed');
  assertOwner();
  fs.rmdirSync(locations.transaction);
  assertOwner();
  throw transactionCancelled(tombstone);
}

function resumeCancelledTransaction(root, token, locations, journal, tombstone, faultInjector, deadline) {
  rollbackTransaction(root, token, journal, deadline);
  invokeFault(faultInjector, 'after-cancel-rollback');
  assertLockOwner({ wikiRoot: root, token });
  fs.rmSync(locations.journal, { force: true });
  assertLockOwner({ wikiRoot: root, token });
  invokeFault(faultInjector, 'after-cancel-journal-removed');
  return teardownCancelledTransaction(root, token, locations, tombstone, faultInjector);
}

function cancelTransaction(root, token, locations, journal, faultInjector, deadline, driftPath) {
  const tombstone = {
    contract_version: 1,
    operation_id: journal.operation_id,
    reason: 'catalog-drift',
    drift: [driftPath],
  };
  const assertOwner = () => assertLockOwner({ wikiRoot: root, token });
  invokeFault(faultInjector, 'before-cancel-tombstone');
  assertOwner();
  atomicWriteFile(locations.tombstone, `${JSON.stringify(tombstone)}\n`, {
    createParent: false, beforeRename: assertOwner, beforePublish: assertOwner,
  });
  assertOwner();
  invokeFault(faultInjector, 'after-cancel-tombstone');
  return resumeCancelledTransaction(
    root, token, locations, journal, tombstone, faultInjector, deadline,
  );
}

function cleanupTransaction(root, token, locations, journal, faultInjector) {
  assertTransactionNotOversized(root, path.basename(locations.transaction));
  if (!journal.transitions.includes('cleaned')) {
    invokeFault(faultInjector, 'before-cleanup');
    assertLockOwner({ wikiRoot: root, token });
    for (const directory of [locations.before, locations.after]) fs.rmSync(directory, { recursive: true, force: true });
    for (const entry of fs.readdirSync(locations.transaction)) {
      if (entry.startsWith('scan-') || entry === 'pending.removed') {
        fs.rmSync(path.join(locations.transaction, entry), { recursive: true, force: true });
      }
    }
    assertLockOwner({ wikiRoot: root, token });
    invokeFault(faultInjector, 'after-cleanup');
    appendTransition(root, token, locations, journal, 'cleaned', faultInjector);
  }

  const receipt = {
    contract_version: 1,
    operation_id: journal.operation_id,
    manifest_sha256: journal.manifest_sha256,
    result: journal.result,
    result_sha256: journal.result_sha256,
  };
  invokeFault(faultInjector, 'before-receipt-publish');
  assertLockOwner({ wikiRoot: root, token });
  ensureDirectory(locations.receipts);
  const assertOwner = () => assertLockOwner({ wikiRoot: root, token });
  atomicWriteFile(locations.receipt, `${JSON.stringify(receipt)}\n`, {
    createParent: false, beforeRename: assertOwner, beforePublish: assertOwner,
  });
  invokeFault(faultInjector, 'after-receipt-publish');
  assertOwner();
  fs.rmSync(locations.transaction, { recursive: true, force: true });
  assertOwner();
  invokeFault(faultInjector, 'after-transaction-compacted');
}

function finishTransaction(root, token, locations, journal, faultInjector, deadline) {
  if (journal.transitions.includes('committed')) {
    cleanupTransaction(root, token, locations, journal, faultInjector);
    return resultFromJournal(journal);
  }
  const tombstone = readValidatedTombstone(locations, journal.operation_id);
  if (tombstone) {
    return resumeCancelledTransaction(
      root, token, locations, journal, tombstone, faultInjector, deadline,
    );
  }
  try {
    if (!journal.transitions.includes('staged')) {
      stageTransaction(root, token, locations, journal, faultInjector, deadline);
    }
    verifyStages(root, token, locations, journal, faultInjector, deadline);
    if (journal.contract_version === 2
        && journal.catalog_seal_cursor < journal.catalog_seal.length) {
      const initialCursor = journal.catalog_seal_cursor;
      while (journal.catalog_seal_cursor < journal.catalog_seal.length) {
        const entry = journal.catalog_seal[journal.catalog_seal_cursor];
        invokeFault(faultInjector, `catalog-seal-scan:${entry.relative_path}`);
        if (remainingMs(deadline) < SCAN_YIELD_MARGIN_MS) {
          persistJournal(
            root, token, locations, journal, faultInjector,
            `catalog-seal-cursor-${journal.catalog_seal_cursor}`,
          );
          throw new DeadlineExceeded(`wiki-state:catalog-seal:${entry.relative_path}`);
        }
        const current = readMaybe(path.join(root, ...entry.relative_path.split('/')));
        if (current === null || sha256(current) !== entry.sha256) {
          return cancelTransaction(
            root, token, locations, journal, faultInjector, deadline, entry.relative_path,
          );
        }
        journal.catalog_seal_cursor += 1;
      }
      if (journal.catalog_seal_cursor !== initialCursor) {
        persistJournal(
          root, token, locations, journal, faultInjector,
          `catalog-seal-cursor-${journal.catalog_seal_cursor}`,
        );
      }
    }
    const phases = [
      ['versions', 'versions-written'], ['pages', 'pages-written'], ['sources', 'sources-written'],
      ['index-json', 'index-json-written'], ['index-md', 'index-md-written'],
      ['log-jsonl', 'log-jsonl-written'], ['log-md', 'log-md-written'],
    ];
    for (const [phase, transition] of phases) {
      assertBeforeDeadline(deadline, `wiki-state:publish:${phase}`);
      publishPhase(root, token, locations, journal, phase, transition, faultInjector, deadline);
    }
    appendTransition(root, token, locations, journal, 'scan-window-staged', faultInjector);
    if (!journal.transitions.includes('pending-promoted')) {
      if (journal.manifest.promote_pending_scan !== null) {
        const promoted = promotePendingScan({
          wikiRoot: root,
          token,
          expected: journal.manifest.promote_pending_scan,
          operationId: journal.operation_id,
          journalAdapter: scanJournalAdapter(root, token, locations, journal, faultInjector),
          faultInjector,
          deadline,
        });
        journal.result.promotedWindow = promoted.lastScan;
        journal.result_sha256 = sha256(Buffer.from(JSON.stringify(journal.result)));
      }
      appendTransition(root, token, locations, journal, 'pending-promoted', faultInjector);
    }
    appendTransition(root, token, locations, journal, 'committed', faultInjector);
  } catch (error) {
    if (error.code === 'TRANSACTION_RECOVERY_REQUIRED') {
      try { rollbackTransaction(root, token, journal, deadline); }
      catch (cause) {
        throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'transaction rollback could not restore before bytes', cause);
      }
    }
    throw error;
  }
  cleanupTransaction(root, token, locations, journal, faultInjector);
  return resultFromJournal(journal);
}

function applyCommit(options = {}) {
  const deadline = operationDeadline(options);
  assertBeforeDeadline(deadline, 'wiki-state:commit-entry');
  const root = physicalRoot(options.wikiRoot);
  assertLockOwner({ wikiRoot: root, token: options.token });
  sweepTransactionDebris(root, options.token, {
    deadline, classes: ['activation', 'plain', 'cancelled', 'junk'],
  });
  const manifest = validateManifestSchema(options.manifest);
  const manifestHash = sha256(Buffer.from(JSON.stringify(manifest)));
  const locations = transactionPaths(root, manifest.operation_id);
  const receipt = readReceipt(locations, manifestHash);
  if (receipt) {
    compactReceiptTransaction(root, options.token, locations, receipt);
    return structuredClone(receipt.result);
  }
  inspectTransactions(root, manifest.operation_id, deadline);
  let journal = readJournal(locations.journal);
  if (journal) {
    journal = validateJournal(journal, root, manifest.operation_id, manifestHash);
    if (journal.contract_version === 2
        && journal.catalog_seal_cursor === journal.catalog_seal.length
        && !journal.transitions.includes('committed')) {
      journal.catalog_seal_cursor = 0;
    }
    if (journal.contract_version === 2
        && journal.verify_stage_cursor === journal.artifacts.length
        && !journal.transitions.includes('committed')) {
      journal.verify_stage_cursor = 0;
    }
    return finishTransaction(root, options.token, locations, journal, options.faultInjector, deadline);
  }

  const residualTombstone = readValidatedTombstone(locations, manifest.operation_id);
  if (residualTombstone) {
    try {
      teardownCancelledTransaction(
        root, options.token, locations, residualTombstone, options.faultInjector,
      );
    } catch (error) {
      if (error.code !== 'TRANSACTION_CANCELLED') throw error;
    }
  }

  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  if (manifest.promote_pending_scan !== null) {
    scanWindow.planScanWindowTransition({
      wikiRoot: root,
      kind: 'promote',
      expected: manifest.promote_pending_scan,
    });
  }
  const { artifacts, catalogSeal } = buildPlan(root, manifest, now, deadline);
  const result = {
    operationId: manifest.operation_id,
    pagesCreated: manifest.pages.filter((page) => page.action === 'create').map((page) => page.file),
    pagesUpdated: manifest.pages.filter((page) => page.action === 'update').map((page) => page.file),
    eventIds: manifest.events.map((event) => event.event_id),
    indexRunId: manifest.operation_id,
    promotedWindow: null,
  };
  journal = {
    engine: 'wiki-state', contract_version: 2, wiki_root: root,
    operation_id: manifest.operation_id, manifest_sha256: manifestHash, manifest,
    owner_token: options.token, transitions: ['preflighted'], artifacts,
    artifacts_sha256: sha256(Buffer.from(JSON.stringify(artifacts))),
    catalog_seal: catalogSeal,
    catalog_seal_sha256: sha256(Buffer.from(JSON.stringify(catalogSeal))),
    catalog_seal_cursor: 0,
    verify_stage_cursor: 0,
    event_ids: manifest.events.map((event) => event.event_id),
    scan_window_journal: null,
    result,
    result_sha256: sha256(Buffer.from(JSON.stringify(result))),
  };
  prepareTransaction(root, options.token, locations, journal, options.faultInjector, deadline);
  return finishTransaction(root, options.token, locations, journal, options.faultInjector, deadline);
}

function recoverTransaction(options = {}) {
  const deadline = operationDeadline(options);
  const root = physicalRoot(options.wikiRoot);
  assertLockOwner({ wikiRoot: root, token: options.token });
  // Cancelled-tombstone teardown removes a tree, so recovery must prove the store is anchored
  // before it reads anything from it — the token says who may write, never where.
  assertTransactionStoreAnchored(root);
  if (!ULID_RE.test(options.operationId)) throw stateError('WIKI_STATE_INVALID', 'operationId is invalid');
  const locations = transactionPaths(root, options.operationId);
  const journal = readJournal(locations.journal);
  if (!journal) {
    const tombstone = readValidatedTombstone(locations, options.operationId);
    if (tombstone) {
      return teardownCancelledTransaction(
        root, options.token, locations, tombstone, options.faultInjector,
      );
    }
    throw stateError('TRANSACTION_NOT_FOUND', 'wiki-state transaction does not exist');
  }
  if (journal.engine !== 'wiki-state' || !journal.manifest) {
    throw stateError('TRANSACTION_NOT_FOUND', 'wiki-state transaction does not exist');
  }
  return applyCommit({
    wikiRoot: root, token: options.token, manifest: journal.manifest,
    faultInjector: options.faultInjector, deadline,
  });
}

function snapshotWiki(options = {}) {
  const deadline = operationDeadline(options);
  const root = physicalRoot(options.wikiRoot);
  inspectTransactions(root, null, deadline);
  const pages = [...readDirectoryFiles(path.join(root, 'pages'), '.md', deadline).keys()].sort();
  const indexPath = path.join(root, '.wiki-meta', 'index.json');
  return {
    wikiRoot: root,
    pages,
    index: fs.existsSync(indexPath) ? readIndexPayload(indexPath) : null,
    events: parseLog(readMaybe(path.join(root, 'log.jsonl')), deadline),
  };
}

function setupIntentPath(root) {
  return path.join(root, '.wiki-meta', '.setup-intent.json');
}

function readSetupIntent(root) {
  const bytes = readMaybe(setupIntentPath(root));
  if (bytes === null) return null;
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); }
  catch (cause) { throw stateError('WIKI_STATE_INVALID', 'setup intent is unreadable', cause); }
  let manifest;
  try { manifest = validateManifestSchema(value?.manifest); }
  catch (cause) { throw stateError('WIKI_STATE_INVALID', 'setup intent manifest is invalid', cause); }
  const manifestHash = sha256(Buffer.from(JSON.stringify(manifest)));
  if (!hasExactKeys(value, SETUP_INTENT_KEYS) || value.contract_version !== 1
      || value.wiki_root !== physicalRoot(root) || value.manifest_sha256 !== manifestHash
      || manifest.operation !== 'setup') {
    throw stateError('WIKI_STATE_INVALID', 'setup intent is invalid');
  }
  const canonical = Buffer.from(`${JSON.stringify({
    contract_version: 1,
    wiki_root: value.wiki_root,
    manifest_sha256: manifestHash,
    manifest,
  })}\n`);
  if (!bytes.equals(canonical)) throw stateError('WIKI_STATE_INVALID', 'setup intent is not canonical');
  return { ...value, manifest };
}

function writeSetupIntent(root, token, manifest) {
  const value = {
    contract_version: 1,
    wiki_root: root,
    manifest_sha256: sha256(Buffer.from(JSON.stringify(manifest))),
    manifest,
  };
  const assertOwner = () => assertLockOwner({ wikiRoot: root, token });
  assertOwner();
  atomicWriteFile(setupIntentPath(root), `${JSON.stringify(value)}\n`, {
    createParent: false, beforeRename: assertOwner, beforePublish: assertOwner,
  });
  assertOwner();
  return value;
}

function assertValidRuntimeMarkerDirectory(root, runtimePath) {
  let stat;
  try { stat = fs.lstatSync(runtimePath); }
  catch (error) {
    throw stateError('WIKI_STATE_INVALID', 'partial setup contains unexpected metadata', error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw stateError('WIKI_STATE_INVALID', 'partial setup contains unexpected metadata');
  }
  const names = fs.readdirSync(runtimePath);
  if (names.length === 0) return;
  if (names.length !== 1 || names[0] !== 'scan-window-maintenance.json') {
    throw stateError('WIKI_STATE_INVALID', 'partial setup contains unexpected metadata');
  }
  try { readMaintenanceMarker(root); }
  catch (error) {
    throw stateError('WIKI_STATE_INVALID', 'partial setup contains unexpected metadata', error);
  }
}

function setupTargetState(root) {
  if (!fs.existsSync(root)) return 'new';
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw stateError('WIKI_STATE_INVALID', 'setup target must be a physical directory');
  }
  const entries = fs.readdirSync(root);
  if (entries.length === 0) return 'new';
  const required = [
    'pages', '.wiki-meta', '.wiki-meta/sources', '.wiki-meta/.versions',
    '.wiki-meta/index.json', 'index.md', 'log.jsonl', 'log.md',
  ];
  if (required.every((relative) => fs.existsSync(path.join(root, ...relative.split('/'))))) {
    return readSetupIntent(root) === null ? 'compatible' : 'partial';
  }
  const allowedTop = new Set(['pages', '.wiki-meta', 'index.md', 'log.jsonl', 'log.md']);
  if (entries.some((entry) => !allowedTop.has(entry))) {
    throw stateError('WIKI_STATE_INVALID', 'nonempty setup target is not a compatible deep-wiki');
  }
  const pages = path.join(root, 'pages');
  if (fs.existsSync(pages) && fs.readdirSync(pages).some((entry) => entry !== 'welcome.md')) {
    throw stateError('WIKI_STATE_INVALID', 'partial setup contains an unexpected page');
  }
  const meta = path.join(root, '.wiki-meta');
  if (fs.existsSync(meta)) {
    const allowedMeta = new Set([
      'sources', '.versions', '.transactions', '.transaction-receipts', '.wiki-lock', 'index.json',
      '.setup-intent.json', '.quarantine',
    ]);
    const metaNames = fs.readdirSync(meta);
    for (const entry of metaNames) {
      if (entry === '.runtime') {
        assertValidRuntimeMarkerDirectory(root, path.join(meta, '.runtime'));
        continue;
      }
      if (!allowedMeta.has(entry)) {
        throw stateError('WIKI_STATE_INVALID', 'partial setup contains unexpected metadata');
      }
    }
  }
  const authenticated = interruptedSetupManifest(root) !== null || readSetupIntent(root) !== null;
  const metaEntries = fs.existsSync(meta) ? fs.readdirSync(meta) : [];
  const bootstrapResidue = entries.length === 1 && entries[0] === '.wiki-meta'
    && metaEntries.every((entry) => entry === '.wiki-lock');
  if (!authenticated && !bootstrapResidue) {
    throw stateError('WIKI_STATE_INVALID', 'partial setup is not authenticated by setup intent or journal');
  }
  return 'partial';
}

function interruptedSetupManifest(root) {
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  let entries;
  try { entries = fs.readdirSync(transactions, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  for (const entry of entries) {
    let kind;
    if (entry.isSymbolicLink()) kind = 'symlink';
    else if (entry.isDirectory()) kind = 'directory';
    else if (!entry.isFile() && !entry.isBlockDevice() && !entry.isCharacterDevice()
        && !entry.isFIFO() && !entry.isSocket()) {
      kind = resolveUnknownDirent(transactions, entry).kind;
    } else kind = 'other';
    if (kind === 'directory' && entry.name.startsWith('.activate-')) continue;
    if (kind !== 'directory') continue;
    assertTransactionNotOversized(root, entry.name);
    const journal = readJournal(path.join(transactions, entry.name, 'journal.json'));
    if (journal?.engine === 'wiki-state' && journal.manifest?.operation === 'setup'
        && !journal.transitions?.includes('committed')) return journal.manifest;
  }
  return null;
}

function establishWiki(options = {}) {
  const root = options.wikiRoot;
  const deadline = operationDeadline(options);
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw stateError('WIKI_STATE_INVALID', 'wikiRoot must be absolute');
  const targetState = setupTargetState(root);
  if (targetState === 'compatible') {
    const physical = physicalRoot(root);
    return { status: 'compatible', snapshot: snapshotWiki({ wikiRoot: physical, deadline }) };
  }
  fs.mkdirSync(root, { recursive: true });
  const physical = physicalRoot(root);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const timestamp = now.toISOString().replace('.000Z', 'Z');
  const welcome = '---\ntitle: Welcome\nsources: [deep-wiki-init]\ntags: [meta]\naliases: []\n---\n\n# Welcome\n';
  invokeFault(options.faultInjector, 'before-setup-lock');
  const owner = acquireLock({ wikiRoot: physical, operation: 'setup', now });
  let result;
  try {
    if (typeof options.onWikiEstablished === 'function') {
      options.onWikiEstablished({ physicalRoot: physical, owner });
      assertLockOwner({ wikiRoot: physical, token: owner.token });
    }
    if (setupTargetState(physical) === 'compatible') {
      result = { status: 'compatible', snapshot: snapshotWiki({ wikiRoot: physical, deadline }) };
    } else {
      const journalManifest = interruptedSetupManifest(physical);
      const intentManifest = readSetupIntent(physical)?.manifest || null;
      if (journalManifest && intentManifest
          && sha256(Buffer.from(JSON.stringify(journalManifest)))
            !== sha256(Buffer.from(JSON.stringify(intentManifest)))) {
        throw stateError('TRANSACTION_RECOVERY_REQUIRED', 'setup intent and journal disagree');
      }
      const resumed = journalManifest || intentManifest;
      const operationId = resumed?.operation_id || options.operationId || envelope.generateUlid(now.getTime());
      const eventId = resumed?.events?.[0]?.event_id || options.eventId || envelope.generateUlid(now.getTime() + 1);
      const manifest = resumed || {
        operation: 'setup', operation_id: operationId,
        pages: [{ file: 'welcome.md', action: 'create', expected_sha256: null, content: welcome }],
        sources: [{ slug: 'deep-wiki-init', content: 'origin: deep-wiki\ntype: setup\n' }],
        events: [{
          event_id: eventId, ts: timestamp, action: 'setup', source: null,
          pages_created: ['welcome.md'], pages_updated: [],
        }],
        refresh_index: true, promote_pending_scan: null,
      };
      writeSetupIntent(physical, owner.token, manifest);
      invokeFault(options.faultInjector, 'after-setup-intent');
      for (const directory of ['pages', '.wiki-meta/sources', '.wiki-meta/.versions']) {
        assertLockOwner({ wikiRoot: physical, token: owner.token });
        fs.mkdirSync(path.join(physical, ...directory.split('/')), { recursive: true });
      }
      result = applyCommit({
        wikiRoot: physical, token: owner.token, now, manifest,
        faultInjector: options.faultInjector, deadline,
      });
      assertLockOwner({ wikiRoot: physical, token: owner.token });
      fs.rmSync(setupIntentPath(physical), { force: true });
      assertLockOwner({ wikiRoot: physical, token: owner.token });
    }
  } finally { releaseLock({ wikiRoot: physical, token: owner.token }); }
  return result;
}

function setupWiki(options = {}) {
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const operationId = options.operationId || envelope.generateUlid(now.getTime());
  const eventId = options.eventId || envelope.generateUlid(now.getTime() + 1);
  const coordinated = coordinateSetup({
    ...options,
    env: options.env || process.env,
    now,
    operationId,
    eventId,
  }, {
    establishWiki,
  });
  const result = {
    ...coordinated.result,
    authority: {
      wiki_root: coordinated.authority.wiki_root,
      generation: coordinated.authority.generation,
    },
  };
  if (coordinated.config) result.config = coordinated.config;
  if (coordinated.migrationEligible) {
    result.migration = migrateAutoIngestPolicy({
      env: options.env || process.env,
      wikiRoot: coordinated.authority.wiki_root,
      deadline: operationDeadline(options),
      fs: options.fs,
    });
  }
  return result;
}

function deterministicUlid(timestamp, seed) {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let time = Date.parse(timestamp);
  const timePart = new Array(10);
  for (let index = 9; index >= 0; index -= 1) {
    timePart[index] = alphabet[time % 32];
    time = Math.floor(time / 32);
  }
  const digest = crypto.createHash('sha256').update(seed).digest().subarray(0, 10);
  let entropy = 0n;
  for (const byte of digest) entropy = (entropy << 8n) | BigInt(byte);
  const randomPart = new Array(16);
  for (let index = 15; index >= 0; index -= 1) {
    randomPart[index] = alphabet[Number(entropy & 31n)];
    entropy >>= 5n;
  }
  return timePart.join('') + randomPart.join('');
}

function registerIngestFailure(options = {}) {
  const root = physicalRoot(options.wikiRoot);
  assertLockOwner({ wikiRoot: root, token: options.token });
  if (!SLUG_RE.test(options.source)) throw stateError('WIKI_STATE_INVALID', 'source slug is invalid');
  const pending = readMaybe(path.join(root, '.wiki-meta', '.pending-scan'));
  if (!pending) return { status: 'no-pending-window', count: 0 };
  const window = pending.toString('utf8').trim();
  canonicalTimestamp(window, 'pending scan');
  const counterPath = path.join(root, '.wiki-meta', '.pending-scan-retry-count');
  const current = readMaybe(counterPath)?.toString('utf8').trim() || '';
  const match = current.match(/^(.*):(\d+)$/);
  const count = match && match[1] === window ? Number(match[2]) + 1 : 1;
  const assertOwner = () => assertLockOwner({ wikiRoot: root, token: options.token });
  atomicWriteFile(counterPath, `${window}:${count}\n`, { beforeRename: assertOwner, beforePublish: assertOwner });
  if (count < 3) return { status: 'retry', count, window };

  const operationId = deterministicUlid(window, `ingest-fail-operation\0${options.source}`);
  const eventId = deterministicUlid(window, `ingest-fail-event\0${options.source}`);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const committed = applyCommit({
    wikiRoot: root,
    token: options.token,
    now,
    faultInjector: options.faultInjector,
    manifest: {
      operation: 'ingest-fail',
      operation_id: operationId,
      pages: [],
      sources: [{
        slug: options.source,
        content: `origin: ${options.source}\ntype: partial_fail\npartial_fail: true\nwindow: ${window}\n`,
      }],
      events: [{
        event_id: eventId,
        ts: window,
        action: 'ingest-fail',
        source: options.source,
        pages_created: [],
        pages_updated: [],
      }],
      refresh_index: true,
      promote_pending_scan: window,
    },
  });
  assertOwner();
  fs.rmSync(counterPath, { force: true });
  assertOwner();
  return { status: 'terminal', count, window, operationId, eventId, committed };
}

function cleanupInbox(options = {}) {
  const deadline = operationDeadline(options);
  const root = physicalRoot(options.wikiRoot);
  assertLockOwner({ wikiRoot: root, token: options.token });
  const maxAgeDays = options.maxAgeDays === undefined ? 7 : options.maxAgeDays;
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) throw stateError('WIKI_STATE_INVALID', 'maxAgeDays is invalid');
  const inbox = path.join(root, '.wiki-meta', '.inbox');
  const quarantine = path.join(inbox, '.quarantine');
  let entries;
  try { entries = fs.readdirSync(inbox, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return { moved: [] }; throw error; }
  const protectedPaths = [...readDirectoryFiles(path.join(root, '.wiki-meta', 'sources'), '.yaml', deadline).values()]
    .filter((bytes) => /partial_fail:\s*true/.test(bytes.toString('utf8')))
    .map((bytes) => bytes.toString('utf8'));
  const moved = [];
  const now = options.now instanceof Date ? options.now.getTime() : Date.now();
  const assertOwner = () => assertLockOwner({ wikiRoot: root, token: options.token });
  for (const entry of entries) {
    assertBeforeDeadline(deadline, `wiki-state:cleanup-inbox:${entry.name}`);
    if (!entry.isFile() || entry.isSymbolicLink()) continue;
    const source = path.join(inbox, entry.name);
    if (protectedPaths.some((text) => text.includes(source))) continue;
    if (now - fs.statSync(source).mtimeMs <= maxAgeDays * 86_400_000) continue;
    assertOwner();
    fs.mkdirSync(quarantine, { recursive: true });
    const target = path.join(quarantine, `${Date.now()}-${crypto.randomUUID()}-${entry.name}`);
    assertOwner();
    fs.renameSync(source, target);
    assertOwner();
    moved.push(entry.name);
  }
  return { moved };
}

function collectIgnoredOsMetadata(directory, catalog, deadline) {
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  entries.sort((left, right) => left.name.localeCompare(right.name, 'en'));
  return entries.filter((entry) => {
    assertBeforeDeadline(deadline, `wiki-state:ignored-os-metadata:${catalog}:${entry.name}`);
    return isReclaimableJunkEntry(entry, directory);
  }).map((entry) => entry.name);
}

function inspectWiki(options = {}) {
  const deadline = operationDeadline(options);
  const snapshot = snapshotWiki({ ...options, deadline });
  const root = snapshot.wikiRoot;
  const issues = [];
  const timestampValue = (file, code) => {
    const bytes = readMaybe(path.join(root, '.wiki-meta', file));
    if (bytes === null) return null;
    const value = bytes.toString('utf8').trim();
    try { canonicalTimestamp(value, file); return value; }
    catch { issues.push({ code, path: `.wiki-meta/${file}` }); return undefined; }
  };
  const pending = timestampValue('.pending-scan', 'INVALID_PENDING_SCAN');
  const last = timestampValue('.last-scan', 'INVALID_LAST_SCAN');
  if (pending !== undefined && pending !== null && last !== undefined && last !== null && pending <= last) {
    issues.push({ code: 'STALE_PENDING_SCAN', path: '.wiki-meta/.pending-scan' });
  }

  const versions = readDirectoryFiles(path.join(root, '.wiki-meta', '.versions'), '.md', deadline);
  const groups = new Map();
  for (const file of versions.keys()) {
    const match = file.match(/^(.*)\.v(\d+)\.md$/);
    if (!match) continue;
    const entries = groups.get(match[1]) || [];
    entries.push(Number(match[2]));
    groups.set(match[1], entries);
  }
  for (const [stem, entries] of groups) {
    if (entries.length > 3) issues.push({ code: 'EXCESS_VERSIONS', stem, count: entries.length });
  }

  const sources = new Set(readDirectoryFiles(path.join(root, '.wiki-meta', 'sources'), '.yaml', deadline).keys());
  const pageFiles = readDirectoryFiles(path.join(root, 'pages'), '.md', deadline);
  for (const [file, bytes] of pageFiles) {
    const frontmatter = parsePageFrontmatter(bytes);
    for (const slug of Array.isArray(frontmatter.sources) ? frontmatter.sources : []) {
      if (!sources.has(`${slug}.yaml`)) issues.push({ code: 'MISSING_SOURCE', page: file, source: slug });
    }
  }
  const indexed = new Set(Array.isArray(snapshot.index?.pages)
    ? snapshot.index.pages.map((page) => page.file) : []);
  if (snapshot.pages.some((file) => !indexed.has(file)) || indexed.size !== snapshot.pages.length) {
    issues.push({ code: 'INDEX_DRIFT', path: '.wiki-meta/index.json' });
  }
  const ignored_os_metadata = {
    pages: collectIgnoredOsMetadata(path.join(root, 'pages'), 'pages', deadline),
    sources: collectIgnoredOsMetadata(path.join(root, '.wiki-meta', 'sources'), 'sources', deadline),
    versions: collectIgnoredOsMetadata(path.join(root, '.wiki-meta', '.versions'), 'versions', deadline),
  };
  const marker = readMaintenanceMarker(root);
  const inventory = listQuarantineBundleNames(root, { deadline });
  const maintenance_residue = {
    prune_failures: marker ? marker.prune_failures : [],
    promoted: marker ? marker.promoted : [],
    skipped_oversized: marker ? marker.skipped_oversized : [],
    quarantine_bundles: marker ? marker.quarantine_bundles : [],
    bundles: inventory.bundles,
    count: inventory.count,
    truncated: inventory.truncated,
    unexpected: inventory.unexpected,
    oversized: inventory.oversized,
    method: inventory.method,
    estimated_entries: inventory.estimated_entries,
  };
  return {
    ok: issues.length === 0,
    pages: snapshot.pages.length,
    events: snapshot.events.length,
    issues,
    ignored_os_metadata,
    maintenance_residue,
  };
}

function transactionStoreJunkNames(root) {
  assertTransactionStoreAnchored(root);
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  let entries;
  try { entries = fs.readdirSync(transactions, { withFileTypes: true }); }
  catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  return entries.filter((entry) => isReclaimableJunkEntry(entry, transactions)).map((entry) => entry.name);
}

// The four blocked-residue fields describe the last pass that walked the store. `null` counts mean
// that pass produced no observation, which is different from observing zero (issue #60).
function pruneObservation(pass) {
  if (pass && Array.isArray(pass.blocked)) {
    return {
      blocked: pass.blocked,
      blocked_count: pass.blocked_count,
      blocked_truncated: pass.blocked_truncated,
      deferred_count: pass.deferred_count,
    };
  }
  return { blocked: [], blocked_count: null, blocked_truncated: false, deferred_count: null };
}

function fixWiki(options = {}) {
  const deadline = operationDeadline(options);
  const root = physicalRoot(options.wikiRoot);
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const manifestNow = new Date(Math.floor(now.getTime() / 1000) * 1000);
  const timestamp = manifestNow.toISOString().replace('.000Z', 'Z');
  let owner;
  try {
    owner = acquireLock({ wikiRoot: root, operation: 'lint-fix', now });
  } catch (error) {
    if (error.code === 'LOCK_CONTENDED') return { status: 'skipped', reason: 'LOCK_CONTENDED' };
    throw error;
  }
  let operationError;
  let completedResult;
  try {
    assertLockOwner({ wikiRoot: root, token: owner.token });
    scanWindow.assertPruneTransactionNamesSupported({
      wikiRoot: root,
      token: owner.token,
      deadline,
    });
    const entryMarkers = scanWindow.inspectPruneMarkers({ wikiRoot: root });
    const suppressEnsurePrune = entryMarkers.pending.invalid || entryMarkers.last.invalid;
    // Snapshot before any sweep: this route runs its own sweep and then a nested commit sweep, so
    // only a before/after diff of the store reports reclamation exactly.
    const junkBefore = new Set(transactionStoreJunkNames(root));
    sweepTransactionDebris(root, owner.token, {
      deadline, classes: ['activation', 'plain', 'cancelled', 'junk'],
    });
    const prune = (mode, limit) => {
      const request = {
        wikiRoot: root,
        token: owner.token,
        maxAgeDays: 0,
        now,
        deadline,
        limit,
      };
      if (mode === 'recovery') request.resumableOnly = true;
      else {
        request.kinds = ['ensure'];
        request.suppressEnsurePrune = suppressEnsurePrune;
      }
      return scanWindow.pruneScanWindowTransactions(request);
    };
    let recovery = {
      processed: 0, removed: [], complete: true, ...pruneObservation(null),
    };
    let before;
    try {
      before = inspectWiki({ wikiRoot: root, deadline });
    } catch (initial) {
      let recoveryInitial = null;
      if (initial.code === 'TRANSACTION_OVERSIZED') {
        const store = path.join(root, '.wiki-meta', '.transactions');
        const parsePruneName = scanWindow.operationIdFromPruneName;
        const tried = new Set();
        let remainingAttempts = QUARANTINE_PROMOTION_LIMIT;
        let current = initial;
        for (;;) {
          if (remainingAttempts <= 0) throw current;
          const names = [];
          if (typeof current.operationId === 'string'
              && !tried.has(current.operationId)
              && isIsolatableStoreName(current.operationId, parsePruneName)) {
            names.push(current.operationId);
          }
          let entries = [];
          try { entries = fs.readdirSync(store, { withFileTypes: true }); }
          catch { throw current; }
          for (const entry of entries) {
            if (deadline) {
              try { assertBeforeDeadline(deadline, `lint-fix-oversized:${entry.name}`); }
              catch (error) {
                if (error.code === 'DEADLINE_EXCEEDED') break;
                throw error;
              }
            }
            if (tried.has(entry.name) || names.includes(entry.name)) continue;
            if (!isIsolatableStoreName(entry.name, parsePruneName)) continue;
            const pressure = inspectDirectoryPressure(path.join(store, entry.name), {
              deadline,
              allowEnumeration: false,
            });
            if (pressure.oversized) names.push(entry.name);
          }
          if (names.length === 0) throw current;
          const promotion = promoteOversizedNames({
            wikiRoot: root,
            token: owner.token,
            names,
            parsePruneName,
            classification: {
              method: current.method || 'stat',
              estimated_entries: current.estimatedEntries ?? null,
            },
            reason: 'oversized',
            deadline,
            limit: remainingAttempts,
          });
          remainingAttempts -= promotion.attempted || 0;
          for (const name of promotion.attempted_names || []) tried.add(name);
          if ((promotion.attempted || 0) === 0) throw current;
          try {
            before = inspectWiki({ wikiRoot: root, deadline });
            break;
          } catch (retry) {
            if (retry.code === 'TRANSACTION_RECOVERY_REQUIRED') {
              recoveryInitial = retry;
              break;
            }
            if (retry.code !== 'TRANSACTION_OVERSIZED') throw retry;
            current = retry;
          }
        }
      } else if (initial.code === 'TRANSACTION_RECOVERY_REQUIRED') recoveryInitial = initial;
      else throw initial;
      if (recoveryInitial) {
        try {
          recovery = prune('recovery', 64);
        } catch (recoveryError) {
          const wrapped = stateError(
            recoveryError.code || 'FILESYSTEM',
            `scan-window prune residue recovery failed: ${recoveryError.message}`,
            recoveryInitial,
          );
          if (recoveryError.terminal_prune) {
            wrapped.terminal_prune = recoveryError.terminal_prune;
          }
          throw wrapped;
        }
        if (recovery.processed === 0 && recovery.complete === true) {
          const wrapped = stateError(
            recoveryInitial.code || 'FILESYSTEM',
            `scan-window prune residue recovery made no progress: ${recoveryInitial.message}`,
            recoveryInitial,
          );
          wrapped.terminal_prune = recovery;
          throw wrapped;
        }
        if (recovery.processed === 0 && recovery.complete === false) {
          const wrapped = stateError(
            recoveryInitial.code || 'FILESYSTEM',
            `scan-window prune residue recovery pass incomplete before inspection failed: ${recoveryInitial.message}`,
            recoveryInitial,
          );
          wrapped.terminal_prune = recovery;
          throw wrapped;
        }
        if (typeof recovery.complete !== 'boolean') {
          const wrapped = stateError(
            'FILESYSTEM',
            'scan-window prune residue recovery returned an invalid completion result',
            recoveryInitial,
          );
          wrapped.terminal_prune = recovery;
          throw wrapped;
        }
        try {
          before = inspectWiki({ wikiRoot: root, deadline });
        } catch (retryError) {
          const prefix = recovery.complete === false
            ? 'scan-window prune residue recovery pass incomplete before inspection failed: '
            : 'scan-window prune residue recovery pass completed before inspection failed: ';
          const wrapped = stateError(
            retryError.code || 'FILESYSTEM',
            `${prefix}${retryError.message}`,
            retryError,
          );
          wrapped.terminal_prune = recovery;
          throw wrapped;
        }
      }
    }
    const pendingBytes = readMaybe(path.join(root, '.wiki-meta', '.pending-scan'));
    const lastBytes = readMaybe(path.join(root, '.wiki-meta', '.last-scan'));
    const parseScan = (bytes) => {
      if (bytes === null) return { valid: true, value: null };
      const text = bytes.toString('utf8');
      if (!Buffer.from(text, 'utf8').equals(bytes) || !text.endsWith('\n')) {
        return { valid: false, value: null };
      }
      const value = text.slice(0, -1);
      try {
        canonicalTimestamp(value, 'scan window');
        if (!Buffer.from(`${value}\n`, 'utf8').equals(bytes)) {
          return { valid: false, value: null };
        }
        return { valid: true, value };
      }
      catch { return { valid: false, value: null }; }
    };
    const pending = parseScan(pendingBytes);
    const last = parseScan(lastBytes);
    const markerRepairable = (marker) => (
      marker.state !== 'invalid'
      || (Buffer.isBuffer(marker.bytes) && marker.identity !== undefined)
    );
    const pendingAfter = !markerRepairable(entryMarkers.pending)
      ? pendingBytes
      : (!pending.valid || (pending.value !== null && last.valid
        && last.value !== null && pending.value <= last.value) ? null : pendingBytes);
    const lastAfter = !markerRepairable(entryMarkers.last)
      ? lastBytes
      : (last.valid ? lastBytes : null);
    if (!bytesEqual(pendingBytes, pendingAfter) || !bytesEqual(lastBytes, lastAfter)) {
      const repairPlan = scanWindow.planScanWindowTransition({
        wikiRoot: root,
        kind: 'repair',
        pendingAfter,
        lastAfter,
      });
      scanWindow.applyScanWindowTransition({
        wikiRoot: root,
        token: owner.token,
        plan: repairPlan,
        operationId: `lint-repair-${sha256(Buffer.concat([
          pendingBytes || Buffer.alloc(0), Buffer.from('\0'), lastBytes || Buffer.alloc(0),
        ])).slice(0, 40)}`,
        deadline,
      });
    }
    const committed = applyCommit({
      wikiRoot: root,
      token: owner.token,
      now,
      manifest: {
        operation: 'lint',
        operation_id: deterministicUlid(
          timestamp,
          `lint-fix-operation\0${owner.token}`,
        ),
        pages: [],
        sources: [],
        events: [{
          event_id: deterministicUlid(timestamp, `lint-fix-event\0${owner.token}`),
          ts: timestamp,
          action: 'lint',
          source: null,
          pages_created: [],
          pages_updated: [],
        }],
        refresh_index: true,
        promote_pending_scan: null,
      },
      deadline,
    });
    const after = inspectWiki({ wikiRoot: root, deadline });
    const primary = {
      status: after.ok ? 'fixed' : 'partial',
      before,
      after,
      committed,
    };
    let tail;
    try {
      tail = prune('tail', 64 - recovery.processed);
    } catch (tailError) {
      const skipped = [...new Set([
        ...(recovery.skipped_oversized || []),
        ...((tailError.terminal_prune && tailError.terminal_prune.skipped_oversized) || []),
      ])];
      let promotion = { skipped_oversized: skipped };
      try {
        promotion = promoteOversizedNames({
          wikiRoot: root,
          token: owner.token,
          names: skipped,
          parsePruneName: scanWindow.operationIdFromPruneName,
          classification: { method: 'stat', estimated_entries: null },
          reason: 'oversized',
          deadline,
        });
      } catch { /* authority may have been lost; telemetry still carries residue */ }
      const wrapped = stateError(
        'LINT_MAINTENANCE_FAILED_AFTER_COMMIT',
        `lint repair committed before terminal maintenance failed: ${tailError.message}`,
        tailError,
      );
      wrapped.lint_result = primary;
      const skippedAfter = promotion.skipped_oversized || skipped;
      if (!tailError.terminal_prune) {
        wrapped.terminal_prune = {
          processed: recovery.processed,
          removed: [...recovery.removed],
          complete: false,
          skipped_oversized: skippedAfter,
          ...pruneObservation(null),
        };
      }
      else {
        wrapped.terminal_prune = {
          processed: recovery.processed + tailError.terminal_prune.processed,
          removed: recovery.removed.concat(tailError.terminal_prune.removed),
          complete: false,
          skipped_oversized: skippedAfter,
          ...pruneObservation(tailError.terminal_prune),
        };
      }
      throw wrapped;
    }
    const skipped = [...new Set([
      ...(recovery.skipped_oversized || []),
      ...(tail.skipped_oversized || []),
    ])];
    const promotion = promoteOversizedNames({
      wikiRoot: root,
      token: owner.token,
      names: skipped,
      parsePruneName: scanWindow.operationIdFromPruneName,
      classification: { method: 'stat', estimated_entries: null },
      reason: 'oversized',
      deadline,
    });
    const terminalPrune = {
      processed: recovery.processed + tail.processed,
      removed: recovery.removed.concat(tail.removed),
      complete: recovery.complete && tail.complete,
      skipped_oversized: promotion.skipped_oversized,
      ...pruneObservation(tail),
    };
    if (suppressEnsurePrune) {
      terminalPrune.suppressed_reason = 'initial-invalid-scan-marker';
    }
    const junkAfter = transactionStoreJunkNames(root);
    completedResult = Object.assign(primary, {
      terminal_prune: terminalPrune,
      removed_junk: [...junkBefore].filter((name) => !junkAfter.includes(name)).sort(),
      removed_junk_complete: junkAfter.length === 0,
    });
    return completedResult;
  } catch (error) {
    operationError = error;
    throw error;
  } finally {
    try {
      releaseLock({ wikiRoot: root, token: owner.token });
    } catch (releaseError) {
      if (operationError) {
        operationError.release_error = releaseError;
      } else {
        if (completedResult) {
          releaseError.lint_result = completedResult;
          releaseError.terminal_prune = completedResult.terminal_prune;
        }
        throw releaseError;
      }
    }
  }
}

function quarantineStoreEntry(options = {}) {
  return quarantineStoreEntryPrimitive({
    ...options,
    parsePruneName: options.parsePruneName || scanWindow.operationIdFromPruneName,
  });
}

module.exports = {
  setupWiki,
  snapshotWiki,
  applyCommit,
  recoverTransaction,
  promotePendingScan,
  registerIngestFailure,
  cleanupInbox,
  inspectWiki,
  fixWiki,
  migrateAutoIngestPolicy,
  quarantineStoreEntry,
};
