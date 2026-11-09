import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { bashCommand, canonicalBeadsDir, explainRemoteFailure, handleRequest, remotePathExport, RemoteCommandError } from '../src/core/service.js';
import type { Project, Snapshot } from '../src/shared.js';

// The agreed seam is handleRequest. Only the external bd executable is faked;
// fixtures describe CLI output, not the service's internal helpers.
async function withBd(
  body: string,
  run: (project: Project, root: string) => Promise<void>,
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'beads-core-'));
  const previousPath = process.env.PATH;
  try {
    await mkdir(join(root, '.beads'));
    await writeFile(join(root, 'bd'), `#!${process.execPath}\n${body}\n`, { mode: 0o755 });
    process.env.PATH = `${root}${delimiter}${previousPath ?? ''}`;
    await run({ id: 'registered', name: 'Fixture', path: root }, root);
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
}

const rawIssue = {
  id: 'fixture-open', title: 'Unassigned task', status: 'open', priority: 2,
  issue_type: 'task', created_at: '2026-11-01T00:00:00Z', updated_at: '2026-11-02T00:00:00Z',
};

test('projects are host-owned and unregistered paths or commands cannot reach bd', async () => {
  await withBd('process.stderr.write("MUST NOT EXECUTE"); process.exit(99);', async (project) => {
    assert.deepEqual(await handleRequest({ method: 'projects' }, [project]), [project]);
    await assert.rejects(handleRequest({ method: 'snapshot', project: project.path }, [project]), /registered project/i);
    await assert.rejects(handleRequest({ method: 'snapshot' }, [project]), /registered project/i);
    await assert.rejects(handleRequest({ method: 'sql', project: project.id }, [project]), /unsupported method/i);
    await assert.rejects(handleRequest({ method: 'close', project: project.id, input: { id: '' } }, [project]), /id/i);
    await assert.rejects(handleRequest({ method: 'reclaim', project: project.id, input: { id: 'one,two' } }, [project]), /id/i);
    await assert.rejects(handleRequest({ method: 'update', project: project.id, input: { id: 'one', priority: 8 } }, [project]), /priority/i);
    await assert.rejects(handleRequest({ method: 'create', project: project.id, input: { title: 'task', args: ['--db=/elsewhere'] } }, [project]), /unsupported input/i);
    await assert.rejects(handleRequest({ method: 'update', project: project.id, input: { id: 'one' } }, [project]), /at least one/i);
  });
});
test('a remote project cannot fall through to the local bd executable', async () => {
  await withBd('process.stderr.write("LOCAL BD MUST NOT RUN"); process.exit(99);', async (project) => {
    const remote = { ...project, id: 'remote-twin', hostId: 'ssh:remote' };
    await assert.rejects(handleRequest({ method: 'snapshot', project: remote.id }, [remote]), /remote|ssh|transport/i);
  });
});


