'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const statePath = '../hooks/scripts/runtime/wiki-state.js';
const scanWindow = require('../hooks/scripts/runtime/scan-window.js');
const { migrateAutoIngestPolicy } = require('../hooks/scripts/runtime/config-migration.js');
const { spawnSync } = require('node:child_process');
const { acquireLock, releaseLock } = require('../hooks/scripts/runtime/lock.js');
const { createDeadline } = require('../hooks/scripts/runtime/deadline.js');
const { readIndexPayload } = require('../hooks/scripts/read-index-envelope.js');

const OPERATION_ID = '01JZ7P9Q6MD7S5PB8H4Y40HJ83';
const EVENT_ID = '01JZ7P9Q6MD7S5PB8H4Y40HJ84';
const TS = '2026-07-11T00:00:00Z';
const cli = path.resolve(__dirname, '..', 'scripts', 'wiki-runtime.js');
const roots = new Set();

function sha(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fixture(prefix = 'deep wiki state Unicode 공간 ') {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.add(root);
  fs.mkdirSync(path.join(root, 'pages'));
  fs.mkdirSync(path.join(root, '.wiki-meta', 'sources'), { recursive: true });
  fs.mkdirSync(path.join(root, '.wiki-meta', '.versions'));
  fs.writeFileSync(path.join(root, 'log.jsonl'), '');
  fs.writeFileSync(path.join(root, 'log.md'), '# Wiki Log\n');
  fs.writeFileSync(path.join(root, 'index.md'), '# Wiki Index\n');
  return root;
}

function setupEnv(home) {
  return { HOME: home, USERPROFILE: home, CODEX_HOME: '' };
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

function pageContent(title, sources, body = '# Topic\r\n') {
  return `---\r\ntitle: ${title}\r\nsources: [${sources.join(', ')}]\r\ntags: [test]\r\naliases: []\r\n---\r\n\r\n${body}`;
}

function manifest(overrides = {}) {
  return {
    operation: 'ingest',
    operation_id: OPERATION_ID,
    pages: [{
      file: 'topic.md',
      action: 'create',
      expected_sha256: null,
      content: pageContent('Topic', ['source-a']),
    }],
    sources: [{ slug: 'source-a', content: 'origin: C:\\Source Space\\자료.md\ntype: file\n' }],
    events: [{
      event_id: EVENT_ID,
      ts: TS,
      action: 'ingest',
      source: 'source-a',
      pages_created: ['topic.md'],
      pages_updated: [],
    }],
    refresh_index: true,
    promote_pending_scan: null,
    ...overrides,
  };
}

function withLock(root, callback) {
  const owner = acquireLock({ wikiRoot: root, operation: 'wiki-state-test', now: new Date(TS) });
  try { return callback(owner.token); }
  finally { releaseLock({ wikiRoot: root, token: owner.token }); }
}

function artifactSnapshot(root) {
  const files = [
    'pages/topic.md',
    '.wiki-meta/sources/source-a.yaml',
    '.wiki-meta/index.json',
    'index.md',
    'log.jsonl',
    'log.md',
    '.wiki-meta/.last-scan',
    '.wiki-meta/.pending-scan',
  ];
  const result = {};
  for (const relative of files) {
    const absolute = path.join(root, relative);
    result[relative] = fs.existsSync(absolute) ? fs.readFileSync(absolute).toString('base64') : null;
  }
  return result;
}

function transactionPath(root, operationId = OPERATION_ID) {
  return path.join(root, '.wiki-meta', '.transactions', operationId);
}

function journalPath(root, operationId = OPERATION_ID) {
  return path.join(transactionPath(root, operationId), 'journal.json');
}

function rebuildManifest(overrides = {}) {
  return {
    operation: 'rebuild', operation_id: OPERATION_ID, pages: [], sources: [],
    events: [{
      event_id: EVENT_ID, ts: TS, action: 'rebuild', source: null,
      pages_created: [], pages_updated: [],
    }],
    refresh_index: true, promote_pending_scan: null,
    ...overrides,
  };
}

function seedUnchangedPage(root, file, title = file, sources = []) {
  fs.writeFileSync(path.join(root, 'pages', file), pageContent(title, sources));
}

function stageInterrupted(root, value, extra = {}) {
  const { applyCommit } = require(statePath);
  withLock(root, (token) => assert.throws(() => applyCommit({
    wikiRoot: root, token, manifest: value, now: new Date(TS),
    ...extra,
    faultInjector(boundary) {
      if (boundary === 'after-transition-staged') throw new Error('stop after staging');
      extra.faultInjector?.(boundary);
    },
  }), /stop after staging/));
  return JSON.parse(fs.readFileSync(journalPath(root, value.operation_id), 'utf8'));
}

function prepareDriftedRebuild(prefix = 'deep wiki drifted rebuild ') {
  const root = fixture(prefix);
  const original = pageContent('Original', []);
  const drifted = pageContent('Drifted', []);
  seedUnchangedPage(root, 'topic.md', 'Original', []);
  const value = rebuildManifest();
  stageInterrupted(root, value);
  fs.writeFileSync(path.join(root, 'pages', 'topic.md'), drifted);
  return { root, value, original, drifted };
}

function snapshotTransactionTree(root, operationId = OPERATION_ID) {
  const base = transactionPath(root, operationId);
  const result = {};
  const visit = (directory, relative = '') => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const next = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) result[next] = `symlink:${fs.readlinkSync(absolute)}`;
      else if (entry.isDirectory()) { result[`${next}/`] = 'directory'; visit(absolute, next); }
      else result[next] = fs.readFileSync(absolute).toString('base64');
    }
  };
  if (fs.existsSync(base)) visit(base);
  return result;
}

test('wiki-state exports the one state surface and exact shared promotion identity', () => {
  const state = require(statePath);
  assert.deepEqual(Object.keys(state).sort(), [
    'applyCommit', 'cleanupInbox', 'fixWiki', 'inspectWiki', 'migrateAutoIngestPolicy', 'promotePendingScan',
    'quarantineStoreEntry', 'recoverTransaction', 'registerIngestFailure', 'setupWiki', 'snapshotWiki',
  ]);
  assert.equal(state.promotePendingScan, scanWindow.promotePendingScan);
  assert.equal(state.migrateAutoIngestPolicy, migrateAutoIngestPolicy);
  const source = fs.readFileSync(require.resolve(statePath), 'utf8');
  assert.doesNotMatch(source, /(?:writeFile|rename|unlink|rm)(?:Sync)?\([^\n]*(?:\.pending-scan|\.last-scan)/);
});

test('manifest preflight rejects schema, path, source, event, and create/update defects before mutation', async (t) => {
  const { applyCommit } = require(statePath);
  const cases = [
    ['unknown manifest key', (value) => { value.extra = true; }],
    ['page traversal', (value) => { value.pages[0].file = '../topic.md'; }],
    ['malformed basename', (value) => { value.pages[0].file = 'Topic Name.md'; }],
    ['duplicate page', (value) => { value.pages.push({ ...value.pages[0] }); }],
    ['unknown page action', (value) => { value.pages[0].action = 'replace'; }],
    ['operation event mismatch', (value) => { value.events[0].action = 'ingest-repair'; }],
    ['invalid event id', (value) => { value.events[0].event_id = 'event-1'; }],
    ['invalid timestamp', (value) => { value.events[0].ts = '2026-07-11'; }],
    ['missing source event', (value) => { value.events = []; }],
    ['duplicate source event', (value) => { value.events.push({ ...value.events[0], event_id: '01JZ7P9Q6MD7S5PB8H4Y40HJ85' }); }],
    ['missing source record', (value) => { value.sources = []; }],
    ['event page mismatch', (value) => { value.events[0].pages_created = []; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, () => {
      const root = fixture(`deep wiki preflight ${name} `);
      const value = structuredClone(manifest());
      mutate(value);
      const before = artifactSnapshot(root);
      withLock(root, (token) => {
        assert.throws(() => applyCommit({ wikiRoot: root, token, manifest: value, now: new Date(TS) }));
      });
      assert.deepEqual(artifactSnapshot(root), before);
      assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.transactions')), false);
    });
  }
});

test('operation-specific manifest semantics reject eventless rebuild and mutating ingest-fail', () => {
  const { applyCommit } = require(statePath);
  const cases = [
    {
      operation: 'rebuild', operation_id: OPERATION_ID, pages: [], sources: [], events: [],
      refresh_index: true, promote_pending_scan: null,
    },
    {
      ...manifest(),
      operation: 'ingest-fail',
      events: [{ ...manifest().events[0], action: 'ingest-fail' }],
      promote_pending_scan: TS,
    },
  ];
  for (const value of cases) {
    const root = fixture('deep wiki operation semantics ');
    const before = artifactSnapshot(root);
    withLock(root, (token) => assert.throws(
      () => applyCommit({ wikiRoot: root, token, manifest: value, now: new Date(TS) }),
      (error) => error.code === 'MANIFEST_INVALID',
    ));
    assert.deepEqual(artifactSnapshot(root), before);
    assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.transactions')), false);
  }
});

test('a page merged from two sources is listed by exactly one source event', () => {
  // The runtime rejects a merged page listed by two source events. Which
  // contributor lists it is caller policy (/wiki-ingest §2), not enforced here.
  const { applyCommit } = require(statePath);
  const merged = (laterEventPages) => manifest({
    pages: [{
      file: 'topic.md', action: 'create', expected_sha256: null,
      content: pageContent('Topic', ['source-a', 'source-b']),
    }],
    sources: [
      { slug: 'source-a', content: 'origin: a.md\ntype: file\n' },
      { slug: 'source-b', content: 'origin: b.md\ntype: file\n' },
    ],
    events: [
      { event_id: EVENT_ID, ts: TS, action: 'ingest', source: 'source-a', pages_created: ['topic.md'], pages_updated: [] },
      { event_id: '01JZ7P9Q6MD7S5PB8H4Y40HJ85', ts: TS, action: 'ingest', source: 'source-b', ...laterEventPages },
    ],
  });
  for (const [name, pages] of [
    ['listed again as created', { pages_created: ['topic.md'], pages_updated: [] }],
    ['listed as updated by the later source', { pages_created: [], pages_updated: ['topic.md'] }],
  ]) {
    const root = fixture(`deep wiki merged split ${name} `);
    const before = artifactSnapshot(root);
    withLock(root, (token) => assert.throws(
      () => applyCommit({ wikiRoot: root, token, manifest: merged(pages), now: new Date(TS) }),
      (error) => error.code === 'MANIFEST_INVALID',
      name,
    ));
    assert.deepEqual(artifactSnapshot(root), before, name);
  }

  const root = fixture('deep wiki merged single owner ');
  withLock(root, (token) => applyCommit({
    wikiRoot: root, token, manifest: merged({ pages_created: [], pages_updated: [] }), now: new Date(TS),
  }));
  const events = fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(events.map((event) => [event.source, event.pages_created, event.pages_updated]),
    [['source-a', ['topic.md'], []], ['source-b', [], []]]);
});

test('scan-window bytes are validated during mutation-free preflight', () => {
  const { applyCommit } = require(statePath);
  const root = fixture('deep wiki scan preflight ');
  fs.writeFileSync(path.join(root, '.wiki-meta', '.last-scan'), 'corrupt\n');
  fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), `${TS}\n`);
  const value = manifest({ promote_pending_scan: TS });
  const before = artifactSnapshot(root);
  withLock(root, (token) => assert.throws(
    () => applyCommit({ wikiRoot: root, token, manifest: value, now: new Date(TS) }),
    (error) => ['SCAN_WINDOW_INVALID', 'MANIFEST_INVALID'].includes(error.code),
  ));
  assert.deepEqual(artifactSnapshot(root), before);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.transactions')), false);
});

test('expected hash conflict and exactly-once history rejection preserve every artifact', () => {
  const { applyCommit } = require(statePath);
  const root = fixture('deep wiki expected hash ');
  const existing = pageContent('Existing', ['source-a'], '# Old\n');
  fs.writeFileSync(path.join(root, 'pages', 'topic.md'), existing);
  fs.writeFileSync(path.join(root, '.wiki-meta', 'sources', 'source-a.yaml'), 'origin: old\ntype: file\n');
  fs.writeFileSync(path.join(root, 'log.jsonl'), `${JSON.stringify({
    event_id: '01JZ7P9Q6MD7S5PB8H4Y40HJ80', ts: TS, action: 'ingest', source: 'source-a',
    pages_created: ['already-created.md'], pages_updated: [],
  })}\n`);
  const value = manifest({
    pages: [{
      file: 'topic.md', action: 'update', expected_sha256: '0'.repeat(64),
      content: pageContent('Topic', ['source-a']),
    }],
    events: [{ ...manifest().events[0], pages_created: [], pages_updated: ['topic.md'] }],
  });
  const before = artifactSnapshot(root);
  withLock(root, (token) => {
    assert.throws(
      () => applyCommit({ wikiRoot: root, token, manifest: value, now: new Date(TS) }),
      (error) => error.code === 'EXPECTED_HASH_CONFLICT',
    );
  });
  assert.deepEqual(artifactSnapshot(root), before);

  const duplicateHistory = manifest({
    pages: [{
      file: 'already-created.md', action: 'create', expected_sha256: null,
      content: pageContent('Already Created', ['source-a']),
    }],
    sources: [],
    events: [{
      ...manifest().events[0], pages_created: ['already-created.md'], pages_updated: [],
    }],
  });
  withLock(root, (token) => {
    assert.throws(
      () => applyCommit({ wikiRoot: root, token, manifest: duplicateHistory, now: new Date(TS) }),
      /exactly-once|created/i,
    );
  });
  assert.deepEqual(artifactSnapshot(root), before);
});

test('commit atomically coordinates page, source, indexes, logs, versions, and pending promotion', () => {
  const { applyCommit } = require(statePath);
  const root = fixture('deep wiki successful commit ');
  fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), `${TS}\n`);
  const result = withLock(root, (token) => applyCommit({
    wikiRoot: root, token, manifest: manifest({ promote_pending_scan: TS }), now: new Date(TS),
  }));
  assert.deepEqual(result.pagesCreated, ['topic.md']);
  assert.deepEqual(result.pagesUpdated, []);
  assert.deepEqual(result.eventIds, [EVENT_ID]);
  assert.equal(result.promotedWindow, TS);
  assert.equal(fs.readFileSync(path.join(root, 'pages', 'topic.md'), 'utf8'), manifest().pages[0].content);
  assert.match(fs.readFileSync(path.join(root, '.wiki-meta', 'sources', 'source-a.yaml'), 'utf8'), /자료\.md/);
  const index = readIndexPayload(path.join(root, '.wiki-meta', 'index.json'));
  assert.deepEqual(index.pages.map((page) => page.file), ['topic.md']);
  assert.match(fs.readFileSync(path.join(root, 'index.md'), 'utf8'), /topic\.md/);
  assert.equal(fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8').match(new RegExp(EVENT_ID, 'g')).length, 1);
  assert.equal(fs.readFileSync(path.join(root, 'log.md'), 'utf8').match(new RegExp(`deep-wiki:event:${EVENT_ID}`, 'g')).length, 1);
  assert.equal(fs.readFileSync(path.join(root, '.wiki-meta', '.last-scan'), 'utf8'), `${TS}\n`);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.pending-scan')), false);

  const beforeRetry = artifactSnapshot(root);
  withLock(root, (token) => applyCommit({
    wikiRoot: root, token, manifest: manifest({ promote_pending_scan: TS }), now: new Date(TS),
  }));
  assert.deepEqual(artifactSnapshot(root), beforeRetry);
  const collision = manifest({ promote_pending_scan: TS });
  collision.events[0].ts = '2026-07-11T00:00:01Z';
  withLock(root, (token) => {
    assert.throws(
      () => applyCommit({ wikiRoot: root, token, manifest: collision, now: new Date(TS) }),
      (error) => error.code === 'OPERATION_ID_COLLISION',
    );
  });
});

test('update backups retain the newest three numeric versions', () => {
  const { applyCommit } = require(statePath);
  const root = fixture('deep wiki versions ');
  const existing = pageContent('Topic', ['source-a'], '# Old\n');
  fs.writeFileSync(path.join(root, 'pages', 'topic.md'), existing);
  fs.writeFileSync(path.join(root, '.wiki-meta', 'sources', 'source-a.yaml'), 'origin: old\ntype: file\n');
  for (let version = 1; version <= 3; version += 1) {
    fs.writeFileSync(path.join(root, '.wiki-meta', '.versions', `topic.v${version}.md`), `v${version}\n`);
  }
  const value = manifest({
    pages: [{
      file: 'topic.md', action: 'update', expected_sha256: sha(Buffer.from(existing)),
      content: pageContent('Topic', ['source-a'], '# 새 내용\r\n'),
    }],
    sources: [],
    events: [{ ...manifest().events[0], pages_created: [], pages_updated: ['topic.md'] }],
  });
  withLock(root, (token) => applyCommit({ wikiRoot: root, token, manifest: value, now: new Date(TS) }));
  assert.deepEqual(
    fs.readdirSync(path.join(root, '.wiki-meta', '.versions')).sort(),
    ['topic.v2.md', 'topic.v3.md', 'topic.v4.md'],
  );
  assert.equal(fs.readFileSync(path.join(root, '.wiki-meta', '.versions', 'topic.v4.md'), 'utf8'), existing);
});

