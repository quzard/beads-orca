import { execFile, type ExecFileException } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, posix } from 'node:path';
import { promisify } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import { bashCommand, executeSsh, finishForkCommand, handleRequest, ProjectUnavailableError, quoteRemote, remoteShellScript, RemoteCommandError, RemoteUnavailableError, type CommandOptions, type RemoteRun, type SshTarget } from '../core/service.js';
import type { Project, ProjectAvailability, RpcRequest, Snapshot } from '../shared.js';
import { t } from '../ui/i18n.js';
import { focusedWorkspaceId, type FocusContext } from '../ui/project-selection.js';
import { forkAvailable, forkExec, forkHosts, forkWorkspaces, ForkServerTooOld, type ForkCaller, type ForkHostRow, type ForkWorkspaceRow } from './fork-host.js';

export interface ProductHost {
  host: ForkCaller;
  settings: { get(key: string): Promise<unknown> };
}

export interface TextFile {
  /** Normalized workspace-relative path, suitable for editor.open. */
  path: string;
  text: string;
  /** SHA-256 of the UTF-8 content, in hexadecimal. */
  hash: string;
}

/** An Orca workspace binding captured before a multi-step file operation. */
export interface ProjectIdentity {
  path: string;
  hostId: string | null;
  workspaceId: string | null;
  /** Opaque fingerprint of the registered workspace and explicit SSH mapping. */
  fingerprint: string;
}

type Workspace = { id: string; name: string; path: string; hostId: string | null; branch?: string | null };
type RemoteMapping = SshTarget & { name?: string };
type AvailabilityState = { availability: ProjectAvailability; reason?: string; lastFetchedAt?: string; cacheError?: string };
type ForkBinding = { hostId: string; workspaceId: string; fallback?: SshTarget };
type Discovery = { projects: Project[]; targets: Map<string, SshTarget>; forks: Map<string, ForkBinding>; keys: Map<string, string> };
type Manifest = { version: 1; generation: string; chunks: number; hash: string; fetchedAt: string };

const executeFile = promisify(execFile);
const LOCAL_REFRESH_MS = 15_000;
const REMOTE_REFRESH_MS = 60_000;
const FILE_LIMIT = 2 * 1024 * 1024;
const PROCESS_OUTPUT_LIMIT = 16 * 1024 * 1024;
const PROCESS_TIMEOUT_MS = 30_000;
// Each plugin storage value is limited to 256 KiB, with 5 MiB shared by the plugin.
const CACHE_CHUNK_SIZE = 128 * 1024;
// 与 remoteHosts.destination 同一套语法：只能是 OpenSSH 的 Host 别名，不能是命令。
const SSH_DESTINATION = /^[A-Za-z0-9_][A-Za-z0-9_.+@:-]*$/u;
// 面板每次请求都会 discover。别名在一次 Orca 会话里很少变，避免每次都拉起 CLI。
const SSH_ALIAS_TTL_MS = 30_000;
const HOST_LIST_TIMEOUT_MS = 10_000;
const MUTATIONS: Record<string, true> = {
  create: true, update: true, claim: true, close: true, reopen: true,
  reclaim: true, link: true, unlink: true, comment: true,
};

function hash(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function relativeFile(path: string): string {
  if (typeof path !== 'string' || !path || path.includes('\0') || path.includes('\\') || path.length > 1024 ||
      posix.isAbsolute(path) || /^[a-z]:/iu.test(path) || path.split('/').includes('..')) {
    throw new Error('File path must be a relative path inside the workspace without traversal or backslashes');
  }
  const normalized = posix.normalize(path);
  if (normalized === '.' || normalized.endsWith('/')) throw new Error('File path must name a file inside the workspace');
  return normalized;
}

function remoteMappings(value: unknown): Map<string, RemoteMapping> {
  if (value === undefined || value === null || value === '') return new Map();
  if (typeof value !== 'string') throw new Error('remoteHosts must be a JSON object');
  let parsed: unknown;
  try { parsed = JSON.parse(value) as unknown; } catch (cause) { throw new Error('remoteHosts must be a valid JSON object', { cause }); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('remoteHosts must be a JSON object');
  const mappings = new Map<string, RemoteMapping>();
  for (const [hostId, entry] of Object.entries(parsed)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`remoteHosts entry ${hostId} must be an object`);
    const record = entry as Record<string, unknown>;
    if (Object.keys(record).some((key) => key !== 'destination' && key !== 'configFile' && key !== 'name') ||
        typeof record.destination !== 'string' || !SSH_DESTINATION.test(record.destination) ||
        (record.configFile !== undefined && (typeof record.configFile !== 'string' || !isAbsolute(record.configFile) || record.configFile.includes('\0'))) ||
        (record.name !== undefined && (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 128 || /[\u0000-\u001f]/u.test(record.name)))) {
      throw new Error(`remoteHosts entry ${hostId} requires an SSH destination, optional absolute configFile, and optional display name`);
    }
    mappings.set(hostId, {
      destination: record.destination,
      ...(typeof record.configFile === 'string' ? { configFile: record.configFile } : {}),
      ...(typeof record.name === 'string' ? { name: record.name.trim() } : {}),
    });
  }
  return mappings;
}

function projectKey(project: Project, target?: SshTarget): string {
  return hash(JSON.stringify([project.id, project.hostId ?? 'local', project.path, target?.destination ?? null, target?.configFile ?? null]));
}

function assertIdentity(expected: ProjectIdentity | undefined, project: Project, key: string): void {
  if (expected && (expected.fingerprint !== key || project.path !== expected.path ||
      (project.hostId ?? null) !== expected.hostId || (project.workspaceId ?? null) !== expected.workspaceId)) {
    throw new Error('Workspace identity changed before access; refresh and try again');
  }
}

function manifestValue(value: unknown): Manifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.version !== 1 || typeof item.generation !== 'string' || !/^[0-9a-f-]{36}$/u.test(item.generation) ||
      typeof item.chunks !== 'number' || !Number.isInteger(item.chunks) || item.chunks < 1 || item.chunks > 512 ||
      typeof item.hash !== 'string' || !/^[a-f0-9]{64}$/u.test(item.hash) || typeof item.fetchedAt !== 'string') return null;
  return item as Manifest;
}

