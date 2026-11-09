import { execFile, type ExecFileException } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join, sep } from 'node:path';
import { promisify } from 'node:util';
import { t } from '../ui/i18n.js';
import type { Issue, Project, RpcRequest, Snapshot } from '../shared.js';

// bd 1.3.2: keep CLI policy authoritative (actor, claims, leases, readiness).
// A request has one 30s deadline and a 16 MiB aggregate stdout/stderr budget.
// Exceeding either is an error, never a successful but truncated snapshot.
const REQUEST_TIMEOUT_MS = 30_000;
const REMOTE_TIMEOUT_MS = 60_000;
// 面板 RPC 上限是 120s。远程预算必须留在这个上限下面。
const MAX_COMMAND_TIMEOUT_MS = 110_000;
const OUTPUT_LIMIT = 16 * 1024 * 1024;
const TEXT_LIMIT = 64 * 1024;
const DEPENDENCY_BATCH_SIZE = 100;
const executeFile = promisify(execFile);
const processQueues = new Map<string, Promise<void>>();
const LIST_ALL = [
  'list', '--all', '--limit=0', '--flat', '--include-ephemeral',
  '--include-gates', '--include-infra', '--include-templates',
];
// Only ambient routing selectors are removed. Passwords, credential helpers,
// TLS settings, actor and replica identity remain available to project config.
const ROUTING_ENV = [
  'BEADS_DB', 'BD_DB', 'BEADS_DATABASE', 'BD_DATABASE', 'BEADS_GLOBAL', 'BD_GLOBAL',
  'BEADS_DOLT_SERVER_DATABASE', 'BEADS_DOLT_SERVER_MODE', 'BEADS_DOLT_SERVER_HOST',
  'BEADS_DOLT_SERVER_PORT', 'BEADS_DOLT_PORT', 'BEADS_DOLT_SERVER_SOCKET',
  'BEADS_DOLT_DATA_DIR', 'BEADS_DOLT_SHARED_SERVER', 'BEADS_SHARED_SERVER_DIR',
  'BEADS_PROXIED_SERVER_ROOT_PATH', 'BEADS_PROXIED_SERVER_CONFIG', 'BEADS_CENTRAL_CONFIG',
  'BD_DOLT_HOST', 'BD_DOLT_PORT', 'BD_DOLT_MODE', 'BD_DOLT_SHARED_SERVER',
  'BEADS_SKIP_IDENTITY_CHECK',
];
const INPUT_FIELDS: Record<string, readonly string[]> = {
  projects: [], snapshot: [], issue: ['id'],
  create: ['title', 'description', 'type', 'priority', 'assignee', 'labels'],
  update: ['id', 'title', 'description', 'priority', 'assignee', 'status', 'notes', 'acceptance', 'design'],
  claim: ['id'], close: ['id', 'reason'], reopen: ['id'], reclaim: ['id'],
  link: ['id', 'dependsOn', 'type'], unlink: ['id', 'dependsOn'],
  comment: ['id', 'text'], comments: ['id'],
};

type Row = Record<string, unknown>;
type Run = (args: string[], readonly: boolean, json?: boolean) => Promise<unknown>;

/** Explicit system-SSH mapping; this never contains credentials. */
export interface SshTarget {
  destination: string;
  configFile?: string;
}

/** The selected workspace or its transport is unavailable. */
export class ProjectUnavailableError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'ProjectUnavailableError';
  }
}

/** The SSH transport failed, rather than the remote command reporting an error. */
export class RemoteUnavailableError extends ProjectUnavailableError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'RemoteUnavailableError';
  }
}

export function quoteRemote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/** 非交互 bash 仍能找到用户安装的 bd，同时保留 sshd 给过来的系统 PATH。 */
export const DEFAULT_REMOTE_PATH = '$HOME/.local/bin:$HOME/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';

export type RemoteFailureCode =
  | 'ssh-auth' | 'ssh-unreachable' | 'ssh-bash-missing' | 'bd-missing' | 'python-missing'
  | 'beads-missing' | 'beads-outside' | 'workspace-unavailable';