test('every observed publication fault blocks readers and same-operation retry converges byte-identically', () => {
  const { applyCommit, snapshotWiki } = require(statePath);
  const baselineRoot = fixture('deep wiki fault baseline ');
  fs.writeFileSync(path.join(baselineRoot, '.wiki-meta', '.pending-scan'), `${TS}\n`);
  const observed = [];
  withLock(baselineRoot, (token) => applyCommit({
    wikiRoot: baselineRoot,
    token,
    manifest: manifest({ promote_pending_scan: TS }),
    now: new Date(TS),
    faultInjector(boundary) { observed.push(boundary); },
  }));
  const baseline = artifactSnapshot(baselineRoot);
  const publicationBoundaries = [...new Set(observed.filter((value) => value.startsWith('after-')))].sort();
  assert.ok(publicationBoundaries.length >= 12, JSON.stringify(publicationBoundaries));

  for (const boundary of publicationBoundaries) {
    const root = fixture(`deep wiki fault ${boundary} `);
    fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), `${TS}\n`);
    let fired = false;
    withLock(root, (token) => {
      assert.throws(() => applyCommit({
        wikiRoot: root,
        token,
        manifest: manifest({ promote_pending_scan: TS }),
        now: new Date(TS),
        faultInjector(value) {
          if (!fired && value === boundary) { fired = true; throw Object.assign(new Error('process terminated'), { code: 'INJECTED_CRASH' }); }
        },
      }));
    });
    assert.equal(fired, true, boundary);
    if ([
      'after-transition-committed', 'after-cleanup', 'after-transition-cleaned',
      'after-receipt-publish', 'after-transaction-compacted',
    ].includes(boundary)) {
      assert.doesNotThrow(() => snapshotWiki({ wikiRoot: root }));
    } else {
      assert.throws(() => snapshotWiki({ wikiRoot: root }), (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED');
    }
    withLock(root, (token) => applyCommit({
      wikiRoot: root,
      token,
      manifest: manifest({ promote_pending_scan: TS }),
      now: new Date(TS),
    }));
    assert.deepEqual(artifactSnapshot(root), baseline, boundary);
  }
});

test('portable CLI consumes an absolute regular manifest file and keeps external inputs', () => {
  const root = fixture('deep wiki cli manifest 공간 ');
  const external = path.join(root, '..', `manifest-${crypto.randomUUID()}.json`);
  roots.add(external);
  fs.writeFileSync(external, `${JSON.stringify(manifest())}\n`);
  const owner = acquireLock({ wikiRoot: root, operation: 'cli-commit', now: new Date(TS) });
  try {
    const commit = spawnSync(process.execPath, [
      cli, 'commit', '--wiki-root', root, '--lock-token', owner.token,
      '--manifest-file', external, '--json',
    ], { encoding: 'utf8', shell: false });
    assert.equal(commit.status, 0, commit.stderr);
    assert.deepEqual(JSON.parse(commit.stdout).eventIds, [EVENT_ID]);
    assert.equal(fs.existsSync(external), true, 'external manifest must not be deleted');
  } finally { releaseLock({ wikiRoot: root, token: owner.token }); }

  const snapshot = spawnSync(process.execPath, [cli, 'snapshot', '--wiki-root', root, '--json'], {
    encoding: 'utf8', shell: false,
  });
  assert.equal(snapshot.status, 0, snapshot.stderr);
  assert.deepEqual(JSON.parse(snapshot.stdout).pages, ['topic.md']);
  const index = spawnSync(process.execPath, [cli, 'index', 'read', '--wiki-root', root, '--json'], {
    encoding: 'utf8', shell: false,
  });
  assert.equal(index.status, 0, index.stderr);
  assert.deepEqual(JSON.parse(index.stdout).pages.map((page) => page.file), ['topic.md']);

  const symlink = path.join(path.dirname(external), `manifest-link-${crypto.randomUUID()}.json`);
  roots.add(symlink);
  fs.symlinkSync(external, symlink);
  const rejected = spawnSync(process.execPath, [
    cli, 'commit', '--wiki-root', root, '--lock-token', 'invalid',
    '--manifest-file', symlink, '--json',
  ], { encoding: 'utf8', shell: false });
  assert.equal(rejected.status, 4, rejected.stderr);
  assert.match(rejected.stderr, /MANIFEST_INVALID/);
});

test('commit journal and staging scale with the manifest, not the catalog', () => {
  const { applyCommit, recoverTransaction } = require(statePath);
  const seed = (root) => {
    for (let index = 0; index < 40; index += 1) {
      const suffix = String(index).padStart(2, '0');
      const page = index === 0 ? 'topic.md' : `page-${suffix}.md`;
      const source = index === 0 ? 'source-a' : `source-${suffix}`;
      seedUnchangedPage(root, page, `Page ${suffix}`, [source]);
      fs.writeFileSync(path.join(root, '.wiki-meta', 'sources', `${source}.yaml`), `origin: old-${suffix}\ntype: file\n`);
    }
  };
  const value = manifest({
    pages: [{
      file: 'topic.md', action: 'update',
      expected_sha256: null,
      content: pageContent('Updated', ['source-a']),
    }],
    sources: [{ slug: 'source-a', content: 'origin: updated\ntype: file\n' }],
    events: [{ ...manifest().events[0], pages_created: [], pages_updated: ['topic.md'] }],
  });
  const root = fixture('deep wiki catalog scaling ');
  seed(root);
  value.pages[0].expected_sha256 = sha(fs.readFileSync(path.join(root, 'pages', 'topic.md')));
  stageInterrupted(root, value);
  const journal = JSON.parse(fs.readFileSync(journalPath(root), 'utf8'));
  assert.equal(journal.contract_version, 2);
  assert.equal(journal.artifacts.length, 7);
  assert.equal(journal.artifacts.some((item) => item.key.startsWith('seal-')), false);
  assert.equal(journal.catalog_seal.length, 78);
  assert.equal(new Set(journal.catalog_seal.map((entry) => entry.relative_path)).size, 78);
  const artifactPaths = new Set(journal.artifacts.map((item) => item.relative_path));
  assert.equal(journal.catalog_seal.some((entry) => artifactPaths.has(entry.relative_path)), false);
  assert.equal(journal.catalog_seal_sha256, sha(Buffer.from(JSON.stringify(journal.catalog_seal))));
  assert.equal(journal.catalog_seal_cursor, 0);
  assert.equal(fs.readdirSync(path.join(transactionPath(root), 'before')).length, 7);
  assert.equal(fs.readdirSync(path.join(transactionPath(root), 'after')).length, 7);
  withLock(root, (token) => recoverTransaction({ wikiRoot: root, token, operationId: OPERATION_ID }));

  const baseline = fixture('deep wiki catalog scaling baseline ');
  seed(baseline);
  const baselineManifest = structuredClone(value);
  baselineManifest.pages[0].expected_sha256 = sha(fs.readFileSync(path.join(baseline, 'pages', 'topic.md')));
  withLock(baseline, (token) => applyCommit({
    wikiRoot: baseline, token, manifest: baselineManifest, now: new Date(TS),
  }));
  assert.deepEqual(artifactSnapshot(root), artifactSnapshot(baseline));
});

test('journal manifest and artifact seal mutations stop recovery before later publication', () => {
  const { applyCommit } = require(statePath);
  for (const mutation of ['manifest', 'artifact']) {
    const root = fixture(`deep wiki journal seal ${mutation} `);
    withLock(root, (token) => {
      assert.throws(() => applyCommit({
        wikiRoot: root, token, manifest: manifest(), now: new Date(TS),
        faultInjector(boundary) {
          if (boundary === 'after-transition-staged') throw new Error('stop after staging');
        },
      }));
    });
    const journalPath = path.join(root, '.wiki-meta', '.transactions', OPERATION_ID, 'journal.json');
    const journal = JSON.parse(fs.readFileSync(journalPath, 'utf8'));
    if (mutation === 'manifest') journal.manifest.events[0].ts = '2026-07-11T00:00:01Z';
    else journal.artifacts[0].relative_path = 'CLAUDE.md';
    fs.writeFileSync(journalPath, `${JSON.stringify(journal)}\n`);
    const before = artifactSnapshot(root);
    withLock(root, (token) => {
      assert.throws(
        () => applyCommit({ wikiRoot: root, token, manifest: manifest(), now: new Date(TS) }),
        (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED',
      );
    });
    assert.deepEqual(artifactSnapshot(root), before);
  }
});

test('catalog drift cancels recovery cleanly: no stale index, no clobber, no reader block', () => {
  const { applyCommit, recoverTransaction, snapshotWiki } = require(statePath);
  const { root, value, drifted } = prepareDriftedRebuild('deep wiki cancelled page drift ');
  withLock(root, (token) => assert.throws(
    () => recoverTransaction({ wikiRoot: root, token, operationId: OPERATION_ID }),
    (error) => error.code === 'TRANSACTION_CANCELLED',
  ));
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', 'index.json')), false);
  assert.equal(fs.readFileSync(path.join(root, 'pages', 'topic.md'), 'utf8'), drifted);
  assert.equal(fs.existsSync(transactionPath(root)), false);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.transaction-receipts', `${OPERATION_ID}.json`)), false);
  assert.doesNotThrow(() => snapshotWiki({ wikiRoot: root }));
  withLock(root, (token) => applyCommit({ wikiRoot: root, token, manifest: value, now: new Date(TS) }));
});

test('unchanged-source content drift cancels before compounding provenance', () => {
  const { recoverTransaction } = require(statePath);
  const root = fixture('deep wiki cancelled source drift ');
  seedUnchangedPage(root, 'topic.md', 'Topic', ['source-a']);
  const sourcePath = path.join(root, '.wiki-meta', 'sources', 'source-a.yaml');
  fs.writeFileSync(sourcePath, 'origin: original\ntype: file\n');
  stageInterrupted(root, rebuildManifest());
  const drifted = 'origin: external-change\ntype: file\n';
  fs.writeFileSync(sourcePath, drifted);
  withLock(root, (token) => assert.throws(
    () => recoverTransaction({ wikiRoot: root, token, operationId: OPERATION_ID }),
    (error) => error.code === 'TRANSACTION_CANCELLED',
  ));
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), drifted);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', 'index.json')), false);
  assert.equal(fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8'), '');
});

test('resume via plain commit (not recover) also rescans and cancels', () => {
  const { applyCommit } = require(statePath);
  const { root, value, drifted } = prepareDriftedRebuild('deep wiki plain recommit drift ');
  withLock(root, (token) => assert.throws(
    () => applyCommit({ wikiRoot: root, token, manifest: value, now: new Date(TS) }),
    (error) => error.code === 'TRANSACTION_CANCELLED',
  ));
  assert.equal(fs.readFileSync(path.join(root, 'pages', 'topic.md'), 'utf8'), drifted);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', 'index.json')), false);
});

test('a same-invocation catalog edit after staging cancels the fresh commit instead of publishing stale state', () => {
  const { applyCommit } = require(statePath);
  const root = fixture('deep wiki fresh same-call drift ');
  seedUnchangedPage(root, 'untouched.md', 'Untouched', []);
  const value = manifest();
  withLock(root, (token) => assert.throws(() => applyCommit({
    wikiRoot: root, token, manifest: value, now: new Date(TS),
    faultInjector(boundary) {
      if (boundary === 'after-transition-staged') {
        fs.writeFileSync(path.join(root, 'pages', 'untouched.md'), pageContent('Drifted Mid-Commit', []));
      }
    },
  }), (error) => error.code === 'TRANSACTION_CANCELLED'));
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', 'index.json')), false);
  assert.equal(fs.existsSync(path.join(root, 'pages', 'topic.md')), false);
  assert.match(fs.readFileSync(path.join(root, 'pages', 'untouched.md'), 'utf8'), /Drifted Mid-Commit/);
  assert.equal(fs.existsSync(transactionPath(root)), false);
});