// Run on the workspace's host without installing a helper. Directory handles
// anchor every operation and O_NOFOLLOW refuses symlinks even during traversal.
// JSON is passed on stdin, never interpolated into the remote shell command.
const FILE_PROGRAM = String.raw`
import errno, json, os, stat, sys, uuid

LIMIT = 2 * 1024 * 1024

def run(req):
    parts = req['path'].split('/')
    if not parts or any(p in ('', '.', '..') for p in parts):
        raise OSError(errno.EINVAL, 'Invalid relative path')
    try:
        root = os.open(req['root'], os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    except FileNotFoundError:
        raise OSError(errno.ESTALE, 'Workspace root is unavailable')
    current = root
    try:
        for part in parts[:-1]:
            if req['action'] == 'write':
                try:
                    os.mkdir(part, 0o755, dir_fd=current)
                except FileExistsError:
                    pass
            next_fd = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=current)
            if current != root:
                os.close(current)
            current = next_fd
        name = parts[-1]
        if req['action'] in ('read', 'inspect'):
            fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC, dir_fd=current)
            try:
                if not stat.S_ISREG(os.fstat(fd).st_mode):
                    raise OSError(errno.EINVAL, 'Not a regular file')
                if req['action'] == 'inspect':
                    return {}
                chunks, size = [], 0
                while True:
                    chunk = os.read(fd, min(65536, LIMIT + 1 - size))
                    if not chunk:
                        break
                    chunks.append(chunk)
                    size += len(chunk)
                    if size > LIMIT:
                        raise OSError(errno.EFBIG, 'Text file exceeds 2 MiB')
                return {'text': b''.join(chunks).decode('utf-8', 'strict')}
            finally:
                os.close(fd)
        if req['action'] == 'write':
            data = req['text'].encode('utf-8', 'strict')
            if len(data) > LIMIT:
                raise OSError(errno.EFBIG, 'Text file exceeds 2 MiB')
            try:
                existing = os.stat(name, dir_fd=current, follow_symlinks=False)
            except FileNotFoundError:
                existing = None
            if existing is not None and not stat.S_ISREG(existing.st_mode):
                raise OSError(errno.ELOOP, 'Destination is a symbolic link or not a regular file')
            temporary = '.beads-orca-tmp-' + uuid.uuid4().hex
            created = False
            try:
                fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600, dir_fd=current)
                created = True
                try:
                    if existing is not None:
                        os.fchmod(fd, stat.S_IMODE(existing.st_mode))
                    position = 0
                    while position < len(data):
                        position += os.write(fd, data[position:])
                finally:
                    os.close(fd)
                os.replace(temporary, name, src_dir_fd=current, dst_dir_fd=current)
            finally:
                if created:
                    try:
                        os.unlink(temporary, dir_fd=current)
                    except FileNotFoundError:
                        pass
            return {}
        if req['action'] == 'remove':
            existing = os.stat(name, dir_fd=current, follow_symlinks=False)
            if not stat.S_ISREG(existing.st_mode):
                raise OSError(errno.ELOOP, 'Destination is a symbolic link or not a regular file')
            os.unlink(name, dir_fd=current)
            return {}
        raise OSError(errno.EINVAL, 'Unknown file action')
    finally:
        if current != root:
            os.close(current)
        os.close(root)

try:
    value = run(json.loads(sys.stdin.buffer.read().decode('utf-8', 'strict')))
    print(json.dumps({'ok': True, **value}))
except (OSError, UnicodeError, ValueError) as exc:
    code = errno.errorcode.get(exc.errno, 'EIO') if isinstance(exc, OSError) else 'EINVAL'
    print(json.dumps({'ok': False, 'code': code, 'message': str(exc)}))
`;

// argv 单项最多 4096。程序本体放 stdin，这段引导留在 -c 里。
const PYTHON_BOOTSTRAP = `import io,sys
marker=b"\\n#__BEADS_REQ__\\n"
raw=sys.stdin.buffer.read()
src,req=raw.split(marker,1)
sys.stdin=io.TextIOWrapper(io.BytesIO(req),encoding="utf-8")
exec(compile(src.decode(),"beads-orca","exec"))
`;

type SshAliasLookup = {
  aliases: Map<string, string>;
  /** hostId → Orca 里看到的名字。该名字不是合法的 SSH config 别名。 */
  rejected: Map<string, string>;
  error?: string;
};

function orcaCliExecutable(): string {
  // 与 NativeWorkflowCli 相同：桌面用 orca，Linux 包用 orca-ide，开发树用 orca-dev。
  return process.env.ORCA_CLI_COMMAND || (process.env.ORCA_DEV_REPO_ROOT ? 'orca-dev' : process.platform === 'linux' ? 'orca-ide' : 'orca');
}

function briefCliError(error: unknown): string {
  return errorMessage(error).replace(/\s+/gu, ' ').slice(0, 180);
}

/**
 * `orca host list` 的 ssh 项：id 是内部 target id，name 是标签。
 * 从 ~/.ssh/config 同步时，标签和 configHost 都写成 Host 别名（new_sls、mini）。
 * workspace.hostId 是 `ssh:` + encodeURIComponent(target.id)，不是别名本身。
 * 列表不返回 user/host/port/identity，所以这里只取别名，连接参数留给默认 SSH config。
 */
function sshAliasesFromHostList(result: unknown): { aliases: Map<string, string>; rejected: Map<string, string> } {
  if (!result || typeof result !== 'object' || !Array.isArray((result as { hosts?: unknown }).hosts)) {
    throw new Error('orca host list returned no hosts');
  }
  const chosen = new Map<string, { alias: string } | { reject: string }>();
  for (const entry of (result as { hosts: unknown[] }).hosts) {
    if (!entry || typeof entry !== 'object') continue;
    const host = entry as { kind?: unknown; id?: unknown; name?: unknown };
    if (host.kind !== 'ssh' || typeof host.id !== 'string' || !host.id || typeof host.name !== 'string') continue;
    const next = SSH_DESTINATION.test(host.name) ? { alias: host.name } : { reject: host.name };
    const previous = chosen.get(host.id);
    if (!previous) chosen.set(host.id, next);
    else if (!('alias' in previous) || !('alias' in next) || previous.alias !== next.alias) chosen.set(host.id, { reject: host.name });
  }
  const aliases = new Map<string, string>();
  const rejected = new Map<string, string>();
  for (const [id, value] of chosen) {
    const keys = new Set([`ssh:${encodeURIComponent(id)}`, `ssh:${id}`]);
    for (const key of keys) {
      if ('alias' in value) aliases.set(key, value.alias);
      else rejected.set(key, value.reject);
    }
  }
  return { aliases, rejected };
}