test('snapshot includes closed and nonstandard states, full edges, and uncapped native ready/blocked membership', async () => {
  const issues = Array.from({ length: 201 }, (_, index) => ({
    ...rawIssue, id: `fixture-${index}`, title: `Task ${index}`,
    status: index === 120 ? 'closed' : index === 121 ? 'deferred' : index === 122 ? 'hooked' : index === 123 ? 'pinned' : 'open',
    ...(index === 120 ? { closed_at: '2026-11-03T00:00:00Z' } : {}),
    // Intentionally incomplete embedded rows must not override raw dep records.
    dependencies: [{ depends_on_id: 'wrong-target', type: 'related' }],
  }));
  const script = `
    const args = process.argv.slice(2);
    const issues = ${JSON.stringify(issues)};
    const command = args.find(arg => !arg.startsWith('-'));
    let result;
    if (command === 'list') {
      result = args.includes('--all') ? issues : issues.filter(issue => issue.status !== 'closed');
      if (!args.includes('--limit=0')) result = result.slice(0, 50);
    } else if (command === 'dep') {
      const requested = args.slice(args.indexOf('--') + 1);
      // Native single-ID output hydrates local targets and drops external ones.
      // Raw batch output deduplicates repeated anchors (dep.go:readDepListEdges).
      const edges = [
        { issue_id: 'fixture-0', depends_on_id: 'fixture-120', type: 'blocks' },
        { issue_id: 'fixture-0', depends_on_id: 'fixture-121', type: 'related' },
        { issue_id: 'fixture-200', depends_on_id: 'external:remote:capability', type: 'blocks' },
      ];
      result = requested.length === 1 ? [] : edges.filter(edge => requested.includes(edge.issue_id));
    } else if (command === 'ready') {
      result = issues.slice(0, 119).map(issue => ({ id: issue.id }));
      if (!args.includes('--limit=0')) result = result.slice(0, 100);
    } else if (command === 'blocked') {
      result = [{ id: 'fixture-119' }];
    } else process.exit(90);
    process.stdout.write(JSON.stringify(result));
  `;
  await withBd(script, async (project) => {
    const snapshot = await handleRequest({ method: 'snapshot', project: project.id }, [project]) as Snapshot;
    assert.equal(snapshot.issues.length, 201);
    assert.equal(snapshot.readyIds.length, 119);
    assert.ok(snapshot.readyIds.includes('fixture-118'));
    assert.deepEqual(snapshot.blockedIds, ['fixture-119']);
    // Native ready can include a task with a closed blocker; don't recalculate.
    assert.ok(snapshot.readyIds.includes('fixture-0'));
    assert.deepEqual(snapshot.issues[0]?.dependencies, [
      { id: 'fixture-120', type: 'blocks' }, { id: 'fixture-121', type: 'related' },
    ]);
    assert.deepEqual(snapshot.issues[200]?.dependencies, [{ id: 'external:remote:capability', type: 'blocks' }]);
    assert.equal(snapshot.issues[120]?.closedAt, '2026-11-03T00:00:00Z');
    assert.equal(snapshot.issues[121]?.status, 'deferred');
    assert.equal(snapshot.issues[122]?.status, 'hooked');
    assert.equal(snapshot.issues[123]?.status, 'pinned');
    assert.equal(snapshot.issues[0]?.assignee, '');
    assert.deepEqual(snapshot.issues[0]?.labels, []);
    assert.ok(Number.isFinite(Date.parse(snapshot.fetchedAt)));
  });
});

test('issue details normalize schema fields and use authoritative directed edges over embedded show details', async () => {
  const issue = {
    ...rawIssue, notes: 'Working notes', acceptance_criteria: 'Reviewed', design: 'Design',
    estimated_minutes: 0, due_at: '2026-11-08T00:00:00Z', defer_until: '2026-11-07T00:00:00Z',
    heartbeat_at: '2026-11-06T00:00:00Z', labels: ['lane:core'],
    dependencies: [{ id: 'embedded-only', issue_type: 'task', dependency_type: 'related' }],
  };
  await withBd(`
    const args = process.argv.slice(2);
    const edges = [
      { issue_id: 'fixture-open', depends_on_id: 'fixture-closed', type: 'blocks' },
      { issue_id: 'fixture-open', depends_on_id: 'fixture-parent', type: 'parent-child' },
      { issue_id: 'fixture-open', depends_on_id: 'external:remote:capability', type: 'related' },
    ];
    const requested = args.slice(args.indexOf('--') + 1);
    const result = args.includes('show') || (args.includes('list') && !args.includes('dep'))
      ? [${JSON.stringify(issue)}]
      : requested.length === 1
        ? [{ id: 'fixture-closed', dependency_type: 'blocks' }, { id: 'fixture-parent', dependency_type: 'parent-child' }]
        : edges.filter(edge => requested.includes(edge.issue_id));
    process.stdout.write(JSON.stringify(result));
  `, async (project) => {
    assert.deepEqual(await handleRequest({ method: 'issue', project: project.id, input: { id: 'fixture-open' } }, [project]), {
      id: 'fixture-open', title: 'Unassigned task', description: '', status: 'open', priority: 2,
      type: 'task', assignee: '', labels: ['lane:core'],
      dependencies: [
        { id: 'fixture-closed', type: 'blocks' }, { id: 'fixture-parent', type: 'parent-child' },
        { id: 'external:remote:capability', type: 'related' },
      ],
      createdAt: '2026-11-01T00:00:00Z', updatedAt: '2026-11-02T00:00:00Z',
      notes: 'Working notes', acceptance: 'Reviewed', design: 'Design', estimatedMinutes: 0,
      dueAt: '2026-11-08T00:00:00Z', deferUntil: '2026-11-07T00:00:00Z', heartbeatAt: '2026-11-06T00:00:00Z',
    });
  });
});