test('authentic v1.8.2 interrupted journal recovers with legacy G1+G2 semantics', (t) => {
  const listing = spawnSync('git', [
    'ls-tree', '-r', '--name-only', '3ebe6bd', 'hooks/scripts/runtime',
  ], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8', shell: false });
  if (listing.status !== 0) {
    t.skip(`git show unavailable: ${listing.stderr.trim()}`);
    return;
  }
  const extraction = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki legacy runtime ')));
  roots.add(extraction);
  const files = [
    ...listing.stdout.trim().split('\n').filter(Boolean),
    'hooks/scripts/envelope.js',
    'hooks/scripts/read-index-envelope.js',
    '.claude-plugin/plugin.json',
  ];
  for (const relative of files) {
    const shown = spawnSync('git', ['show', `3ebe6bd:${relative}`], {
      cwd: path.resolve(__dirname, '..'), encoding: null, shell: false,
    });
    if (shown.status !== 0) {
      t.skip(`git show unavailable for ${relative}`);
      return;
    }
    const destination = path.join(extraction, relative);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, shown.stdout);
  }
  const legacy = require(path.join(extraction, 'hooks', 'scripts', 'runtime', 'wiki-state.js'));
  const current = require(statePath);
  const root = fixture('deep wiki legacy journal recovery ');
  const original = pageContent('Original Legacy', []);
  const drifted = pageContent('External Legacy Drift', []);
  fs.writeFileSync(path.join(root, 'pages', 'topic.md'), original);
  const value = rebuildManifest();
  withLock(root, (token) => assert.throws(() => legacy.applyCommit({
    wikiRoot: root, token, manifest: value, now: new Date(TS),
    faultInjector(boundary) { if (boundary === 'after-transition-staged') throw new Error('legacy stop'); },
  }), /legacy stop/));
  assert.equal(JSON.parse(fs.readFileSync(journalPath(root), 'utf8')).contract_version, 1);
  fs.writeFileSync(path.join(root, 'pages', 'topic.md'), drifted);
  withLock(root, (token) => assert.throws(
    () => current.recoverTransaction({ wikiRoot: root, token, operationId: OPERATION_ID }),
    (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED',
  ));
  assert.equal(fs.readFileSync(path.join(root, 'pages', 'topic.md'), 'utf8'), original);
  withLock(root, (token) => current.recoverTransaction({
    wikiRoot: root, token, operationId: OPERATION_ID,
  }));
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.transaction-receipts', `${OPERATION_ID}.json`)), true);
});

test('catalog_seal and tombstone tampering are rejected fail-closed', () => {
  const { applyCommit, recoverTransaction } = require(statePath);
  const sealCases = [
    ['sha mismatch', false, (journal) => { journal.catalog_seal[0].sha256 = '0'.repeat(64); }],
    ['duplicate path', true, (journal) => { journal.catalog_seal[1].relative_path = journal.catalog_seal[0].relative_path; }],
    ['artifact collision', true, (journal) => { journal.catalog_seal[0].relative_path = journal.artifacts[0].relative_path; }],
    ['negative cursor', true, (journal) => { journal.catalog_seal_cursor = -1; }],
    ['oversize cursor', true, (journal) => { journal.catalog_seal_cursor = journal.catalog_seal.length + 1; }],
    ['negative verify cursor', true, (journal) => { journal.verify_stage_cursor = -1; }],
    ['oversize verify cursor', true, (journal) => { journal.verify_stage_cursor = journal.artifacts.length + 1; }],
  ];
  for (const [name, reseal, mutate] of sealCases) {
    const root = fixture(`deep wiki catalog tamper ${name} `);
    seedUnchangedPage(root, 'page-a.md', 'A', []);
    seedUnchangedPage(root, 'page-b.md', 'B', []);
    stageInterrupted(root, rebuildManifest());
    const file = journalPath(root);
    const journal = JSON.parse(fs.readFileSync(file, 'utf8'));
    mutate(journal);
    if (reseal) journal.catalog_seal_sha256 = sha(Buffer.from(JSON.stringify(journal.catalog_seal)));
    fs.writeFileSync(file, `${JSON.stringify(journal)}\n`);
    const before = snapshotTransactionTree(root);
    const wikiBefore = artifactSnapshot(root);
    withLock(root, (token) => assert.throws(
      () => recoverTransaction({ wikiRoot: root, token, operationId: OPERATION_ID }),
      (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED',
    ));
    assert.deepEqual(snapshotTransactionTree(root), before, name);
    assert.deepEqual(artifactSnapshot(root), wikiBefore, name);
  }

  const tombstoneCases = [
    ['extra key', (value) => { value.extra = true; }],
    ['operation mismatch', (value) => { value.operation_id = '01JZ7P9Q6MD7S5PB8H4Y40HJ85'; }],
    ['unknown reason', (value) => { value.reason = 'unknown'; }],
    ['traversal drift', (value) => { value.drift = ['pages/../escape.md']; }],
  ];
  for (const [name, mutate] of tombstoneCases) {
    const { root, drifted } = prepareDriftedRebuild(`deep wiki tombstone tamper ${name} `);
    withLock(root, (token) => assert.throws(() => recoverTransaction({
      wikiRoot: root, token, operationId: OPERATION_ID,
      faultInjector(boundary) { if (boundary === 'after-cancel-tombstone') throw new Error('capture tombstone'); },
    }), /capture tombstone/));
    const tombstone = path.join(transactionPath(root), 'cancelled.json');
    const value = JSON.parse(fs.readFileSync(tombstone, 'utf8'));
    mutate(value);
    fs.writeFileSync(tombstone, `${JSON.stringify(value)}\n`);
    const before = snapshotTransactionTree(root);
    withLock(root, (token) => assert.throws(
      () => recoverTransaction({ wikiRoot: root, token, operationId: OPERATION_ID }),
      (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED',
    ));
    assert.deepEqual(snapshotTransactionTree(root), before, name);
    assert.equal(fs.readFileSync(path.join(root, 'pages', 'topic.md'), 'utf8'), drifted, name);
  }

  const { root, drifted } = prepareDriftedRebuild('deep wiki tombstone symlink tamper ');
  withLock(root, (token) => assert.throws(() => recoverTransaction({
    wikiRoot: root, token, operationId: OPERATION_ID,
    faultInjector(boundary) { if (boundary === 'after-cancel-tombstone') throw new Error('capture tombstone'); },
  }), /capture tombstone/));
  const tombstone = path.join(transactionPath(root), 'cancelled.json');
  const target = path.join(root, 'foreign-tombstone.json');
  fs.writeFileSync(target, fs.readFileSync(tombstone));
  fs.rmSync(tombstone);
  fs.symlinkSync(target, tombstone);
  const symlinkTree = snapshotTransactionTree(root);
  withLock(root, (token) => assert.throws(
    () => recoverTransaction({ wikiRoot: root, token, operationId: OPERATION_ID }),
    (error) => error.code === 'WIKI_STATE_FILESYSTEM',
  ));
  assert.deepEqual(snapshotTransactionTree(root), symlinkTree);
  assert.equal(fs.existsSync(journalPath(root)), true);
  assert.equal(fs.readFileSync(path.join(root, 'pages', 'topic.md'), 'utf8'), drifted);
});

test('cancel converges from every interruption point', () => {
  const { applyCommit, recoverTransaction, snapshotWiki, inspectWiki } = require(statePath);
  const finishCancel = (root, faultInjector) => withLock(root, (token) => assert.throws(
    () => recoverTransaction({ wikiRoot: root, token, operationId: OPERATION_ID, faultInjector }),
    (error) => error.code === 'TRANSACTION_CANCELLED',
  ));
  const assertCancelled = (root, drifted) => {
    assert.equal(fs.readFileSync(path.join(root, 'pages', 'topic.md'), 'utf8'), drifted);
    assert.equal(fs.existsSync(path.join(root, '.wiki-meta', 'index.json')), false);
    assert.equal(fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8'), '');
    assert.equal(fs.existsSync(transactionPath(root)), false);
    assert.doesNotThrow(() => snapshotWiki({ wikiRoot: root }));
  };

  const caseA = prepareDriftedRebuild('deep wiki cancel tombstone deadline ');
  const journalA = JSON.parse(fs.readFileSync(journalPath(caseA.root), 'utf8'));
  const clock = { now: 0, nowMs() { return this.now; } };
  const deadline = createDeadline({ clock, budgetMs: 12_000 });
  withLock(caseA.root, (token) => assert.throws(() => recoverTransaction({
    wikiRoot: caseA.root, token, operationId: OPERATION_ID, deadline,
    faultInjector(boundary) { if (boundary === 'after-cancel-tombstone') clock.now = 20_000; },
  }), (error) => error.code === 'DEADLINE_EXCEEDED'
      && error.boundary === `wiki-state:rollback:${journalA.artifacts.at(-1).key}`));
  finishCancel(caseA.root, (boundary) => {
    if (boundary.startsWith('catalog-seal-scan:')) throw new Error('scan must be skipped after tombstone');
  });
  assertCancelled(caseA.root, caseA.drifted);
  withLock(caseA.root, (token) => assert.throws(
    () => recoverTransaction({ wikiRoot: caseA.root, token, operationId: OPERATION_ID }),
    (error) => error.code === 'TRANSACTION_NOT_FOUND',
  ));

  const caseB = prepareDriftedRebuild('deep wiki cancel journal removed ');
  withLock(caseB.root, (token) => assert.throws(() => recoverTransaction({
    wikiRoot: caseB.root, token, operationId: OPERATION_ID,
    faultInjector(boundary) { if (boundary === 'after-cancel-journal-removed') throw new Error('journal removed stop'); },
  }), /journal removed stop/));
  assert.equal(fs.existsSync(journalPath(caseB.root)), false);
  assert.equal(fs.existsSync(path.join(transactionPath(caseB.root), 'cancelled.json')), true);
  finishCancel(caseB.root);
  assertCancelled(caseB.root, caseB.drifted);

  const caseD = prepareDriftedRebuild('deep wiki cancel residual resubmit ');
  withLock(caseD.root, (token) => assert.throws(() => recoverTransaction({
    wikiRoot: caseD.root, token, operationId: OPERATION_ID,
    faultInjector(boundary) { if (boundary === 'after-cancel-journal-removed') throw new Error('journal removed stop'); },
  }), /journal removed stop/));
  assert.equal(fs.existsSync(path.join(caseD.root, '.wiki-meta', 'index.json')), false);
  assert.equal(fs.readFileSync(path.join(caseD.root, 'log.jsonl'), 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(caseD.root, 'pages', 'topic.md'), 'utf8'), caseD.drifted);
  const lowClock = { now: 0, nowMs() { return this.now; } };
  const lowSweepDeadline = createDeadline({ clock: lowClock, budgetMs: 12_000 });
  lowClock.now = 2_001;
  withLock(caseD.root, (token) => applyCommit({
    wikiRoot: caseD.root, token, manifest: caseD.value, now: new Date(TS), deadline: lowSweepDeadline,
  }));
  assert.equal(fs.existsSync(transactionPath(caseD.root)), false);

  const caseE = prepareDriftedRebuild('deep wiki cancel teardown entry ');
  let stoppedDuringTeardown = false;
  withLock(caseE.root, (token) => assert.throws(() => recoverTransaction({
    wikiRoot: caseE.root, token, operationId: OPERATION_ID,
    faultInjector(boundary) {
      if (!stoppedDuringTeardown && boundary.startsWith('during-cancel-teardown:')) {
        stoppedDuringTeardown = true;
        throw new Error('teardown entry stop');
      }
    },
  }), /teardown entry stop/));
  assert.equal(stoppedDuringTeardown, true);
  assert.equal(fs.existsSync(path.join(transactionPath(caseE.root), 'cancelled.json')), true);
  finishCancel(caseE.root);
  assertCancelled(caseE.root, caseE.drifted);

  const caseF = prepareDriftedRebuild('deep wiki cancel tombstone removed ');
  withLock(caseF.root, (token) => assert.throws(() => recoverTransaction({
    wikiRoot: caseF.root, token, operationId: OPERATION_ID,
    faultInjector(boundary) { if (boundary === 'after-cancel-tombstone-removed') throw new Error('tombstone removed stop'); },
  }), /tombstone removed stop/));
  assert.doesNotThrow(() => snapshotWiki({ wikiRoot: caseF.root }));
  assert.doesNotThrow(() => inspectWiki({ wikiRoot: caseF.root }));
  assert.equal(fs.existsSync(path.join(caseF.root, '.wiki-meta', 'index.json')), false);
  assert.equal(fs.readFileSync(path.join(caseF.root, 'log.jsonl'), 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(caseF.root, 'pages', 'topic.md'), 'utf8'), caseF.drifted);
  const unrelated = rebuildManifest({
    operation_id: '01JZ7P9Q6MD7S5PB8H4Y40HJ85',
    events: [{
      ...rebuildManifest().events[0], event_id: '01JZ7P9Q6MD7S5PB8H4Y40HJ86',
    }],
  });
  withLock(caseF.root, (token) => applyCommit({
    wikiRoot: caseF.root, token, manifest: unrelated, now: new Date(TS),
  }));
  withLock(caseF.root, (token) => assert.throws(
    () => recoverTransaction({ wikiRoot: caseF.root, token, operationId: OPERATION_ID }),
    (error) => error.code === 'TRANSACTION_NOT_FOUND',
  ));
  assert.equal(fs.existsSync(transactionPath(caseF.root)), false);
  withLock(caseF.root, (token) => applyCommit({
    wikiRoot: caseF.root, token, manifest: caseF.value, now: new Date(TS),
  }));
});

test('corrupt staged data rolls every published artifact back to recorded before bytes', () => {
  const { applyCommit } = require(statePath);
  const root = fixture('deep wiki corrupt stage rollback ');
  withLock(root, (token) => assert.throws(() => applyCommit({
    wikiRoot: root, token, manifest: manifest(), now: new Date(TS),
    faultInjector(boundary) { if (boundary === 'after-publish-page-topic.md') throw new Error('stop'); },
  })));
  const stage = path.join(root, '.wiki-meta', '.transactions', OPERATION_ID, 'after', '0000.json');
  fs.writeFileSync(stage, 'corrupt\n');
  withLock(root, (token) => assert.throws(
    () => applyCommit({ wikiRoot: root, token, manifest: manifest(), now: new Date(TS) }),
    (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED',
  ));
  assert.equal(fs.existsSync(path.join(root, 'pages', 'topic.md')), false);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', 'sources', 'source-a.yaml')), false);
  assert.equal(fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8'), '');
});

test('an expired deadline surfaces a resumable boundary and recover completes', () => {
  const { applyCommit, recoverTransaction } = require(statePath);
  const baseline = fixture('deep wiki deadline baseline ');
  withLock(baseline, (token) => applyCommit({
    wikiRoot: baseline, token, manifest: manifest(), now: new Date(TS),
  }));
  const root = fixture('deep wiki deadline resume ');
  const clock = { now: 0, nowMs() { return this.now; } };
  const deadline = createDeadline({ clock, budgetMs: 12_000 });
  withLock(root, (token) => assert.throws(() => applyCommit({
    wikiRoot: root, token, manifest: manifest(), now: new Date(TS), deadline,
    faultInjector(boundary) {
      if (boundary === 'after-transition-staged') clock.now = 20_000;
    },
  }), (error) => error.code === 'DEADLINE_EXCEEDED'
      && error.boundary === 'wiki-state:verify-stage:page-topic.md'));
  withLock(root, (token) => recoverTransaction({
    wikiRoot: root, token, operationId: OPERATION_ID,
    deadline: createDeadline({ budgetMs: 12_000 }),
  }));
  assert.deepEqual(artifactSnapshot(root), artifactSnapshot(baseline));
});

test('staging deadline trips at the next artifact and resumes file-precise', () => {
  const { applyCommit, recoverTransaction } = require(statePath);
  const baseline = fixture('deep wiki staging deadline baseline ');
  withLock(baseline, (token) => applyCommit({
    wikiRoot: baseline, token, manifest: manifest(), now: new Date(TS),
  }));
  const root = fixture('deep wiki staging deadline resume ');
  const clock = { now: 0, nowMs() { return this.now; } };
  const deadline = createDeadline({ clock, budgetMs: 12_000 });
  withLock(root, (token) => assert.throws(() => applyCommit({
    wikiRoot: root, token, manifest: manifest(), now: new Date(TS), deadline,
    faultInjector(boundary) {
      if (boundary === 'after-stage-0-after') clock.now = 20_000;
    },
  }), (error) => error.code === 'DEADLINE_EXCEEDED'
      && error.boundary === 'wiki-state:stage:source-source-a'));
  withLock(root, (token) => recoverTransaction({
    wikiRoot: root, token, operationId: OPERATION_ID,
    deadline: createDeadline({ budgetMs: 12_000 }),
  }));
  assert.deepEqual(artifactSnapshot(root), artifactSnapshot(baseline));
});

test('verify-stage deadline recovery persists a resumable cursor across multiple deadlines', () => {
  const { applyCommit, recoverTransaction } = require(statePath);
  const value = manifest({
    pages: [
      { file: 'page-a.md', action: 'create', expected_sha256: null, content: pageContent('A', []) },
      { file: 'page-b.md', action: 'create', expected_sha256: null, content: pageContent('B', []) },
      { file: 'page-c.md', action: 'create', expected_sha256: null, content: pageContent('C', []) },
    ],
    sources: [],
    events: [{ ...manifest().events[0], pages_created: ['page-a.md', 'page-b.md', 'page-c.md'] }],
  });
  const root = fixture('deep wiki verify cursor resume ');
  stageInterrupted(root, value);
  let journal = JSON.parse(fs.readFileSync(journalPath(root), 'utf8'));
  assert.equal(journal.artifacts.length, 7);
  assert.equal(journal.verify_stage_cursor, 0);

  const clock = { now: 0, nowMs() { return this.now; } };
  const deadline = createDeadline({ clock, budgetMs: 12_000 });
  withLock(root, (token) => assert.throws(() => recoverTransaction({
    wikiRoot: root, token, operationId: OPERATION_ID, deadline,
    faultInjector(boundary) {
      if (boundary === 'verify-stage-scan:page-page-b.md') clock.now = 20_000;
    },
  }), (error) => error.code === 'DEADLINE_EXCEEDED'
      && error.boundary === 'wiki-state:verify-stage:page-page-b.md'));
  journal = JSON.parse(fs.readFileSync(journalPath(root), 'utf8'));
  assert.equal(journal.verify_stage_cursor, 1);

  const observed = [];
  withLock(root, (token) => recoverTransaction({
    wikiRoot: root, token, operationId: OPERATION_ID,
    faultInjector(boundary) {
      if (boundary.startsWith('verify-stage-scan:')) observed.push(boundary.slice('verify-stage-scan:'.length));
    },
  }));
  assert.equal(observed.includes('page-page-a.md'), false);
  assert.equal(observed.includes('page-page-b.md'), true);
  assert.equal(fs.existsSync(path.join(root, 'pages', 'page-a.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'pages', 'page-b.md')), true);
  assert.equal(fs.existsSync(path.join(root, 'pages', 'page-c.md')), true);
  assert.equal(fs.existsSync(transactionPath(root)), false);
});

test('deadline expiry inside the catalog scan persists the cursor; resumed scan reaches the drift and cancels', () => {
  const { recoverTransaction } = require(statePath);
  const root = fixture('deep wiki catalog cursor resume ');
  for (let index = 0; index < 12; index += 1) {
    seedUnchangedPage(root, `page-${String(index).padStart(2, '0')}.md`, `Page ${index}`, []);
  }
  stageInterrupted(root, rebuildManifest());
  let journal = JSON.parse(fs.readFileSync(journalPath(root), 'utf8'));
  const paths = journal.catalog_seal.map((entry) => entry.relative_path);
  assert.equal(paths.length, 12);
  const seventh = paths[6];
  const ninth = paths[8];
  fs.writeFileSync(path.join(root, ...ninth.split('/')), pageContent('Externally Drifted', []));
  const clock = { now: 0, nowMs() { return this.now; } };
  const deadline = createDeadline({ clock, budgetMs: 12_000 });
  withLock(root, (token) => assert.throws(() => recoverTransaction({
    wikiRoot: root, token, operationId: OPERATION_ID, deadline,
    faultInjector(boundary) {
      if (boundary === `catalog-seal-scan:${seventh}`) clock.now = 20_000;
    },
  }), (error) => error.code === 'DEADLINE_EXCEEDED'
      && error.boundary === `wiki-state:catalog-seal:${seventh}`));
  journal = JSON.parse(fs.readFileSync(journalPath(root), 'utf8'));
  assert.equal(journal.catalog_seal_cursor, 6);
  const observed = [];
  withLock(root, (token) => assert.throws(() => recoverTransaction({
    wikiRoot: root, token, operationId: OPERATION_ID,
    faultInjector(boundary) {
      if (boundary.startsWith('catalog-seal-scan:')) observed.push(boundary.slice('catalog-seal-scan:'.length));
    },
  }), (error) => error.code === 'TRANSACTION_CANCELLED'));
  for (const prior of paths.slice(0, 6)) assert.equal(observed.includes(prior), false, prior);
  assert.equal(observed.includes(ninth), true);
  assert.match(fs.readFileSync(path.join(root, ...ninth.split('/')), 'utf8'), /Externally Drifted/);
  assert.equal(fs.existsSync(transactionPath(root)), false);
});

test('unchanged-source deletion cancels; provenance is never built upon', () => {
  const { applyCommit, snapshotWiki, inspectWiki } = require(statePath);
  const root = fixture('deep wiki deleted source cancel ');
  seedUnchangedPage(root, 'existing.md', 'Existing', ['source-a']);
  const sourcePath = path.join(root, '.wiki-meta', 'sources', 'source-a.yaml');
  const sourceBytes = 'origin: source-a\ntype: file\n';
  fs.writeFileSync(sourcePath, sourceBytes);
  const value = manifest({
    pages: [{
      file: 'topic.md', action: 'create', expected_sha256: null,
      content: pageContent('New Topic', ['source-new']),
    }],
    sources: [{ slug: 'source-new', content: 'origin: source-new\ntype: file\n' }],
    events: [{ ...manifest().events[0], source: 'source-new' }],
  });
  stageInterrupted(root, value);
  fs.rmSync(sourcePath);
  const owner = acquireLock({ wikiRoot: root, operation: 'deleted-source-recover', now: new Date(TS) });
  try {
    const recovered = spawnSync(process.execPath, [
      cli, 'transaction', 'recover', '--wiki-root', root, '--lock-token', owner.token,
      '--operation-id', OPERATION_ID, '--json',
    ], { encoding: 'utf8', shell: false });
    assert.equal(recovered.status, 4, recovered.stderr);
    assert.match(recovered.stderr, /TRANSACTION_CANCELLED/);
  } finally { releaseLock({ wikiRoot: root, token: owner.token }); }
  assert.equal(fs.existsSync(transactionPath(root)), false);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.transaction-receipts', `${OPERATION_ID}.json`)), false);
  assert.equal(fs.existsSync(path.join(root, 'pages', 'topic.md')), false);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', 'sources', 'source-new.yaml')), false);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', 'index.json')), false);
  assert.equal(fs.readFileSync(path.join(root, 'index.md'), 'utf8'), '# Wiki Index\n');
  assert.equal(fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8'), '');
  assert.equal(fs.readFileSync(path.join(root, 'log.md'), 'utf8'), '# Wiki Log\n');
  assert.doesNotThrow(() => snapshotWiki({ wikiRoot: root }));
  assert.equal(inspectWiki({ wikiRoot: root }).issues.some((issue) => issue.code === 'MISSING_SOURCE'
    && issue.source === 'source-a'), true);
  fs.writeFileSync(sourcePath, sourceBytes);
  withLock(root, (token) => applyCommit({ wikiRoot: root, token, manifest: value, now: new Date(TS) }));
});

test('transaction recover removes the recovered operation\'s runtime manifest under lock', () => {
  const root = fixture('deep wiki runtime manifest recover cleanup ');
  const runtimeDirectory = path.join(root, '.wiki-meta', '.runtime');
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const targetManifest = path.join(runtimeDirectory, `${OPERATION_ID}.json`);
  const unrelatedManifest = path.join(runtimeDirectory, 'unrelated-op.json');
  const strayFile = path.join(runtimeDirectory, 'not-json.txt');
  fs.writeFileSync(targetManifest, JSON.stringify({ operation_id: OPERATION_ID }));
  fs.writeFileSync(unrelatedManifest, JSON.stringify({ operation_id: 'unrelated-operation-id' }));
  fs.writeFileSync(strayFile, 'not json\n');
  stageInterrupted(root, manifest());
  const owner = acquireLock({ wikiRoot: root, operation: 'runtime-cleanup-recover', now: new Date(TS) });
  try {
    const recovered = spawnSync(process.execPath, [
      cli, 'transaction', 'recover', '--wiki-root', root, '--lock-token', owner.token,
      '--operation-id', OPERATION_ID, '--json',
    ], { encoding: 'utf8', shell: false });
    assert.equal(recovered.status, 0, recovered.stderr);
  } finally { releaseLock({ wikiRoot: root, token: owner.token }); }
  assert.equal(fs.existsSync(targetManifest), false);
  assert.equal(fs.existsSync(unrelatedManifest), true);
  assert.equal(fs.existsSync(strayFile), true);
});

test('cleanup helper refuses under a replaced lock owner', () => {
  const { cleanupRuntimeManifests } = require('../scripts/wiki-runtime.js');
  const root = fixture('deep wiki runtime cleanup lock seizure ');
  const runtimeDirectory = path.join(root, '.wiki-meta', '.runtime');
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const targetManifest = path.join(runtimeDirectory, `${OPERATION_ID}.json`);
  fs.writeFileSync(targetManifest, JSON.stringify({ operation_id: OPERATION_ID }));
  const owner = acquireLock({ wikiRoot: root, operation: 'runtime-cleanup-direct', now: new Date(TS) });
  cleanupRuntimeManifests(root, owner.token, OPERATION_ID);
  assert.equal(fs.existsSync(targetManifest), false);

  fs.writeFileSync(targetManifest, JSON.stringify({ operation_id: OPERATION_ID }));
  const ownerPath = path.join(root, '.wiki-meta', '.wiki-lock', 'owner.json');
  const seized = { ...JSON.parse(fs.readFileSync(ownerPath, 'utf8')), token: 'f'.repeat(64) };
  fs.writeFileSync(ownerPath, `${JSON.stringify(seized)}\n`);
  assert.throws(
    () => cleanupRuntimeManifests(root, owner.token, OPERATION_ID),
    (error) => error.code === 'LOCK_TOKEN_MISMATCH',
  );
  assert.equal(fs.existsSync(targetManifest), true);
});

function shellArgvAfterPrefix(commandLine, prefix) {
  assert.ok(commandLine.startsWith(prefix), commandLine);
  const rest = commandLine.slice(prefix.length).replace('<token>', 'stub-token');
  const script = `node -e "console.log(JSON.stringify(process.argv))" -- ${rest}`;
  const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

function argAfterFlag(argv, flag) {
  const index = argv.indexOf(flag);
  assert.ok(index !== -1, JSON.stringify(argv));
  return argv[index + 1];
}

function decodePowershellSingleQuoted(token) {
  assert.ok(token.startsWith("'") && token.endsWith("'"), token);
  return token.slice(1, -1).replace(/''/g, "'");
}

function extractQuotedFlagValue(commandLine, flag) {
  const marker = `${flag} '`;
  const start = commandLine.indexOf(marker);
  assert.ok(start !== -1, commandLine);
  const openQuoteIndex = start + marker.length - 1;
  let cursor = openQuoteIndex + 1;
  while (cursor < commandLine.length) {
    if (commandLine[cursor] === "'") {
      if (commandLine[cursor + 1] === "'") { cursor += 2; continue; }
      return commandLine.slice(openQuoteIndex, cursor + 1);
    }
    cursor += 1;
  }
  throw new Error(`unterminated quoted value for ${flag}`);
}

function posixQuote(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function nodeCommandLines(text) {
  return String(text).split('\n').map((line) => line.trim()).filter((line) => line.startsWith('node '));
}

function recoverRuntimePrefix() {
  return `node ${posixQuote(cli)} `;
}

test('recover hint is appended to a DEADLINE_EXCEEDED commit failure and exit code stays 5', { skip: process.platform === 'win32' ? 'POSIX hint-label assertion; win32 label covered by the platform-mock tests' : false }, () => {
  const { main, recoverHint } = require('../scripts/wiki-runtime.js');
  const wikiRuntimeState = require('../hooks/scripts/runtime/wiki-state.js');
  const { DeadlineExceeded } = require('../hooks/scripts/runtime/deadline.js');

  const root = fixture('deep wiki recover hint stub ');
  const manifestFile = path.join(root, 'stub-manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ operation_id: OPERATION_ID }));

  assert.equal(
    recoverHint(root, OPERATION_ID),
    `resume with:\n${recoverRuntimePrefix()}transaction recover --wiki-root '${root}' --lock-token <token> --operation-id '${OPERATION_ID}' --json`,
  );

  const originalApplyCommit = wikiRuntimeState.applyCommit;
  const originalWrite = process.stderr.write;
  const chunks = [];
  wikiRuntimeState.applyCommit = () => {
    const transactionDir = path.join(root, '.wiki-meta', '.transactions', OPERATION_ID);
    fs.mkdirSync(transactionDir, { recursive: true });
    fs.writeFileSync(path.join(transactionDir, 'journal.json'), JSON.stringify({ operation_id: OPERATION_ID }));
    throw new DeadlineExceeded('wiki-state:catalog-seal:pages/x.md');
  };
  process.stderr.write = (chunk) => { chunks.push(chunk); return true; };
  let exitCode;
  try {
    exitCode = main([
      'commit', '--wiki-root', root, '--lock-token', 'stub-token',
      '--manifest-file', manifestFile, '--json',
    ]);
  } finally {
    wikiRuntimeState.applyCommit = originalApplyCommit;
    process.stderr.write = originalWrite;
  }
  assert.equal(exitCode, 5);
  const stderr = chunks.join('');
  assert.ok(stderr.startsWith(
    'DEADLINE_EXCEEDED: DEADLINE_EXCEEDED at wiki-state:catalog-seal:pages/x.md — resume with:\n',
  ));
  assert.ok(stderr.includes(
    `${recoverRuntimePrefix()}transaction recover --wiki-root '${root}' --lock-token <token> --operation-id '${OPERATION_ID}' --json`,
  ));
});

test('recoverHint shell-escapes adversarial wiki roots and operation ids', (t) => {
  const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  if (probe.status !== 0) { t.skip('bash unavailable for POSIX shell-quoting verification'); return; }
  const { recoverHint } = require('../scripts/wiki-runtime.js');
  const adversarial = [
    '/tmp/deep wiki has space',
    '/tmp/deep wiki has"quote',
    "/tmp/deep wiki has'quote",
    '/tmp/deep wiki $(printf shell-injection-probe)',
    '/tmp/deep wiki `printf shell-injection-probe`',
    '/tmp/deep wiki has\nnewline',
  ];
  for (const value of adversarial) {
    const hint = recoverHint(value, value);
    const commandLine = hint.slice(hint.indexOf('\n') + 1);
    const argv = shellArgvAfterPrefix(commandLine, `${recoverRuntimePrefix()}transaction recover `);
    assert.equal(argAfterFlag(argv, '--wiki-root'), path.resolve(value));
    assert.equal(argAfterFlag(argv, '--operation-id'), value);
  }
});

test('commitRetryHint shell-escapes adversarial wiki roots and manifest paths', (t) => {
  const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  if (probe.status !== 0) { t.skip('bash unavailable for POSIX shell-quoting verification'); return; }
  const { commitRetryHint } = require('../scripts/wiki-runtime.js');
  const adversarial = [
    '/tmp/deep wiki has space',
    '/tmp/deep wiki has"quote',
    "/tmp/deep wiki has'quote",
    '/tmp/deep wiki $(printf shell-injection-probe)',
    '/tmp/deep wiki `printf shell-injection-probe`',
    '/tmp/deep wiki has\nnewline',
  ];
  for (const value of adversarial) {
    const hint = commitRetryHint(value, value);
    const commandLine = hint.slice(hint.indexOf('\n') + 1);
    const argv = shellArgvAfterPrefix(commandLine, 'node scripts/wiki-runtime.js commit ');
    assert.equal(argAfterFlag(argv, '--wiki-root'), path.resolve(value));
    assert.equal(argAfterFlag(argv, '--manifest-file'), path.resolve(value));
  }
});

test('shellQuote renders a PowerShell-safe literal on win32 for adversarial characters', () => {
  const { recoverHint, commitRetryHint } = require('../scripts/wiki-runtime.js');
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const adversarial = [
      'C:\\Deep Wiki has space',
      'C:\\Deep Wiki & evil',
      'C:\\Deep Wiki %PATH%',
      'C:\\Deep Wiki "quoted"',
      "C:\\Deep Wiki has'quote",
      'C:\\Deep Wiki ^caret',
      'C:\\Deep Wiki\nnewline',
    ];
    const quotedRuntime = `'${cli.replace(/'/g, "''")}'`;
    for (const value of adversarial) {
      const hint = recoverHint(value, value);
      assert.ok(hint.startsWith('resume with (PowerShell):\n'), hint);
      const commandLine = hint.split('\n').slice(1).join('\n');
      assert.ok(commandLine.startsWith(`node ${quotedRuntime} transaction recover `), commandLine);
      assert.match(commandLine, /--lock-token <token>/);
      const wikiRootValue = decodePowershellSingleQuoted(extractQuotedFlagValue(commandLine, '--wiki-root'));
      assert.equal(wikiRootValue, path.resolve(value));
      const operationIdValue = decodePowershellSingleQuoted(extractQuotedFlagValue(commandLine, '--operation-id'));
      assert.equal(operationIdValue, value);

      const tokenless = recoverHint(value, value, { includeLockToken: false });
      assert.ok(tokenless.startsWith('resume with (PowerShell):\n'), tokenless);
      const tokenlessLine = tokenless.split('\n').slice(1).join('\n');
      assert.ok(tokenlessLine.startsWith(`node ${quotedRuntime} transaction recover `), tokenlessLine);
      assert.equal(tokenlessLine.includes('--lock-token'), false);

      const retryHint = commitRetryHint(value, value);
      assert.ok(retryHint.startsWith('rerun with (PowerShell):\n'), retryHint);
      const retryLine = retryHint.split('\n').slice(1).join('\n');
      const retryRootValue = decodePowershellSingleQuoted(extractQuotedFlagValue(retryLine, '--wiki-root'));
      assert.equal(retryRootValue, path.resolve(value));
      const manifestValue = decodePowershellSingleQuoted(extractQuotedFlagValue(retryLine, '--manifest-file'));
      assert.equal(manifestValue, path.resolve(value));
    }
  } finally {
    Object.defineProperty(process, 'platform', originalDescriptor);
  }
});

test('oversizedHint reuses the isolatable predicate and quotes every argv value', (t) => {
  const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  if (probe.status !== 0) { t.skip('bash unavailable for POSIX shell-quoting verification'); return; }
  const runtime = require('../scripts/wiki-runtime.js');
  const debris = require('../hooks/scripts/runtime/transaction-debris.js');
  const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-wiki-hint-sentinel-'));
  roots.add(sentinelDir);
  const sentinel = path.join(sentinelDir, 'SIDE_EFFECT');
  const adversarial = [
    `/tmp/deep wiki has space`,
    `/tmp/deep wiki has"quote`,
    `/tmp/deep wiki has'quote`,
    `/tmp/deep wiki $(printf shell-injection-probe)`,
    `/tmp/deep wiki; touch ${sentinel}`,
    `/tmp/deep wiki & echo amp`,
    `/tmp/deep wiki %PATH%`,
    `/tmp/deep wiki has\nnewline`,
  ];
  const isolatableName = `scan-window-ensure-${'ab'.repeat(20)}`;
  for (const value of adversarial) {
    const hint = runtime.oversizedHint({
      code: 'TRANSACTION_OVERSIZED',
      operationId: isolatableName,
      wikiRoot: value,
    });
    assert.match(hint, /transaction quarantine/);
    const commandLine = hint.slice(hint.indexOf('transaction quarantine'));
    const argv = shellArgvAfterPrefix(`node scripts/wiki-runtime.js ${commandLine}`, 'node scripts/wiki-runtime.js transaction quarantine ');
    assert.equal(argAfterFlag(argv, '--wiki-root'), path.resolve(value));
    assert.equal(argAfterFlag(argv, '--operation-id'), isolatableName);
  }
  assert.equal(fs.existsSync(sentinel), false);

  const ulidHint = runtime.oversizedHint({
    code: 'TRANSACTION_OVERSIZED',
    operationId: OPERATION_ID,
    wikiRoot: '/tmp/wiki',
  });
  assert.match(ulidHint, /pure ULID is not automatically isolatable/);
  assert.equal(ulidHint.includes('transaction quarantine'), false);
  assert.equal(debris.isIsolatableStoreName('.prune-oversized', scanWindow.operationIdFromPruneName), false);
  const pruneHint = runtime.oversizedHint({
    code: 'TRANSACTION_OVERSIZED',
    operationId: '.prune-oversized',
    wikiRoot: '/tmp/wiki',
  });
  assert.match(pruneHint, /not automatically isolatable/);
  assert.doesNotMatch(pruneHint, /pure ULID/);
  assert.equal(pruneHint.includes('transaction quarantine'), false);
  const otherHint = runtime.oversizedHint({
    code: 'TRANSACTION_OVERSIZED',
    operationId: 'not-a-transaction',
    wikiRoot: `/tmp/deep wiki; touch ${sentinel}`,
  });
  assert.match(otherHint, /not automatically isolatable/);
  assert.doesNotMatch(otherHint, /pure ULID/);
  assert.equal(otherHint.includes('transaction quarantine'), false);
  assert.equal(fs.existsSync(sentinel), false);

  const rollbackHint = runtime.oversizedHint({
    code: 'TRANSACTION_OVERSIZED',
    operationId: 'rollback-01JZ7P9Q6MD7S5PB8H4Y40HJ83',
    wikiRoot: `/tmp/deep wiki; touch ${sentinel}`,
  });
  assert.match(rollbackHint, /rollback remnant/);
  assert.match(rollbackHint, /transaction recover/);
  assert.match(rollbackHint, /--wiki-root/);
  assert.match(rollbackHint, /--operation-id/);
  assert.doesNotMatch(rollbackHint, /then transaction recover --operation-id/);
  assert.equal(fs.existsSync(sentinel), false);
});

test('rollback quarantine follow_up is a self-locking recover that snapshot can execute', () => {
  const root = fixture('deep wiki rollback follow up ');
  stageInterrupted(root, manifest());
  const rollbackName = `rollback-${OPERATION_ID}`;
  fs.mkdirSync(path.join(root, '.wiki-meta', '.transactions', rollbackName), { recursive: true });
  fs.writeFileSync(path.join(root, '.wiki-meta', '.transactions', rollbackName, 'journal.json'), '{}\n');

  const quarantined = spawnSync(process.execPath, [
    cli, 'transaction', 'quarantine',
    '--wiki-root', root, '--operation-id', rollbackName, '--json',
  ], { encoding: 'utf8', shell: false });
  assert.equal(quarantined.status, 0, quarantined.stderr);
  const payload = JSON.parse(quarantined.stdout);
  assert.equal(payload.status, 'quarantined');
  assert.deepEqual(payload.follow_up_argv, [
    'transaction', 'recover', '--wiki-root', root, '--operation-id', OPERATION_ID, '--json',
  ]);
  assert.match(payload.follow_up, /--wiki-root/);
  assert.doesNotMatch(payload.follow_up, /--lock-token/);

  const recovered = spawnSync('bash', ['-c', payload.follow_up], {
    cwd: os.tmpdir(), encoding: 'utf8', shell: false,
  });
  assert.equal(recovered.status, 0, recovered.stderr);

  const snapshot = spawnSync(process.execPath, [
    cli, 'snapshot', '--wiki-root', root, '--json',
  ], { encoding: 'utf8', shell: false });
  assert.equal(snapshot.status, 0, snapshot.stderr);

  const status = spawnSync(process.execPath, [
    cli, 'lock', 'status', '--wiki-root', root, '--json',
  ], { encoding: 'utf8', shell: false });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(JSON.parse(status.stdout).locked, false);
});

test('rollback follow_up quotes a hostile wiki root and remains executable', (t) => {
  const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  if (probe.status !== 0) { t.skip('bash unavailable for POSIX shell-quoting verification'); return; }
  const root = fixture('deep wiki follow \'up $(printf injected) ');
  stageInterrupted(root, manifest());
  const rollbackName = `rollback-${OPERATION_ID}`;
  fs.mkdirSync(path.join(root, '.wiki-meta', '.transactions', rollbackName), { recursive: true });
  fs.writeFileSync(path.join(root, '.wiki-meta', '.transactions', rollbackName, 'journal.json'), '{}\n');
  const quarantined = spawnSync(process.execPath, [
    cli, 'transaction', 'quarantine',
    '--wiki-root', root, '--operation-id', rollbackName, '--json',
  ], { encoding: 'utf8', shell: false });
  assert.equal(quarantined.status, 0, quarantined.stderr);
  const payload = JSON.parse(quarantined.stdout);
  const argv = shellArgvAfterPrefix(payload.follow_up, `node ${posixQuote(cli)} transaction recover `);
  assert.equal(argAfterFlag(argv, '--wiki-root'), path.resolve(root));
  assert.equal(argAfterFlag(argv, '--operation-id'), OPERATION_ID);
  assert.equal(argv.includes('--lock-token'), false);

  const recovered = spawnSync('bash', ['-c', payload.follow_up], {
    cwd: os.tmpdir(), encoding: 'utf8', shell: false,
  });
  assert.equal(recovered.status, 0, recovered.stderr);
  const snapshot = spawnSync(process.execPath, [
    cli, 'snapshot', '--wiki-root', root, '--json',
  ], { encoding: 'utf8', shell: false });
  assert.equal(snapshot.status, 0, snapshot.stderr);
  const status = spawnSync(process.execPath, [
    cli, 'lock', 'status', '--wiki-root', root, '--json',
  ], { encoding: 'utf8', shell: false });
  assert.equal(JSON.parse(status.stdout).locked, false);
});

test('oversizedHint emits a complete executable runtime command without a synthetic prefix', {
  skip: process.platform === 'win32' ? 'POSIX exact-command execution; win32 label covered by the platform-mock tests' : false,
}, (t) => {
  const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  if (probe.status !== 0) { t.skip('bash unavailable for exact-command execution'); return; }
  const { oversizedHint } = require('../scripts/wiki-runtime.js');
  const root = fixture('deep wiki oversized hint exec ');
  const isolatableName = `scan-window-ensure-${'ab'.repeat(20)}`;
  fs.mkdirSync(path.join(root, '.wiki-meta', '.transactions', isolatableName), { recursive: true });
  fs.writeFileSync(path.join(root, '.wiki-meta', '.transactions', isolatableName, 'journal.json'), '{}\n');
  const hint = oversizedHint({
    code: 'TRANSACTION_OVERSIZED',
    operationId: isolatableName,
    wikiRoot: root,
  });
  const quotedRuntime = posixQuote(cli);
  assert.match(hint, /TRANSACTION_OVERSIZED is isolatable\. Run:\nnode /);
  const commands = nodeCommandLines(hint);
  assert.equal(commands.length, 1, hint);
  assert.ok(commands[0].startsWith(`node ${quotedRuntime} transaction quarantine `), commands[0]);
  const executed = spawnSync('bash', ['-c', commands[0]], { encoding: 'utf8' });
  assert.notEqual(executed.status, 127, executed.stderr);
  assert.equal(executed.status, 0, executed.stderr);
  const payload = JSON.parse(executed.stdout);
  assert.equal(payload.status, 'quarantined');
});

test('oversizedHint rollback commands are independently copyable complete runtime invocations', {
  skip: process.platform === 'win32' ? 'POSIX exact-command execution; win32 label covered by the platform-mock tests' : false,
}, (t) => {
  const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  if (probe.status !== 0) { t.skip('bash unavailable for exact-command execution'); return; }
  const { oversizedHint } = require('../scripts/wiki-runtime.js');
  const root = fixture('deep wiki oversized rollback hint exec ');
  const rollbackName = `rollback-${OPERATION_ID}`;
  fs.mkdirSync(path.join(root, '.wiki-meta', '.transactions', rollbackName), { recursive: true });
  fs.writeFileSync(path.join(root, '.wiki-meta', '.transactions', rollbackName, 'journal.json'), '{}\n');
  const hint = oversizedHint({
    code: 'TRANSACTION_OVERSIZED',
    operationId: rollbackName,
    wikiRoot: root,
  });
  const quotedRuntime = posixQuote(cli);
  assert.match(hint, /rollback remnant/);
  const commands = nodeCommandLines(hint);
  assert.equal(commands.length, 2, hint);
  assert.ok(commands[0].startsWith(`node ${quotedRuntime} transaction quarantine `), commands[0]);
  assert.ok(commands[1].startsWith(`node ${quotedRuntime} transaction recover `), commands[1]);
  assert.equal(commands[1].includes('--lock-token'), false, commands[1]);
  const quarantined = spawnSync('bash', ['-c', commands[0]], { encoding: 'utf8' });
  assert.notEqual(quarantined.status, 127, quarantined.stderr);
  assert.equal(quarantined.status, 0, quarantined.stderr);
  const recovered = spawnSync('bash', ['-c', commands[1]], { encoding: 'utf8' });
  assert.notEqual(recovered.status, 127, recovered.stderr);
});

test('oversizedHint renders a PowerShell-safe literal on win32 for adversarial characters', () => {
  const { oversizedHint } = require('../scripts/wiki-runtime.js');
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const adversarial = [
      'C:\\Deep Wiki has space',
      'C:\\Deep Wiki & evil',
      'C:\\Deep Wiki %PATH%',
      'C:\\Deep Wiki "quoted"',
      "C:\\Deep Wiki has'quote",
      'C:\\Deep Wiki ^caret',
      'C:\\Deep Wiki\nnewline',
    ];
    const isolatableName = `scan-window-ensure-${'cd'.repeat(20)}`;
    for (const value of adversarial) {
      const hint = oversizedHint({
        code: 'TRANSACTION_OVERSIZED',
        operationId: isolatableName,
        wikiRoot: value,
      });
      assert.match(hint, /\(PowerShell\)/);
      const wikiRootValue = decodePowershellSingleQuoted(extractQuotedFlagValue(hint, '--wiki-root'));
      assert.equal(wikiRootValue, path.resolve(value));
      const operationIdValue = decodePowershellSingleQuoted(extractQuotedFlagValue(hint, '--operation-id'));
      assert.equal(operationIdValue, isolatableName);
    }
    const rollbackHint = oversizedHint({
      code: 'TRANSACTION_OVERSIZED',
      operationId: `rollback-${OPERATION_ID}`,
      wikiRoot: adversarial[0],
    });
    assert.match(rollbackHint, /\(PowerShell\)/);
    assert.match(rollbackHint, /transaction recover/);
  } finally {
    Object.defineProperty(process, 'platform', originalDescriptor);
  }
});

test('rollback follow_up is labeled (PowerShell) on win32 and round-trips quoting', () => {
  const debris = require('../hooks/scripts/runtime/transaction-debris.js');
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  try {
    const command = debris.followUpRecoverCommand('C:\\Deep Wiki & evil "quoted"', OPERATION_ID);
    assert.match(command, /\(PowerShell\)/);
    assert.ok(command.includes(`node '${cli.replace(/'/g, "''")}' transaction recover `), command);
    const argv = debris.followUpRecoverArgv('C:\\Deep Wiki & evil "quoted"', OPERATION_ID);
    assert.deepEqual(argv, [
      'transaction', 'recover',
      '--wiki-root', path.resolve('C:\\Deep Wiki & evil "quoted"'),
      '--operation-id', OPERATION_ID,
      '--json',
    ]);
    const wikiRootValue = decodePowershellSingleQuoted(extractQuotedFlagValue(command, '--wiki-root'));
    assert.equal(wikiRootValue, path.resolve('C:\\Deep Wiki & evil "quoted"'));
  } finally {
    Object.defineProperty(process, 'platform', originalDescriptor);
  }
});

test('shellQuote (Windows) round-trips through a real PowerShell when available', (t) => {
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const probe = spawnSync(shell, ['-NoProfile', '-Command', 'Write-Output ok'], { encoding: 'utf8' });
  if (probe.status !== 0 || probe.error) { t.skip(`${shell} unavailable for real PowerShell round-trip`); return; }
  const { recoverHint } = require('../scripts/wiki-runtime.js');
  const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  let hint;
  try { hint = recoverHint('C:\\Deep Wiki & evil "quoted"', 'OP-ID'); }
  finally { Object.defineProperty(process, 'platform', originalDescriptor); }
  const commandLine = hint.split('\n').slice(1).join('\n');
  const wikiRootToken = extractQuotedFlagValue(commandLine, '--wiki-root');
  const script = `Write-Output ${wikiRootToken}`;
  const result = spawnSync(shell, ['-NoProfile', '-Command', script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), decodePowershellSingleQuoted(wikiRootToken));
});

test('tokenless recover DEADLINE_EXCEEDED emits a self-locking retry and releases the lock', {
  skip: process.platform === 'win32' ? 'POSIX hint-label assertion; win32 label covered by the platform-mock tests' : false,
}, () => {
  const { main } = require('../scripts/wiki-runtime.js');
  const wikiRuntimeState = require('../hooks/scripts/runtime/wiki-state.js');
  const { DeadlineExceeded } = require('../hooks/scripts/runtime/deadline.js');
  const root = fixture('deep wiki tokenless recover deadline ');
  const originalRecover = wikiRuntimeState.recoverTransaction;
  const originalWrite = process.stderr.write;
  const chunks = [];
  wikiRuntimeState.recoverTransaction = () => {
    throw new DeadlineExceeded('transaction-recover');
  };
  process.stderr.write = (chunk) => { chunks.push(chunk); return true; };
  let exitCode;
  try {
    exitCode = main([
      'transaction', 'recover', '--wiki-root', root, '--operation-id', OPERATION_ID, '--json',
    ]);
  } finally {
    wikiRuntimeState.recoverTransaction = originalRecover;
    process.stderr.write = originalWrite;
  }
  assert.equal(exitCode, 5);
  const stderr = chunks.join('');
  assert.match(stderr, /DEADLINE_EXCEEDED/);
  assert.ok(stderr.includes(`resume with:\n${recoverRuntimePrefix()}transaction recover `), stderr);
  assert.doesNotMatch(stderr, /--lock-token/);
  assert.match(stderr, new RegExp(`--wiki-root '${root.replace(/'/g, "'\\\\''")}'`));
  assert.match(stderr, new RegExp(`--operation-id '${OPERATION_ID}'`));
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
});

test('token-injected recover DEADLINE_EXCEEDED keeps the lock-token hint and leaves the lock held', {
  skip: process.platform === 'win32' ? 'POSIX hint-label assertion; win32 label covered by the platform-mock tests' : false,
}, () => {
  const { main } = require('../scripts/wiki-runtime.js');
  const wikiRuntimeState = require('../hooks/scripts/runtime/wiki-state.js');
  const { DeadlineExceeded } = require('../hooks/scripts/runtime/deadline.js');
  const root = fixture('deep wiki injected recover deadline ');
  const owner = acquireLock({ wikiRoot: root, operation: 'injected-recover-deadline', now: new Date(TS) });
  const originalRecover = wikiRuntimeState.recoverTransaction;
  const originalWrite = process.stderr.write;
  const chunks = [];
  wikiRuntimeState.recoverTransaction = () => {
    throw new DeadlineExceeded('transaction-recover');
  };
  process.stderr.write = (chunk) => { chunks.push(chunk); return true; };
  let exitCode;
  try {
    exitCode = main([
      'transaction', 'recover',
      '--wiki-root', root,
      '--lock-token', owner.token,
      '--operation-id', OPERATION_ID,
      '--json',
    ]);
  } finally {
    wikiRuntimeState.recoverTransaction = originalRecover;
    process.stderr.write = originalWrite;
  }
  try {
    assert.equal(exitCode, 5);
    const stderr = chunks.join('');
    assert.match(stderr, /DEADLINE_EXCEEDED/);
    assert.ok(stderr.includes(`resume with:\n${recoverRuntimePrefix()}transaction recover `), stderr);
    assert.match(stderr, /--lock-token <token>/);
    assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), true);
  } finally {
    releaseLock({ wikiRoot: root, token: owner.token });
  }
});

test('tokenless recoverHint executes the exact emitted retry from a non-plugin cwd', {
  skip: process.platform === 'win32' ? 'POSIX exact-command execution; win32 label covered by the platform-mock tests' : false,
}, (t) => {
  const probe = spawnSync('bash', ['-c', 'echo ok'], { encoding: 'utf8' });
  if (probe.status !== 0) { t.skip('bash unavailable for exact-command execution'); return; }
  const { recoverHint } = require('../scripts/wiki-runtime.js');
  const root = fixture('deep wiki tokenless recover exec ');
  stageInterrupted(root, manifest());
  const hint = recoverHint(root, OPERATION_ID, { includeLockToken: false });
  const commands = nodeCommandLines(hint);
  assert.equal(commands.length, 1, hint);
  assert.ok(commands[0].startsWith(`${recoverRuntimePrefix()}transaction recover `), commands[0]);
  assert.equal(commands[0].includes('--lock-token'), false, commands[0]);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-wiki-non-plugin-cwd-'));
  roots.add(outside);
  const executed = spawnSync('bash', ['-c', commands[0]], {
    encoding: 'utf8',
    cwd: outside,
    shell: false,
  });
  assert.notEqual(executed.status, 127, executed.stderr);
  assert.doesNotMatch(executed.stderr, /MODULE_NOT_FOUND/);
  assert.equal(executed.status, 0, `${executed.stdout}\n${executed.stderr}`);
  const payload = JSON.parse(executed.stdout);
  assert.equal(typeof payload, 'object');
  assert.notEqual(payload, null);
  assert.equal(fs.existsSync(transactionPath(root)), false);
});

test('commit at a pre-activation deadline instructs a plain rerun instead of an unusable recover hint', { skip: process.platform === 'win32' ? 'POSIX hint-label assertion; win32 label covered by the platform-mock tests' : false }, () => {
  const { main } = require('../scripts/wiki-runtime.js');
  const wikiRuntimeState = require('../hooks/scripts/runtime/wiki-state.js');
  const { DeadlineExceeded } = require('../hooks/scripts/runtime/deadline.js');

  const root = fixture('deep wiki recover hint pre-activation ');
  const manifestFile = path.join(root, 'stub-manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify({ operation_id: OPERATION_ID }));

  const originalApplyCommit = wikiRuntimeState.applyCommit;
  const originalWrite = process.stderr.write;
  const chunks = [];
  wikiRuntimeState.applyCommit = () => { throw new DeadlineExceeded('wiki-state:commit-entry'); };
  process.stderr.write = (chunk) => { chunks.push(chunk); return true; };
  let exitCode;
  try {
    exitCode = main([
      'commit', '--wiki-root', root, '--lock-token', 'stub-token',
      '--manifest-file', manifestFile, '--json',
    ]);
  } finally {
    wikiRuntimeState.applyCommit = originalApplyCommit;
    process.stderr.write = originalWrite;
  }
  assert.equal(exitCode, 5);
  const stderr = chunks.join('');
  assert.ok(!stderr.includes('transaction recover'));
  assert.ok(stderr.includes('rerun with:'));
  assert.ok(stderr.includes(manifestFile));
});

test('supported readers block on a nonterminal shared scan-window journal', () => {
  const { snapshotWiki } = require(statePath);
  const root = fixture('deep wiki scan reader block ');
  fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), `${TS}\n`);
  withLock(root, (token) => assert.throws(() => scanWindow.promotePendingScan({
    wikiRoot: root,
    token,
    expected: TS,
    operationId: 'reader-block-probe',
    faultInjector(boundary) { if (boundary === 'after-last-scan-rename') throw new Error('stop'); },
  })));
  assert.throws(
    () => snapshotWiki({ wikiRoot: root }),
    (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED',
  );
});

test('third ingest failure emits one terminal event before shared pending promotion and retries exactly once', () => {
  const { registerIngestFailure } = require(statePath);
  const root = fixture('deep wiki terminal ingest failure ');
  fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), `${TS}\n`);
  withLock(root, (token) => {
    assert.equal(registerIngestFailure({ wikiRoot: root, token, source: 'source-a', now: new Date(TS) }).count, 1);
    assert.equal(registerIngestFailure({ wikiRoot: root, token, source: 'source-a', now: new Date(TS) }).count, 2);
    assert.throws(() => registerIngestFailure({
      wikiRoot: root, token, source: 'source-a', now: new Date(TS),
      faultInjector(boundary) {
        if (boundary === 'after-publish-log-jsonl') throw new Error('terminal emit interrupted');
      },
    }));
  });
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.pending-scan')), true);
  assert.match(fs.readFileSync(path.join(root, '.wiki-meta', '.pending-scan-retry-count'), 'utf8'), /:3\n$/);
  const result = withLock(root, (token) => registerIngestFailure({
    wikiRoot: root, token, source: 'source-a', now: new Date(TS),
  }));
  assert.equal(result.status, 'terminal');
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.pending-scan')), false);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.pending-scan-retry-count')), false);
  assert.match(fs.readFileSync(path.join(root, '.wiki-meta', 'sources', 'source-a.yaml'), 'utf8'), /partial_fail: true/);
  const jsonLog = fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8');
  const markdownLog = fs.readFileSync(path.join(root, 'log.md'), 'utf8');
  assert.equal((jsonLog.match(/"action":"ingest-fail"/g) || []).length, 1);
  assert.equal((markdownLog.match(/— ingest-fail/g) || []).length, 1);
  assert.equal(fs.readFileSync(path.join(root, '.wiki-meta', '.last-scan'), 'utf8'), `${TS}\n`);
});

test('lint fix self-locks, prunes numeric versions in the journal, rebuilds indexes, and emits one event', () => {
  const { fixWiki } = require(statePath);
  const root = fixture('deep wiki lint state fix ');
  fs.writeFileSync(path.join(root, 'pages', 'topic.md'), pageContent('Topic', ['source-a']));
  fs.writeFileSync(path.join(root, '.wiki-meta', 'sources', 'source-a.yaml'), 'origin: test\ntype: file\n');
  for (let version = 1; version <= 4; version += 1) {
    fs.writeFileSync(path.join(root, '.wiki-meta', '.versions', `topic.v${version}.md`), `v${version}\n`);
  }
  const result = fixWiki({ wikiRoot: root, now: new Date(TS) });
  assert.equal(result.status, 'fixed');
  assert.deepEqual(
    fs.readdirSync(path.join(root, '.wiki-meta', '.versions')).sort(),
    ['topic.v2.md', 'topic.v3.md', 'topic.v4.md'],
  );
  assert.deepEqual(readIndexPayload(path.join(root, '.wiki-meta', 'index.json')).pages.map((page) => page.file), ['topic.md']);
  assert.equal((fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8').match(/"action":"lint"/g) || []).length, 1);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
});

test('lint reports and repairs invalid or stale scan-window state through the shared planner', () => {
  const { fixWiki, inspectWiki } = require(statePath);
  const root = fixture('deep wiki lint pending repair ');
  fs.writeFileSync(path.join(root, '.wiki-meta', '.last-scan'), `${TS}\n`);
  fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), 'invalid\n');
  const report = inspectWiki({ wikiRoot: root });
  assert.equal(report.ok, false);
  assert.ok(report.issues.some((issue) => issue.code === 'INVALID_PENDING_SCAN'));
  const result = fixWiki({ wikiRoot: root, now: new Date(TS) });
  assert.equal(result.status, 'fixed');
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.pending-scan')), false);
  assert.equal(inspectWiki({ wikiRoot: root }).issues.some((issue) => issue.code === 'INVALID_PENDING_SCAN'), false);
  const source = fs.readFileSync(require.resolve(statePath), 'utf8');
  assert.doesNotMatch(source, /(?:writeFile|rename|unlink|rm)(?:Sync)?\([^\n]*(?:\.pending-scan|\.last-scan)/);
});

test('setup commits a compatible wiki before writing the selected host config target', () => {
  const { setupWiki } = require(statePath);
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki setup home ')));
  roots.add(home);
  const root = path.join(home, 'Vault 공간', 'Wiki');
  const result = setupWiki({
    wikiRoot: root,
    configHost: 'codex',
    env: setupEnv(home),
    now: new Date(TS),
    operationId: OPERATION_ID,
    eventId: EVENT_ID,
  });
  assert.equal(result.operationId, OPERATION_ID);
  assert.equal(fs.existsSync(path.join(root, 'pages', 'welcome.md')), true);
  assert.equal(result.config.status, 'created');
  assert.equal(result.config.path, path.join(home, '.codex', 'deep-wiki-config.yaml'));
  assert.match(fs.readFileSync(result.config.path, 'utf8'), /wiki_root:/);
});

test('setup resumes its journal after interruption without leaving an incompatible target', () => {
  const { setupWiki } = require(statePath);
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki setup resume home ')));
  roots.add(home);
  const root = path.join(home, 'Interrupted Wiki');
  assert.throws(() => setupWiki({
    wikiRoot: root,
    env: setupEnv(home),
    now: new Date(TS),
    operationId: OPERATION_ID,
    eventId: EVENT_ID,
    faultInjector(boundary) { if (boundary === 'after-transition-staged') throw new Error('stop'); },
  }));
  const result = setupWiki({
    wikiRoot: root,
    env: setupEnv(home),
    now: new Date(TS),
    operationId: OPERATION_ID,
    eventId: EVENT_ID,
  });
  assert.equal(result.operationId, OPERATION_ID);
  assert.equal(fs.existsSync(path.join(root, 'pages', 'welcome.md')), true);
});

test('setup resumes from its authenticated intent when interrupted before journaling', () => {
  const { setupWiki } = require(statePath);
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki setup intent home ')));
  roots.add(home);
  const root = path.join(home, 'Intent Wiki');
  assert.throws(() => setupWiki({
    wikiRoot: root,
    env: setupEnv(home),
    now: new Date(TS),
    operationId: OPERATION_ID,
    eventId: EVENT_ID,
    faultInjector(boundary) { if (boundary === 'after-setup-intent') throw new Error('stop'); },
  }));
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.setup-intent.json')), true);
  const result = setupWiki({ wikiRoot: root, env: setupEnv(home), now: new Date(TS) });
  assert.equal(result.operationId, OPERATION_ID);
  assert.equal(fs.existsSync(path.join(root, 'pages', 'welcome.md')), true);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.setup-intent.json')), false);
});

test('setup repeats fresh preflight after reservation when a concurrent setup wins', () => {
  const { setupWiki } = require(statePath);
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki setup race home ')));
  roots.add(home);
  const root = path.join(home, 'Racing Wiki');
  let competingResult;
  const result = setupWiki({
    wikiRoot: root,
    env: setupEnv(home),
    now: new Date(TS),
    operationId: '01JZ7P9Q6MD7S5PB8H4Y40HJ85',
    eventId: '01JZ7P9Q6MD7S5PB8H4Y40HJ86',
    faultInjector(boundary) {
      if (boundary === 'before-setup-reservation') {
        competingResult = setupWiki({
          wikiRoot: root,
          env: setupEnv(home),
          now: new Date(TS),
          operationId: OPERATION_ID,
          eventId: EVENT_ID,
        });
      }
    },
  });
  assert.equal(competingResult.operationId, OPERATION_ID);
  assert.equal(result.status, 'compatible');
  assert.equal(fs.existsSync(path.join(root, 'pages', 'welcome.md')), true);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.setup-intent.json')), false);
  assert.equal(fs.readFileSync(path.join(root, 'log.jsonl'), 'utf8').match(/"action":"setup"/g).length, 1);
});

test('setup rejects an unauthenticated empty pages/meta scaffold', () => {
  const { setupWiki } = require(statePath);
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki foreign scaffold home ')));
  roots.add(home);
  const root = path.join(home, 'wiki');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, 'pages'));
  fs.mkdirSync(path.join(root, '.wiki-meta'));
  assert.throws(
    () => setupWiki({ wikiRoot: root, env: setupEnv(home), now: new Date(TS) }),
    (error) => error.code === 'WIKI_STATE_INVALID',
  );
  assert.deepEqual(fs.readdirSync(root).sort(), ['.wiki-meta', 'pages']);
});

