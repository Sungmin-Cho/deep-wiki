'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const readJson = (file) => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
const readText = (file) => fs.readFileSync(path.join(root, file), 'utf8');

const versions = [
  readJson('.claude-plugin/plugin.json').version,
  readJson('.codex-plugin/plugin.json').version,
  readJson('package.json').version];
test('1.12.0 release keeps every package version and changelog heading exact', () => { assert.strictEqual(versions.join(','), '1.12.0,1.12.0,1.12.0');
  assert.match(readText('CHANGELOG.md'), /^## \[1\.12\.0\] — 2026-09-25 \(blocked prune diagnostics\)$/m);
  assert.match(readText('CHANGELOG.ko.md'), /^## \[1\.12\.0\] — 2026-09-25 \(막힌 prune 진단\)$/m);
  assert.match(readText('CHANGELOG.md'), /^## \[1\.11\.0\] — 2026-09-15 \(main-caller ingest\)$/m);
  assert.match(readText('CHANGELOG.ko.md'), /^## \[1\.11\.0\] — 2026-09-15 \(main-caller ingest\)$/m);
  assert.match(readText('CHANGELOG.md'), /^## \[1\.10\.1\] — 2026-08-26 \(worker dispatch contract\)$/m);
  assert.match(readText('CHANGELOG.ko.md'), /^## \[1\.10\.1\] — 2026-08-26 \(worker dispatch 계약\)$/m);
  assert.match(readText('CHANGELOG.md'), /^## \[1\.10\.0\] — 2026-08-25 \(oversized transaction isolation\)$/m);
  assert.match(readText('CHANGELOG.ko.md'), /^## \[1\.10\.0\] — 2026-08-25 \(oversized 트랜잭션 격리\)$/m);
  assert.match(readText('CHANGELOG.md'), /^## \[1\.9\.7\] — 2026-08-05 \(content metadata and nested prune safety\)$/m);
  assert.match(readText('CHANGELOG.ko.md'), /^## \[1\.9\.7\] — 2026-08-05 \(콘텐츠 메타데이터 및 중첩 prune 안전성\)$/m);
});