test('directory label defaults do not hide snapshot rows, readiness, or exact registered IDs', async () => {
  const issues = [rawIssue, { ...rawIssue, id: 'fixture-labeled', labels: ['lane:visible'] }];
  await withBd(`
    const args = process.argv.slice(2);
    const issues = ${JSON.stringify(issues)};
    const defaults = JSON.parse(process.env.BD_DIRECTORY_LABELS ?? '{"fixture":"lane:visible"}');
    const visible = Object.keys(defaults).length === 0
      ? issues : issues.filter(issue => issue.labels?.includes('lane:visible'));
    let result;
    if (args.includes('dep') || args.includes('blocked')) result = [];
    else if (args.includes('list')) {
      const id = args.find(arg => arg.startsWith('--id='))?.slice(5);
      result = id ? visible.filter(issue => issue.id === id) : visible;
      if (args.includes('--skip-labels')) result = result.map(issue => ({ ...issue, labels: [] }));
    } else if (args.includes('ready')) result = visible;
    else if (args.includes('show')) result = [issues[0]];
    else if (args.includes('update')) result = { updated: true };
    else process.exit(90);
    process.stdout.write(JSON.stringify(result));
  `, async (project) => {
    const snapshot = await handleRequest({ method: 'snapshot', project: project.id }, [project]) as Snapshot;
    assert.deepEqual(snapshot.issues.map(issue => issue.id), ['fixture-open', 'fixture-labeled']);
    assert.deepEqual(snapshot.issues[1]?.labels, ['lane:visible']);
    assert.deepEqual(snapshot.readyIds, ['fixture-open', 'fixture-labeled']);
    const detail = await handleRequest({ method: 'issue', project: project.id, input: { id: 'fixture-open' } }, [project]);
    assert.ok(detail && typeof detail === 'object' && 'id' in detail);
    assert.equal(detail.id, 'fixture-open');
    assert.deepEqual(await handleRequest({
      method: 'update', project: project.id, input: { id: 'fixture-open', title: 'Still visible' },
    }, [project]), { updated: true });
  });
});

test('empty native query results remain an empty snapshot, not fabricated tasks', async () => {
  await withBd('process.stdout.write(\"null\");', async (project) => {
    const result = await handleRequest({ method: 'snapshot', project: project.id }, [project]) as Snapshot;
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.readyIds, []);
    assert.deepEqual(result.blockedIds, []);
  });
});

test('native failures are visible and never replaced by successful empty snapshots', async () => {
  await withBd('process.stderr.write(\"schema version mismatch: upgrade bd\"); process.exit(2);', async (project) => {
    await assert.rejects(handleRequest({ method: 'snapshot', project: project.id }, [project]), (error: unknown) => {
      assert.ok(error instanceof Error && error.cause instanceof Error && 'code' in error.cause);
      assert.equal(error.cause.code, 2);
      return true;
    });
  });
  await withBd('process.stdout.write(\"not JSON\");', async (project) => {
    await assert.rejects(handleRequest({ method: 'snapshot', project: project.id }, [project]), (error: unknown) => {
      assert.ok(error instanceof Error && error.cause instanceof SyntaxError);
      return true;
    });
  });
});