test('authenticated partial setup accepts .quarantine and a valid .runtime marker and keeps the marker', () => {
  const { setupWiki } = require(statePath);
  const markerFixture = require('./helpers/maintenance-marker-fixture.js');
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki partial runtime home ')));
  roots.add(home);
  const root = path.join(home, 'Partial Wiki');
  assert.throws(() => setupWiki({
    wikiRoot: root,
    env: setupEnv(home),
    now: new Date(TS),
    operationId: OPERATION_ID,
    eventId: EVENT_ID,
    faultInjector(boundary) { if (boundary === 'after-setup-intent') throw new Error('stop'); },
  }));
  markerFixture.ensureRuntime(root);
  markerFixture.writeRawMarker(root, markerFixture.canonicalMarkerBytes(markerFixture.emptyMarker({
    promoted: ['scan-window-ensure-aa'],
  })));
  fs.mkdirSync(markerFixture.quarantinePath(root), { recursive: true });
  const result = setupWiki({ wikiRoot: root, env: setupEnv(home), now: new Date(TS) });
  assert.equal(result.operationId, OPERATION_ID);
  assert.equal(fs.existsSync(path.join(root, 'pages', 'welcome.md')), true);
  assert.equal(fs.existsSync(markerFixture.markerPath(root)), true);
});

