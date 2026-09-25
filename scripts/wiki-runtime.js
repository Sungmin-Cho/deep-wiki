#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const runtimeRoot = path.resolve(__dirname, '..', 'hooks', 'scripts', 'runtime');
const { resolveConfig } = require(path.join(runtimeRoot, 'config.js'));
const {
  acquireLock,
  releaseLock,
  recoverLock,
  assertLockOwner,
} = require(path.join(runtimeRoot, 'lock.js'));
const wikiState = require(path.join(runtimeRoot, 'wiki-state.js'));
const scanWindow = require(path.join(runtimeRoot, 'scan-window.js'));
const { createDeadline } = require(path.join(runtimeRoot, 'deadline.js'));
const { sha256, stateError } = require(path.join(runtimeRoot, 'fs-safe.js'));
const { probeObsidian, runObsidian } = require(path.join(runtimeRoot, 'obsidian-probe.js'));
const { terminateWorkerTree } = require(path.resolve(
  __dirname,
  '..',
  'hooks',
  'scripts',
  'scan-vault-changes.js',
));

const SNAPSHOT_TIMEOUT_MS = 12_000;
const SNAPSHOT_WORKER_GRACE_MS = 250;
const SNAPSHOT_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

const HELP = `deep-wiki portable runtime

Usage:
  node scripts/wiki-runtime.js config resolve --json
  node scripts/wiki-runtime.js lock acquire --wiki-root <absolute> --operation <name> --json
  node scripts/wiki-runtime.js lock status --wiki-root <absolute> --json
  node scripts/wiki-runtime.js lock release --wiki-root <absolute> --token <token> --json
  node scripts/wiki-runtime.js lock recover --wiki-root <absolute> --stale-ms <integer> [--force] --json
  node scripts/wiki-runtime.js setup --wiki-root <absolute> --config-host <claude|codex> [--replace-config] --json
  node scripts/wiki-runtime.js setup --rebind-authority-from <old-absolute> --wiki-root <new-absolute> --config-host <claude|codex> --json
  node scripts/wiki-runtime.js probe obsidian --json
  node scripts/wiki-runtime.js obsidian search --query <text> [--limit <n>] --json
  node scripts/wiki-runtime.js obsidian backlinks --path <vault-note-path> --json
  node scripts/wiki-runtime.js obsidian tags --json
  node scripts/wiki-runtime.js snapshot --wiki-root <absolute> --json
  node scripts/wiki-runtime.js commit --wiki-root <absolute> --lock-token <token> --manifest-file <absolute-json> --json
  node scripts/wiki-runtime.js transaction recover --wiki-root <absolute> --operation-id <id> --json
  node scripts/wiki-runtime.js transaction recover --wiki-root <absolute> --lock-token <token> --operation-id <id> --json
  node scripts/wiki-runtime.js transaction prune --wiki-root <absolute> --lock-token <token> --max-age-days <integer> --json
  node scripts/wiki-runtime.js transaction quarantine --wiki-root <absolute> --operation-id <id-or-prune-name> --json
  node scripts/wiki-runtime.js index read --wiki-root <absolute> --json
  node scripts/wiki-runtime.js scan-window promote --wiki-root <absolute> --lock-token <token> --expected <UTC-Z> --json
  node scripts/wiki-runtime.js scan-window fail --wiki-root <absolute> --lock-token <token> --source <slug> --json
  node scripts/wiki-runtime.js inbox cleanup --wiki-root <absolute> --lock-token <token> --max-age-days 7 --json
  node scripts/wiki-runtime.js lint inspect --wiki-root <absolute> --json
  node scripts/wiki-runtime.js lint fix --wiki-root <absolute> --json

Recovery safety:
  --force bypasses age only. It never bypasses owner validity, same-host liveness,
  complete owner equality, or lock-directory identity checks.
`;

class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.code = 'USAGE';
  }
}

function parseFlags(argv, schema) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!Object.hasOwn(schema, flag) || Object.hasOwn(values, flag)) throw new UsageError(`unknown or repeated flag: ${flag}`);
    if (schema[flag] === 'boolean') values[flag] = true;
    else {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) throw new UsageError(`missing value for ${flag}`);
      values[flag] = value;
      index += 1;
    }
  }
  return values;
}

function requireFlag(flags, name) {
  if (!Object.hasOwn(flags, name) || flags[name] === '') throw new UsageError(`required flag missing: ${name}`);
  return flags[name];
}

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function redactedContentionHolder(value) {
  const ownerKeys = ['token', 'operation', 'pid', 'hostname', 'acquired_at'];
  const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== ownerKeys.length
      || ownerKeys.some((key) => !Object.hasOwn(value, key))) return null;
  if (typeof value.token !== 'string' || !/^[a-f0-9]{32,}$/.test(value.token)
      || typeof value.operation !== 'string' || value.operation.length === 0
      || !Number.isInteger(value.pid) || value.pid <= 0
      || typeof value.hostname !== 'string' || value.hostname.length === 0
      || typeof value.acquired_at !== 'string' || !timestampPattern.test(value.acquired_at)) {
    return null;
  }
  const timestamp = Date.parse(value.acquired_at);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value.acquired_at) return null;
  return {
    operation: value.operation,
    pid: value.pid,
    hostname: value.hostname,
    acquired_at: value.acquired_at,
  };
}