async function readOrcaHostList(): Promise<unknown> {
  const env = { ...process.env };
  delete env.ORCA_PAIRING_CODE;
  delete env.ORCA_ENVIRONMENT;
  delete env.ELECTRON_RUN_AS_NODE;
  const execution = executeFile(orcaCliExecutable(), ['host', 'list', '--json'], {
    env, encoding: 'utf8', shell: false, timeout: HOST_LIST_TIMEOUT_MS, killSignal: 'SIGKILL',
    maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  execution.child.stdin?.end();
  const { stdout } = await execution;
  const envelope = JSON.parse(stdout) as { ok?: unknown; result?: unknown };
  if (!envelope || envelope.ok !== true || !envelope.result || typeof envelope.result !== 'object') {
    throw new Error('orca host list returned no hosts');
  }
  return envelope.result;
}

function unsupportedHostReason(hostId: string, lookup: SshAliasLookup): string {
  if (!hostId.startsWith('ssh:')) {
    return t('Unsupported host {hostId}. Paired runtime hosts need a remoteHosts SSH alias; there is no paired file adapter.', '不支持的主机 {hostId}。配对的 runtime 主机需要在 remoteHosts 里写 SSH 别名；没有通用的配对文件通道。', { hostId });
  }
  if (lookup.error) {
    return t('Unsupported host {hostId}. Could not read Orca SSH hosts ({error}). Set remoteHosts.destination to the ~/.ssh/config Host alias.', '不支持的主机 {hostId}。读不到 Orca SSH 主机（{error}）。请把 remoteHosts.destination 设成 ~/.ssh/config 的 Host 别名。', { hostId, error: lookup.error });
  }
  const rejected = lookup.rejected.get(hostId);
  if (rejected) {
    return t('Unsupported host {hostId}. Orca host name "{name}" is not a ~/.ssh/config alias. Set remoteHosts.destination to that alias.', '不支持的主机 {hostId}。Orca 主机名「{name}」不是 ~/.ssh/config 别名。请把 remoteHosts.destination 设成那个别名。', { hostId, name: rejected });
  }
  return t('Unsupported host {hostId}. It is not in `orca host list` as an SSH alias. Sync ~/.ssh/config, or set remoteHosts.destination.', '不支持的主机 {hostId}。`orca host list` 里没有对应的 SSH 别名。请同步 ~/.ssh/config，或设置 remoteHosts.destination。', { hostId });
}

export function remoteHostsExample(hostId: string): string {
  return JSON.stringify({ [hostId]: { destination: 'linux-dev', configFile: '/Users/you/.ssh/config', name: 'Linux dev' } }, null, 2);
}

export type SshCheck = { name: string; ok: boolean; detail: string };
export type Diagnostics = { pathErrors: string[]; refreshMs: number; unmapped: { hostId: string; example: string }[] };

function positiveSeconds(value: unknown, fallback: number, max: number): number {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 5 || seconds > max) return fallback;
  return seconds;
}

export class ProjectAccess {
  private readonly state = new Map<string, AvailabilityState>();
  private sshAliasCache: { at: number; lookup: SshAliasLookup } | null = null;
  private forkCache: { at: number; hosts: ForkHostRow[]; workspaces: ForkWorkspaceRow[]; unreachable: string[] } | null = null;
  private forkBlocked = new Set<string>();
  private readonly cacheQueues = new Map<string, Promise<void>>();
  private pathErrors: string[] = [];
  private remotePath = '';
  private refreshSeconds = 0;
  private timeoutSeconds = 0;

  constructor(private readonly host: ProductHost) {}

  /** 自动别名不带 -F。用户若改了 Orca 显示名，或要用另一份 config，仍写 remoteHosts。 */
  private aliasTarget(hostId: string | null, lookup: SshAliasLookup): RemoteMapping | undefined {
    if (!hostId) return undefined;
    const destination = lookup.aliases.get(hostId);
    if (!destination) return undefined;
    return { destination, name: destination };
  }

  private async sshAliasLookup(): Promise<SshAliasLookup> {
    const cached = this.sshAliasCache;
    if (cached && Date.now() - cached.at < SSH_ALIAS_TTL_MS) return cached.lookup;
    try {
      const lookup = sshAliasesFromHostList(await readOrcaHostList());
      this.sshAliasCache = { at: Date.now(), lookup };
      return lookup;
    } catch (error) {
      // 失败不缓存：下一次请求再试。本地项目不依赖这次查询。
      return { aliases: new Map(), rejected: new Map(), error: briefCliError(error) };
    }
  }

  private async discover(): Promise<Discovery> {
    const catalog = await this.forkCatalog();
    const discovery = catalog ? await this.discoverFromFork(catalog) : await this.discoverConfigured();
    // fork.workspaces.list 只挂在 runtime 上。SSH 主机的 worktree 仍在 workspace.list 里。
    if (catalog) await this.appendMissingDesktopWorkspaces(discovery);
    await this.applyFocus(discovery);
    return discovery;
  }

  private async forkCatalog(): Promise<{ hosts: ForkHostRow[]; workspaces: ForkWorkspaceRow[]; unreachable: string[] } | null> {
    if (this.forkCache && Date.now() - this.forkCache.at < SSH_ALIAS_TTL_MS) return this.forkCache;
    if (!(await forkAvailable(this.host.host))) return null;
    try {
      const [hosts, listed] = await Promise.all([forkHosts(this.host.host), forkWorkspaces(this.host.host)]);
      if (listed.truncated) throw new Error('Orca truncated its workspace list. Narrow the registered workspaces before using Beads.');
      const value = { at: Date.now(), hosts, workspaces: listed.workspaces, unreachable: listed.unreachable };
      this.forkCache = value;
      return value;
    } catch (error) {
      if (error instanceof Error && /truncated/i.test(error.message)) throw error;
      return null;
    }
  }

  private forkAlias(row: ForkHostRow | undefined): string | undefined {
    const candidate = row?.configHost || row?.label;
    return candidate && SSH_DESTINATION.test(candidate) ? candidate : undefined;
  }

  private forkRun(binding: ForkBinding): RemoteRun {
    return async (script, options) => {
      if (options.timeoutMs < 1_000) {
        throw Object.assign(new Error('remote command timed out'), { killed: true, code: 'ETIMEDOUT', stderr: '', stdout: '' });
      }
      const body = remoteShellScript(script, this.remotePath);
      const stdin = options.stdin === undefined ? body : `${body}\n${options.stdin}`;
      const result = await forkExec(this.host.host, {
        hostId: binding.hostId,
        workspaceId: binding.workspaceId,
        argv: ['bash', '--noprofile', '--norc', '-s'],
        stdin,
        timeoutMs: options.timeoutMs,
        maxOutputBytes: options.maxBuffer,
      });
      return finishForkCommand(result, options.context);
    };
  }

  private async discoverFromFork(catalog: { hosts: ForkHostRow[]; workspaces: ForkWorkspaceRow[]; unreachable: string[] }): Promise<Discovery> {
    const mappings = remoteMappings(await this.host.settings.get('remoteHosts'));
    const byHost = new Map(catalog.hosts.map((host) => [host.hostId, host]));
    const targets = new Map<string, SshTarget>();
    const forks = new Map<string, ForkBinding>();
    const keys = new Map<string, string>();
    const projects: Project[] = [];
    for (const workspace of catalog.workspaces) {
      if (!workspace || typeof workspace.id !== 'string' || typeof workspace.name !== 'string' || typeof workspace.path !== 'string' || typeof workspace.hostId !== 'string') {
        throw new Error('Orca returned an invalid workspace');
      }
      const hostId = workspace.hostId;
      const local = hostId === 'local';
      const row = byHost.get(hostId);
      const pluginId = local ? workspace.id : `${hostId}::${workspace.id}`;
      const override = mappings.get(hostId);
      const alias = this.forkAlias(row);
      const ssh = override ?? (alias ? { destination: alias, name: row?.label || alias } : undefined);
      const useFork = !local && !override && row?.exec === true && row.kind === 'runtime' && !this.forkBlocked.has(hostId);
      const project: Project = {
        id: pluginId, name: workspace.name, path: workspace.path, hostId,
        ...(local ? { hostName: 'Local' } : { hostName: override?.name || row?.label || alias }),
        workspaceId: workspace.id, ...(workspace.branch !== undefined ? { branch: workspace.branch } : {}),
      };
      const key = projectKey(project, useFork ? undefined : ssh);
      keys.set(project.id, key);
      if (useFork) forks.set(project.id, { hostId, workspaceId: workspace.id, ...(ssh ? { fallback: ssh } : {}) });
      else if (ssh) targets.set(project.id, ssh);
      const status = this.state.get(key);
      if (!local && !useFork && !ssh) {
        project.availability = 'unsupported';
        project.availabilityReason = unsupportedHostReason(hostId, { aliases: new Map(), rejected: new Map() });
      } else {
        project.availability = status?.availability ?? 'unknown';
        if (status?.reason) project.availabilityReason = status.reason;
        if (status?.lastFetchedAt) project.lastFetchedAt = status.lastFetchedAt;
        if (status?.cacheError) project.cacheError = status.cacheError;
      }
      projects.push(project);
    }
    await this.loadLimits();
    this.pathErrors = catalog.unreachable.map((hostId) => t('{hostId}: Orca server is unreachable', '{hostId}：Orca 服务器不可达', { hostId }));
    await this.appendProjectPaths(projects, keys, false);
    return { projects, targets, forks, keys };
  }

  private async loadLimits(): Promise<void> {
    const remotePath = await this.host.settings.get('remotePath');
    this.remotePath = typeof remotePath === 'string' ? remotePath : '';
    this.refreshSeconds = positiveSeconds(await this.host.settings.get('refreshSeconds'), 0, 300);
    this.timeoutSeconds = positiveSeconds(await this.host.settings.get('commandTimeoutSeconds'), 0, 110);
  }

  private async appendProjectPaths(projects: Project[], keys: Map<string, string>, resetErrors: boolean): Promise<void> {
    if (resetErrors) this.pathErrors = [];
    const configured = await this.host.settings.get('projectPaths');
    if (typeof configured !== 'string') return;
    for (const line of configured.split('\n').map((value) => value.trim()).filter(Boolean)) {
      if (!isAbsolute(line)) { this.pathErrors.push(`${line}: Beads project paths must be absolute`); continue; }
      let path: string;
      try { path = await realpath(line); }
      catch (error) { this.pathErrors.push(`${line}: ${errorMessage(error)}`); continue; }
      let matched = false;
      for (const project of projects) {
        if (project.hostId !== null && project.hostId !== 'local') continue;
        const existing = await realpath(project.path).catch(() => project.path);
        if (existing === path) { matched = true; break; }
      }
      if (matched) continue;
      const project: Project = { id: `path:${path}`, name: basename(path), path, hostId: 'local', hostName: 'Local', workspaceId: null };
      const key = projectKey(project);
      keys.set(project.id, key);
      const status = this.state.get(key);
      project.availability = status?.availability ?? 'unknown';
      if (status?.reason) project.availabilityReason = status.reason;
      if (status?.lastFetchedAt) project.lastFetchedAt = status.lastFetchedAt;
      if (status?.cacheError) project.cacheError = status.cacheError;
      projects.push(project);
    }
  }

  private async discoverConfigured(): Promise<Discovery> {
    const listed = await this.host.host.call('workspace.list') as { workspaces?: Workspace[]; truncated?: boolean };
    if (!listed || !Array.isArray(listed.workspaces)) throw new Error('Orca returned an invalid workspace list');
    if (listed.truncated) throw new Error('Orca truncated its workspace list. Narrow the registered workspaces before using Beads.');
    const mappings = remoteMappings(await this.host.settings.get('remoteHosts'));
    const needsAlias = listed.workspaces.some((workspace) => {
      const hostId = workspace?.hostId;
      return typeof hostId === 'string' && hostId.startsWith('ssh:') && !mappings.has(hostId);
    });
    const lookup = needsAlias ? await this.sshAliasLookup() : { aliases: new Map<string, string>(), rejected: new Map<string, string>() };
    const targets = new Map<string, SshTarget>();
    const keys = new Map<string, string>();
    const projects: Project[] = [];
    for (const workspace of listed.workspaces) {
      if (!workspace || typeof workspace.id !== 'string' || typeof workspace.name !== 'string' || typeof workspace.path !== 'string') {
        throw new Error('Orca returned an invalid workspace');
      }
      const hostId = workspace.hostId ?? null;
      const local = hostId === null || hostId === 'local';
      // remoteHosts 同 key 整条覆盖自动别名，包括 destination、configFile 和显示名。
      const target = local ? undefined : mappings.get(hostId ?? '') ?? this.aliasTarget(hostId, lookup);
      const project: Project = {
        id: workspace.id, name: workspace.name, path: workspace.path, hostId,
        ...(local ? { hostName: 'Local' } : target?.name ? { hostName: target.name } : {}), workspaceId: workspace.id,
        ...(workspace.branch !== undefined ? { branch: workspace.branch } : {}),
      };
      const key = projectKey(project, target);
      keys.set(project.id, key);
      if (target) targets.set(project.id, target);
      const status = this.state.get(key);
      if (!local && !target) {
        project.availability = 'unsupported';
        project.availabilityReason = unsupportedHostReason(hostId ?? '', lookup);
      } else {
        project.availability = status?.availability ?? 'unknown';
        if (status?.reason) project.availabilityReason = status.reason;
        if (status?.lastFetchedAt) project.lastFetchedAt = status.lastFetchedAt;
        if (status?.cacheError) project.cacheError = status.cacheError;
      }
      projects.push(project);
    }
    await this.loadLimits();
    await this.appendProjectPaths(projects, keys, true);
    return { projects, targets, forks: new Map(), keys };
  }

  private placeKey(hostId: string | null | undefined, path: string): string {
    const host = !hostId || hostId === 'local' ? 'local' : hostId;
    return `${host}\0${path.replace(/\/+$/, '') || '/'}`;
  }

  /** SSH worktrees live on workspace.list even when fork.workspaces.list only has runtime rows. */
  private async appendMissingDesktopWorkspaces(discovery: Discovery): Promise<void> {
    let listed: { workspaces?: Workspace[] };
    try { listed = await this.host.host.call('workspace.list') as { workspaces?: Workspace[] }; }
    catch { return; }
    if (!listed || !Array.isArray(listed.workspaces)) return;
    const present = new Set(discovery.projects.map((project) => this.placeKey(project.hostId, project.path)));
    const extra = listed.workspaces.filter((workspace) => workspace && typeof workspace.path === 'string' && typeof workspace.id === 'string' && typeof workspace.name === 'string' && !present.has(this.placeKey(workspace.hostId ?? null, workspace.path)));
    if (!extra.length) return;
    const mappings = remoteMappings(await this.host.settings.get('remoteHosts'));
    const needsAlias = extra.some((workspace) => {
      const hostId = workspace.hostId;
      return typeof hostId === 'string' && hostId.startsWith('ssh:') && !mappings.has(hostId);
    });
    const lookup = needsAlias ? await this.sshAliasLookup() : { aliases: new Map<string, string>(), rejected: new Map<string, string>() };
    for (const workspace of extra) {
      const hostId = workspace.hostId ?? null;
      const local = hostId === null || hostId === 'local';
      const target = local ? undefined : mappings.get(hostId ?? '') ?? this.aliasTarget(hostId, lookup);
      const project: Project = {
        id: workspace.id, name: workspace.name, path: workspace.path, hostId,
        ...(local ? { hostName: 'Local' } : target?.name ? { hostName: target.name } : {}), workspaceId: workspace.id,
        ...(workspace.branch !== undefined ? { branch: workspace.branch } : {}),
      };
      const key = projectKey(project, target);
      discovery.keys.set(project.id, key);
      if (target) discovery.targets.set(project.id, target);
      const status = this.state.get(key);
      if (!local && !target) {
        project.availability = 'unsupported';
        project.availabilityReason = unsupportedHostReason(hostId ?? '', lookup);
      } else {
        project.availability = status?.availability ?? 'unknown';
        if (status?.reason) project.availabilityReason = status.reason;
        if (status?.lastFetchedAt) project.lastFetchedAt = status.lastFetchedAt;
        if (status?.cacheError) project.cacheError = status.cacheError;
      }
      discovery.projects.push(project);
    }
  }

  private async applyFocus(discovery: Discovery): Promise<void> {
    let context: FocusContext | null = null;
    try { context = await this.host.host.call('workspace.readContext') as FocusContext | null; }
    catch { context = null; }
    const id = focusedWorkspaceId(discovery.projects.map((project) => ({
      id: project.id, name: project.name, path: project.path, hostId: project.hostId, branch: project.branch,
    })), context);
    for (const project of discovery.projects) delete project.current;
    const match = id ? discovery.projects.find((project) => project.id === id) : undefined;
    if (match) match.current = true;
  }

  private async localHasBeads(path: string): Promise<boolean> {
    try {
      const stat = await lstat(join(path, '.beads'));
      return stat.isDirectory() || stat.isSymbolicLink();
    } catch {
      return false;
    }
  }

  /** true 有 .beads，false 确认没有，null 查不了（主机不可达或没有连接）。 */
  private async remoteHasBeads(project: Project, discovery: Discovery): Promise<boolean | null> {
    const transport = { target: discovery.targets.get(project.id), fork: discovery.forks.get(project.id) };
    if (!transport.target && !transport.fork) return null;
    try {
      await this.withTransport(transport, async ({ target, options }) => {
        const script = `cd -- ${quoteRemote(project.path)} || exit 125\ntest -d .beads`;
        if (options.remoteRun) {
          await options.remoteRun(script, { timeoutMs: options.timeoutMs ?? PROCESS_TIMEOUT_MS, maxBuffer: 1024, context: 'exec' });
          return;
        }
        if (target) {
          await executeSsh(target, bashCommand(script, this.remotePath), { timeoutMs: options.timeoutMs ?? PROCESS_TIMEOUT_MS, maxBuffer: 1024, context: 'exec' });
          return;
        }
        const execution = executeFile('sh', ['-c', 'cd -- "$1" && test -d .beads', 'probe', project.path], {
          encoding: 'utf8', shell: false, timeout: PROCESS_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 1024,
        });
        execution.child.stdin?.end();
        await execution;
      });
      return true;
    } catch (error) {
      if (error instanceof RemoteUnavailableError) return null;
      if (error instanceof RemoteCommandError) return false;
      const code = (error as ExecFileException).code;
      if (code === 1 || code === 125) return false;
      return null;
    }
  }

  private async beadsInitialized(project: Project, discovery: Discovery): Promise<boolean> {
    const local = !project.hostId || project.hostId === 'local' || project.id.startsWith('path:');
    if (local) return this.localHasBeads(project.path);
    const remote = await this.remoteHasBeads(project, discovery);
    return remote !== false;
  }

  async list(): Promise<Project[]> {
    const discovered = await this.discover();
    const visible: Project[] = [];
    for (const project of discovered.projects) {
      if (await this.beadsInitialized(project, discovered)) visible.push(project);
    }
    return visible;
  }

  private async resolve(projectId: string): Promise<{ project: Project; target?: SshTarget; fork?: ForkBinding; key: string; projects: Project[] }> {
    const discovered = await this.discover();
    const project = discovered.projects.find((candidate) => candidate.id === projectId);
    const key = project && discovered.keys.get(project.id);
    if (!project || !key) throw new Error('A registered project ID is required');
    if (project.availability === 'unsupported') throw new Error(project.availabilityReason ?? 'Unsupported project host');
    return { project, target: discovered.targets.get(project.id), fork: discovered.forks.get(project.id), key, projects: discovered.projects };
  }

  private async withTransport<T>(resolved: { target?: SshTarget; fork?: ForkBinding }, run: (transport: { target?: SshTarget; options: CommandOptions }) => Promise<T>): Promise<T> {
    const fork = resolved.fork;
    if (fork && !this.forkBlocked.has(fork.hostId)) {
      try {
        return await run({ options: this.commandOptions(true, this.forkRun(fork)) });
      } catch (error) {
        if (!(error instanceof ForkServerTooOld) || !fork.fallback) throw error;
        this.forkBlocked.add(fork.hostId);
        return await run({ target: fork.fallback, options: this.commandOptions(true) });
      }
    }
    return await run({ target: resolved.target, options: this.commandOptions(Boolean(resolved.target)) });
  }

  async captureIdentity(projectId: string): Promise<ProjectIdentity> {
    const { project, key } = await this.resolve(projectId);
    return { path: project.path, hostId: project.hostId ?? null, workspaceId: project.workspaceId ?? null, fingerprint: key };
  }

  private mark(key: string, availability: ProjectAvailability, reason?: string): void {
    const previous = this.state.get(key);
    this.state.set(key, { ...previous, availability, ...(reason ? { reason } : { reason: undefined }) });
  }

  private async storageValue(key: string): Promise<unknown> {
    const result = await this.host.host.call('storage.get', { key }) as { value?: unknown };
    return result?.value ?? null;
  }

  private async removeChunks(prefix: string, manifest: Manifest): Promise<void> {
    for (let index = 0; index < manifest.chunks; index++) {
      await this.host.host.call('storage.delete', { key: `${prefix}.${manifest.generation}.${index}` });
    }
  }

  private async cacheOperation<T>(key: string, run: () => Promise<T>): Promise<T> {
    const operation = (this.cacheQueues.get(key) ?? Promise.resolve()).then(run);
    const settled = operation.then(() => undefined, () => undefined);
    this.cacheQueues.set(key, settled);
    void settled.then(() => { if (this.cacheQueues.get(key) === settled) this.cacheQueues.delete(key); });
    return operation;
  }

  private async persist(key: string, snapshot: Snapshot): Promise<void> {
    const prefix = `beads.snapshot.${key}`;
    await this.cacheOperation(key, async () => {
      const current = manifestValue(await this.storageValue(`${prefix}.current`));
      if (current && current.fetchedAt > snapshot.fetchedAt) return;
      const encoded = gzipSync(Buffer.from(JSON.stringify(snapshot), 'utf8')).toString('base64');
      const generation = randomUUID();
      const chunks = Math.ceil(encoded.length / CACHE_CHUNK_SIZE);
      const manifest: Manifest = { version: 1, generation, chunks, hash: hash(encoded), fetchedAt: snapshot.fetchedAt };
      let written = 0;
      try {
        for (; written < chunks; written++) {
          await this.host.host.call('storage.set', { key: `${prefix}.${generation}.${written}`, value: encoded.slice(written * CACHE_CHUNK_SIZE, (written + 1) * CACHE_CHUNK_SIZE) });
        }
        await this.host.host.call('storage.set', { key: `${prefix}.current`, value: manifest });
      } catch (error) {
        for (let index = 0; index < written; index++) {
          await this.host.host.call('storage.delete', { key: `${prefix}.${generation}.${index}` }).catch(() => undefined);
        }
        throw error;
      }
      if (current) await this.removeChunks(prefix, current).catch(() => undefined);
    });
  }

  private async cached(key: string): Promise<Snapshot | null> {
    return this.cacheOperation(key, async () => {
      const prefix = `beads.snapshot.${key}`;
      const raw = await this.storageValue(`${prefix}.current`);
      if (raw === null) return null;
      const manifest = manifestValue(raw);
      if (!manifest) throw new Error('The persisted offline snapshot manifest is invalid');
      const parts: string[] = [];
      for (let index = 0; index < manifest.chunks; index++) {
        const value = await this.storageValue(`${prefix}.${manifest.generation}.${index}`);
        if (typeof value !== 'string' || value.length > CACHE_CHUNK_SIZE) throw new Error('The persisted offline snapshot is incomplete');
        parts.push(value);
      }
      const encoded = parts.join('');
      if (hash(encoded) !== manifest.hash) throw new Error('The persisted offline snapshot is corrupt');
      let value: unknown;
      try { value = JSON.parse(gunzipSync(Buffer.from(encoded, 'base64'), { maxOutputLength: 64 * 1024 * 1024 }).toString('utf8')) as unknown; }
      catch (cause) { throw new Error('The persisted offline snapshot is invalid', { cause }); }
      const snapshot = value as Partial<Snapshot> | null;
      if (!snapshot || typeof snapshot !== 'object' || !Array.isArray(snapshot.issues) || !Array.isArray(snapshot.readyIds) ||
          !Array.isArray(snapshot.blockedIds) || snapshot.fetchedAt !== manifest.fetchedAt) throw new Error('The persisted offline snapshot is invalid');
      return snapshot as Snapshot;
    });
  }

  private commandOptions(remote: boolean, remoteRun?: RemoteRun): CommandOptions {
    const timeoutMs = this.timeoutSeconds ? this.timeoutSeconds * 1000 : remote ? 60_000 : 30_000;
    return { timeoutMs, ...(this.remotePath.trim() ? { remotePath: this.remotePath } : {}), ...(remoteRun ? { remoteRun } : {}) };
  }

  private refreshMs(projects: Project[]): number {
    if (this.refreshSeconds) return this.refreshSeconds * 1000;
    return projects.some((project) => project.hostId && project.hostId !== 'local') ? REMOTE_REFRESH_MS : LOCAL_REFRESH_MS;
  }

  private diagnostics(projects: Project[]): Diagnostics {
    const unmapped = projects.filter((project) => project.availability === 'unsupported' && project.hostId).map((project) => ({
      hostId: project.hostId!, example: remoteHostsExample(project.hostId!),
    }));
    return { pathErrors: [...this.pathErrors], refreshMs: this.refreshMs(projects), unmapped };
  }

  async request(request: RpcRequest, expected?: ProjectIdentity): Promise<unknown> {
    if (request?.method === 'diagnostics') return this.diagnostics(await this.list());
    if (request?.method === 'ssh.test') return this.testSsh(typeof request.project === 'string' ? request.project : '');
    const discovery = await this.discover();
    if (request?.method === 'projects') {
      const visible: Project[] = [];
      for (const project of discovery.projects) {
        if (await this.beadsInitialized(project, discovery)) visible.push(project);
      }
      return handleRequest(request, visible);
    }
    const project = discovery.projects.find((candidate) => candidate.id === request?.project);
    const key = project && discovery.keys.get(project.id);
    if (!project || !key) throw new Error('A registered project ID is required');
    if (project.availability === 'unsupported') throw new Error(project.availabilityReason ?? 'Unsupported project host');
    assertIdentity(expected, project, key);
    if (project.availability === 'offline' && Object.hasOwn(MUTATIONS, request.method)) throw new Error(`Project ${project.name} is offline; refresh before writing`);
    try {
      const response = await this.withTransport(
        { target: discovery.targets.get(project.id), fork: discovery.forks.get(project.id) },
        ({ target, options }) => handleRequest(request, discovery.projects, target, options),
      );
      this.mark(key, 'online');
      if (request.method !== 'snapshot') return response;
      const snapshot = response as Snapshot;
      snapshot.offline = false;
      snapshot.project = { ...project, availability: 'online', lastFetchedAt: snapshot.fetchedAt };
      delete snapshot.project.availabilityReason;
      delete snapshot.project.cacheError;
      const status = this.state.get(key)!;
      status.lastFetchedAt = snapshot.fetchedAt;
      status.cacheError = undefined;
      try {
        await this.persist(key, snapshot);
      } catch (error) {
        status.cacheError = `Offline snapshot could not be persisted: ${errorMessage(error)}`;
        snapshot.project.cacheError = status.cacheError;
      }
      return snapshot;
    } catch (error) {
      if (!(error instanceof ProjectUnavailableError)) throw error;
      this.mark(key, 'offline', error.message);
      if (request.method === 'snapshot') {
        const snapshot = await this.cached(key);
        if (snapshot) {
          const status = this.state.get(key)!;
          status.lastFetchedAt = snapshot.fetchedAt;
          return { ...snapshot, offline: true, project: { ...project, availability: 'offline', availabilityReason: error.message, lastFetchedAt: snapshot.fetchedAt } } satisfies Snapshot;
        }
      }
      throw error;
    }
  }

  private async file(projectId: string, path: string, action: 'read' | 'inspect' | 'write' | 'remove', text?: string, expected?: ProjectIdentity): Promise<TextFile | { path: string } | void> {
    const normalized = relativeFile(path);
    if (action === 'write' && (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > FILE_LIMIT || Buffer.from(text, 'utf8').toString('utf8') !== text)) {
      throw new Error('Text must be a UTF-8 string of at most 2 MiB');
    }
    const resolved = await this.resolve(projectId);
    const { project, key } = resolved;
    assertIdentity(expected, project, key);
    if ((action === 'write' || action === 'remove') && project.availability === 'offline') throw new Error(`Project ${project.name} is offline; refresh before writing`);
    const input = JSON.stringify({ root: project.path, path: normalized, action, ...(action === 'write' ? { text } : {}) });
    let stdout: string;
    try {
      stdout = await this.withTransport(resolved, async ({ target, options }) => {
        if (options.remoteRun && resolved.fork) {
          const result = await forkExec(this.host.host, {
            hostId: resolved.fork.hostId,
            workspaceId: resolved.fork.workspaceId,
            argv: ['python3', '-I', '-c', PYTHON_BOOTSTRAP],
            stdin: `${FILE_PROGRAM}\n#__BEADS_REQ__\n${input}`,
            timeoutMs: options.timeoutMs ?? PROCESS_TIMEOUT_MS,
            maxOutputBytes: PROCESS_OUTPUT_LIMIT,
          });
          return finishForkCommand(result, 'python').stdout;
        }
        if (target) {
          const script = `python3 -I -c ${quoteRemote(FILE_PROGRAM)}`;
          return (await executeSsh(target, bashCommand(script, this.remotePath), { input, timeoutMs: options.timeoutMs ?? PROCESS_TIMEOUT_MS, maxBuffer: PROCESS_OUTPUT_LIMIT, context: 'python' })).stdout;
        }
        const execution = executeFile('python3', ['-I', '-c', FILE_PROGRAM], {
          encoding: 'utf8', shell: false, timeout: PROCESS_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: PROCESS_OUTPUT_LIMIT, windowsHide: true,
        });
        execution.child.stdin?.on('error', () => undefined);
        execution.child.stdin?.end(input);
        return (await execution).stdout;
      });
    } catch (cause) {
      if (cause instanceof RemoteUnavailableError) { this.mark(key, 'offline', cause.message); throw cause; }
      if (cause instanceof RemoteCommandError) throw cause;
      throw new Error(`Workspace file access failed; python3 is required on the workspace host: ${errorMessage(cause)}`, { cause });
    }
    this.mark(key, 'online');
    let result: { ok?: boolean; code?: string; message?: string; text?: string };
    try { result = JSON.parse(stdout) as typeof result; } catch (cause) { throw new Error('Workspace file access returned invalid output', { cause }); }
    if (!result.ok) {
      if (result.code === 'ESTALE') {
        const error = new ProjectUnavailableError(result.message ?? 'Workspace root is unavailable');
        this.mark(key, 'offline', error.message);
        throw error;
      }
      throw Object.assign(new Error(result.message ?? 'Workspace file access failed'), { code: result.code ?? 'EIO' });
    }
    if (action === 'inspect') return { path: normalized };
    if (action === 'read') {
      if (typeof result.text !== 'string') throw new Error('Workspace file access returned invalid text');
      return { path: normalized, text: result.text, hash: hash(Buffer.from(result.text, 'utf8')) };
    }
  }

  async readText(projectId: string, relativePath: string, expected?: ProjectIdentity): Promise<TextFile> {
    return await this.file(projectId, relativePath, 'read', undefined, expected) as TextFile;
  }

  /** Verify a confined regular file without reading or transferring its content. */
  async inspectFile(projectId: string, relativePath: string, expected?: ProjectIdentity): Promise<{ path: string }> {
    return await this.file(projectId, relativePath, 'inspect', undefined, expected) as { path: string };
  }

  async writeText(projectId: string, relativePath: string, text: string, expected?: ProjectIdentity): Promise<void> {
    await this.file(projectId, relativePath, 'write', text, expected);
  }

  async removeFile(projectId: string, relativePath: string, expected?: ProjectIdentity): Promise<void> {
    await this.file(projectId, relativePath, 'remove', undefined, expected);
  }

  /** Probe only an executable basename on the workspace's execution host. */
  async executableAvailable(projectId: string, command: string): Promise<boolean> {
    if (typeof command !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.+-]{0,127}$/u.test(command)) throw new Error('Executable must be a command basename');
    const resolved = await this.resolve(projectId);
    const { project, key } = resolved;
    try {
      await this.withTransport(resolved, async ({ target, options }) => {
        const script = `cd -- ${quoteRemote(project.path)} || exit 125\ncommand -v ${quoteRemote(command)} >/dev/null 2>&1`;
        if (options.remoteRun) {
          await options.remoteRun(script, { timeoutMs: options.timeoutMs ?? PROCESS_TIMEOUT_MS, maxBuffer: PROCESS_OUTPUT_LIMIT, context: 'exec' });
          return;
        }
        if (target) {
          await executeSsh(target, bashCommand(script, this.remotePath), { timeoutMs: options.timeoutMs ?? PROCESS_TIMEOUT_MS, maxBuffer: PROCESS_OUTPUT_LIMIT, context: 'exec' });
          return;
        }
        const execution = executeFile('sh', ['-c', 'command -v "$1" >/dev/null 2>&1', 'probe', command], {
          cwd: project.path, encoding: 'utf8', shell: false, timeout: PROCESS_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: PROCESS_OUTPUT_LIMIT,
        });
        execution.child.stdin?.end();
        await execution;
      });
      this.mark(key, 'online');
      return true;
    } catch (error) {
      if (error instanceof RemoteUnavailableError) { this.mark(key, 'offline', error.message); throw error; }
      if (error instanceof RemoteCommandError) throw error;
      if ((error as ExecFileException).code === 1) { this.mark(key, 'online'); return false; }
      throw error;
    }
  }

  /** 一条复用连接上的检查。登录 shell 不参与 bd/python 的查找。 */
  private async testSsh(projectId: string): Promise<{ ok: boolean; checks: SshCheck[] }> {
    const resolved = await this.resolve(projectId);
    const { project, key } = resolved;
    if (!resolved.target && !resolved.fork) return { ok: false, checks: [{ name: 'mapping', ok: false, detail: t('This project is local, or its SSH host has no alias.', '这是本地项目，或这台 SSH 主机没有别名。') }] };
    const script = [
      'if ! command -v bash >/dev/null 2>&1; then echo bash=missing; exit 0; fi',
      'echo bash=ok',
      'if command -v bd >/dev/null 2>&1; then echo "bd=$(command -v bd)"; echo "version=$(bd --version 2>/dev/null | head -n 1)"; else echo bd=missing; echo version=; fi',
      'if command -v python3 >/dev/null 2>&1; then echo "python=$(command -v python3)"; else echo python=missing; fi',
      `cd -- ${quoteRemote(project.path)} || { echo root=inaccessible; echo beads=unchecked; exit 0; }`,
      'echo "root=$(pwd -P)"',
      'if [ ! -d .beads ]; then echo beads=missing; exit 0; fi',
      'beads_root=$(pwd -P)',
      'cd -P -- .beads || { echo beads=unreadable; exit 0; }',
      'beads_phys=$(pwd -P)',
      'case "$beads_phys" in',
      '  "$beads_root"/.beads|"$beads_root"/.beads/*) echo "beads=ok $beads_phys" ;;',
      '  *) echo "beads=outside $beads_phys" ;;',
      'esac',
    ].join('\n');
    try {
      const { stdout } = await this.withTransport(resolved, async ({ target, options }) => {
        if (options.remoteRun) return options.remoteRun(script, { timeoutMs: options.timeoutMs ?? 60_000, maxBuffer: 1024 * 1024, context: 'exec' });
        return executeSsh(target!, bashCommand(script, this.remotePath), { timeoutMs: options.timeoutMs ?? 60_000, maxBuffer: 1024 * 1024, context: 'exec' });
      });
      this.mark(key, 'online');
      const fields = Object.fromEntries(stdout.trim().split('\n').map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }));
      const checks: SshCheck[] = [
        { name: 'connect', ok: true, detail: resolved.fork ? t('Connected through Orca on {host}', '已通过 Orca 连到 {host}', { host: resolved.fork.hostId }) : `Connected to ${resolved.target?.destination}` },
        { name: 'bash', ok: fields.bash === 'ok', detail: fields.bash === 'ok' ? 'bash is available' : 'bash is missing' },
        { name: 'bd', ok: fields.bd !== 'missing' && Boolean(fields.bd), detail: fields.bd && fields.bd !== 'missing' ? fields.bd : 'bd was not found on the remote PATH' },
        { name: 'bd version', ok: Boolean(fields.version), detail: fields.version || 'bd did not print a version' },
        { name: 'python3', ok: fields.python !== 'missing' && Boolean(fields.python), detail: fields.python && fields.python !== 'missing' ? fields.python : 'python3 was not found on the remote PATH' },
        { name: 'workspace', ok: Boolean(fields.root) && fields.root !== 'inaccessible', detail: fields.root || 'workspace path is not accessible' },
        { name: '.beads', ok: Boolean(fields.beads?.startsWith('ok ')), detail: fields.beads || 'not checked' },
      ];
      return { ok: checks.every((check) => check.ok), checks };
    } catch (error) {
      const message = errorMessage(error);
      if (error instanceof RemoteUnavailableError) this.mark(key, 'offline', message);
      return { ok: false, checks: [{ name: 'connect', ok: false, detail: message }] };
    }
  }
}
