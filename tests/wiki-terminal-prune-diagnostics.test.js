'use strict';

// Issue #60: a terminal prune quarantine that its safety checks refuse must be reported, not
// swallowed. These tests build the stalled states on temporary roots only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { fixWiki } = require('../hooks/scripts/runtime/wiki-state.js');
const {
  createStalledQuarantine,
  createWikiRoot,
  makeBackupPublicationAmbiguous,
} = require('./helpers/wiki-lint-pruning-fixture.js');

const roots = new Set();

function wiki() {
  const root = createWikiRoot();
  roots.add(root);
  return root;
}

function storeTree(root) {
  const transactions = path.join(root, '.wiki-meta', '.transactions');
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
  visit(transactions, '');
  return out.sort();
}

test.after(() => {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
});

test('an ambiguous backup publication stalls lint fix without changing the store', () => {
  const root = wiki();
  const stalled = createStalledQuarantine(root);
  makeBackupPublicationAmbiguous(stalled.quarantine);
  const before = storeTree(root);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    assert.throws(() => fixWiki({ wikiRoot: root, now: stalled.now }), (error) =>
      error.code === 'TRANSACTION_RECOVERY_REQUIRED'
      && /stopped-host/i.test(error.message));
  }
  assert.deepEqual(storeTree(root), before);
  assert.equal(fs.existsSync(path.join(root, '.wiki-meta', '.wiki-lock')), false);
});