function emitError(error) {
  const code = error.code || 'FILESYSTEM';
  if (code === 'LOCK_CONTENDED') {
    process.stderr.write(`${JSON.stringify({
      code,
      message: 'wiki lock is contended',
      holder: redactedContentionHolder(error.owner),
    })}\n`);
    return;
  }
  const hasStructuredEvidence = error.lint_result !== undefined
    || error.terminal_prune !== undefined
    || error.release_error !== undefined;
  if (!hasStructuredEvidence) {
    process.stderr.write(`${code}: ${error.message}\n`);
    return;
  }
  const payload = {
    code,
    message: error.message,
  };
  if (error.lint_result !== undefined) payload.lint_result = error.lint_result;
  if (error.terminal_prune !== undefined) payload.terminal_prune = error.terminal_prune;
  if (error.release_error !== undefined) {
    payload.release_error = {
      code: error.release_error.code || 'FILESYSTEM',
      message: error.release_error.message,
    };
  }
  process.stderr.write(`${JSON.stringify(payload)}\n`);
}

function lockOwner(wikiRoot) {
  const ownerPath = path.join(wikiRoot, '.wiki-meta', '.wiki-lock', 'owner.json');
  try {
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    return owner && typeof owner === 'object' && !Array.isArray(owner) ? owner : null;
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    return null;
  }
}

function validateLockWikiRoot(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    const error = new Error('wikiRoot must be absolute');
    error.code = 'LOCK_INVALID';
    throw error;
  }
  return path.normalize(value);
}

function runConfig(argv) {
  if (argv[0] !== 'resolve') throw new UsageError('config requires the resolve command');
  const flags = parseFlags(argv.slice(1), { '--json': 'boolean' });
  requireFlag(flags, '--json');
  emit(resolveConfig(process.env));
}

function runLock(argv) {
  const command = argv[0];
  if (!command) throw new UsageError('lock command is required');
  if (command === 'acquire') {
    const flags = parseFlags(argv.slice(1), { '--wiki-root': 'value', '--operation': 'value', '--json': 'boolean' });
    requireFlag(flags, '--json');
    emit(acquireLock({
      wikiRoot: requireFlag(flags, '--wiki-root'),
      operation: requireFlag(flags, '--operation'),
    }));
    return;
  }
  if (command === 'status') {
    const flags = parseFlags(argv.slice(1), { '--wiki-root': 'value', '--json': 'boolean' });
    requireFlag(flags, '--json');
    const wikiRoot = validateLockWikiRoot(requireFlag(flags, '--wiki-root'));
    const owner = lockOwner(wikiRoot);
    emit({ locked: fs.existsSync(path.join(wikiRoot, '.wiki-meta', '.wiki-lock')), owner });
    return;
  }
  if (command === 'release') {
    const flags = parseFlags(argv.slice(1), { '--wiki-root': 'value', '--token': 'value', '--json': 'boolean' });
    requireFlag(flags, '--json');
    releaseLock({
      wikiRoot: requireFlag(flags, '--wiki-root'),
      token: requireFlag(flags, '--token'),
    });
    emit({ released: true });
    return;
  }
  if (command === 'recover') {
    const flags = parseFlags(argv.slice(1), {
      '--wiki-root': 'value', '--stale-ms': 'value', '--force': 'boolean', '--json': 'boolean',
    });
    requireFlag(flags, '--json');
    const rawStale = requireFlag(flags, '--stale-ms');
    if (!/^\d+$/.test(rawStale)) throw new UsageError('--stale-ms must be a nonnegative integer');
    emit({
      recovered: recoverLock({
        wikiRoot: requireFlag(flags, '--wiki-root'),
        staleMs: Number(rawStale),
        force: flags['--force'] === true,
      }),
    });
    return;
  }
  throw new UsageError(`unsupported lock command: ${command}`);
}

function wikiFlags(argv, schema) {
  const flags = parseFlags(argv, { '--wiki-root': 'value', '--json': 'boolean', ...schema });
  requireFlag(flags, '--json');
  requireFlag(flags, '--wiki-root');
  return flags;
}

function readManifestFile(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new UsageError('--manifest-file must be absolute');
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (cause) { throw Object.assign(new Error(`manifest file is unavailable: ${cause.message}`), { code: 'MANIFEST_INVALID' }); }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw Object.assign(new Error('manifest file must be regular and non-symlink'), { code: 'MANIFEST_INVALID' });
  }
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (cause) { throw Object.assign(new Error(`manifest file is invalid JSON: ${cause.message}`), { code: 'MANIFEST_INVALID' }); }
}

function runSetup(argv) {
  const flags = wikiFlags(argv, {
    '--config-host': 'value',
    '--replace-config': 'boolean',
    '--rebind-authority-from': 'value',
  });
  emit(wikiState.setupWiki({
    wikiRoot: flags['--wiki-root'],
    configHost: requireFlag(flags, '--config-host'),
    replaceConfig: flags['--replace-config'] === true,
    rebindAuthorityFrom: flags['--rebind-authority-from'],
    env: process.env,
    now: new Date(Math.trunc(Date.now() / 1000) * 1000),
  }));
}

function runProbe(argv) {
  if (argv[0] !== 'obsidian') throw new UsageError('probe requires the obsidian target');
  const flags = parseFlags(argv.slice(1), { '--json': 'boolean' });
  requireFlag(flags, '--json');
  emit(probeObsidian());
}