test('unauthenticated partial setup with a valid .runtime is still rejected as not authenticated', () => {
  const { setupWiki } = require(statePath);
  const markerFixture = require('./helpers/maintenance-marker-fixture.js');
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki unauth runtime home ')));
  roots.add(home);
  const root = path.join(home, 'wiki');
  fs.mkdirSync(root);
  fs.mkdirSync(path.join(root, 'pages'));
  fs.mkdirSync(path.join(root, '.wiki-meta'));
  markerFixture.ensureRuntime(root);
  markerFixture.writeRawMarker(root, markerFixture.canonicalMarkerBytes(markerFixture.emptyMarker({
    promoted: ['keep'],
  })));
  assert.throws(
    () => setupWiki({ wikiRoot: root, env: setupEnv(home), now: new Date(TS) }),
    (error) => error.code === 'WIKI_STATE_INVALID'
      && /not authenticated by setup intent or journal/.test(error.message),
  );
});

test('authenticated partial setup rejects invalid .runtime and .quarantine shapes', () => {
  const { setupWiki } = require(statePath);
  const markerFixture = require('./helpers/maintenance-marker-fixture.js');
  const cases = [
    {
      name: 'runtime-symlink',
      plant(root) {
        const target = path.join(root, 'runtime-target');
        fs.mkdirSync(target);
        fs.symlinkSync(target, markerFixture.runtimePath(root));
      },
    },
    {
      name: 'runtime-file',
      plant(root) {
        fs.writeFileSync(markerFixture.runtimePath(root), 'not-a-directory\n');
      },
    },
    {
      name: 'runtime-extra-name',
      plant(root) {
        markerFixture.ensureRuntime(root);
        fs.writeFileSync(path.join(markerFixture.runtimePath(root), 'leftover-manifest.json'), '{}\n');
      },
    },
    {
      name: 'marker-symlink',
      plant(root) {
        markerFixture.ensureRuntime(root);
        const target = path.join(root, 'marker-target.json');
        fs.writeFileSync(target, '{}\n');
        fs.symlinkSync(target, markerFixture.markerPath(root));
      },
    },
    {
      name: 'marker-json-broken',
      plant(root) {
        markerFixture.writeRawMarker(root, Buffer.from('{not json\n'));
      },
    },
    {
      name: 'marker-operation-id',
      plant(root) {
        markerFixture.writeRawMarker(root, Buffer.from(`${JSON.stringify({
          schema: 1,
          updated_at: '2026-08-25T00:00:00Z',
          operation_id: 'nope',
          prune_failures: [],
          promoted: [],
          skipped_oversized: [],
          quarantine_bundles: [],
        })}\n`));
      },
    },
  ];
  for (const item of cases) {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `deep wiki partial ${item.name} `)));
    roots.add(home);
    const root = path.join(home, 'Partial Wiki');
    assert.throws(() => setupWiki({
      wikiRoot: root,
      env: setupEnv(home),
      now: new Date(TS),
      operationId: OPERATION_ID,
      eventId: EVENT_ID,
      faultInjector(boundary) { if (boundary === 'after-setup-intent') throw new Error('stop'); },
    }));
    item.plant(root);
    assert.throws(
      () => setupWiki({ wikiRoot: root, env: setupEnv(home), now: new Date(TS) }),
      (error) => error.code === 'WIKI_STATE_INVALID',
      item.name,
    );
  }
});