/** 主机在线，但命令本身不能继续（缺 bash、缺 bd、库越界）。 */
export class RemoteCommandError extends Error {
  constructor(message: string, readonly code: RemoteFailureCode) {
    super(message);
    this.name = 'RemoteCommandError';
  }
}

export function remotePathExport(configured?: string): string {
  const source = configured?.trim() ? configured.trim() : DEFAULT_REMOTE_PATH;
  if (/[\0\r\n`]/.test(source) || source.includes('$(') || source.includes('${')) {
    throw new Error('remotePath must be a colon-separated directory list without command substitution');
  }
  const segments = source.split(':').filter((segment) => segment.length > 0).map((segment) => {
    const expanded = segment === '~' ? '$HOME' : segment.startsWith('~/') ? `$HOME/${segment.slice(2)}` : segment;
    const plain = expanded.replaceAll('$HOME', '');
    if (plain.includes('$') || plain.includes('~') || plain.includes('"') || plain.includes("'") || plain.includes('\\') || plain.includes(' ')) {
      throw new Error(`remotePath segment is not a plain directory: ${segment}`);
    }
    return expanded;
  });
  if (!segments.length) throw new Error('remotePath must contain at least one directory');
  return `"${segments.join(':')}:$PATH"`;
}

/** 登录 shell 只负责启动 bash。bashrc、zshenv 和 fish 函数进不了这条命令。 */
export function bashCommand(script: string, configuredPath?: string): string {
  const body = `export PATH=${remotePathExport(configuredPath)}\n${script}`;
  // env 直接执行 bash 二进制，登录 shell 里的 bash 函数或别名不会插进来。
  return `env -u BASH_ENV -u ENV bash --noprofile --norc -c ${quoteRemote(body)}`;
}

function offlineFailure(message: string, code: RemoteFailureCode, cause?: unknown): RemoteUnavailableError {
  return Object.assign(new RemoteUnavailableError(message, cause), { code });
}

export function explainRemoteFailure(error: ExecFileException & { stderr?: string }, context: 'probe' | 'bd' | 'python' | 'exec'): Error {
  const stderr = error.stderr?.trim() || '';
  const exit = error.code;
  if (/permission denied \(publickey\)|authentication failed|too many authentication failures/i.test(stderr)) {
    return offlineFailure(t('SSH authentication failed. Check the Mac SSH config, agent, and IdentityFile. {detail}', 'SSH 认证失败。检查 Mac 上的 SSH 配置、agent 和 IdentityFile。{detail}', { detail: stderr.slice(0, 500) }), 'ssh-auth', error);
  }
  if (exit === 255 || /connection timed out|connection refused|could not resolve|no route to host|network is unreachable|connection closed/i.test(stderr)) {
    return offlineFailure(t('SSH host is unreachable. {detail}', 'SSH 主机不可达。{detail}', { detail: stderr.slice(0, 500) || error.message }), 'ssh-unreachable', error);
  }
  if (/bash: command not found|bash: not found/i.test(stderr)) {
    return new RemoteCommandError(t('The remote host has no bash. Install bash; Beads Board does not run commands in the login shell.', '远端没有 bash。请安装 bash；Beads 看板不在登录 shell 里执行命令。'), 'ssh-bash-missing');
  }
  if (exit === 127 || /command not found/i.test(stderr)) {
    if (context === 'python' || /python3/i.test(stderr)) {
      return new RemoteCommandError(t('python3 was not found on the remote PATH. Install it or add its directory to the remotePath setting.', '远端 PATH 上没有 python3。请安装，或把目录加到 remotePath。'), 'python-missing');
    }
    return new RemoteCommandError(t('bd was not found on the remote PATH. Install bd 1.3.2 or add its directory to the remotePath setting, then run Test SSH connection.', '远端 PATH 上没有 bd。请安装 bd 1.3.2，或把目录加到 remotePath，然后测试 SSH 连接。'), 'bd-missing');
  }
  if (exit === 124) return offlineFailure(t('The workspace directory is not accessible on the remote host.', '远端访问不了这个工作区目录。'), 'workspace-unavailable', error);
  if (exit === 125) return new RemoteCommandError(t('This workspace has no .beads directory. Initialize it with bd on the remote host.', '这个工作区没有 .beads 目录。请在远端用 bd 初始化。'), 'beads-missing');
  if (exit === 126) return new RemoteCommandError(t('The .beads directory resolves outside the workspace. Refusing to follow that path.', '.beads 解析到了工作区外面。拒绝跟随这条路径。'), 'beads-outside');
  return error instanceof Error ? error : new Error(String(error));
}

/** All dynamic remote command arguments must be individually shell-quoted. */
async function controlSocket(target: SshTarget): Promise<string> {
  const dir = join(tmpdir(), 'beads-orca-ssh');
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const id = createHash('sha256').update(`${target.destination}\0${target.configFile ?? ''}`).digest('hex').slice(0, 12);
  return join(dir, id);
}

export async function executeSsh(
  target: SshTarget,
  command: string,
  options: { input?: string; timeoutMs: number; maxBuffer: number; context?: 'probe' | 'bd' | 'python' | 'exec' },
): Promise<{ stdout: string; stderr: string }> {
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.+@:-]*$/u.test(target.destination)) {
    throw new Error('SSH destination must be an explicit SSH host alias or user@host');
  }
  if (target.configFile !== undefined && (!isAbsolute(target.configFile) || target.configFile.includes('\0'))) {
    throw new Error('SSH configFile must be an absolute path without NUL bytes');
  }
  const socket = await controlSocket(target);
  const args = [
    ...(target.configFile ? ['-F', target.configFile] : []),
    '-T', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ControlMaster=auto', '-o', 'ControlPersist=60', '-o', `ControlPath=${socket}`,
    '--', target.destination, command,
  ];
  const execution = executeFile('ssh', args, {
    encoding: 'utf8', shell: false, timeout: options.timeoutMs,
    killSignal: 'SIGKILL', maxBuffer: options.maxBuffer, windowsHide: true,
  });
  // A failed SSH handshake can close stdin before the input has been sent.
  execution.child.stdin?.on('error', () => undefined);
  execution.child.stdin?.end(options.input);
  try {
    return await execution;
  } catch (cause) {
    const error = cause as ExecFileException & { stderr?: string };
    if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw cause;
    if (error.code === 'ENOENT') {
      throw new RemoteUnavailableError('ssh was not found on the Mac PATH.', cause);
    }
    if (error.killed) throw cause;
    throw explainRemoteFailure(error, options.context ?? 'exec');
  }
}

/** 物理路径必须落在工作区里。符号链接指向别处时直接拒绝。 */
export async function canonicalBeadsDir(projectPath: string): Promise<string> {
  let root: string;
  try { root = await realpath(projectPath); }
  catch (cause) { throw new ProjectUnavailableError(`Workspace ${projectPath} is offline or inaccessible`, cause); }
  const link = join(projectPath, '.beads');
  let info;
  try { info = await lstat(link); }
  catch { throw new RemoteCommandError(`Registered project has no .beads directory at ${link}. Initialize that workspace with bd first.`, 'beads-missing'); }
  if (!info.isDirectory() && !info.isSymbolicLink()) {
    throw new RemoteCommandError(`${link} is not a Beads directory.`, 'beads-missing');
  }
  const beads = await realpath(link);
  const expected = join(root, '.beads');
  if (beads !== expected && !beads.startsWith(`${expected}${sep}`)) {
    throw new RemoteCommandError(`The .beads directory resolves to ${beads}, outside workspace ${root}.`, 'beads-outside');
  }
  return beads;
}

function object(value: unknown, context: string): Row {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as Row;
}

function text(value: unknown, field: string, required = false): string {
  if (typeof value !== 'string' || value.includes('\0') || Buffer.byteLength(value) > TEXT_LIMIT || (required && !value.trim())) {
    throw new Error(`${field} must be ${required ? 'a nonempty' : 'a'} string of at most 64 KiB without NUL bytes`);
  }
  return value;
}

function id(value: unknown, field = 'id'): string {
  const result = text(value, field, true);
  // reclaim --id uses a CSV flag; one request must never expand to multiple IDs.
  if (result.length > 256 || /[\s,]/u.test(result)) throw new Error(`${field} must be a single issue ID`);
  return result;
}

function priority(value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 4) {
    throw new Error('priority must be an integer from 0 to 4');
  }
  return value;
}

function inputFor(request: RpcRequest): Row {
  const fields = INPUT_FIELDS[request.method];
  if (!Object.hasOwn(INPUT_FIELDS, request.method) || !fields) throw new Error(`Unsupported method: ${request.method}`);
  const input = request.input === undefined ? {} : object(request.input, 'input');
  for (const key of Object.keys(input)) {
    if (!fields.includes(key)) throw new Error(`Unsupported input for ${request.method}: ${key}`);
    const value = input[key];
    if (value === undefined) continue;
    if (key === 'id' || key === 'dependsOn') id(value, key);
    else if (key === 'priority') priority(value);
    else if (key === 'labels') {
      if (!Array.isArray(value) || value.length > 100) throw new Error('labels must be an array of at most 100 strings');
      for (const label of value) {
        text(label, 'label', true);
        if (/[,\r\n]/u.test(label)) throw new Error('labels cannot contain commas or line breaks');
      }
    } else text(value, key, ['title', 'text', 'type', 'status'].includes(key));
  }
  if (fields.includes('id')) id(input.id);
  if (fields.includes('dependsOn')) id(input.dependsOn, 'dependsOn');
  if (request.method === 'create') text(input.title, 'title', true);
  if (request.method === 'comment') text(input.text, 'text', true);
  if (request.method === 'update' && !fields.some((key) => key !== 'id' && input[key] !== undefined)) {
    throw new Error('update requires at least one changed field');
  }
  return input;
}

function beadsGuard(projectPath: string, print: boolean): string {
  return [
    `cd -- ${quoteRemote(projectPath)} || exit 124`,
    'beads_root=$(pwd -P) || exit 124',
    'test -d .beads || exit 125',
    'cd -P -- .beads || exit 125',
    'beads_phys=$(pwd -P) || exit 125',
    'case "$beads_phys" in',
    '  "$beads_root"/.beads|"$beads_root"/.beads/*) ;;',
    '  *) exit 126 ;;',
    'esac',
    ...(print ? ["printf '%s\\n' \"$beads_phys\""] : []),
  ].join('\n');
}

function bdScript(projectPath: string, beadsDir: string, argv: string[]): string {
  return [
    beadsGuard(projectPath, false),
    `cd -- ${quoteRemote(projectPath)} || exit 124`,
    `unset ${ROUTING_ENV.join(' ')} || { echo "Could not clear ambient Beads routing" >&2; exit 125; }`,
    `export BEADS_DIR=${quoteRemote(beadsDir)} BD_LAST_TOUCHED_FALLBACK=0 BD_ROUTING_MODE=explicit BD_ROUTING_DEFAULT=. BD_DIRECTORY_LABELS='{}' || exit 125`,
    `bd ${argv.map(quoteRemote).join(' ')}`,
    'beads_exit_status=$?',
    'if [ "$beads_exit_status" -eq 255 ]; then exit 254; fi',
    'exit "$beads_exit_status"',
  ].join('\n');
}

export type CommandOptions = { timeoutMs?: number; remotePath?: string };

async function runner(project: Project, target?: SshTarget, options: CommandOptions = {}): Promise<Run> {
  const remote = project.hostId != null && project.hostId !== 'local';
  if (remote && !target) throw new Error(`Remote project ${project.id} requires an explicit SSH transport`);
  if (!remote && target) throw new Error(`Local project ${project.id} cannot use a remote transport`);
  if (!isAbsolute(project.path) || project.path.includes('\0')) throw new Error(`Registered project ${project.id} must have an absolute path`);
  const timeoutMs = options.timeoutMs ?? (target ? REMOTE_TIMEOUT_MS : REQUEST_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  let remainingBytes = OUTPUT_LIMIT;
  let key: string;
  let beadsDir: string;
  if (target) {
    let result: { stdout: string; stderr: string };
    try {
      result = await executeSsh(target, bashCommand(beadsGuard(project.path, true), options.remotePath), { timeoutMs, maxBuffer: remainingBytes, context: 'probe' });
    } catch (cause) {
      if (cause instanceof RemoteUnavailableError || cause instanceof RemoteCommandError) throw cause;
      throw explainRemoteFailure(cause as ExecFileException & { stderr?: string }, 'probe');
    }
    remainingBytes -= Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    const canonical = result.stdout.replace(/\n$/u, '');
    if (!isAbsolute(canonical)) throw new Error('SSH returned an invalid canonical .beads path');
    beadsDir = canonical;
    key = `ssh:${target.configFile ?? ''}:${target.destination}:${canonical}`;
  } else {
    beadsDir = await canonicalBeadsDir(project.path);
    key = `local:${beadsDir}`;
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env, BEADS_DIR: beadsDir, BD_LAST_TOUCHED_FALLBACK: '0',
    // list/ready also support contributor auto-routing; pin the current store.
    BD_ROUTING_MODE: 'explicit', BD_ROUTING_DEFAULT: '.',
    // Suppress directory filters without discarding hydrated labels.
    BD_DIRECTORY_LABELS: '{}',
  };
  for (const name of ROUTING_ENV) delete env[name];
  const execute: Run = async (args, readonly, json = true) => {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) throw new Error(`bd request timed out after ${timeoutMs}ms`);
    if (remainingBytes <= 0) throw new Error('bd output exceeded the 16 MiB request limit');
    const argv = ['--json', '--no-color', ...(readonly ? ['--readonly'] : []), ...args];
    let output: string;
    try {
      let result: { stdout: string; stderr: string };
      if (target) {
        // 登录 shell 只启动 bash。请求文本在单引号里，255 留给 SSH 自己。
        result = await executeSsh(target, bashCommand(bdScript(project.path, beadsDir, argv), options.remotePath), { timeoutMs: remainingMs, maxBuffer: remainingBytes, context: 'bd' });
      } else {
        const execution = executeFile('bd', argv, {
          cwd: project.path, env, encoding: 'utf8', shell: false,
          timeout: remainingMs, killSignal: 'SIGKILL', maxBuffer: remainingBytes,
          windowsHide: true,
        });
        // Never inherit a terminal or wait for interactive stdin.
        execution.child.stdin?.end();
        result = await execution;
      }
      remainingBytes -= Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
      output = result.stdout;
    } catch (cause) {
      if (cause instanceof RemoteUnavailableError || cause instanceof RemoteCommandError) throw cause;
      const error = cause as ExecFileException & { stdout?: string; stderr?: string };
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        throw new Error('bd output exceeded the 16 MiB request limit; no partial result returned', { cause });
      }
      const detail = error.stderr?.trim() || error.stdout?.trim() || error.message;
      const classified = explainRemoteFailure(error, 'bd');
      if (classified !== error && (classified instanceof RemoteCommandError || classified instanceof RemoteUnavailableError)) throw classified;
      const reason = error.killed ? `timed out after ${timeoutMs}ms` : `failed (${error.code ?? error.signal ?? 'unknown'})`;
      throw new Error(`bd ${args[0]} ${reason}: ${detail.slice(0, 8192)}`, { cause });
    }
    if (remainingBytes < 0) throw new Error('bd output exceeded the 16 MiB request limit; no partial result returned');
    if (!json) {
      // Mutation results have no prescribed JSON shape. Preserve native text
      // rather than turn a successful write into a parse error and invite retry.
      try { return JSON.parse(output) as unknown; } catch { return output.trim() || null; }
    }
    try { return JSON.parse(output) as unknown; } catch (error) {
      throw new Error(`bd ${args[0]} returned invalid JSON`, { cause: error });
    }
  };
  return (args, readonly, json) => {
    // Embedded Dolt has a process-level store lock. Serialize CLI processes
    // within this host, without holding unrelated registered projects back.
    const operation = (processQueues.get(key) ?? Promise.resolve()).then(() => execute(args, readonly, json));
    const settled = operation.then(() => undefined, () => undefined);
    processQueues.set(key, settled);
    void settled.then(() => {
      if (processQueues.get(key) === settled) processQueues.delete(key);
    });
    return operation;
  };
}

function rows(value: unknown, context: string): Row[] {
  // Go nil slices encode as null, including empty dep/comment/query results.
  if (value === null) return [];
  if (!Array.isArray(value)) throw new Error(`bd ${context} returned a non-array result`);
  return value.map((row) => object(row, `bd ${context} row`));
}

function stringField(row: Row, field: string, required = false): string {
  const value = row[field];
  if (!required && (value === undefined || value === null)) return '';
  if (typeof value !== 'string' || (required && !value)) throw new Error(`bd issue has invalid ${field}`);
  return value;
}

function normalizeIssue(row: Row): Issue {
  if (typeof row.priority !== 'number' || !Number.isInteger(row.priority)) throw new Error('bd issue has invalid priority');
  const labels = row.labels ?? [];
  if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string')) throw new Error('bd issue has invalid labels');
  const issue: Issue = {
    id: stringField(row, 'id', true), title: stringField(row, 'title', true),
    description: stringField(row, 'description'), status: stringField(row, 'status'),
    priority: row.priority, type: stringField(row, 'issue_type'), assignee: stringField(row, 'assignee'),
    labels, dependencies: [], createdAt: stringField(row, 'created_at', true), updatedAt: stringField(row, 'updated_at', true),
  };
  const optionalStrings = {
    closed_at: 'closedAt', notes: 'notes', acceptance_criteria: 'acceptance', design: 'design',
    due_at: 'dueAt', defer_until: 'deferUntil', heartbeat_at: 'heartbeatAt',
  } as const;
  for (const [source, target] of Object.entries(optionalStrings)) {
    if (row[source] !== undefined && row[source] !== null) issue[target] = stringField(row, source);
  }
  if (row.estimated_minutes !== undefined && row.estimated_minutes !== null) {
    if (typeof row.estimated_minutes !== 'number' || !Number.isInteger(row.estimated_minutes)) throw new Error('bd issue has invalid estimated_minutes');
    issue.estimatedMinutes = row.estimated_minutes;
  }
  return issue;
}

async function issuesWithDependencies(value: unknown, run: Run): Promise<Issue[]> {
  const issues = rows(value, 'issues').map(normalizeIssue);
  const byId = new Map(issues.map((issue) => [issue.id, issue]));
  // bd 1.3.2 dep.go: single-ID hydration drops targets absent from this store.
  // Repeat a lone anchor to select raw edges, as dep_list_cross_db_test.go does.
  // readDepListEdges deduplicates anchors, so this does not duplicate edges.
  for (let offset = 0; offset < issues.length; offset += DEPENDENCY_BATCH_SIZE) {
    const ids = issues.slice(offset, offset + DEPENDENCY_BATCH_SIZE).map((issue) => issue.id);
    if (ids.length === 1) ids.push(ids[0]!);
    const dependencies = rows(await run(['dep', 'list', '--direction=down', '--', ...ids], true), 'dep list');
    for (const dependency of dependencies) {
      const issue = byId.get(stringField(dependency, 'issue_id', true));
      if (!issue) throw new Error('bd dep list returned an unexpected source issue');
      issue.dependencies.push({
        id: stringField(dependency, 'depends_on_id', true),
        type: stringField(dependency, 'type', true),
      });
    }
  }
  return issues;
}

function flags(input: Row, fields: readonly string[]): string[] {
  return fields.filter((field) => input[field] !== undefined).map((field) => `--${field}=${String(input[field])}`);
}

/** The sole host RPC entrypoint. project is a host-registered ID, never a path. */
export async function handleRequest(request: RpcRequest, projects: Project[], target?: SshTarget, options: CommandOptions = {}): Promise<unknown> {
  object(request, 'request');
  if (typeof request.method !== 'string') throw new Error('request.method must be a string');
  const input = inputFor(request);
  if (request.method === 'projects') return projects.map((project) => ({ ...project }));
  const project = projects.find((candidate) => candidate.id === request.project);
  if (!project) throw new Error('A registered project ID is required');
  const run = await runner(project, target, options);
  // Reject IDs absent from the local list; no shorthand is accepted here.
  // This is a precheck, not atomic isolation: bd 1.3.2 may prefix-route if an
  // external actor deletes the local ID before the next native command.
  for (const field of ['id', 'dependsOn'] as const) {
    if (input[field] === undefined) continue;
    const local = rows(await run([...LIST_ALL, `--id=${String(input[field])}`], true), 'list');
    if (local.length !== 1 || local[0]?.id !== input[field]) {
      throw new Error(`Issue ${String(input[field])} not found in registered project ${project.id}`);
    }
  }
  switch (request.method) {
    case 'snapshot': {
      // Explicit unlimited queries: bd defaults to 50 list / 100 ready rows.
      // Include every stored status and normally hidden category; do not export
      // (export has owner filters and omits the ephemeral storage plane).
      const issues = await issuesWithDependencies(await run(LIST_ALL, true), run);
      const readyIds = rows(await run(['ready', '--limit=0', '--include-ephemeral'], true), 'ready').map((row) => stringField(row, 'id', true));
      const blockedIds = rows(await run(['blocked'], true), 'blocked').map((row) => stringField(row, 'id', true));
      const snapshot: Snapshot = { project: { ...project }, issues, readyIds, blockedIds, fetchedAt: new Date().toISOString() };
      return snapshot;
    }
    case 'issue': {
      const issues = await issuesWithDependencies(await run(['show', '--brief-deps', `--id=${String(input.id)}`], true), run);
      if (issues.length !== 1) throw new Error('bd show did not return exactly one issue');
      return issues[0];
    }
    case 'create': {
      const args = ['create', '--repo=.', ...flags(input, ['title', 'description', 'type', 'priority', 'assignee'])];
      if (input.labels !== undefined) args.push(`--labels=${(input.labels as string[]).map((label) => `"${label.replaceAll('"', '""')}"`).join(',')}`);
      return run(args, false, false);
    }
    case 'update':
      return run(['update', ...flags(input, ['title', 'description', 'priority', 'assignee', 'status', 'notes', 'acceptance', 'design']), '--', String(input.id)], false, false);
    case 'claim':
      return run(['update', '--claim', '--', String(input.id)], false, false);
    case 'close':
      return run(['close', ...flags(input, ['reason']), '--', String(input.id)], false, false);
    case 'reopen':
      return run(['reopen', '--', String(input.id)], false, false);
    case 'reclaim':
      return run(['reclaim', `--id=${String(input.id)}`], false, false);
    case 'link':
      return run(['dep', 'add', ...flags(input, ['type']), '--', String(input.id), String(input.dependsOn)], false, false);
    case 'unlink':
      return run(['dep', 'remove', '--', String(input.id), String(input.dependsOn)], false, false);
    case 'comment':
      return run(['comment', '--', String(input.id), String(input.text)], false, false);
    case 'comments':
      return rows(await run(['comments', '--', String(input.id)], true), 'comments');
    default:
      throw new Error(`Unsupported method: ${request.method}`);
  }
}