function runObsidianBridge(argv) {
  const subcommand = argv[0];
  const schemas = {
    search: { '--query': 'value', '--limit': 'value', '--json': 'boolean' },
    backlinks: { '--path': 'value', '--json': 'boolean' },
    tags: { '--json': 'boolean' },
  };
  if (!subcommand || !Object.hasOwn(schemas, subcommand)) {
    throw new UsageError(`obsidian requires one of: ${Object.keys(schemas).join(', ')}`);
  }
  const flags = parseFlags(argv.slice(1), schemas[subcommand]);
  requireFlag(flags, '--json');
  let limit;
  if (subcommand === 'search') {
    requireFlag(flags, '--query');
    if (flags['--limit'] !== undefined) {
      if (!/^\d+$/.test(flags['--limit'])) throw new UsageError('--limit must be a nonnegative integer');
      limit = Number(flags['--limit']);
    }
  }
  if (subcommand === 'backlinks') requireFlag(flags, '--path');

  let obsidianCli = null;
  try { obsidianCli = resolveConfig(process.env).config.obsidianCli; } catch { obsidianCli = null; }
  if (obsidianCli && obsidianCli.enabled === false) {
    emit({
      ok: false, found: false, executable: null, source: null, format: null, data: null,
      error: 'obsidian integration is disabled in the resolved configuration',
    });
    return;
  }
  emit(runObsidian({
    subcommand,
    query: flags['--query'],
    targetPath: flags['--path'],
    limit,
    vaultName: obsidianCli ? obsidianCli.vaultName : null,
  }));
}

function parseSnapshotWorkerDetail(detail) {
  if (detail === undefined) return null;
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    throw stateError('WIKI_STATE_FILESYSTEM', 'snapshot worker error violates its contract');
  }
  const keys = Object.keys(detail).sort();
  if (JSON.stringify(keys) !== JSON.stringify(['estimated_entries', 'method', 'operation_id'])) {
    throw stateError('WIKI_STATE_FILESYSTEM', 'snapshot worker error violates its contract');
  }
  const operationId = detail.operation_id;
  if (typeof operationId !== 'string' || operationId.length < 1 || operationId.length > 256
      || !/^[.]?[A-Za-z0-9._-]+$/.test(operationId)) {
    throw stateError('WIKI_STATE_FILESYSTEM', 'snapshot worker error violates its contract');
  }
  if (!['stat', 'enumeration', 'none'].includes(detail.method)) {
    throw stateError('WIKI_STATE_FILESYSTEM', 'snapshot worker error violates its contract');
  }
  const estimated = detail.estimated_entries;
  if (!(estimated === null || (Number.isSafeInteger(estimated) && estimated >= 0))) {
    throw stateError('WIKI_STATE_FILESYSTEM', 'snapshot worker error violates its contract');
  }
  return detail;
}

function parseSnapshotWorkerOutput(stdout, status, wikiRoot) {
  if (typeof stdout !== 'string' || !stdout.endsWith('\n')
      || stdout.slice(0, -1).includes('\n') || stdout.includes('\r')) {
    throw stateError('WIKI_STATE_FILESYSTEM', 'snapshot worker returned an invalid result');
  }
  let envelope;
  try { envelope = JSON.parse(stdout.slice(0, -1)); }
  catch (cause) {
    throw stateError('WIKI_STATE_FILESYSTEM', 'snapshot worker returned invalid JSON', cause);
  }
  const keys = Object.keys(envelope || {}).sort();
  if (envelope?.contract_version !== 1 || !['ok', 'error'].includes(envelope.status)) {
    throw stateError('WIKI_STATE_FILESYSTEM', 'snapshot worker result violates its contract');
  }
  if (envelope.status === 'ok') {
    if (status !== 0
        || JSON.stringify(keys) !== JSON.stringify(['contract_version', 'snapshot', 'status'])) {
      throw stateError('WIKI_STATE_FILESYSTEM', 'snapshot worker result violates its contract');
    }
    return envelope.snapshot;
  }
  const errorKeys = Object.keys(envelope.error || {}).sort();
  const withoutDetail = errorKeys.filter((key) => key !== 'detail');
  if (status !== 1
      || JSON.stringify(keys) !== JSON.stringify(['contract_version', 'error', 'status'])
      || !envelope.error || typeof envelope.error !== 'object' || Array.isArray(envelope.error)
      || JSON.stringify(withoutDetail) !== JSON.stringify(['code', 'message'])
      || typeof envelope.error.code !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(envelope.error.code)
      || typeof envelope.error.message !== 'string' || envelope.error.message.length === 0) {
    throw stateError('WIKI_STATE_FILESYSTEM', 'snapshot worker error violates its contract');
  }
  const parsed = parseSnapshotWorkerDetail(envelope.error.detail);
  const error = stateError(envelope.error.code, envelope.error.message);
  if (parsed) {
    error.operationId = parsed.operation_id;
    error.estimatedEntries = parsed.estimated_entries;
    error.method = parsed.method;
  }
  if (typeof wikiRoot === 'string' && wikiRoot.length > 0) error.wikiRoot = wikiRoot;
  throw error;
}

function abandonSnapshotWorker(child) {
  for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
    if (!stream) continue;
    stream.removeAllListeners();
    stream.once('error', () => {});
    stream.destroy();
    stream.unref?.();
  }
  child?.removeAllListeners();
  child?.once('error', () => {});
  child?.unref?.();
}