test('oversized output fails explicitly rather than returning a truncated snapshot', async () => {
  await withBd('process.stdout.write(\"x\".repeat(17 * 1024 * 1024));', async (project) => {
    await assert.rejects(handleRequest({ method: 'snapshot', project: project.id }, [project]), (error: unknown) => {
      assert.ok(error instanceof Error && error.cause instanceof Error && 'code' in error.cause);
      assert.equal(error.cause.code, 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER');
      return true;
    });
  });
});

test('uninitialized registered directories cannot fall back to an ancestor database', async () => {
  await withBd('require("node:fs").writeFileSync("executed", "yes"); process.stdout.write("[]");', async (project, root) => {
    const child = join(root, 'uninitialized');
    await mkdir(child);
    await assert.rejects(handleRequest({ method: 'snapshot', project: project.id }, [{ ...project, path: child }]));
    await assert.rejects(access(join(child, 'executed')), { code: 'ENOENT' });
  });
});

test('ambient store selectors cannot replace the selected project but actor and credentials survive', async () => {
  const overrides: Record<string, string> = {
    BEADS_DIR: '/foreign/.beads', BEADS_DB: '/foreign/db', BD_DB: '/foreign/db',
    BEADS_DOLT_SERVER_DATABASE: 'foreign', BEADS_DOLT_SERVER_HOST: 'foreign.example',
    BEADS_DOLT_SHARED_SERVER: '1', BEADS_PROXIED_SERVER_ROOT_PATH: '/foreign/dolt',
    BD_ROUTING_DEFAULT: '/foreign', BEADS_ACTOR: 'fixture-actor', BEADS_DOLT_PASSWORD: 'fixture-secret',
  };
  const previous = Object.fromEntries(Object.keys(overrides).map((key) => [key, process.env[key]]));
  Object.assign(process.env, overrides);
  try {
    await withBd(`
      const fs = require('node:fs');
      const path = require('node:path');
      if (process.env.BEADS_DB || process.env.BD_DB || process.env.BEADS_DOLT_SERVER_DATABASE ||
          process.env.BEADS_DOLT_SERVER_HOST || process.env.BEADS_DOLT_SHARED_SERVER ||
          process.env.BEADS_PROXIED_SERVER_ROOT_PATH || process.env.BD_ROUTING_DEFAULT !== '.') {
        process.stderr.write('foreign database selected'); process.exit(91);
      }
      if (process.env.BEADS_ACTOR !== 'fixture-actor' || process.env.BEADS_DOLT_PASSWORD !== 'fixture-secret') {
        process.stderr.write('actor or credential lost'); process.exit(92);
      }
      const issue = JSON.parse(fs.readFileSync(path.join(process.env.BEADS_DIR, 'fixture.json'), 'utf8'));
      process.stdout.write(JSON.stringify(process.argv.includes('list') && !process.argv.includes('dep') ? [issue] : []));
    `, async (project, root) => {
      await writeFile(join(root, '.beads', 'fixture.json'), JSON.stringify(rawIssue));
      const snapshot = await handleRequest({ method: 'snapshot', project: project.id }, [project]) as Snapshot;
      assert.deepEqual(snapshot.issues.map((issue) => issue.id), ['fixture-open']);
    });
  } finally {
    for (const key of Object.keys(overrides)) {
      const value = previous[key];
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('registered-ID precheck rejects IDs absent from the local list before invoking native operations', async () => {
  await withBd(`
    if (process.argv.includes('list')) process.stdout.write('[]');
    else { process.stderr.write('FOREIGN STORE TOUCHED'); process.exit(99); }
  `, async (project) => {
    for (const method of ['issue', 'update', 'claim', 'close', 'reopen', 'reclaim', 'comment', 'comments']) {
      const input = method === 'update' ? { id: 'foreign-1', title: 'changed' }
        : method === 'comment' ? { id: 'foreign-1', text: 'comment' } : { id: 'foreign-1' };
      await assert.rejects(handleRequest({ method, project: project.id, input }, [project]), /not found in registered project/);
    }
  });
});

test('concurrent requests do not overlap embedded bd processes for one workspace', async () => {
  // This process-boundary integration test deliberately holds a native file
  // lock briefly: parent-process fake timers cannot drive separate CLI clocks.
  await withBd(`
    const fs = require('node:fs');
    try { fs.writeFileSync('.exclusive-bd', '', { flag: 'wx' }); }
    catch { process.stderr.write('embedded database already open'); process.exit(93); }
    setTimeout(() => { fs.unlinkSync('.exclusive-bd'); process.stdout.write('[]'); }, 15);
  `, async (project) => {
    const results = await Promise.all(Array.from({ length: 4 }, () =>
      handleRequest({ method: 'snapshot', project: project.id }, [project]) as Promise<Snapshot>));
    assert.ok(results.every((result) => result.issues.length === 0));
  });
});

test('remote commands start bash without rc files and keep a plain PATH', () => {
  const command = bashCommand('bd --version', '~/bin:/opt/bd');
  assert.match(command, /env -u BASH_ENV -u ENV bash --noprofile --norc -c /);
  assert.match(command, /\$HOME\/bin:\/opt\/bd:\$PATH/);
  assert.equal(remotePathExport(), `"${'$HOME/.local/bin:$HOME/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin'}:$PATH"`);
  assert.throws(() => remotePathExport('$(touch /tmp/pwn)'), /command substitution/);
  const missing = explainRemoteFailure({ code: 127, stderr: 'bash: command not found', message: 'fail' } as never, 'exec');
  assert.ok(missing instanceof RemoteCommandError && missing.code === 'ssh-bash-missing');
  const auth = explainRemoteFailure({ code: 255, stderr: 'Permission denied (publickey).', message: 'fail' } as never, 'exec');
  assert.match(auth.message, /authentication failed/i);
});

test('a symlinked .beads directory outside the workspace is refused before bd runs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'beads-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'beads-outside-'));
  try {
    const project = join(root, 'project');
    await mkdir(project);
    await mkdir(join(outside, '.beads'));
    await symlink(join(outside, '.beads'), join(project, '.beads'));
    await assert.rejects(canonicalBeadsDir(project), (error: unknown) => error instanceof RemoteCommandError && error.code === 'beads-outside');
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
