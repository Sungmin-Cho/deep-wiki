'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relativePath), 'utf8'));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

function changelogSection(text, heading) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, heading);
  const next = text.indexOf('\n## [', start + heading.length);
  return text.slice(start, next === -1 ? undefined : next);
}

test('Codex manifest uses default hook discovery and has no MCP surface', () => {
  const manifest = readJson('.codex-plugin/plugin.json');
  assert.equal(Object.hasOwn(manifest, 'hooks'), false);
  assert.equal(Object.hasOwn(manifest, 'mcpServers'), false);
  assert.equal(manifest.skills, './skills/');
});

test('all package versions remain exactly aligned', () => {
  const versions = [
    readJson('.codex-plugin/plugin.json').version,
    readJson('.claude-plugin/plugin.json').version,
    readJson('package.json').version,
  ];
  assert.equal(new Set(versions).size, 1, `version drift: ${versions.join(', ')}`);
});

test('default SessionStart hook has one supported command entry', () => {
  const config = readJson('hooks/hooks.json');
  assert.deepEqual(Object.keys(config).sort(), ['description', 'hooks']);
  assert.deepEqual(Object.keys(config.hooks), ['SessionStart']);
  assert.equal(config.hooks.SessionStart.length, 1);

  const registration = config.hooks.SessionStart[0];
  assert.equal(registration.matcher, '*');
  assert.equal(registration.hooks.length, 1);

  const command = registration.hooks[0];
  const allowed = new Set(['type', 'command', 'commandWindows', 'timeout', 'statusMessage']);
  assert.deepEqual(
    Object.keys(command).filter((key) => !allowed.has(key)),
    [],
  );
  assert.equal(command.type, 'command');
  assert.equal(command.timeout, 15);
  assert.equal(command.command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/scripts/scan-vault-changes.js"');
  assert.equal(command.commandWindows, 'node "${CLAUDE_PLUGIN_ROOT}\\hooks\\scripts\\scan-vault-changes.js"');
  for (const value of [command.command, command.commandWindows]) {
    assert.doesNotMatch(value, /[|;&<>`\r\n]|\$\(/);
    assert.doesNotMatch(value, /\.(?:sh|cmd|bat|ps1)(?:"|\s|$)/i);
  }
  assert.equal(fs.existsSync(path.join(ROOT, 'hooks', 'scripts', 'scan-vault-changes.sh')), false);
});

test('portable npm test cannot discover the native installed-Codex release smoke', () => {
  const pkg = readJson('package.json');
  const portable = pkg.scripts.test;
  const driver = path.join(ROOT, 'tests', 'codex-plugin-hook-smoke-driver.test.js');
  const release = path.join(ROOT, 'tests', 'release', 'codex-plugin-hook-smoke.release.js');

  assert.equal(fs.existsSync(driver), true);
  assert.equal(fs.existsSync(release), true);
  assert.match(driver, /\.test\.js$/);
  assert.doesNotMatch(release, /\.test\.js$/);
  assert.doesNotMatch(portable, /codex-plugin-hook-smoke\.release|test:codex-windows-release/);
  assert.match(portable, /^node --test --test-concurrency=1$/);

  const workflow = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'tests.yml'), 'utf8');
  const smoke = fs.readFileSync(path.join(ROOT, 'scripts', 'codex-plugin-hook-smoke.js'), 'utf8');
  const releaseSource = fs.readFileSync(release, 'utf8');
  const helper = path.join(ROOT, 'tests', 'helpers', 'codex-loopback-responses.js');
  const fixture = path.join(ROOT, 'tests', 'fixtures', 'codex-release-smoke.json');
  assert.equal(fs.existsSync(helper), true);
  assert.equal(fs.existsSync(fixture), true);
  for (const label of ['ubuntu-24.04', 'macos-15', 'macos-15-intel', 'windows-2025']) {
    assert.match(workflow, new RegExp(`- os: ${label.replaceAll('.', '\\.')}(?:\\r?\\n|$)`));
  }
  assert.doesNotMatch(workflow, /ubuntu-latest|macos-latest|windows-latest|workflow_dispatch/);
  assert.match(workflow, /node-version: '22'/);
  assert.match(workflow, /EXPECTED_SHA:.*pull_request\.head\.sha/);
  assert.match(workflow, /ref:.*EXPECTED_SHA/);
  assert.match(workflow, /persist-credentials:\s*false/);
  assert.match(workflow, /git'.*'rev-parse'.*'HEAD'/s);
  for (const command of [
    'npm test', 'npm run validate-fixture', 'npm run lint:commands',
    'npm run lint:agents', 'npm run validate-plugin',
  ]) assert.match(workflow, new RegExp(command.replaceAll(' ', '\\s+')));
  assert.match(workflow, /@openai\/codex@0\.144\.1/);
  assert.match(workflow, /@openai\/codex-win32-x64\/vendor\/x86_64-pc-windows-msvc\/bin\/codex\.exe/);
  assert.match(workflow, /--ignore-scripts/);
  assert.match(workflow, /codex-cli 0\.144\.1/);
  assert.match(workflow, /vendorVersion -ne '0\.144\.1-win32-x64'/);
  assert.match(workflow, /test:codex-windows-release/);
  assert.match(releaseSource, /CANDIDATE_SHA/);
  assert.match(releaseSource, /CODEX_BINARY_SHA256/);
  assert.match(releaseSource, /await runCodexPluginHookSmoke/);
  assert.doesNotMatch(`${workflow}\n${smoke}\n${releaseSource}`, /process\.env\.(?:OPENAI_API_KEY|CODEX_ACCESS_TOKEN)|secrets\.|vars\.|environment:/);
  assert.doesNotMatch(workflow, /https?:\/\/(?!github\.com\/actions|registry\.npmjs)/);
  assert.equal(fs.existsSync(path.join(ROOT, '.github', 'workflows', 'windows-codex-release.yml')), false);

  const helperSource = fs.readFileSync(helper, 'utf8');
  const fixtureValue = readJson('tests/fixtures/codex-release-smoke.json');
  assert.match(helperSource, /1024 \* 1024/);
  assert.match(helperSource, /server\.listen\(0, '127\.0\.0\.1'/);
  assert.match(helperSource, /body_sha256/);
  assert.doesNotMatch(helperSource, /rawBody|raw_prompt|prompt_text/);
  assert.equal(fixtureValue.request.method, 'POST');
  assert.equal(fixtureValue.request.path, '/v1/responses');
  assert.deepEqual(fixtureValue.sse_events, [
    'response.created',
    'response.in_progress',
    'response.output_item.added',
    'response.content_part.added',
    'response.output_text.delta',
    'response.output_text.done',
    'response.content_part.done',
    'response.output_item.done',
    'response.completed',
  ]);
  assert.equal(fixtureValue.public_bearer, 'deep-wiki-loopback-public-v1');
  assert.equal(fixtureValue.model, 'gpt-5.4-mini');

  assert.match(smoke, /git',\s*\['ls-tree', '-r', '-z', '--full-tree'/);
  assert.match(smoke, /git',\s*\['cat-file', 'blob'/);
  assert.doesNotMatch(smoke, /stableTrustDenial|UNTRUSTED_HOOK_DENIAL|denied:\s*true/);
  assert.match(smoke, /deep_wiki_effect:\s*false/);
  assert.match(smoke, /model_continued:\s*true/);
  assert.match(smoke, /direct_installed_supervisor/);
  assert.match(smoke, /direct\.stdout !== expectedDirectOutput/);
  assert.doesNotMatch(smoke, /DIRECT_SUPERVISOR_PARITY|expectedInputText/);
  assert.match(smoke, /record\?\.item\?\.type === 'agent_message'/);
  assert.match(smoke, /ageMs > maxAgeMs/);
  assert.match(smoke, /diagnostic-exec/);
  assert.ok(smoke.lastIndexOf('untrusted-exec') < smoke.lastIndexOf('const diagnostic = await runDiagnosticPhase'));
  assert.match(smoke, /stdio: \['ignore', 'pipe', 'pipe'\]/);
  assert.match(smoke, /shell: false/);
  assert.match(smoke, /windowsHide: true/);
});

test('1.11.0 release keeps package identity and bilingual changelogs exact', () => {
  const packageFiles = [
    '.claude-plugin/plugin.json',
    '.codex-plugin/plugin.json',
    'package.json',
  ];
  for (const file of packageFiles) assert.equal(readJson(file).version, '1.11.0', file);

  const releaseSection = (text, heading) => {
    const start = text.indexOf(heading);
    assert.notEqual(start, -1, heading);
    const next = text.indexOf('\n## [', start + heading.length);
    return text.slice(start, next === -1 ? undefined : next);
  };
  const changelog = readText('CHANGELOG.md');
  const changelogKo = readText('CHANGELOG.ko.md');
  const english1101 = releaseSection(changelog, '## [1.10.1] — 2026-08-26 (worker dispatch contract)');
  const korean1101 = releaseSection(changelogKo, '## [1.10.1] — 2026-08-26 (worker dispatch 계약)');
  const english1110 = releaseSection(changelog, '## [1.11.0] — 2026-09-15 (main-caller ingest)');
  const korean1110 = releaseSection(changelogKo, '## [1.11.0] — 2026-09-15 (main-caller ingest)');
  assert.match(english1110, /`main-caller-sequential` route/);
  assert.match(english1110, /URL source-origin prompt contract/);
  assert.match(english1110, /no host reads them/);
  assert.match(english1110, /distinct 1\.11\.0 installation identity/);
  assert.match(korean1110, /`main-caller-sequential` route/);
  assert.match(korean1110, /URL source-origin prompt contract/);
  assert.match(korean1110, /어느 host도 이 값을 읽지 않습니다/);
  assert.match(korean1110, /별도 1\.11\.0 설치 식별자/);
  assert.match(english1101, /effective `a5_fanout_threshold` and `a5_worker_timeout_sec`/);
  assert.match(english1101, /positive safe integers/);
  assert.match(english1101, /anchored input\/output contract/);
  assert.match(english1101, /only a true non-response/);
  assert.match(english1101, /distinct 1\.10\.1 installation identity/);
  assert.match(korean1101, /effective `a5_fanout_threshold`와 `a5_worker_timeout_sec`/);
  assert.match(korean1101, /양의 safe integer/);
  assert.match(korean1101, /anchored input\/output 계약/);
  assert.match(korean1101, /실제 non-response만/);
  assert.match(korean1101, /별도 1\.10\.1 설치 식별자/);
  const english197 = releaseSection(changelog, '## [1.9.7] — 2026-08-05 (content metadata and nested prune safety)');
  const korean197 = releaseSection(changelogKo, '## [1.9.7] — 2026-08-05 (콘텐츠 메타데이터 및 중첩 prune 안전성)');
  assert.match(english197, /nested terminal and quarantine metadata/i);
  assert.match(english197, /parent-first `\.wiki-meta` anchor/);
  assert.match(english197, /non-regular recognized names remain recovery conditions/);
  assert.match(english197, /distinct 1\.9\.7 installation identity/);
  assert.match(korean197, /중첩 terminal·quarantine 메타데이터/);
  assert.match(korean197, /parent-first `\.wiki-meta` anchor/);
  assert.match(korean197, /non-regular 인식 이름은 recovery 조건/);
  assert.match(korean197, /별도 1\.9\.7 설치 식별자/);
  assert.equal(
    english197.includes(
      '- Content readers now skip regular AppleDouble and exact OS-metadata files in `pages/`, `.wiki-meta/sources/`, and `.wiki-meta/.versions/`, report them in `ignored_os_metadata`, and never delete them; junk-named symlinks/directories remain fail-closed, and `removed_junk` remains transaction-store-only.',
    ),
    true,
  );
  assert.equal(
    korean197.includes(
      '- `pages/`, `.wiki-meta/sources/`, `.wiki-meta/.versions/`의 regular AppleDouble 및 정확한 OS 메타데이터 파일은 content reader가 건너뛰고 `ignored_os_metadata`에 보고하며 삭제하지 않습니다. junk 이름의 symlink/directory는 fail-closed로 유지되고, `removed_junk`는 transaction store에만 해당합니다.',
    ),
    true,
  );

  const english196 = releaseSection(
    changelog,
    '## [1.9.6] — 2026-08-04 (transaction store junk tolerance)',
  );
  assert.match(english196, /no longer wedges the wiki/);
  assert.match(english196, /TRANSACTION_RECOVERY_REQUIRED/);
  assert.match(english196, /AppleDouble `\._` prefix/);
  assert.match(english196, /never followed or removed/);
  assert.match(english196, /anchors its own store before it enumerates or deletes/);
  assert.match(english196, /fails closed with `WIKI_STATE_FILESYSTEM`/);
  assert.match(english196, /a refused unlink/);
  assert.match(english196, /device, inode, and birth time/);
  assert.match(english196, /swept to completion before any OS metadata is considered/);
  assert.match(english196, /still fails closed, whatever its errno/);
  assert.match(english196, /Known residual/);
  assert.match(english196, /no handle-relative `unlinkat`/);
  assert.match(english196, /distinct 1\.9\.6 installation identity/);

  const korean196 = releaseSection(
    changelogKo,
    '## [1.9.6] — 2026-08-04 (transaction store 잡파일 내성)',
  );
  assert.match(korean196, /위키 전체가 잠기지 않습니다/);
  assert.match(korean196, /TRANSACTION_RECOVERY_REQUIRED/);
  assert.match(korean196, /AppleDouble `\._` 접두사/);
  assert.match(korean196, /따라가지도 제거하지도 않습니다/);
  assert.match(korean196, /열거·삭제 전에 자기 저장소를 먼저 anchor합니다/);
  assert.match(korean196, /`WIKI_STATE_FILESYSTEM`으로 fail closed합니다/);
  assert.match(korean196, /unlink가 거부되면/);
  assert.match(korean196, /device·inode·birth time/);
  assert.match(korean196, /모두 정리한 뒤에야 OS 메타데이터를 처리합니다/);
  assert.match(korean196, /errno가 무엇이든 fail closed입니다/);
  assert.match(korean196, /알려진 잔여 위험/);
  assert.match(korean196, /handle 기반 `unlinkat`이 없고/);
  assert.match(korean196, /별도 1\.9\.6 설치 식별자/);

  const english195 = releaseSection(
    changelog,
    '## [1.9.5] — 2026-08-01 (lock contention observability)',
  );
  assert.match(english195, /every `LOCK_CONTENDED` result/);
  assert.match(english195, /holder: null/);
  assert.match(english195, /active release transition/);
  assert.match(english195, /distinct 1\.9\.5 installation identity/);

  const korean195 = releaseSection(
    changelogKo,
    '## [1.9.5] — 2026-08-01 (lock 경합 관측성)',
  );
  assert.match(korean195, /모든 `LOCK_CONTENDED` 결과/);
  assert.match(korean195, /holder: null/);
  assert.match(korean195, /활성 release transition/);
  assert.match(korean195, /별도 1\.9\.5 설치 식별자/);

  const english = releaseSection(
    changelog,
    '## [1.9.4] — 2026-07-31 (lint repair reclamation)',
  );
  assert.match(english, /Completed scan-window `ensure` journals/);
  assert.match(english, /self-healing reclamation/);
  assert.match(english, /Fractional-clock `lint fix` operations/);
  assert.match(english, /MANIFEST_INVALID/);
  assert.match(english, /distinct 1\.9\.4 installation identity/);

  const korean = releaseSection(
    changelogKo,
    '## [1.9.4] — 2026-07-31 (lint repair 회수)',
  );
  assert.match(korean, /완료된 scan-window `ensure` journal/);
  assert.match(korean, /자체 복구 회수/);
  assert.match(korean, /Fractional-clock `lint fix` 작업/);
  assert.match(korean, /MANIFEST_INVALID/);
  assert.match(korean, /별도 1\.9\.4 설치 식별자/);

  assert.match(
    releaseSection(changelog, '## [1.9.3] — 2026-07-30'),
    /wiki-runtime snapshot/,
  );
  assert.match(
    releaseSection(changelogKo, '## [1.9.3] — 2026-07-30'),
    /wiki-runtime snapshot/,
  );
});

test('1.8.0 release documents the reviewed runtime and evidence boundary', () => {
  // CLAUDE.md is excluded: AGENTS.md is the single source for shared runtime rules
  // and CLAUDE.md reaches it through `@AGENTS.md`. Asserting the boundary in both
  // would require the duplication the AGENTS-first restructure removed. That import
  // is what makes the exclusion sound, so it is asserted rather than assumed.
  // Pinned to line 1: a multiline-anchored match would accept the import anywhere
  // in the file, which is not the AGENTS-first standard.
  assert.equal(readText('CLAUDE.md').split('\n')[0].trim(), '@AGENTS.md');
  const englishRuntimeDocs = [
    'README.md', 'AGENTS.md', 'CONTRIBUTING.md', 'SECURITY.md',
  ];
  const englishBoundary = [
    /cooperative current writer/i,
    /post-seizure owner and directory checks/i,
    /stopped-host intervention/i,
    /concurrent old version/i,
    /mounted-filesystem and process-termination durability/i,
    /%COMSPEC%\s+\/C/,
    /no shipped shell-script runtime/i,
    /Windows Server 2025/,
    /macOS arm64 and Intel/,
    /no Windows 11 claim/i,
    /no plugin MCP server or native binary/i,
    /backup-only downgrade/i,
    /unauthenticated local Responses fixture/i,
    /not production OpenAI API, login, model-quality, Windows 11, arbitrary-user-machine, or OS-level no-egress certification/i,
  ];
  for (const file of englishRuntimeDocs) {
    const text = readText(file).replace(/\s+/g, ' ');
    for (const pattern of englishBoundary) assert.match(text, pattern, `${file}: ${pattern}`);
  }

  const koreanRuntimeDocs = ['README.ko.md'];
  const koreanBoundary = [
    /협력적 현재 writer/,
    /탈취 후 owner와 directory 검사/,
    /host를 중지한 상태의 개입/,
    /구버전 동시 실행 금지/,
    /마운트된 파일시스템과 프로세스 종료 내구성/,
    /%COMSPEC%\s+\/C/,
    /배포 shell-script runtime 없음/,
    /Windows Server 2025/,
    /macOS arm64와 Intel/,
    /Windows 11 주장 없음/,
    /플러그인 MCP 서버나 native binary 없음/,
    /백업 전용 downgrade/,
    /인증 없는 로컬 Responses fixture/,
    /프로덕션 OpenAI API, login, model 품질, Windows 11, 임의 사용자 머신, OS 수준 no-egress 인증이 아니다/,
  ];
  for (const file of koreanRuntimeDocs) {
    const text = readText(file).replace(/\s+/g, ' ');
    for (const pattern of koreanBoundary) assert.match(text, pattern, `${file}: ${pattern}`);
  }

  assert.match(readText('CHANGELOG.md'), /## \[1\.8\.0\] — 2026-07-19/);
  assert.match(readText('CHANGELOG.md'), /unauthenticated local Responses fixture/i);
  assert.match(readText('CHANGELOG.ko.md'), /## \[1\.8\.0\] — 2026-07-19/);
  assert.match(readText('CHANGELOG.ko.md'), /인증 없는 로컬 Responses fixture/);
});

test('wiki-local auto-ingest and setup-authority operator docs stay aligned', () => {
  const schema = readText('skills/wiki-schema/wiki-schema.yaml');
  assert.match(schema, /config_block:\s+"<wiki_root>\/\.wiki-meta\/\.config\.json"/);
  assert.match(schema, /legacy_alias:\s+"Global host YAML .*bootstrap\/legacy alias/);
  assert.match(schema, /owner:\s+"wiki-local"/);
  assert.match(schema, /accepted_keys:\s+\["auto_ingest", "a5_fanout_threshold", "a5_worker_timeout_sec"\]/);
  assert.match(schema, /invalid_local_fail_closed: "Non-regular file, symlink, duplicate key, invalid UTF-8, and >64 KiB wiki-local config states are CONFIG_INVALID."/);
  assert.match(schema, /a5_preservation: "Migration preserves a5_fanout_threshold and a5_worker_timeout_sec while moving only auto_ingest ownership."/);
  assert.match(schema, /conflict_recovery: "CONFIG_CONFLICT local-vs-legacy policy values require matching local and legacy values or deleting one policy block while hosts are stopped; CONFIG_CONFLICT candidates=/);
  assert.doesNotMatch(schema, /absence = defaults; no migration needed/);

  const englishSurfaces = [
    'README.md',
    'skills/wiki-schema/SKILL.md',
    'skills/wiki-schema/references/storage-layout.md',
  ];
  for (const file of englishSurfaces) {
    const text = readText(file).replace(/\s+/g, ' ');
    assert.match(text, /wiki-local `\.wiki-meta\/\.config\.json` owns `auto_ingest`/i, file);
    assert.match(text, /global host YAML `auto_ingest` is only a bootstrap\/legacy alias/i, file);
    assert.match(text, /conflicting local and legacy policies fail closed/i, file);
    assert.match(text, /accepted wiki-local keys are `auto_ingest`, `a5_fanout_threshold`, and `a5_worker_timeout_sec`/i, file);
    assert.match(text, /migration preserves A5 keys/i, file);
    assert.match(text, /ignore globs are vault-relative/i, file);
    assert.match(text, /non-regular file, symlink, duplicate key, invalid UTF-8, or >64 KiB/i, file);
    assert.match(text, /`CONFIG_CONFLICT` recovery for local-vs-legacy policy values is to make local and legacy values match, or delete one policy block/i, file);
    assert.match(text, /`CONFIG_CONFLICT candidates=[^`]+` means cross-host candidate YAML files diverge/i, file);
    assert.match(text, /remove legacy YAML only after `policy_source=wiki_local_migrated`/i, file);
    assert.match(text, /re-resolve and confirm `policy_source=wiki_local`/i, file);
    assert.match(text, /stop all hosts before direct edit/i, file);
    assert.match(text, /divergent `CODEX_HOME` or `HOME` values create separate setup-authority domains/i, file);
    assert.match(text, /explicit stopped-host rebind/i, file);
    assert.match(text, /rebind resumes require the original `CODEX_HOME` and `DEEP_WIKI_CONFIG` spelling/i, file);
    assert.match(text, /backup-only downgrade/i, file);
    assert.match(text, /`--replace-config` does not bypass invalid selected-host YAML/i, file);
    assert.match(text, /`\.deep-wiki-setup-authority\.json` and `\.deep-wiki-setup\.reserve` are home authority artifacts, never SessionStart config candidates/i, file);
  }

  const korean = readText('README.ko.md').replace(/\s+/g, ' ');
  assert.match(korean, /wiki-local `\.wiki-meta\/\.config\.json`가 `auto_ingest`를 소유/);
  assert.match(korean, /global host YAML `auto_ingest`는 bootstrap\/legacy alias/);
  assert.match(korean, /충돌하는 local 및 legacy policy는 fail closed/);
  assert.match(korean, /허용되는 wiki-local key는 `auto_ingest`, `a5_fanout_threshold`, `a5_worker_timeout_sec`/);
  assert.match(korean, /migration은 A5 key를 보존/);
  assert.match(korean, /ignore glob은 vault-relative/);
  assert.match(korean, /non-regular file, symlink, duplicate key, invalid UTF-8, 또는 >64 KiB/);
  assert.match(korean, /`CONFIG_CONFLICT` recovery for local-vs-legacy policy values는 local과 legacy 값을 일치시키거나 policy block 하나를 삭제/);
  assert.match(korean, /`CONFIG_CONFLICT candidates=[^`]+`는 cross-host candidate YAML file divergence/);
  assert.match(korean, /legacy YAML은 `policy_source=wiki_local_migrated` 이후에만 제거/);
  assert.match(korean, /다시 resolve해 `policy_source=wiki_local` 확인/);
  assert.match(korean, /직접 편집 전에는 모든 host를 중지/);
  assert.match(korean, /서로 다른 `CODEX_HOME` 또는 `HOME` 값은 별도 setup-authority domain/);
  assert.match(korean, /명시적 stopped-host rebind/);
  assert.match(korean, /rebind resume에는 원래 `CODEX_HOME` 및 `DEEP_WIKI_CONFIG` spelling/);
  assert.match(korean, /백업 전용 downgrade/);
  assert.match(korean, /`--replace-config`는 invalid selected-host YAML을 우회하지 않습니다/);
  assert.match(korean, /`\.deep-wiki-setup-authority\.json`와 `\.deep-wiki-setup\.reserve`는 home authority artifact이며 SessionStart config candidate가 아닙니다/);

  const readme = readText('README.md').replace(/\s+/g, ' ');
  assert.match(readme, /"auto_ingest":\s*\{\s*"ignore_globs":\s*\[\s*"archive\/\*\*"\s*\],\s*"require_tag":\s*"project"\s*\}/);
  assert.match(readme, /YAML examples above are bootstrap\/legacy alias forms/i);
  assert.match(readme, /including non-regular file, symlink, duplicate key, invalid UTF-8, or >64 KiB.*`CONFIG_INVALID`/i);
  assert.match(readme, /local-vs-legacy policy values/);
  assert.match(readme, /`CONFIG_CONFLICT candidates=[^`]+` means cross-host candidate YAML files diverge/);

  const koreanReadme = readText('README.ko.md').replace(/\s+/g, ' ');
  assert.match(koreanReadme, /"auto_ingest":\s*\{\s*"ignore_globs":\s*\[\s*"archive\/\*\*"\s*\],\s*"require_tag":\s*"project"\s*\}/);
  assert.match(koreanReadme, /위 YAML 예시는 bootstrap\/legacy alias 형식/);
  assert.match(koreanReadme, /including non-regular file, symlink, duplicate key, invalid UTF-8, 또는 >64 KiB.*`CONFIG_INVALID`/);
  assert.match(koreanReadme, /local-vs-legacy policy value/);
  assert.match(koreanReadme, /`CONFIG_CONFLICT candidates=[^`]+`는 cross-host candidate YAML file divergence/);

  const changelogCurrent = changelogSection(readText('CHANGELOG.md'), '## [1.10.0] — 2026-08-25 (oversized transaction isolation)');
  assert.match(changelogCurrent, /setup lifecycle event.*`YYYY-MM-DDTHH:MM:SSZ`.*`MANIFEST_INVALID`/);
  assert.doesNotMatch(changelogCurrent, /scan-window metadata/);
  assert.match(changelogCurrent, /`auto_ingest` policy now lives in `<wiki_root>\/\.wiki-meta\/\.config\.json`/);
  assert.match(changelogCurrent, /`\/wiki-setup` and SessionStart create it by migrating an equivalent global YAML block/);
  assert.match(changelogCurrent, /`\/wiki-setup` also creates `~\/\.deep-wiki-setup-authority\.json` and `~\/\.deep-wiki-setup\.reserve\/`/);
  assert.match(changelogCurrent, /Divergent local\/legacy policy and representative invalid local config shapes now fail closed/);
  assert.match(changelogCurrent, /TRANSACTION_OVERSIZED/);
  assert.match(changelogCurrent, /transaction quarantine/);
  assert.match(changelogCurrent, /SessionStart ensure, lint fix, transaction prune, and transaction quarantine/);
  assert.match(changelogCurrent, /automatically relocate isolatable oversized trees/);
  assert.match(changelogCurrent, /never auto-deleted/);

  const changelogHistorical = readText('CHANGELOG.md');
  assert.doesNotMatch(changelogHistorical, /no shipped code reads that file/);
  assert.match(changelogHistorical, /At 1\.9\.2 release time, no shipped code read that file/);

  const koreanChangelogCurrent = changelogSection(readText('CHANGELOG.ko.md'), '## [1.10.0] — 2026-08-25 (oversized 트랜잭션 격리)');
  assert.match(koreanChangelogCurrent, /setup lifecycle event.*`YYYY-MM-DDTHH:MM:SSZ`.*`MANIFEST_INVALID`/);
  assert.doesNotMatch(koreanChangelogCurrent, /scan-window metadata/);
  assert.match(koreanChangelogCurrent, /`auto_ingest` policy는 이제 `<wiki_root>\/\.wiki-meta\/\.config\.json`에 저장/);
  assert.match(koreanChangelogCurrent, /`\/wiki-setup`과 SessionStart가 동등한 global YAML block을 migration해 생성/);
  assert.match(koreanChangelogCurrent, /`\/wiki-setup`은 `~\/\.deep-wiki-setup-authority\.json`와 `~\/\.deep-wiki-setup\.reserve\/`도 생성/);
  assert.match(koreanChangelogCurrent, /divergent local\/legacy policy와 대표 invalid local config shape는 fail closed/);
  assert.match(koreanChangelogCurrent, /TRANSACTION_OVERSIZED/);
  assert.match(koreanChangelogCurrent, /transaction quarantine/);
  assert.match(koreanChangelogCurrent, /SessionStart ensure, lint fix, transaction prune, transaction quarantine/);
  assert.match(koreanChangelogCurrent, /isolatable oversized tree를 자동으로 옮깁니다/);
  assert.match(koreanChangelogCurrent, /자동 삭제하지 않습니다/);

  const koreanChangelogHistorical = readText('CHANGELOG.ko.md');
  assert.doesNotMatch(koreanChangelogHistorical, /배포되는 코드 중 이 파일을 읽는 곳은 없습니다/);
  assert.match(koreanChangelogHistorical, /1\.9\.2 release 시점에는 배포되는 코드 중 이 파일을 읽는 곳이 없었습니다/);
});

test('1.8.0 ships no MCP, native binary, runtime dependency, or shell entrypoint', () => {
  const codexManifest = readJson('.codex-plugin/plugin.json');
  const claudeManifest = readJson('.claude-plugin/plugin.json');
  const pkg = readJson('package.json');
  assert.equal(Object.hasOwn(codexManifest, 'mcpServers'), false);
  assert.equal(Object.hasOwn(claudeManifest, 'mcpServers'), false);
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies', 'bundledDependencies']) {
    assert.equal(Object.hasOwn(pkg, field), false, field);
  }

  const tracked = childProcess.execFileSync('git', ['ls-files', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).split('\0').filter(Boolean);
  assert.deepEqual(tracked.filter((file) => /(^|\/)\.mcp\.json$/.test(file)), []);
  assert.deepEqual(tracked.filter((file) => file.startsWith('native/')), []);

  const shellEntrypoints = tracked.filter((file) => /\.(?:sh|cmd|bat|ps1)$/i.test(file));
  assert.deepEqual(shellEntrypoints.sort(), [
    'scripts/v0-probe/v0-record.sh',
    'scripts/v0-probe/v1-record.sh',
    'scripts/v0-probe/v2-v3-record.sh',
  ]);
});