function validatedSnapshotTaskkillPath(env) {
  const systemRoot = typeof env.SystemRoot === 'string' ? env.SystemRoot.trim() : '';
  if (!systemRoot || !path.win32.isAbsolute(systemRoot) || systemRoot.includes('\0')) {
    throw new Error('SystemRoot is unavailable');
  }
  const executable = path.win32.normalize(path.win32.join(systemRoot, 'System32', 'taskkill.exe'));
  const expected = path.win32.normalize(`${systemRoot}\\System32\\taskkill.exe`);
  if (executable.toLowerCase() !== expected.toLowerCase()) {
    throw new Error('taskkill path is invalid');
  }
  return executable;
}

function snapshotTerminationState(
  child,
  env,
  platform,
  terminate = terminateWorkerTree,
  spawnWindowsTerminator = spawn,
) {
  if (!child || !Number.isSafeInteger(child.pid) || child.pid <= 0) {
    return 'termination could not be requested or confirmed';
  }
  if (platform === 'win32') {
    try {
      const terminator = spawnWindowsTerminator(
        validatedSnapshotTaskkillPath(env),
        ['/PID', String(child.pid), '/T', '/F'],
        {
          stdio: 'ignore',
          shell: false,
          windowsHide: true,
        },
      );
      if (!terminator || typeof terminator.once !== 'function'
          || typeof terminator.unref !== 'function') {
        return 'termination could not be requested or confirmed';
      }
      terminator.once('error', () => {});
      terminator.unref();
      return 'termination requested but unconfirmed';
    } catch {
      return 'termination could not be requested or confirmed';
    }
  }
  try {
    const requested = terminate(child, { env, platform });
    if (!requested) return 'termination could not be requested or confirmed';
    return 'termination requested but unconfirmed';
  } catch {
    return 'termination could not be requested or confirmed';
  }
}

function snapshotDeadlineError(wikiRoot, timeoutMs, terminationState) {
  const transactions = path.join(path.normalize(wikiRoot), '.wiki-meta', '.transactions');
  return stateError(
    'DEADLINE_EXCEEDED',
    `snapshot transaction inspection exceeded ${timeoutMs}ms at ${transactions}; `
      + `worker tree ${terminationState}; stop all hosts, restore filesystem readability, `
      + 'then rerun snapshot before recovery; if a prior inspection failed with TRANSACTION_OVERSIZED, follow the guidance that error printed',
  );
}