test('setup CLI exposes only explicit stopped-host rebind and returns public authority generation', () => {
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki cli rebind home ')));
  roots.add(home);
  const oldRoot = path.join(home, 'Old Wiki');
  const newRoot = path.join(home, 'New Wiki');
  const env = setupEnv(home);

  const first = spawnSync(process.execPath, [
    cli, 'setup', '--wiki-root', oldRoot, '--config-host', 'codex', '--json',
  ], { cwd: home, env, encoding: 'utf8', shell: false });
  assert.equal(first.status, 0, first.stderr);
  assert.deepEqual(JSON.parse(first.stdout).authority, {
    wiki_root: fs.realpathSync.native(oldRoot),
    generation: 1,
  });

  fs.rmSync(oldRoot, { recursive: true, force: true });
  fs.rmSync(path.join(home, '.codex', 'deep-wiki-config.yaml'), { force: true });

  const implicit = spawnSync(process.execPath, [
    cli, 'setup', '--wiki-root', newRoot, '--config-host', 'codex', '--json',
  ], { cwd: home, env, encoding: 'utf8', shell: false });
  assert.equal(implicit.status, 4, implicit.stderr);
  assert.match(implicit.stderr, /^SETUP_AUTHORITY_CONFLICT:/);
  assert.equal(fs.existsSync(newRoot), false);

  const explicit = spawnSync(process.execPath, [
    cli, 'setup', '--rebind-authority-from', oldRoot, '--wiki-root', newRoot,
    '--config-host', 'codex', '--json',
  ], { cwd: home, env, encoding: 'utf8', shell: false });
  assert.equal(explicit.status, 0, explicit.stderr);
  const result = JSON.parse(explicit.stdout);
  assert.deepEqual(result.authority, {
    wiki_root: fs.realpathSync.native(newRoot),
    generation: 2,
  });
  assert.equal(fs.existsSync(path.join(newRoot, 'pages', 'welcome.md')), true);
});

test('setup rejects unsafe global and selected-target inputs before requested wiki mutation', () => {
  const { setupWiki } = require(statePath);
  const cases = [
    {
      name: 'invalid global candidate',
      prepare(home, root) {
        fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
        fs.writeFileSync(path.join(home, '.codex', 'deep-wiki-config.yaml'), 'wiki_root:\n  hidden: value\n');
        return { wikiRoot: root, configHost: 'codex', env: setupEnv(home), now: new Date(TS) };
      },
      code: 'CONFIG_INVALID',
    },
    {
      name: 'conflicting global candidates',
      prepare(home, root) {
        fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
        fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(home, '.codex', 'deep-wiki-config.yaml'), `wiki_root: ${JSON.stringify(root)}\n`);
        fs.writeFileSync(path.join(home, '.claude', 'deep-wiki-config.yaml'), `wiki_root: ${JSON.stringify(path.join(home, 'other'))}\n`);
        return { wikiRoot: root, configHost: 'codex', env: setupEnv(home), now: new Date(TS) };
      },
      code: 'CONFIG_CONFLICT',
    },
    {
      name: 'symlinked selected target under replace-config',
      prepare(home, root) {
        const codex = path.join(home, '.codex', 'deep-wiki-config.yaml');
        fs.mkdirSync(path.dirname(codex), { recursive: true });
        fs.writeFileSync(codex, `wiki_root: ${JSON.stringify(root)}\n`);
        fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
        fs.symlinkSync(codex, path.join(home, '.claude', 'deep-wiki-config.yaml'));
        return {
          wikiRoot: root, configHost: 'claude', replaceConfig: true,
          env: setupEnv(home), now: new Date(TS),
        };
      },
      code: 'CONFIG_TARGET_CONFLICT',
    },
  ];

  for (const entry of cases) {
    const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `deep wiki ${entry.name} home `)));
    roots.add(home);
    const root = path.join(home, 'requested-wiki');
    const options = entry.prepare(home, root);
    assert.throws(() => setupWiki(options), (error) => error.code === entry.code, entry.name);
    assert.equal(fs.existsSync(root), false, entry.name);
  }
});

test('cleaned transactions compact to bounded receipts while preserving idempotent retry', () => {
  const { applyCommit } = require(statePath);
  const root = fixture('deep wiki compact receipt ');
  withLock(root, (token) => applyCommit({ wikiRoot: root, token, manifest: manifest(), now: new Date(TS) }));
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.transactions', OPERATION_ID)), false);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.transaction-receipts', `${OPERATION_ID}.json`)), true);
  const before = artifactSnapshot(root);
  withLock(root, (token) => applyCommit({ wikiRoot: root, token, manifest: manifest(), now: new Date(TS) }));
  assert.deepEqual(artifactSnapshot(root), before);
});

test('success-path residual dir self-heals via receipt compaction', () => {
  const { applyCommit, snapshotWiki } = require(statePath);
  const root = fixture('deep wiki residual receipt ');
  const first = withLock(root, (token) => applyCommit({
    wikiRoot: root, token, manifest: manifest(), now: new Date(TS),
  }));
  const residual = path.join(root, '.wiki-meta', '.transactions', OPERATION_ID);
  fs.mkdirSync(path.join(residual, 'before'), { recursive: true });
  assert.doesNotThrow(() => snapshotWiki({ wikiRoot: root }));
  const clock = { now: 0, nowMs() { return this.now; } };
  const deadline = createDeadline({ clock, budgetMs: 12_000 });
  clock.now = 2_001;
  const retry = withLock(root, (token) => applyCommit({
    wikiRoot: root, token, manifest: manifest(), now: new Date(TS), deadline,
  }));
  assert.deepEqual(retry, first);
  assert.equal(fs.existsSync(residual), false);
});

