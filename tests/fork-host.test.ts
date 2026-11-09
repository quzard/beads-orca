import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { ProjectAccess, type ProductHost } from '../src/orca/projects.js';
import type { Snapshot } from '../src/shared.js';

const hosts = [
  { hostId: 'local', kind: 'local', label: 'This computer', aliasHostIds: [], state: 'connected', platform: 'linux', exec: true },
  { hostId: 'runtime:mini', kind: 'runtime', label: 'mini', envId: 'mini', configHost: 'mini', aliasHostIds: ['ssh:abc'], state: 'connected', platform: 'linux', exec: true },
  { hostId: 'ssh:abc', kind: 'ssh', label: 'mini', configHost: 'mini', aliasHostIds: ['runtime:mini'], state: 'connected', platform: 'linux', exec: false },
  { hostId: 'runtime:old', kind: 'runtime', label: 'oldbox', envId: 'old', configHost: 'oldbox', aliasHostIds: ['ssh:old'], state: 'connected', platform: 'linux', exec: false },
];

test('paired runtime workspaces use fork.host.exec, and ssh remains the override', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beads-fork-'));
  const previousPath = process.env.PATH;
  try {
    const bin = join(root, 'bin');
    const local = join(root, 'local');
    const remote = join(root, 'remote');
    const old = join(root, 'old');
    const sshArgs = join(root, 'ssh-args.json');
    const execs: unknown[] = [];
    await mkdir(bin);
    await mkdir(join(local, '.beads'), { recursive: true });
    await mkdir(join(remote, '.beads'), { recursive: true });
    await mkdir(join(old, '.beads'), { recursive: true });
    await writeFile(join(bin, 'bd'), `#!${process.execPath}\nprocess.stdout.write('[]');\n`, { mode: 0o755 });
    await writeFile(join(bin, 'ssh'), `#!${process.execPath}\nconst fs=require('node:fs'); const cp=require('node:child_process');\nfs.writeFileSync(${JSON.stringify(sshArgs)}, JSON.stringify(process.argv.slice(2)));\nconst result=cp.spawnSync('/bin/sh',['-c',process.argv.at(-1)],{stdio:'inherit',env:process.env}); process.exit(result.status ?? 1);\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
    const workspaces = [
      { hostId: 'local', id: 'local-ws', kind: 'folder', name: 'Local', path: local, branch: null },
      { hostId: 'runtime:mini', envId: 'mini', id: 'remote-ws', kind: 'worktree', name: 'Dev', path: remote, branch: 'main' },
      { hostId: 'runtime:old', envId: 'old', id: 'old-ws', kind: 'worktree', name: 'Old', path: old, branch: 'main' },
    ];
    let failFork = false;
    const host: ProductHost = {
      host: {
        async has(method) { return method.startsWith('fork.'); },
        async call(method, params) {
          if (method === 'fork.hosts.list') return { hosts };
          if (method === 'fork.workspaces.list') return { workspaces, truncated: false, unreachable: ['runtime:down'] };
          if (method === 'workspace.readContext') return null;
          if (method === 'storage.get') return { value: null };
          if (method === 'storage.set' || method === 'storage.delete') return { ok: true };
          if (method === 'storage.keys') return { keys: [] };
          if (method === 'fork.host.exec') {
            if (failFork) {
              failFork = false;
              throw Object.assign(new Error('update the server'), { code: 'unavailable', reason: 'server-method-missing' });
            }
            execs.push(params);
            const argv = params?.argv as string[];
            const result = spawnSync(argv[0], argv.slice(1), { input: String(params?.stdin ?? ''), encoding: 'utf8', env: process.env });
            return { exitCode: result.status, signal: null, stdout: result.stdout, stderr: result.stderr, truncated: false, timedOut: false };
          }
          throw new Error(`Unexpected host method: ${method}`);
        },
      },
      settings: { async get() { return ''; } },
    };
    const access = new ProjectAccess(host);
    const projects = await access.list();
    assert.equal(projects.find((project) => project.name === 'Dev')?.id, 'runtime:mini::remote-ws');
    assert.equal(projects.find((project) => project.name === 'Dev')?.hostName, 'mini');
    assert.equal(projects.some((project) => project.hostId === 'ssh:abc'), false);
    const diagnostics = await access.request({ method: 'diagnostics' }) as { pathErrors: string[] };
    assert.match(diagnostics.pathErrors.join('\n'), /runtime:down/);
    await rm(sshArgs, { force: true });
    const snapshot = await access.request({ method: 'snapshot', project: 'runtime:mini::remote-ws' }) as Snapshot;
    assert.equal(snapshot.offline, false);
    const exec = execs.find((item) => (item as { stdin?: string }).stdin?.includes('bd ')) as { argv: string[]; stdin: string; hostId: string; workspaceId: string };
    assert.deepEqual(exec.argv, ['bash', '--noprofile', '--norc', '-s']);
    assert.equal(exec.hostId, 'runtime:mini');
    assert.equal(exec.workspaceId, 'remote-ws');
    assert.match(exec.stdin, /export PATH/);
    assert.equal(execs.every((item) => JSON.stringify((item as { argv: string[] }).argv) === JSON.stringify(['bash', '--noprofile', '--norc', '-s'])), true);
    assert.match(execs.map((item) => (item as { stdin: string }).stdin).join('\n'), /bd /);
    await assert.rejects(readFile(sshArgs, 'utf8'));

    execs.length = 0;
    const overridden = new ProjectAccess({
      ...host,
      settings: { async get(key) { return key === 'remoteHosts' ? JSON.stringify({ 'runtime:mini': { destination: 'override', name: 'Override' } }) : ''; } },
    });
    const mapped = await overridden.list();
    assert.equal(mapped.find((project) => project.name === 'Dev')?.hostName, 'Override');
    await overridden.request({ method: 'snapshot', project: 'runtime:mini::remote-ws' });
    const overrideArgs = JSON.parse(await readFile(sshArgs, 'utf8')) as string[];
    assert.equal(overrideArgs.includes('override'), true);
    assert.equal(execs.length, 0);

    await access.request({ method: 'snapshot', project: 'runtime:old::old-ws' });
    const oldArgs = JSON.parse(await readFile(sshArgs, 'utf8')) as string[];
    assert.equal(oldArgs.includes('oldbox'), true);

    failFork = true;
    const again = new ProjectAccess(host);
    await again.request({ method: 'snapshot', project: 'runtime:mini::remote-ws' });
    const fallback = JSON.parse(await readFile(sshArgs, 'utf8')) as string[];
    assert.equal(fallback.includes('mini'), true);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