function runSnapshotWorker(options = {}) {
  const wikiRoot = options.wikiRoot;
  const timeoutMs = options.timeoutMs === undefined ? SNAPSHOT_TIMEOUT_MS : options.timeoutMs;
  const maxOutputBytes = options.maxOutputBytes === undefined
    ? SNAPSHOT_MAX_OUTPUT_BYTES
    : options.maxOutputBytes;
  const platform = options.platform === undefined ? process.platform : options.platform;
  const workerPath = options.workerPath
    || path.resolve(__dirname, '..', 'hooks', 'scripts', 'wiki-snapshot-worker.js');
  if (typeof wikiRoot !== 'string' || !path.isAbsolute(wikiRoot)) {
    throw stateError('WIKI_STATE_INVALID', 'wikiRoot must be absolute');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= SNAPSHOT_WORKER_GRACE_MS
      || timeoutMs > SNAPSHOT_TIMEOUT_MS) {
    throw new RangeError('snapshot timeout must be from 251 through 12_000 milliseconds');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0
      || maxOutputBytes > SNAPSHOT_MAX_OUTPUT_BYTES) {
    throw new RangeError('snapshot output cap must be from 1 through 67_108_864 bytes');
  }
  if (typeof platform !== 'string' || platform.length === 0) {
    throw new TypeError('snapshot platform must be a non-empty string');
  }
  if (typeof workerPath !== 'string' || !path.isAbsolute(workerPath)) {
    throw new TypeError('snapshot worker path must be absolute');
  }
  const env = options.env || process.env;
  const spawnWorker = options.spawn || spawn;
  const terminate = options.terminateWorkerTree || terminateWorkerTree;
  const spawnWindowsTerminator = options.spawnWindowsTerminator || spawn;

  return new Promise((resolve, reject) => {
    let child;
    let timer;
    let terminal = false;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let sawStdoutNewline = false;
    const stdout = [];

    const fail = (error, { requestTermination = true, deadline = false } = {}) => {
      if (terminal) return;
      terminal = true;
      clearTimeout(timer);
      let terminationState;
      if (requestTermination) {
        terminationState = snapshotTerminationState(
          child,
          env,
          platform,
          terminate,
          spawnWindowsTerminator,
        );
      }
      abandonSnapshotWorker(child);
      reject(deadline
        ? snapshotDeadlineError(wikiRoot, timeoutMs, terminationState)
        : error);
    };

    try {
      child = spawnWorker(process.execPath, [
        workerPath,
        '--wiki-root', path.normalize(wikiRoot),
        '--budget-ms', String(timeoutMs - SNAPSHOT_WORKER_GRACE_MS),
      ], {
        cwd: path.dirname(workerPath),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: platform !== 'win32',
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      fail(stateError(
        'WIKI_STATE_FILESYSTEM',
        `snapshot worker failed to run: ${error.message}`,
        error,
      ), { requestTermination: false });
      return;
    }

    timer = setTimeout(() => {
      fail(null, { deadline: true });
    }, timeoutMs);
    timer.unref?.();

    child.stdout.on('data', (chunk) => {
      if (terminal) return;
      stdoutBytes += chunk.length;
      if (stdoutBytes > maxOutputBytes) {
        fail(stateError('WIKI_STATE_FILESYSTEM', 'snapshot worker stdout exceeded its cap'));
        return;
      }
      for (let index = 0; index < chunk.length; index += 1) {
        if (sawStdoutNewline) {
          fail(stateError('WIKI_STATE_FILESYSTEM', 'snapshot worker returned multiple result lines'));
          return;
        }
        if (chunk[index] === 0x0a) {
          sawStdoutNewline = true;
          if (index !== chunk.length - 1) {
            fail(stateError('WIKI_STATE_FILESYSTEM', 'snapshot worker returned multiple result lines'));
            return;
          }
        }
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (terminal) return;
      stderrBytes += chunk.length;
      if (stderrBytes > maxOutputBytes) {
        fail(stateError('WIKI_STATE_FILESYSTEM', 'snapshot worker stderr exceeded its cap'));
        return;
      }
      fail(stateError('WIKI_STATE_FILESYSTEM', 'snapshot worker wrote stderr'));
    });
    child.once('error', (error) => {
      fail(stateError(
        'WIKI_STATE_FILESYSTEM',
        `snapshot worker failed to run: ${error.message}`,
        error,
      ), { requestTermination: false });
    });
    child.once('close', (code, signal) => {
      if (terminal) return;
      clearTimeout(timer);
      if (signal !== null) {
        fail(
          stateError('WIKI_STATE_FILESYSTEM', `snapshot worker terminated by ${signal}`),
          { requestTermination: false },
        );
        return;
      }
      try {
        const snapshot = parseSnapshotWorkerOutput(Buffer.concat(stdout).toString('utf8'), code, wikiRoot);
        terminal = true;
        resolve(snapshot);
      } catch (error) {
        fail(error);
      }
    });
  });
}

async function runSnapshot(argv) {
  const flags = wikiFlags(argv, {});
  emit(await runSnapshotWorker({ wikiRoot: flags['--wiki-root'] }));
}

function cleanupRuntimeManifests(wikiRoot, token, operationId) {
  const root = path.resolve(wikiRoot);
  const directory = path.join(root, '.wiki-meta', '.runtime');
  assertLockOwner({ wikiRoot: root, token });
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const file = path.join(directory, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.operation_id !== operationId) continue;
    assertLockOwner({ wikiRoot: root, token });
    fs.rmSync(file, { force: true });
    assertLockOwner({ wikiRoot: root, token });
  }
}

function powershellQuote(value) {
  // PowerShell single-quoted strings are fully literal (no interpolation, no metacharacter
  // interpretation of %, &, ", ^, etc.) except that an embedded literal single quote must be
  // doubled -- the PowerShell analogue of the POSIX single-quote escape below. We deliberately do
  // NOT attempt a cmd.exe-safe encoding: cmd.exe has no general-purpose literal-string quoting
  // mechanism (its own metacharacters -- %, &, |, ^, <, >, and ! under delayed expansion -- are
  // interpreted by cmd.exe's parser even inside double quotes, with no escape that neutralizes
  // all of them for an arbitrary byte string), so no cmd.exe encoding here could be made
  // genuinely safe. The rendered hint is explicitly labeled "(PowerShell)" so a Windows user
  // knows which shell to run it in.
  return `'${String(value).replace(/'/g, "''")}'`;
}

function shellQuote(value) {
  if (process.platform === 'win32') return powershellQuote(value);
  // POSIX: wrap in single quotes; nothing is special inside them except the single quote itself,
  // which must be closed, escaped literally, and reopened.
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

function recoverHint(wikiRoot, operationId, options = {}) {
  const root = path.resolve(wikiRoot);
  const label = process.platform === 'win32' ? 'resume with (PowerShell):' : 'resume with:';
  const tokenPart = options.includeLockToken === false ? '' : ' --lock-token <token>';
  return `${label}\n${runtimeCommandPrefix()} transaction recover --wiki-root ${shellQuote(root)}${tokenPart} --operation-id ${shellQuote(operationId)} --json`;
}

function runtimeCommandPrefix() {
  return `node ${shellQuote(path.resolve(__filename))}`;
}

function transactionDurablyExists(wikiRoot, operationId) {
  const transaction = path.join(path.resolve(wikiRoot), '.wiki-meta', '.transactions', operationId);
  return fs.existsSync(path.join(transaction, 'journal.json'))
    || fs.existsSync(path.join(transaction, 'cancelled.json'));
}

function commitRetryHint(wikiRoot, manifestFile) {
  const root = path.resolve(wikiRoot);
  const manifest = path.resolve(manifestFile);
  const label = process.platform === 'win32' ? 'rerun with (PowerShell):' : 'rerun with:';
  return `${label}\nnode scripts/wiki-runtime.js commit --wiki-root ${shellQuote(root)} --lock-token <token> --manifest-file ${shellQuote(manifest)} --json`;
}

function runCommit(argv) {
  const flags = wikiFlags(argv, { '--lock-token': 'value', '--manifest-file': 'value' });
  const manifestFile = requireFlag(flags, '--manifest-file');
  const token = requireFlag(flags, '--lock-token');
  const manifest = readManifestFile(manifestFile);
  let result;
  try {
    result = wikiState.applyCommit({
      wikiRoot: flags['--wiki-root'],
      token,
      manifest,
    });
  } catch (error) {
    if (error.code === 'DEADLINE_EXCEEDED') {
      error.message = transactionDurablyExists(flags['--wiki-root'], manifest.operation_id)
        ? `${error.message} — ${recoverHint(flags['--wiki-root'], manifest.operation_id)}`
        : `${error.message} — ${commitRetryHint(flags['--wiki-root'], manifestFile)}`;
    }
    throw error;
  }
  emit(result);
  const runtimeDirectory = path.join(path.resolve(flags['--wiki-root']), '.wiki-meta', '.runtime');
  const relative = path.relative(runtimeDirectory, path.resolve(manifestFile));
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
    try {
      cleanupRuntimeManifests(flags['--wiki-root'], token, manifest.operation_id);
    } catch (error) {
      if (error.code !== 'LOCK_TOKEN_MISMATCH') throw error;
      process.stderr.write(`WARNING: runtime manifest cleanup skipped after lock ownership changed: ${error.message}\n`);
    }
  }
}

function quarantineStoreEntry(options = {}) {
  return scanWindow.quarantineStoreEntry(options);
}

function oversizedHint(error) {
  const name = error.operationId || '';
  const root = error.wikiRoot;
  const { isIsolatableStoreName } = require(path.join(runtimeRoot, 'transaction-debris.js'));
  const isolatable = isIsolatableStoreName(name, scanWindow.operationIdFromPruneName);
  const rollback = /^rollback-([0-9A-HJKMNP-TV-Z]{26})$/.exec(name);
  if (isolatable && root) {
    const quotedRoot = shellQuote(path.resolve(root));
    const quotedName = shellQuote(name);
    const prefix = runtimeCommandPrefix();
    const quarantineCmd = `${prefix} transaction quarantine --wiki-root ${quotedRoot} --operation-id ${quotedName} --json`;
    const powershell = process.platform === 'win32';
    const runLabel = powershell ? 'Run (PowerShell):' : 'Run:';
    if (rollback) {
      const recover = `${prefix} transaction recover --wiki-root ${quotedRoot} --operation-id ${shellQuote(rollback[1])} --json`;
      const isolateLabel = powershell ? 'Isolate it with (PowerShell):' : 'Isolate it with:';
      const thenLabel = powershell ? 'then (PowerShell):' : 'then:';
      return `TRANSACTION_OVERSIZED is isolatable as a rollback remnant. ${isolateLabel}\n${quarantineCmd}\n${thenLabel}\n${recover}`;
    }
    return `TRANSACTION_OVERSIZED is isolatable. ${runLabel}\n${quarantineCmd}`;
  }
  if (/^[0-9A-HJKMNP-TV-Z]{26}$/.test(name)) {
    return 'TRANSACTION_OVERSIZED for a pure ULID is not automatically isolatable; stop all hosts, restore filesystem readability, and if recover still cannot read the journal restore the authenticated backup.';
  }
  return 'TRANSACTION_OVERSIZED is not automatically isolatable; stop all hosts, restore filesystem readability, then rerun.';
}

function physicalWikiRootForHint(value) {
  try { return fs.realpathSync.native(path.resolve(value)); }
  catch { return null; }
}

// Turns a prune observation into a reviewable, preserve-first plan (issue #60). The plan is only
// printed: every command is an existing `transaction quarantine`, which moves and never deletes.
function blockedPruneHint(observation, wikiRoot, options = {}) {
  const heldLock = options.command === 'transaction prune';
  if (!observation || !Array.isArray(observation.blocked) || !wikiRoot
      || !(observation.blocked_count > 0)) return null;
  if (observation.processed > 0) {
    return `Progress was made on this pass; rerun ${heldLock
      ? 'transaction prune under the same lock'
      : 'lint fix'}. Preserve residue only if the same entries stay blocked on a pass with no progress.`;
  }
  const { isIsolatableStoreName } = require(path.join(runtimeRoot, 'transaction-debris.js'));
  const isolatable = (name) => isIsolatableStoreName(name, scanWindow.operationIdFromPruneName);
  const groups = new Map();
  const manual = [];
  for (const entry of observation.blocked) {
    if (!entry.operation_id) {
      manual.push(`${entry.name}: ${entry.stage}/${entry.reason}; its operation is unknown`);
      continue;
    }
    if (!groups.has(entry.operation_id)) groups.set(entry.operation_id, []);
    groups.get(entry.operation_id).push(entry);
  }
  const prefix = runtimeCommandPrefix();
  const quotedRoot = shellQuote(wikiRoot);
  const commands = [];
  for (const [operationId, entries] of groups) {
    const kinds = new Set(entries.map((entry) => entry.canonical));
    const canonical = kinds.size === 1 ? entries[0].canonical : 'unknown';
    const prunes = entries.map((entry) => entry.name).filter((name) => name.startsWith('.prune-')).sort();
    let targets = null;
    if (prunes.length > 0) {
      if (canonical === 'directory') targets = [operationId, ...prunes];
      else if (canonical === 'reservation' || canonical === 'absent') targets = prunes;
    } else if (canonical === 'directory'
        && entries.every((entry) => entry.stage === 'quarantine-entry')) {
      targets = [operationId];
    }
    if (targets === null) {
      manual.push(`${operationId}: canonical path is ${canonical}; `
        + `${entries.map((entry) => `${entry.name} ${entry.stage}/${entry.reason}`).join(', ')}`);
      continue;
    }
    if (!targets.every(isolatable)) {
      manual.push(`${operationId}: ${targets.join(', ')} are not isolatable by command`);
      continue;
    }
    for (const name of targets) {
      commands.push(`${prefix} transaction quarantine --wiki-root ${quotedRoot} --operation-id ${shellQuote(name)} --json`);
    }
  }
  const lines = [
    (heldLock ? 'Release the lock passed as --lock-token first: these commands take the lock '
      + 'themselves. ' : '')
      + 'Blocked terminal prune residue (observed at the end of this pass). Stop all hosts, review '
      + 'these entries, then preserve them one command at a time in this order. Stop at the first '
      + 'result that is not "quarantined" and rerun lint fix before continuing. Nothing is '
      + 'deleted; bundles go to .wiki-meta/.quarantine/.',
  ];
  if (commands.length > 0) {
    lines.push(process.platform === 'win32' ? 'Run (PowerShell):' : 'Run:', ...commands);
  }
  if (manual.length > 0) {
    lines.push('No command is safe for these; stop all hosts and inspect them by hand:',
      ...manual.map((line) => `- ${line}`));
  }
  if (observation.blocked_truncated) {
    lines.push('After these, rerun lint fix to list the remaining entries.');
  }
  return lines.join('\n');
}

function writeBlockedPruneHint(observation, wikiRoot, options) {
  const hint = blockedPruneHint(observation, wikiRoot, options);
  if (hint) process.stderr.write(`${hint}\n`);
}

function runTransaction(argv) {
  const command = argv[0];
  if (command === 'quarantine') {
    const flags = wikiFlags(argv.slice(1), { '--operation-id': 'value' });
    const wikiRoot = flags['--wiki-root'];
    let owner;
    try {
      owner = acquireLock({ wikiRoot, operation: 'transaction-quarantine' });
    } catch (error) {
      if (error.code === 'LOCK_CONTENDED') {
        emit({ status: 'skipped', reason: 'LOCK_CONTENDED' });
        return;
      }
      throw error;
    }
    try {
      emit(quarantineStoreEntry({
        wikiRoot,
        token: owner.token,
        name: requireFlag(flags, '--operation-id'),
        classification: { method: 'none', estimated_entries: null },
        reason: 'operator',
      }));
    } finally {
      releaseLock({ wikiRoot, token: owner.token });
    }
    return;
  }
  if (command === 'prune') {
    const flags = wikiFlags(argv.slice(1), {
      '--lock-token': 'value',
      '--max-age-days': 'value',
    });
    const raw = requireFlag(flags, '--max-age-days');
    const maxAgeDays = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(maxAgeDays)) {
      throw new UsageError('--max-age-days must be a nonnegative safe integer');
    }
    const token = requireFlag(flags, '--lock-token');
    const wikiRoot = flags['--wiki-root'];
    const deadline = createDeadline({ budgetMs: 12_000 });
    const hintRoot = physicalWikiRootForHint(wikiRoot);
    let pruneResult;
    try {
      pruneResult = scanWindow.pruneScanWindowTransactions({
        wikiRoot,
        token,
        maxAgeDays,
        limit: 64,
        deadline,
      });
    } catch (error) {
      if (error && typeof error === 'object') {
        error.hintWikiRoot = hintRoot;
        error.hintCommand = 'transaction prune';
      }
      throw error;
    }
    const skipped = pruneResult.skipped_oversized || [];
    const promotion = scanWindow.promoteOversizedNames({
      wikiRoot,
      token,
      names: skipped,
      classification: { method: 'stat', estimated_entries: null },
      reason: 'oversized',
      deadline,
      limit: 8,
    });
    emit({
      ...pruneResult,
      skipped_oversized: promotion.skipped_oversized,
      promoted: promotion.promoted,
      promotion_failures: promotion.failures,
      telemetry_error: promotion.telemetry_error || undefined,
    });
    writeBlockedPruneHint(pruneResult, hintRoot, { command: 'transaction prune' });
    return;
  }
  if (command === 'recover') {
    const flags = wikiFlags(argv.slice(1), { '--lock-token': 'value', '--operation-id': 'value' });
    const operationId = requireFlag(flags, '--operation-id');
    const wikiRoot = flags['--wiki-root'];
    const injected = flags['--lock-token'];
    let token = injected;
    let acquired = null;
    if (!injected) {
      try {
        acquired = acquireLock({ wikiRoot, operation: 'transaction-recover' });
      } catch (error) {
        if (error.code === 'LOCK_CONTENDED') {
          emit({ status: 'skipped', reason: 'LOCK_CONTENDED' });
          return;
        }
        throw error;
      }
      token = acquired.token;
    }
    try {
      let result;
      try {
        result = wikiState.recoverTransaction({
          wikiRoot, token, operationId,
        });
      } catch (error) {
        if (error.code === 'DEADLINE_EXCEEDED') {
          error.message = `${error.message} — ${recoverHint(wikiRoot, operationId, {
            includeLockToken: acquired == null,
          })}`;
        }
        throw error;
      }
      emit(result);
      try {
        cleanupRuntimeManifests(wikiRoot, token, operationId);
      } catch (error) {
        if (error.code !== 'LOCK_TOKEN_MISMATCH') throw error;
        process.stderr.write(`WARNING: runtime manifest cleanup skipped after lock ownership changed: ${error.message}\n`);
      }
    } finally {
      if (acquired) releaseLock({ wikiRoot, token: acquired.token });
    }
    return;
  }
  throw new UsageError('transaction requires recover, prune, or quarantine');
}

function runIndex(argv) {
  if (argv[0] !== 'read') throw new UsageError('index requires read');
  const flags = wikiFlags(argv.slice(1), {});
  emit(wikiState.snapshotWiki({ wikiRoot: flags['--wiki-root'] }).index);
}

function runScanWindow(argv) {
  const command = argv[0];
  if (command === 'promote') {
    const flags = wikiFlags(argv.slice(1), { '--lock-token': 'value', '--expected': 'value' });
    const expected = requireFlag(flags, '--expected');
    emit(wikiState.promotePendingScan({
      wikiRoot: flags['--wiki-root'], token: requireFlag(flags, '--lock-token'), expected,
      operationId: `scan-window-cli-${sha256(Buffer.from(`${flags['--wiki-root']}\0${expected}`)).slice(0, 40)}`,
    }));
    return;
  }
  if (command === 'fail') {
    const flags = wikiFlags(argv.slice(1), { '--lock-token': 'value', '--source': 'value' });
    emit(wikiState.registerIngestFailure({
      wikiRoot: flags['--wiki-root'], token: requireFlag(flags, '--lock-token'),
      source: requireFlag(flags, '--source'),
    }));
    return;
  }
  throw new UsageError('scan-window requires promote or fail');
}

function runInbox(argv) {
  if (argv[0] !== 'cleanup') throw new UsageError('inbox requires cleanup');
  const flags = wikiFlags(argv.slice(1), { '--lock-token': 'value', '--max-age-days': 'value' });
  const raw = requireFlag(flags, '--max-age-days');
  if (!/^\d+$/.test(raw)) throw new UsageError('--max-age-days must be a nonnegative integer');
  emit(wikiState.cleanupInbox({
    wikiRoot: flags['--wiki-root'], token: requireFlag(flags, '--lock-token'), maxAgeDays: Number(raw),
  }));
}

function runLint(argv) {
  const command = argv[0];
  const flags = wikiFlags(argv.slice(1), {});
  if (command === 'inspect') emit(wikiState.inspectWiki({ wikiRoot: flags['--wiki-root'] }));
  else if (command === 'fix') {
    const hintRoot = physicalWikiRootForHint(flags['--wiki-root']);
    let result;
    try {
      result = wikiState.fixWiki({ wikiRoot: flags['--wiki-root'] });
    } catch (error) {
      if (error && typeof error === 'object') error.hintWikiRoot = hintRoot;
      throw error;
    }
    emit(result);
    writeBlockedPruneHint(result && result.terminal_prune, hintRoot);
  }
  else throw new UsageError('lint requires inspect or fix');
}

function exitCode(error) {
  if (error.code === 'USAGE') return 2;
  if (['LOCK_CONTENDED', 'LOCK_TOKEN_MISMATCH'].includes(error.code)) return 3;
  if (error.code === 'CONFIG_CONFLICT' || error.code === 'CONFIG_TARGET_CONFLICT'
      || error.code === 'CONFIG_NOT_FOUND' || error.code === 'CONFIG_INVALID'
      || error.code === 'SETUP_AUTHORITY_INVALID'
      || error.code === 'SETUP_AUTHORITY_CONFLICT'
      || error.code === 'SETUP_AUTHORITY_RECOVERY_REQUIRED'
      || error.code === 'LOCK_INVALID' || error.code === 'MANIFEST_INVALID'
      || error.code === 'EXPECTED_HASH_CONFLICT' || error.code === 'TRANSACTION_CANCELLED'
      || error.code === 'WIKI_STATE_INVALID') return 4;
  return 5;
}

function reportMainError(error) {
  emitError(error);
  if (error && typeof error === 'object') {
    writeBlockedPruneHint(error.terminal_prune, error.hintWikiRoot, { command: error.hintCommand });
  }
  if (error && error.code === 'TRANSACTION_OVERSIZED') {
    process.stderr.write(`${oversizedHint(error)}\n`);
  }
  return exitCode(error);
}

async function snapshotMain(argv) {
  try {
    await runSnapshot(argv);
    return 0;
  } catch (error) {
    return reportMainError(error);
  }
}

function main(argv = process.argv.slice(2)) {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    process.stdout.write(HELP);
    return 0;
  }
  if (argv[0] === 'snapshot') return snapshotMain(argv.slice(1));
  try {
    if (argv[0] === 'config') runConfig(argv.slice(1));
    else if (argv[0] === 'lock') runLock(argv.slice(1));
    else if (argv[0] === 'setup') runSetup(argv.slice(1));
    else if (argv[0] === 'probe') runProbe(argv.slice(1));
    else if (argv[0] === 'obsidian') runObsidianBridge(argv.slice(1));
    else if (argv[0] === 'commit') runCommit(argv.slice(1));
    else if (argv[0] === 'transaction') runTransaction(argv.slice(1));
    else if (argv[0] === 'index') runIndex(argv.slice(1));
    else if (argv[0] === 'scan-window') runScanWindow(argv.slice(1));
    else if (argv[0] === 'inbox') runInbox(argv.slice(1));
    else if (argv[0] === 'lint') runLint(argv.slice(1));
    else throw new UsageError('unsupported command family');
    return 0;
  } catch (error) {
    return reportMainError(error);
  }
}

if (require.main === module) {
  const status = main();
  if (status && typeof status.then === 'function') {
    status.then((code) => { process.exitCode = code; });
  } else {
    process.exitCode = status;
  }
}

module.exports = {
  main,
  recoverHint,
  commitRetryHint,
  oversizedHint,
  blockedPruneHint,
  cleanupRuntimeManifests,
  runSnapshotWorker,
  quarantineStoreEntry,
  parseSnapshotWorkerOutput,
  snapshotDeadlineError,
};