test('readers never see a journal-less live transaction', () => {
  const { applyCommit, snapshotWiki } = require(statePath);
  const root = fixture('deep wiki journal first ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  const operation = path.join(transactions, OPERATION_ID);
  const observed = new Set();
  withLock(root, (token) => applyCommit({
    wikiRoot: root, token, manifest: manifest(), now: new Date(TS),
    faultInjector(boundary) {
      if (!['before-transaction-activate', 'after-transaction-activate', 'before-stage-0-before'].includes(boundary)) return;
      observed.add(boundary);
      if (boundary === 'before-transaction-activate') {
        assert.doesNotThrow(() => snapshotWiki({ wikiRoot: root }));
        const names = fs.readdirSync(transactions);
        assert.equal(names.includes(OPERATION_ID), false);
        assert.equal(names.some((name) => name.startsWith('.activate-')), true);
      } else {
        assert.equal(fs.existsSync(path.join(operation, 'journal.json')), true);
        assert.throws(
          () => snapshotWiki({ wikiRoot: root }),
          (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED',
        );
      }
    },
  }));
  assert.deepEqual([...observed].sort(), [
    'after-transaction-activate', 'before-stage-0-before', 'before-transaction-activate',
  ]);

  const crashRoot = fixture('deep wiki abandoned activation ');
  const crashTransactions = path.join(crashRoot, '.wiki-meta', '.transactions');
  withLock(crashRoot, (token) => assert.throws(() => applyCommit({
    wikiRoot: crashRoot, token, manifest: manifest(), now: new Date(TS),
    faultInjector(boundary) {
      if (boundary === 'before-transaction-activate') throw new Error('activation crash');
    },
  }), /activation crash/));
  assert.equal(fs.readdirSync(crashTransactions).some((name) => name.startsWith('.activate-')), true);
  const unrelated = manifest({ operation_id: '01JZ7P9Q6MD7S5PB8H4Y40HJ85' });
  unrelated.events[0].event_id = '01JZ7P9Q6MD7S5PB8H4Y40HJ86';
  withLock(crashRoot, (token) => applyCommit({
    wikiRoot: crashRoot, token, manifest: unrelated, now: new Date(TS),
  }));
  assert.equal(fs.readdirSync(crashTransactions).some((name) => name.startsWith('.activate-')), false);
});

test('scan-window producer never exposes a journal-less operation dir', () => {
  const root = fixture('deep wiki scan atomic activation ');
  const operationId = 'scan-window-atomic-activation';
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  fs.writeFileSync(path.join(root, '.wiki-meta', '.pending-scan'), `${TS}\n`);
  const observed = [];
  withLock(root, (token) => scanWindow.promotePendingScan({
    wikiRoot: root, token, expected: TS, operationId,
    faultInjector(boundary) {
      observed.push(boundary);
      const operation = path.join(transactions, operationId);
      assert.equal(!fs.existsSync(operation) || fs.existsSync(path.join(operation, 'journal.json')), true, boundary);
    },
  }));
  assert.equal(observed.includes('before-transaction-activate'), true);
  assert.equal(observed.includes('after-transaction-activate'), true);

  const crashRoot = fixture('deep wiki scan activation retry ');
  const crashTransactions = path.join(crashRoot, '.wiki-meta', '.transactions');
  fs.mkdirSync(crashTransactions, { recursive: true });
  fs.writeFileSync(path.join(crashRoot, '.wiki-meta', '.pending-scan'), `${TS}\n`);
  withLock(crashRoot, (token) => assert.throws(() => scanWindow.promotePendingScan({
    wikiRoot: crashRoot, token, expected: TS, operationId,
    faultInjector(boundary) {
      if (boundary === 'before-transaction-activate') throw new Error('scan activation crash');
    },
  }), /scan activation crash/));
  assert.equal(fs.readdirSync(crashTransactions).some((name) => name.startsWith('.activate-')), true);
  const retry = withLock(crashRoot, (token) => scanWindow.promotePendingScan({
    wikiRoot: crashRoot, token, expected: TS, operationId,
  }));
  assert.equal(retry.status, 'promoted');
  assert.equal(fs.readFileSync(path.join(crashRoot, '.wiki-meta', '.last-scan'), 'utf8'), `${TS}\n`);
  assert.equal(fs.readdirSync(crashTransactions).some((name) => name.startsWith('.activate-')), false);
});

test('transaction debris sweep yields before consuming the primary-operation reserve', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep deadline reserve ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  for (const name of ['plain-a', 'plain-b', 'plain-c']) fs.mkdirSync(path.join(transactions, name));
  const clock = { now: 0, nowMs() { return this.now; } };
  const deadline = createDeadline({ clock, budgetMs: 12_000 });
  clock.now = 2_001;
  withLock(root, (token) => assert.doesNotThrow(() => sweepTransactionDebris(root, token, { deadline })));
  assert.deepEqual(fs.readdirSync(transactions).sort(), ['plain-a', 'plain-b', 'plain-c']);
});

test('transaction debris sweep never removes a transaction with a journal', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep journal safety ');
  const transaction = path.join(root, '.wiki-meta', '.transactions', 'journalled');
  fs.mkdirSync(transaction, { recursive: true });
  fs.writeFileSync(path.join(transaction, 'journal.json'), 'preserve exactly\n');
  fs.writeFileSync(path.join(transaction, 'stray'), 'also preserve\n');
  const deadline = createDeadline({ budgetMs: 12_000 });
  withLock(root, (token) => sweepTransactionDebris(root, token, { deadline }));
  assert.equal(fs.readFileSync(path.join(transaction, 'journal.json'), 'utf8'), 'preserve exactly\n');
  assert.equal(fs.readFileSync(path.join(transaction, 'stray'), 'utf8'), 'also preserve\n');
});

test('transaction debris sweep completes valid cancelled tombstone teardown', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep cancelled teardown ');
  const operationId = '01JZ7P9Q6MD7S5PB8H4Y40HJ85';
  const transaction = path.join(root, '.wiki-meta', '.transactions', operationId);
  fs.mkdirSync(path.join(transaction, 'after'), { recursive: true });
  fs.writeFileSync(path.join(transaction, 'after', '0000.json'), 'staged\n');
  fs.writeFileSync(path.join(transaction, 'cancelled.json'), `${JSON.stringify({
    contract_version: 1,
    operation_id: operationId,
    reason: 'catalog-drift',
    drift: ['pages/topic.md'],
  })}\n`);
  const deadline = createDeadline({ budgetMs: 12_000 });
  withLock(root, (token) => sweepTransactionDebris(root, token, { deadline }));
  assert.equal(fs.existsSync(transaction), false);
});

test('debris removal is interruptible between entries when the clock advances mid-teardown', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep mid-removal interrupt ');
  const transaction = path.join(root, '.wiki-meta', '.transactions', 'plain-large');
  fs.mkdirSync(transaction, { recursive: true });
  for (let index = 0; index < 4; index += 1) {
    fs.writeFileSync(path.join(transaction, `file-${index}.txt`), 'debris\n');
  }
  const clock = { now: 0, nowMs() { return this.now; } };
  const deadline = createDeadline({ clock, budgetMs: 12_000 });
  withLock(root, (token) => {
    const result = sweepTransactionDebris(root, token, {
      deadline,
      faultInjector(boundary) { if (boundary === 'sweep-remove:1') clock.now = 2_001; },
    });
    assert.deepEqual(result, { processed: 0, removed: [], removed_junk: [], skipped_oversized: [] });
  });
  assert.equal(fs.existsSync(transaction), true);
  assert.equal(fs.readdirSync(transaction).length, 3);

  withLock(root, (token) => {
    const result = sweepTransactionDebris(root, token, { deadline: createDeadline({ budgetMs: 12_000 }) });
    assert.deepEqual(result, { processed: 1, removed: ['plain-large'], removed_junk: [], skipped_oversized: [] });
  });
  assert.equal(fs.existsSync(transaction), false);
});

test('readers tolerate an OS metadata file dropped into the transaction store', () => {
  const { snapshotWiki } = require(statePath);
  const root = fixture('deep wiki transaction store junk ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  for (const name of ['.DS_Store', '._topic.md', 'Thumbs.db', 'desktop.ini']) {
    fs.writeFileSync(path.join(transactions, name), 'sync-client metadata\n');
  }
  const snapshot = snapshotWiki({ wikiRoot: root });
  assert.deepEqual(snapshot.pages, []);
});

test('an unrecognized non-directory transaction entry still demands recovery', () => {
  const { snapshotWiki } = require(statePath);
  const root = fixture('deep wiki transaction store stray ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  fs.writeFileSync(path.join(transactions, '01JZ7P9Q6MD7S5PB8H4Y40HJ86'), 'not a transaction\n');
  assert.throws(
    () => snapshotWiki({ wikiRoot: root }),
    (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED',
  );
});

test('a symlink wearing an OS metadata name still demands recovery', () => {
  const { snapshotWiki } = require(statePath);
  const root = fixture('deep wiki transaction store symlink ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  fs.writeFileSync(path.join(root, 'pages', 'target.md'), pageContent('Target', ['source-a']));
  fs.symlinkSync(path.join(root, 'pages', 'target.md'), path.join(transactions, '.DS_Store'));
  assert.throws(
    () => snapshotWiki({ wikiRoot: root }),
    (error) => error.code === 'TRANSACTION_RECOVERY_REQUIRED',
  );
  assert.equal(fs.existsSync(path.join(root, 'pages', 'target.md')), true);
});

test('transaction debris sweep reclaims OS metadata files under the owner token', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep os metadata ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  fs.writeFileSync(path.join(transactions, '.DS_Store'), 'finder metadata\n');
  fs.writeFileSync(path.join(transactions, 'Thumbs.db'), 'explorer metadata\n');
  const deadline = createDeadline({ budgetMs: 12_000 });
  withLock(root, (token) => {
    const result = sweepTransactionDebris(root, token, { deadline });
    assert.deepEqual(result.removed, []);
    assert.deepEqual([...result.removed_junk].sort(), ['.DS_Store', 'Thumbs.db']);
  });
  assert.deepEqual(fs.readdirSync(transactions), []);
});

test('transaction debris sweep never removes an unrecognized non-directory entry', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep stray file ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  fs.writeFileSync(path.join(transactions, 'evidence.json'), 'preserve exactly\n');
  const deadline = createDeadline({ budgetMs: 12_000 });
  withLock(root, (token) => {
    assert.deepEqual(
      sweepTransactionDebris(root, token, { deadline }),
      { processed: 0, removed: [], removed_junk: [], skipped_oversized: [] },
    );
  });
  assert.equal(fs.readFileSync(path.join(transactions, 'evidence.json'), 'utf8'), 'preserve exactly\n');
});

test('a symlinked transaction store is refused before the sweep deletes anything outside the wiki', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep anchored store ');
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki outside store ')));
  roots.add(outside);
  fs.writeFileSync(path.join(outside, '.DS_Store'), 'external bytes\n');
  fs.mkdirSync(path.join(outside, 'plain-debris'));
  fs.mkdirSync(path.join(root, '.wiki-meta'), { recursive: true });
  fs.symlinkSync(outside, path.join(root, '.wiki-meta', '.transactions'));
  const deadline = createDeadline({ budgetMs: 12_000 });
  withLock(root, (token) => {
    assert.throws(
      () => sweepTransactionDebris(root, token, { deadline }),
      (error) => error.code === 'WIKI_STATE_FILESYSTEM',
    );
  });
  assert.equal(fs.readFileSync(path.join(outside, '.DS_Store'), 'utf8'), 'external bytes\n');
  assert.equal(fs.existsSync(path.join(outside, 'plain-debris')), true);
});

test('junk never consumes the budget that reader-fatal cancelled debris needs', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const { snapshotWiki } = require(statePath);
  const root = fixture('deep wiki sweep junk starvation ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  for (let index = 0; index < 12; index += 1) {
    fs.writeFileSync(path.join(transactions, `._junk-${index}`), 'appledouble\n');
  }
  const operationId = '01JZ7P9Q6MD7S5PB8H4Y40HJ87';
  const cancelled = path.join(transactions, operationId);
  fs.mkdirSync(cancelled);
  fs.writeFileSync(path.join(cancelled, 'cancelled.json'), `${JSON.stringify({
    contract_version: 1,
    operation_id: operationId,
    reason: 'catalog-drift',
    drift: ['pages/topic.md'],
  })}\n`);
  const deadline = createDeadline({ budgetMs: 12_000 });
  withLock(root, (token) => {
    const result = sweepTransactionDebris(root, token, { deadline });
    assert.deepEqual(result.removed, [operationId]);
  });
  assert.equal(fs.existsSync(cancelled), false);
  assert.deepEqual(snapshotWiki({ wikiRoot: root }).pages, []);
});

test('junk removal publishes the same interruption boundary as directory debris', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep junk boundary ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  fs.writeFileSync(path.join(transactions, '.DS_Store'), 'finder metadata\n');
  const boundaries = [];
  const deadline = createDeadline({ budgetMs: 12_000 });
  withLock(root, (token) => sweepTransactionDebris(root, token, {
    deadline,
    faultInjector: (boundary) => { boundaries.push(boundary); },
  }));
  assert.deepEqual(boundaries, ['junk-remove:0', 'junk-validated:0', 'junk-removed:0']);
  assert.equal(fs.existsSync(path.join(transactions, '.DS_Store')), false);
});

test('a symlinked .wiki-meta is refused before any transaction state is created outside the wiki', () => {
  const { applyCommit } = require(statePath);
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki meta escape ')));
  roots.add(base);
  const root = path.join(base, 'wiki');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(outside, 'sources'), { recursive: true });
  fs.mkdirSync(path.join(outside, '.versions'));
  fs.writeFileSync(path.join(root, 'log.jsonl'), '');
  fs.symlinkSync(outside, path.join(root, '.wiki-meta'));
  const deadline = createDeadline({ budgetMs: 12_000 });
  withLock(root, (token) => {
    assert.throws(
      () => sweepTransactionDebris(root, token, { deadline }),
      (error) => error.code === 'WIKI_STATE_FILESYSTEM',
    );
    assert.throws(
      () => applyCommit({ wikiRoot: root, token, manifest: manifest(), now: new Date(TS) }),
      (error) => error.code === 'WIKI_STATE_FILESYSTEM',
    );
  });
  assert.equal(fs.existsSync(path.join(outside, '.transactions')), false);
});

test('reader-fatal cancelled debris is reclaimed before junk can exhaust the sweep reserve', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep order ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  const operationId = '01JZ7P9Q6MD7S5PB8H4Y40HJ88';
  const cancelled = path.join(transactions, operationId);
  fs.mkdirSync(cancelled);
  fs.writeFileSync(path.join(cancelled, 'cancelled.json'), `${JSON.stringify({
    contract_version: 1,
    operation_id: operationId,
    reason: 'catalog-drift',
    drift: ['pages/topic.md'],
  })}\n`);
  fs.writeFileSync(path.join(transactions, '.DS_Store'), 'finder metadata\n');
  const clock = { now: 0, nowMs() { return this.now; } };
  const deadline = createDeadline({ clock, budgetMs: 12_000 });
  const seen = [];
  withLock(root, (token) => sweepTransactionDebris(root, token, {
    deadline,
    // Burn the reserve the moment junk reclamation is first reached. `readdirSync` order is
    // filesystem dependent, so this asserts the ordering guarantee itself: whatever the order,
    // the cancelled teardown must already be done by the time any junk boundary fires.
    faultInjector: (boundary) => {
      seen.push(boundary);
      if (boundary.startsWith('junk-')) clock.now = 11_000;
    },
  }));
  assert.equal(seen.some((boundary) => boundary.startsWith('junk-')), true, 'junk was never reached');
  assert.equal(fs.existsSync(cancelled), false, 'cancelled teardown did not run before junk');
  assert.equal(fs.existsSync(path.join(transactions, '.DS_Store')), true);
});

test('a junk entry swapped for a symlink at the removal boundary is neither followed nor removed', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep junk swap ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  const junk = path.join(transactions, '.DS_Store');
  fs.writeFileSync(junk, 'finder metadata\n');
  fs.writeFileSync(path.join(root, 'pages', 'victim.md'), pageContent('Victim', ['source-a']));
  let swapped = false;
  const deadline = createDeadline({ budgetMs: 12_000 });
  withLock(root, (token) => sweepTransactionDebris(root, token, {
    deadline,
    faultInjector: (boundary) => {
      if (boundary === 'junk-remove:0' && !swapped) {
        swapped = true;
        fs.rmSync(junk, { force: true });
        fs.symlinkSync(path.join(root, 'pages', 'victim.md'), junk);
      }
    },
  }));
  assert.equal(swapped, true);
  assert.equal(fs.lstatSync(junk).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(root, 'pages', 'victim.md')), true);
});

