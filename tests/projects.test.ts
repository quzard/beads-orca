import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { access as fileAccess, mkdtemp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { ProjectAccess, type ProductHost } from '../src/orca/projects.js';
import type { Snapshot } from '../src/shared.js';

type Workspace = { id: string; name: string; path: string; hostId: string | null; branch?: string | null };

function fixtureHost(workspaces: Workspace[], settings: Record<string, string> = {}, storage = new Map<string, unknown>()): ProductHost {
  return {
    host: { async call(method, params) {
      if (method === 'workspace.list') return { workspaces, truncated: false };
      if (method === 'workspace.readContext') return null;
      if (method === 'storage.get') return { value: storage.get(String(params?.key)) ?? null };
      if (method === 'storage.set') { storage.set(String(params?.key), params?.value); return { ok: true }; }
      if (method === 'storage.delete') { storage.delete(String(params?.key)); return { ok: true }; }
      if (method === 'storage.keys') return { keys: [...storage.keys()] };
      throw new Error(`Unexpected host method: ${method}`);
    } },
    settings: { async get(key) { return settings[key] ?? ''; } },
  };
}

test('project discovery keeps remote and unsupported host identities distinct from a local twin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beads-projects-'));
  try {
    const workspaces: Workspace[] = [
      { id: 'local', name: 'Local', path: root, hostId: null },
      { id: 'ssh', name: 'Remote twin', path: root, hostId: 'ssh:example' },
      { id: 'paired', name: 'Paired', path: root, hostId: 'runtime:example' },
    ];
    const access = new ProjectAccess(fixtureHost(workspaces, {
      projectPaths: root,
      remoteHosts: JSON.stringify({ 'ssh:example': { destination: 'example', name: 'Build host' } }),
    }));
    const projects = await access.list();
    assert.deepEqual(projects.map((project) => project.id), ['local', 'ssh', 'paired']);
    assert.equal(projects[0]?.workspaceId, 'local');
    assert.equal(projects[1]?.hostId, 'ssh:example');
    assert.equal(projects[1]?.hostName, 'Build host');
    assert.equal(projects[2]?.hostName, undefined);
    assert.equal(projects[1]?.availability, 'unknown');
    assert.equal(projects[2]?.availability, 'unsupported');
    assert.match(projects[2]?.availabilityReason ?? '', /unsupported|mapping/i);
    await assert.rejects(access.request({ method: 'snapshot', project: 'paired' }), /unsupported|mapping/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('focused workspace is identified only when the available host context is unambiguous', async () => {
  const workspaces: Workspace[] = [
    { id: 'one', name: 'Same name', branch: 'main', path: '/first', hostId: null },
    { id: 'two', name: 'Same name', branch: 'main', path: '/second', hostId: 'runtime:other' },
  ];
  const base = fixtureHost(workspaces);
  const service = new ProjectAccess({
    settings: base.settings,
    host: { async call(method, params) {
      if (method === 'workspace.readContext') return { displayName: 'Same name', branch: 'main', terminals: [] };
      return base.host.call(method, params);
    } },
  });
  assert.deepEqual((await service.list()).map((project) => project.current), [undefined, undefined]);
  workspaces.pop();
  assert.equal((await service.list())[0]?.current, true);
});

test('confined text access refuses traversal and symlinks, creates parents, and removes only the named file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beads-files-'));
  const outside = await mkdtemp(join(tmpdir(), 'beads-outside-'));
  try {
    await writeFile(join(outside, 'secret.md'), 'outside');
    await symlink(outside, join(root, 'escape'));
    await symlink(join(outside, 'secret.md'), join(root, 'linked.md'));
    const service = new ProjectAccess(fixtureHost([{ id: 'files', name: 'Files', path: root, hostId: null }]));
    await service.writeText('files', '.beads-orca/handoffs/example/context.md', 'Hello, мир\n');
    const result = await service.readText('files', '.beads-orca/handoffs/example/context.md');
    assert.equal(result.path, '.beads-orca/handoffs/example/context.md');
    assert.equal(result.text, 'Hello, мир\n');
    assert.match(result.hash, /^[a-f0-9]{64}$/u);
    const changedIdentity = { ...await service.captureIdentity('files'), path: outside };
    await assert.rejects(service.inspectFile('files', result.path, changedIdentity), /identity|changed/i);
    await assert.rejects(service.readText('files', result.path, changedIdentity), /identity|changed/i);
    await assert.rejects(service.writeText('files', result.path, 'wrong workspace', changedIdentity), /identity|changed/i);
    await assert.rejects(service.removeFile('files', result.path, changedIdentity), /identity|changed/i);
    assert.equal((await service.readText('files', result.path)).text, 'Hello, мир\n');
    await assert.rejects(service.readText('files', '../secret.md'), /relative|travers|inside/i);
    await assert.rejects(service.readText('files', 'escape/secret.md'), /symbolic|symlink|not a directory|loop/i);
    await assert.rejects(service.writeText('files', 'linked.md', 'changed'), /symbolic|symlink|loop/i);
    await assert.rejects(service.inspectFile('files', 'linked.md'), /symbolic|symlink|loop/i);
    await writeFile(join(root, 'large.md'), Buffer.alloc(2 * 1024 * 1024 + 1, 65));
    assert.deepEqual(await service.inspectFile('files', './large.md'), { path: 'large.md' });
    await assert.rejects(service.readText('files', 'large.md'), /2 MiB/i);
    await assert.rejects(service.writeText('files', 'large.md', 'x'.repeat(2 * 1024 * 1024 + 1)), /2 MiB/i);
    await assert.rejects(service.writeText('files', 'invalid.md', '\ud800'), /UTF-8/i);
    await assert.rejects(service.readText('files', 'missing.md'), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ENOENT');
    await assert.rejects(service.inspectFile('files', 'missing.md'), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ENOENT');
    await service.removeFile('files', result.path);
    await assert.rejects(service.readText('files', result.path), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ENOENT');
    assert.equal(await readFile(join(outside, 'secret.md'), 'utf8'), 'outside');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('remote snapshots survive worker restart and a disconnected SSH host disables writes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beads-offline-'));
  const previousPath = process.env.PATH;
  const storage = new Map<string, unknown>();
  try {
    const bin = join(root, 'bin');
    const projectPath = join(root, "remote 'quoted'");
    await mkdir(bin);
    await mkdir(projectPath);
    await mkdir(join(projectPath, '.beads'));
    const offline = join(root, 'offline');
    const sshArgs = join(root, 'ssh-args.json');
    const configFile = join(root, 'config with spaces');
    // macOS defaults to zsh, whose `status` parameter is read-only.
    const loginShell = existsSync('/bin/zsh') ? '/bin/zsh' : '/bin/sh';
    await writeFile(join(bin, 'ssh'), `#!${process.execPath}\nconst fs = require('node:fs'); const cp = require('node:child_process');\nfs.writeFileSync(${JSON.stringify(sshArgs)}, JSON.stringify(process.argv.slice(2)));\nif (fs.existsSync(${JSON.stringify(offline)})) process.exit(255);\nconst result = cp.spawnSync(${JSON.stringify(loginShell)}, ['-c', process.argv.at(-1)], {stdio:'inherit', env:process.env}); process.exit(result.status ?? 1);\n`, { mode: 0o755 });
    await writeFile(join(bin, 'bd'), `#!${process.execPath}\nprocess.stdout.write('[]');\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
    const baseHost = fixtureHost(
      [{ id: 'remote', name: 'Remote', path: projectPath, hostId: 'ssh:fixture' }],
      { remoteHosts: JSON.stringify({ 'ssh:fixture': { destination: 'fixture', configFile } }) }, storage,
    );
    let rejectStorageWrites = false;
    const host: ProductHost = {
      settings: baseHost.settings,
      host: { async call(method, params) {
        if (method === 'storage.set' && rejectStorageWrites) throw new Error('plugin storage quota');
        return baseHost.host.call(method, params);
      } },
    };
    const live = new ProjectAccess(host);
    const first = await live.request({ method: 'snapshot', project: 'remote' }) as Snapshot;
    assert.deepEqual(first, JSON.parse(JSON.stringify(first)), 'Native plugin RPC rejects non-JSON snapshot values');
    assert.equal(first.offline, false);
    assert.equal(first.project.availability, 'online');
    const args = JSON.parse(await readFile(sshArgs, 'utf8')) as string[];
    assert.equal(args[args.indexOf('-F') + 1], configFile);
    assert.equal(await live.executableAvailable('remote', 'bd'), true);
    await assert.rejects(live.executableAvailable('remote', 'bd;touch marker'), /basename/i);
    await live.writeText('remote', 'notes/context.md', 'remote text');
    assert.equal((await live.readText('remote', 'notes/context.md')).text, 'remote text');
    const largeContext = `private-context-marker-${'x'.repeat(150 * 1024)}`;
    await live.writeText('remote', 'notes/large.md', largeContext);
    const fileArgs = JSON.parse(await readFile(sshArgs, 'utf8')) as string[];
    assert.ok(!fileArgs.some((arg) => arg.includes('private-context-marker-')));
    assert.equal((await live.readText('remote', 'notes/large.md')).text, largeContext);
    await assert.rejects(live.readText('remote', 'missing.md'), (error: unknown) =>
      error instanceof Error && 'code' in error && error.code === 'ENOENT');
    await writeFile(join(bin, 'bd'), `#!${process.execPath}\nconst a=process.argv.slice(2); process.stdout.write(JSON.stringify(a.includes('--all') ? [{id:'fresh-1',title:'Fresh',status:'open',priority:2,issue_type:'task',created_at:'2026-01-01',updated_at:'2026-01-01'}] : []));\n`, { mode: 0o755 });
    rejectStorageWrites = true;
    const fresh = await live.request({ method: 'snapshot', project: 'remote' }) as Snapshot;
    assert.equal(fresh.issues.length, 1);
    assert.equal(fresh.project.availability, 'online');
    assert.match(fresh.project.cacheError ?? '', /quota/i);
    await writeFile(offline, 'offline');
    const restored = new ProjectAccess(host);
    const last = await restored.request({ method: 'snapshot', project: 'remote' }) as Snapshot;
    assert.equal(last.offline, true);
    assert.equal(last.fetchedAt, first.fetchedAt);
    assert.deepEqual(last.issues, first.issues);
    assert.equal(last.project.availability, 'offline');
    await assert.rejects(restored.request({ method: 'create', project: 'remote', input: { title: 'Must not write' } }), /offline/i);
    await assert.rejects(restored.writeText('remote', 'must-not-exist.md', 'no'), /offline/i);
    await assert.rejects(fileAccess(join(projectPath, 'must-not-exist.md')));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('a disappeared local workspace uses its last persisted snapshot and rejects edits', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beads-local-offline-'));
  const previousPath = process.env.PATH;
  try {
    const workspace = join(root, 'workspace');
    const bin = join(root, 'bin');
    await mkdir(workspace);
    await mkdir(join(workspace, '.beads'));
    await mkdir(bin);
    await writeFile(join(bin, 'bd'), `#!${process.execPath}\nprocess.stdout.write('[]');\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
    const service = new ProjectAccess(fixtureHost([{ id: 'local', name: 'Local', path: workspace, hostId: null }]));
    const first = await service.request({ method: 'snapshot', project: 'local' }) as Snapshot;
    await rename(workspace, join(root, 'temporarily-unavailable'));
    const offline = await service.request({ method: 'snapshot', project: 'local' }) as Snapshot;
    assert.equal(offline.offline, true);
    assert.equal(offline.fetchedAt, first.fetchedAt);
    await assert.rejects(service.request({ method: 'create', project: 'local', input: { title: 'No write' } }), /offline/i);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('a pinned workspace identity rejects a changed SSH mapping before file access', async () => {
  const settings = { remoteHosts: JSON.stringify({ 'ssh:server': { destination: 'first' } }) };
  const service = new ProjectAccess(fixtureHost(
    [{ id: 'remote', name: 'Remote', path: '/remote/project', hostId: 'ssh:server' }], settings,
  ));
  const expected = await service.captureIdentity('remote');
  settings.remoteHosts = JSON.stringify({ 'ssh:server': { destination: 'second' } });
  await assert.rejects(service.readText('remote', 'notes.md', expected), /identity|changed/i);
  await assert.rejects(service.writeText('remote', 'notes.md', 'wrong host', expected), /identity|changed/i);
  await assert.rejects(service.removeFile('remote', 'notes.md', expected), /identity|changed/i);
  await assert.rejects(service.request({ method: 'create', project: 'remote', input: { title: 'Wrong host' } }, expected), /identity|changed/i);
});

test('oversized SSH output is an error, not an offline snapshot or a truncated success', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beads-remote-limit-'));
  const previousPath = process.env.PATH;
  try {
    await writeFile(join(root, 'ssh'), `#!${process.execPath}\nconst cmd=process.argv.at(-1); if(!cmd.includes("'--json'")) process.stdout.write('/remote/.beads\\n'); else process.stdout.write('x'.repeat(16 * 1024 * 1024 + 1));\n`, { mode: 0o755 });
    process.env.PATH = `${root}${delimiter}${previousPath ?? ''}`;
    const service = new ProjectAccess(fixtureHost(
      [{ id: 'remote', name: 'Remote', path: '/remote', hostId: 'ssh:server' }],
      { remoteHosts: JSON.stringify({ 'ssh:server': { destination: 'fixture' } }) },
    ));
    await assert.rejects(service.request({ method: 'snapshot', project: 'remote' }), /output exceeded.*limit/i);
    assert.equal((await service.list())[0]?.availability, 'unknown');
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test('remote native writes pin the remote store and treat issue text as data, not shell syntax', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beads-remote-command-'));
  const previousPath = process.env.PATH;
  const previousDb = process.env.BD_DB;
  const previousActor = process.env.BEADS_ACTOR;
  try {
    const bin = join(root, 'bin');
    const workspace = join(root, "remote 'workspace'");
    const observed = join(root, 'observed.json');
    const marker = join(root, 'must-not-exist');
    await mkdir(bin);
    await mkdir(workspace);
    await mkdir(join(workspace, '.beads'));
    await writeFile(join(bin, 'ssh'), `#!${process.execPath}\nconst cp=require('node:child_process'); const result=cp.spawnSync('/bin/sh',['-c',process.argv.at(-1)],{stdio:'inherit',env:process.env}); process.exit(result.status ?? 1);\n`, { mode: 0o755 });
    await writeFile(join(bin, 'bd'), `#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(observed)},JSON.stringify({args:process.argv.slice(2),env:{BEADS_DIR:process.env.BEADS_DIR,BD_DB:process.env.BD_DB,BD_ROUTING_MODE:process.env.BD_ROUTING_MODE,BEADS_ACTOR:process.env.BEADS_ACTOR}})); process.stdout.write('{\"ok\":true}');\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
    process.env.BD_DB = '/wrong/store';
    process.env.BEADS_ACTOR = 'fixture-actor';
    const service = new ProjectAccess(fixtureHost(
      [{ id: 'remote', name: 'Remote', path: workspace, hostId: 'ssh:server' }],
      { remoteHosts: JSON.stringify({ 'ssh:server': { destination: 'fixture' } }) },
    ));
    const title = `title'; touch ${marker}; echo '`;
    await service.request({ method: 'create', project: 'remote', input: { title } });
    const actual = JSON.parse(await readFile(observed, 'utf8')) as { args: string[]; env: Record<string, string> };
    assert.ok(actual.args.includes(`--title=${title}`));
    assert.ok(actual.args.includes('--repo=.'));
    assert.equal(actual.env.BD_DB, undefined);
    assert.equal(actual.env.BEADS_DIR, join(workspace, '.beads'));
    assert.equal(actual.env.BD_ROUTING_MODE, 'explicit');
    assert.equal(actual.env.BEADS_ACTOR, 'fixture-actor');
    await assert.rejects(fileAccess(marker));
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousDb === undefined) delete process.env.BD_DB; else process.env.BD_DB = previousDb;
    if (previousActor === undefined) delete process.env.BEADS_ACTOR; else process.env.BEADS_ACTOR = previousActor;
    await rm(root, { recursive: true, force: true });
  }
});

test('one bad additional path does not hide the other projects', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beads-paths-'));
  try {
    const service = new ProjectAccess(fixtureHost(
      [{ id: 'local', name: 'Local', path: root, hostId: null }],
      { projectPaths: `${join(root, 'missing')}\n${root}` },
    ));
    const projects = await service.list();
    assert.equal(projects.some((project) => project.id === 'local'), true);
    const diagnostics = await service.request({ method: 'diagnostics' }) as { pathErrors: string[] };
    assert.equal(diagnostics.pathErrors.length, 1);
    assert.match(diagnostics.pathErrors[0] ?? '', /missing/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('remote .beads symlinks and login-shell hijacks do not leave the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beads-remote-link-'));
  const previousPath = process.env.PATH;
  const previousEnv = process.env.BASH_ENV;
  try {
    const bin = join(root, 'bin');
    const workspace = join(root, 'workspace');
    const outside = join(root, 'outside');
    const hijack = join(root, 'hijack.sh');
    await mkdir(bin);
    await mkdir(workspace);
    await mkdir(join(outside, '.beads'), { recursive: true });
    await symlink(join(outside, '.beads'), join(workspace, '.beads'));
    await writeFile(hijack, 'bd() { echo HIJACKED; }\n');
    await writeFile(join(bin, 'ssh'), `#!${process.execPath}\nconst cp=require('node:child_process'); const result=cp.spawnSync('/bin/sh',['-c',process.argv.at(-1)],{stdio:'inherit',env:process.env}); process.exit(result.status ?? 1);\n`, { mode: 0o755 });
    await writeFile(join(bin, 'bd'), `#!${process.execPath}\nprocess.stdout.write('HIJACKED');\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
    process.env.BASH_ENV = hijack;
    const service = new ProjectAccess(fixtureHost(
      [{ id: 'remote', name: 'Remote', path: workspace, hostId: 'ssh:server' }],
      { remoteHosts: JSON.stringify({ 'ssh:server': { destination: 'fixture' } }) },
    ));
    await assert.rejects(service.request({ method: 'snapshot', project: 'remote' }), /outside the workspace/i);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (previousEnv === undefined) delete process.env.BASH_ENV; else process.env.BASH_ENV = previousEnv;
    await rm(root, { recursive: true, force: true });
  }
});

test('SSH connection test reports bd, python3, and the physical workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beads-ssh-test-'));
  const previousPath = process.env.PATH;
  try {
    const bin = join(root, 'bin');
    const workspace = join(root, 'workspace');
    await mkdir(bin);
    await mkdir(join(workspace, '.beads'), { recursive: true });
    await writeFile(join(bin, 'ssh'), `#!${process.execPath}\nconst cp=require('node:child_process'); const result=cp.spawnSync('/bin/sh',['-c',process.argv.at(-1)],{stdio:'inherit',env:process.env}); process.exit(result.status ?? 1);\n`, { mode: 0o755 });
    await writeFile(join(bin, 'bd'), `#!${process.execPath}\nif (process.argv.includes('--version')) process.stdout.write('bd version 1.3.2\\n'); else process.stdout.write('');\n`, { mode: 0o755 });
    process.env.PATH = `${bin}${delimiter}${previousPath ?? ''}`;
    const service = new ProjectAccess(fixtureHost(
      [{ id: 'remote', name: 'Remote', path: workspace, hostId: 'ssh:server' }],
      { remoteHosts: JSON.stringify({ 'ssh:server': { destination: 'fixture', name: 'Dev' } }) },
    ));
    const report = await service.request({ method: 'ssh.test', project: 'remote' }) as { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] };
    assert.equal(report.ok, true);
    assert.equal(report.checks.find((check) => check.name === 'bd')?.ok, true);
    assert.match(report.checks.find((check) => check.name === 'bd version')?.detail ?? '', /1\.3\.2/);
    assert.equal(report.checks.find((check) => check.name === 'python3')?.ok, true);
    assert.match(report.checks.find((check) => check.name === '.beads')?.detail ?? '', /ok /);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});
