import { t } from '../ui/i18n.js';

/** 桌面 fork.host.*。旧 Orca 没有这些方法时走系统 SSH。 */
export interface ForkHostRow {
  hostId: string;
  kind: 'local' | 'ssh' | 'runtime';
  label: string;
  envId?: string;
  configHost?: string;
  aliasHostIds: string[];
  state: 'connected' | 'connecting' | 'disconnected' | 'unknown';
  platform: string | null;
  exec: boolean;
}

export interface ForkWorkspaceRow {
  hostId: string;
  envId?: string;
  id: string;
  kind: 'worktree' | 'folder';
  name: string;
  path: string;
  branch: string | null;
}

export interface ForkExecResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
}

export interface ForkCaller {
  call(method: string, params?: Record<string, unknown>): Promise<unknown>;
  has?(method: string): boolean | Promise<boolean>;
}

/** 配对服务器还没有 fork.workspace.exec。调用方可以改走系统 SSH。 */
export class ForkServerTooOld extends Error {
  readonly reason = 'server-method-missing';
  constructor(message: string) {
    super(message);
    this.name = 'ForkServerTooOld';
  }
}

const FORK_METHODS = ['fork.host.exec', 'fork.hosts.list', 'fork.workspaces.list'] as const;
const STDIN_MAX = 8 * 1024 * 1024;
const OUTPUT_MAX = 16 * 1024 * 1024;

export async function forkAvailable(host: ForkCaller): Promise<boolean> {
  if (typeof host.has !== 'function') return false;
  try {
    for (const method of FORK_METHODS) {
      if (await host.has(method) !== true) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function forkError(error: unknown): { code?: string; reason?: string; message: string } {
  if (error && typeof error === 'object') {
    const record = error as { code?: unknown; reason?: unknown };
    return {
      code: typeof record.code === 'string' ? record.code : undefined,
      reason: typeof record.reason === 'string' ? record.reason : undefined,
      message: error instanceof Error ? error.message : String(error),
    };
  }
  return { message: String(error) };
}

export function rethrowFork(error: unknown): never {
  const coded = forkError(error);
  if (coded.reason === 'server-method-missing') throw new ForkServerTooOld(coded.message);
  if (coded.reason === 'host-unreachable' || coded.code === 'unavailable') {
    throw Object.assign(new Error(t('Orca server is unreachable. {detail}', 'Orca 服务器不可达。{detail}', { detail: coded.message })), { code: 'host-unreachable' });
  }
  if (coded.reason === 'ssh-not-served' || coded.code === 'not_permitted') {
    throw new Error(t('This Orca build does not run commands on a bare ssh: host. Use the paired runtime: server.', '这个 Orca 不在裸的 ssh: 主机上执行命令。请使用配对的 runtime: 服务器。'));
  }
  throw error instanceof Error ? error : new Error(coded.message);
}

export async function forkHosts(host: ForkCaller): Promise<ForkHostRow[]> {
  const listed = await host.call('fork.hosts.list') as { hosts?: ForkHostRow[] };
  if (!listed || !Array.isArray(listed.hosts)) throw new Error('fork.hosts.list returned no hosts');
  return listed.hosts;
}

export async function forkWorkspaces(host: ForkCaller): Promise<{ workspaces: ForkWorkspaceRow[]; truncated: boolean; unreachable: string[] }> {
  const listed = await host.call('fork.workspaces.list') as { workspaces?: ForkWorkspaceRow[]; truncated?: boolean; unreachable?: string[] };
  if (!listed || !Array.isArray(listed.workspaces)) throw new Error('fork.workspaces.list returned no workspaces');
  return { workspaces: listed.workspaces, truncated: listed.truncated === true, unreachable: Array.isArray(listed.unreachable) ? listed.unreachable : [] };
}

export async function forkExec(host: ForkCaller, params: {
  hostId: string;
  workspaceId: string;
  argv: string[];
  stdin?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}): Promise<ForkExecResult> {
  if (params.stdin?.includes('\0')) throw new Error('fork.host.exec stdin cannot contain NUL');
  if (params.stdin && Buffer.byteLength(params.stdin, 'utf8') > STDIN_MAX) {
    throw new Error(t('The request is larger than fork.host.exec can send (8 MiB).', '这次请求超过 fork.host.exec 的 8 MiB 输入上限。'));
  }
  const timeoutMs = Math.min(110_000, Math.max(1_000, Math.floor(params.timeoutMs)));
  const maxOutputBytes = Math.min(OUTPUT_MAX, Math.max(1024, Math.floor(params.maxOutputBytes)));
  try {
    const result = await host.call('fork.host.exec', {
      hostId: params.hostId,
      workspaceId: params.workspaceId,
      argv: params.argv,
      ...(params.stdin !== undefined ? { stdin: params.stdin } : {}),
      timeoutMs,
      maxOutputBytes,
    }) as ForkExecResult;
    if (!result || typeof result !== 'object' || typeof result.stdout !== 'string' || typeof result.stderr !== 'string') {
      throw new Error('fork.host.exec returned no output');
    }
    return result;
  } catch (error) {
    rethrowFork(error);
  }
}