test('a transaction store swapped for a symlink mid-sweep is caught before the next removal', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep midswap ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  fs.writeFileSync(path.join(transactions, '.DS_Store'), 'finder metadata\n');
  fs.writeFileSync(path.join(transactions, '._decoy'), 'appledouble\n');
  const outside = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki midswap outside ')));
  roots.add(outside);
  fs.writeFileSync(path.join(outside, '.DS_Store'), 'EXTERNAL VICTIM\n');
  let swapped = false;
  const deadline = createDeadline({ budgetMs: 12_000 });
  withLock(root, (token) => {
    assert.throws(() => sweepTransactionDebris(root, token, {
      deadline,
      faultInjector: (boundary) => {
        if (boundary === 'junk-remove:0' && !swapped) {
          swapped = true;
          fs.renameSync(transactions, `${transactions}.real`);
          fs.symlinkSync(outside, transactions);
        }
      },
    }), (error) => error.code === 'WIKI_STATE_FILESYSTEM');
  });
  assert.equal(swapped, true);
  assert.equal(fs.readFileSync(path.join(outside, '.DS_Store'), 'utf8'), 'EXTERNAL VICTIM\n');
});

test('the sweep never follows or removes a symlink wearing an OS metadata name', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep junk symlink ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  fs.writeFileSync(path.join(root, 'pages', 'victim.md'), pageContent('Victim', ['source-a']));
  const link = path.join(transactions, '.DS_Store');
  fs.symlinkSync(path.join(root, 'pages', 'victim.md'), link);
  const deadline = createDeadline({ budgetMs: 12_000 });
  withLock(root, (token) => {
    assert.deepEqual(
      sweepTransactionDebris(root, token, { deadline }),
      { processed: 0, removed: [], removed_junk: [], skipped_oversized: [] },
    );
  });
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.existsSync(path.join(root, 'pages', 'victim.md')), true);
});

test('junk a foreign process refuses to release never fails the enclosing mutation route', {
  skip: process.platform === 'win32' ? 'POSIX directory permissions' : false,
}, () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const { snapshotWiki } = require(statePath);
  const root = fixture('deep wiki sweep held junk ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  fs.writeFileSync(path.join(transactions, 'Thumbs.db'), 'held by explorer\n');
  // Read+execute still satisfies every validation step; only the unlink itself is refused.
  fs.chmodSync(transactions, 0o555);
  const deadline = createDeadline({ budgetMs: 12_000 });
  try {
    withLock(root, (token) => {
      const result = sweepTransactionDebris(root, token, { deadline });
      assert.deepEqual(result.removed_junk, []);
    });
    assert.equal(fs.existsSync(path.join(transactions, 'Thumbs.db')), true);
    assert.deepEqual(snapshotWiki({ wikiRoot: root }).pages, []);
  } finally {
    fs.chmodSync(transactions, 0o755);
  }
});

test('an anchor re-proof that fails with a hold code still fails closed', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep anchor failopen ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  fs.writeFileSync(path.join(transactions, '._a'), 'appledouble\n');
  fs.writeFileSync(path.join(transactions, '._b'), 'appledouble\n');
  const realLstat = fs.lstatSync;
  let armed = false;
  fs.lstatSync = function patched(target, ...rest) {
    if (armed && String(target).endsWith('.transactions')) {
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    }
    return realLstat.call(this, target, ...rest);
  };
  try {
    withLock(root, (token) => {
      assert.throws(() => sweepTransactionDebris(root, token, {
        deadline: createDeadline({ budgetMs: 12_000 }),
        faultInjector: () => { armed = true; },
      }), (error) => error.code === 'WIKI_STATE_FILESYSTEM');
    });
  } finally {
    fs.lstatSync = realLstat;
  }
  assert.equal(fs.existsSync(path.join(transactions, '._a')), true);
  assert.equal(fs.existsSync(path.join(transactions, '._b')), true);
});

test('one sweep pass never mutates more entries than its documented limit', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep budget cap ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  for (let index = 0; index < 6; index += 1) {
    fs.mkdirSync(path.join(transactions, `plain-${index}`));
  }
  for (let index = 0; index < 6; index += 1) {
    fs.writeFileSync(path.join(transactions, `._junk-${index}`), 'appledouble\n');
  }
  const deadline = createDeadline({ budgetMs: 12_000 });
  withLock(root, (token) => {
    const result = sweepTransactionDebris(root, token, { deadline, limit: 8 });
    assert.equal(result.processed + result.removed_junk.length <= 8, true,
      `${result.processed} + ${result.removed_junk.length} exceeded the pass limit`);
    assert.equal(result.processed, 6);
    assert.equal(result.removed_junk.length, 2);
  });
});

test('lint fix reports the OS metadata it reclaimed', () => {
  const { fixWiki } = require(statePath);
  const root = fixture('deep wiki lint fix junk report ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  fs.writeFileSync(path.join(transactions, '.DS_Store'), 'finder metadata\n');
  const result = fixWiki({ wikiRoot: root, now: new Date(TS) });
  assert.deepEqual(result.removed_junk, ['.DS_Store']);
  assert.equal(result.removed_junk_complete, true);
});

test('lint fix never reports junk reclamation as complete while junk remains', () => {
  const { fixWiki } = require(statePath);
  const root = fixture('deep wiki lint fix junk partial ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  for (let index = 0; index < 12; index += 1) {
    fs.writeFileSync(path.join(transactions, `._junk-${index}`), 'appledouble\n');
  }
  const result = fixWiki({ wikiRoot: root, now: new Date(TS) });
  const remaining = fs.readdirSync(transactions).filter((name) => name.startsWith('._')).length;
  assert.equal(result.removed_junk_complete, remaining === 0);
  assert.equal(result.removed_junk.length + remaining, 12);
});

test('transaction creation re-proves the store anchor after the sweep has released it', () => {
  const { applyCommit } = require(statePath);
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki activate swap ')));
  roots.add(base);
  const root = path.join(base, 'wiki');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, '.wiki-meta', 'sources'), { recursive: true });
  fs.mkdirSync(path.join(root, '.wiki-meta', '.versions'));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(root, 'log.jsonl'), '');
  fs.writeFileSync(path.join(root, 'log.md'), '# Wiki Log\n');
  fs.writeFileSync(path.join(root, 'index.md'), '# Wiki Index\n');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  let swapped = false;
  withLock(root, (token) => {
    assert.throws(() => applyCommit({
      wikiRoot: root,
      token,
      manifest: manifest(),
      now: new Date(TS),
      // The sweep's anchor has already been released by this boundary, and the lock still lives in
      // a physical `.wiki-meta`, so only the creation-time re-proof can catch this swap.
      faultInjector: (boundary) => {
        if (boundary === 'before-transaction-activate' && !swapped) {
          swapped = true;
          fs.rmSync(transactions, { recursive: true, force: true });
          fs.symlinkSync(outside, transactions);
        }
      },
    }), (error) => error.code === 'WIKI_STATE_FILESYSTEM');
  });
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(outside), []);
});

test('recovery refuses a transaction store that escapes the wiki', () => {
  const { recoverTransaction } = require(statePath);
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki recover anchor ')));
  roots.add(base);
  const root = path.join(base, 'wiki');
  const outside = path.join(base, 'outside');
  const operationId = '01JZ7P9Q6MD7S5PB8H4Y40HJ89';
  fs.mkdirSync(path.join(root, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, '.wiki-meta'), { recursive: true });
  fs.mkdirSync(path.join(outside, operationId), { recursive: true });
  fs.writeFileSync(path.join(outside, operationId, 'cancelled.json'), `${JSON.stringify({
    contract_version: 1,
    operation_id: operationId,
    reason: 'catalog-drift',
    drift: ['pages/topic.md'],
  })}\n`);
  fs.writeFileSync(path.join(outside, operationId, 'evidence.txt'), 'EXTERNAL\n');
  // `.wiki-meta` stays physical so the lock is genuinely held; only `.transactions` escapes.
  fs.symlinkSync(outside, path.join(root, '.wiki-meta', '.transactions'));
  withLock(root, (token) => {
    assert.throws(
      () => recoverTransaction({ wikiRoot: root, token, operationId }),
      (error) => error.code === 'WIKI_STATE_FILESYSTEM',
    );
  });
  assert.equal(
    fs.readFileSync(path.join(outside, operationId, 'evidence.txt'), 'utf8'),
    'EXTERNAL\n',
  );
});

test('readers refuse a transaction store that escapes the wiki', () => {
  const { snapshotWiki } = require(statePath);
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki reader anchor ')));
  roots.add(base);
  const root = path.join(base, 'wiki');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, '.wiki-meta'), { recursive: true });
  fs.mkdirSync(outside);
  // Recognized junk only: without the reader anchor this store would pass inspection outright.
  fs.writeFileSync(path.join(outside, '.DS_Store'), 'finder metadata\n');
  fs.symlinkSync(outside, path.join(root, '.wiki-meta', '.transactions'));
  assert.throws(
    () => snapshotWiki({ wikiRoot: root }),
    (error) => error.code === 'WIKI_STATE_FILESYSTEM',
  );
  assert.equal(fs.existsSync(path.join(outside, '.DS_Store')), true);
});

test('every junk reclamation attempt consumes the pass budget, not only the successful ones', {
  skip: process.platform === 'win32' ? 'POSIX directory permissions' : false,
}, () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki sweep attempt budget ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  for (let index = 0; index < 12; index += 1) {
    fs.writeFileSync(path.join(transactions, `._junk-${index}`), 'appledouble\n');
  }
  fs.chmodSync(transactions, 0o555);
  const attempts = [];
  try {
    withLock(root, (token) => sweepTransactionDebris(root, token, {
      deadline: createDeadline({ budgetMs: 12_000 }),
      limit: 4,
      faultInjector: (boundary) => {
        if (boundary.startsWith('junk-remove:')) attempts.push(boundary);
      },
    }));
  } finally {
    fs.chmodSync(transactions, 0o755);
  }
  // Nothing can be unlinked, so a success-only counter would retry all twelve.
  assert.equal(attempts.length, 4);
  assert.equal(fs.readdirSync(transactions).length, 12);
});

function escapeFixture(prefix) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  roots.add(base);
  const root = path.join(base, 'wiki');
  const outside = path.join(base, 'outside');
  fs.mkdirSync(path.join(root, 'pages'), { recursive: true });
  fs.mkdirSync(path.join(root, '.wiki-meta', 'sources'), { recursive: true });
  fs.mkdirSync(path.join(root, '.wiki-meta', '.versions'));
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'EXTERNAL.txt'), 'EXTERNAL\n');
  fs.writeFileSync(path.join(root, 'log.jsonl'), '');
  fs.writeFileSync(path.join(root, 'log.md'), '# Wiki Log\n');
  fs.writeFileSync(path.join(root, 'index.md'), '# Wiki Index\n');
  return { root, outside, transactions: path.join(root, '.wiki-meta', '.transactions') };
}

function swapStoreForSymlink(transactions, outside) {
  fs.rmSync(transactions, { recursive: true, force: true });
  fs.symlinkSync(outside, transactions);
}

for (const boundary of ['precreate-transaction-store', 'postcreate-transaction-store']) {
  test(`transaction creation proves the store anchor at ${boundary}`, () => {
    const { applyCommit } = require(statePath);
    const { root, outside, transactions } = escapeFixture(`deep wiki anchor ${boundary} `);
    let swapped = false;
    withLock(root, (token) => {
      assert.throws(() => applyCommit({
        wikiRoot: root,
        token,
        manifest: manifest(),
        now: new Date(TS),
        faultInjector: (seen) => {
          if (seen === boundary && !swapped) {
            swapped = true;
            swapStoreForSymlink(transactions, outside);
          }
        },
      }), (error) => error.code === 'WIKI_STATE_FILESYSTEM');
    });
    assert.equal(swapped, true);
    assert.deepEqual(fs.readdirSync(outside), ['EXTERNAL.txt']);
  });
}

test('junk reclamation re-checks the reserve after its validation syscalls', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const root = fixture('deep wiki junk validated reserve ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  fs.writeFileSync(path.join(transactions, '.DS_Store'), 'finder metadata\n');
  const clock = { now: 0, nowMs() { return this.now; } };
  const deadline = createDeadline({ clock, budgetMs: 12_000 });
  let validated = false;
  withLock(root, (token) => {
    const result = sweepTransactionDebris(root, token, {
      deadline,
      // Validation itself burned the budget; the unlink must not start.
      faultInjector: (boundary) => {
        if (boundary === 'junk-validated:0') { validated = true; clock.now = 11_000; }
      },
    });
    assert.deepEqual(result.removed_junk, []);
  });
  assert.equal(validated, true);
  assert.equal(fs.existsSync(path.join(transactions, '.DS_Store')), true);
});

test('a store swapped after a junk unlink is caught by the post-removal proof', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const { root, outside, transactions } = escapeFixture('deep wiki junk post proof ');
  fs.mkdirSync(transactions, { recursive: true });
  fs.writeFileSync(path.join(transactions, '.DS_Store'), 'finder metadata\n');
  let swapped = false;
  withLock(root, (token) => {
    assert.throws(() => sweepTransactionDebris(root, token, {
      deadline: createDeadline({ budgetMs: 12_000 }),
      faultInjector: (boundary) => {
        if (boundary === 'junk-removed:0' && !swapped) {
          swapped = true;
          swapStoreForSymlink(transactions, outside);
        }
      },
    }), (error) => error.code === 'WIKI_STATE_FILESYSTEM');
  });
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(outside), ['EXTERNAL.txt']);
});

test('a transaction directory swapped mid-teardown is caught before its children are followed', () => {
  const { sweepTransactionDebris } = require('../hooks/scripts/runtime/transaction-debris.js');
  const { root, outside, transactions } = escapeFixture('deep wiki subtree seal ');
  fs.mkdirSync(transactions, { recursive: true });
  const transaction = path.join(transactions, 'plain-debris');
  fs.mkdirSync(path.join(transaction, 'before'), { recursive: true });
  fs.writeFileSync(path.join(transaction, 'before', '0000.json'), 'staged\n');
  fs.writeFileSync(path.join(transaction, 'stray.json'), 'staged\n');
  let swapped = false;
  withLock(root, (token) => {
    assert.throws(() => sweepTransactionDebris(root, token, {
      deadline: createDeadline({ budgetMs: 12_000 }),
      faultInjector: (boundary) => {
        if (boundary === 'sweep-remove:0' && !swapped) {
          swapped = true;
          fs.rmSync(transaction, { recursive: true, force: true });
          fs.symlinkSync(outside, transaction);
        }
      },
    }), (error) => error.code === 'WIKI_STATE_FILESYSTEM');
  });
  assert.equal(swapped, true);
  assert.deepEqual(fs.readdirSync(outside), ['EXTERNAL.txt']);
});

test('no engine-generated transaction store name is classified as junk', () => {
  const {
    isTransactionStoreJunkName,
  } = require('../hooks/scripts/runtime/transaction-debris.js');
  const engineNames = [
    '01JZ7P9Q6MD7S5PB8H4Y40HJ83',
    '01JZ7P9Q6MD7S5PB8H4Y40HJ83.json',
    `.activate-${process.pid}-${crypto.randomUUID()}`,
    '.prune-5-phase-debris',
    '.reservation-.prune-5-phase-debris',
    'scan-window-ensure-45e46792a84a6967587d4d0ff06640920c78f9ff',
    `.${'01JZ7P9Q6MD7S5PB8H4Y40HJ83'}.tmp.${process.pid}.${crypto.randomUUID()}`,
    'journal.json',
    'cancelled.json',
  ];
  for (const name of engineNames) {
    assert.equal(isTransactionStoreJunkName(name), false, name);
  }
  const junkNames = [
    '.DS_Store', '.localized', '.apdisk', '.VolumeIcon.icns', 'Icon\r',
    'Thumbs.db', 'ehthumbs.db', 'desktop.ini',
    '.directory', '.dropbox', '.dropbox.attr',
    '._topic.md', '._',
  ];
  for (const name of junkNames) assert.equal(isTransactionStoreJunkName(name), true, name);
});

test('an ingest commit reclaims OS metadata left in the transaction store', () => {
  const { applyCommit } = require(statePath);
  const root = fixture('deep wiki commit junk reclaim ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  fs.writeFileSync(path.join(transactions, '.DS_Store'), 'finder metadata\n');
  withLock(root, (token) => applyCommit({
    wikiRoot: root, token, manifest: manifest(), now: new Date(TS),
  }));
  assert.equal(fs.existsSync(path.join(root, 'pages', 'topic.md')), true);
  assert.equal(fs.existsSync(path.join(transactions, '.DS_Store')), false);
});

test('lint fix self-heals a transaction store wedged by an OS metadata file', () => {
  const { fixWiki } = require(statePath);
  const root = fixture('deep wiki lint fix junk ');
  const transactions = path.join(root, '.wiki-meta', '.transactions');
  fs.mkdirSync(transactions, { recursive: true });
  fs.writeFileSync(path.join(transactions, '.DS_Store'), 'finder metadata\n');
  const result = fixWiki({ wikiRoot: root, now: new Date(TS) });
  assert.equal(result.status, 'fixed');
  assert.equal(fs.existsSync(path.join(transactions, '.DS_Store')), false);
});

test('setup refuses a nonempty incompatible target before creating wiki state', () => {
  const { setupWiki } = require(statePath);
  const home = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'deep wiki incompatible setup home ')));
  roots.add(home);
  const root = path.join(home, 'wiki');
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, 'foreign.txt'), 'preserve me\n');
  assert.throws(
    () => setupWiki({ wikiRoot: root, env: setupEnv(home), now: new Date(TS) }),
    (error) => error.code === 'WIKI_STATE_INVALID',
  );
  assert.deepEqual(fs.readdirSync(root), ['foreign.txt']);
  assert.equal(fs.readFileSync(path.join(root, 'foreign.txt'), 'utf8'), 'preserve me\n');
});
