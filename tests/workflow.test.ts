import assert from 'node:assert/strict';
import test from 'node:test';
import { WorkflowService } from '../src/orca/workflow.js';
import type { HandoffGroup, HandoffPreview, HistoryEntry, WorktreePreview, WorkflowResults } from '../src/orca/workflow-types.js';
import type { Issue, Project, Snapshot } from '../src/shared.js';

const project: Project = { id: 'source', name: 'Demo', path: '/demo', workspaceId: 'repo::/demo', hostId: 'local', availability: 'online' };
const issue: Issue = { id: 'A', title: 'Implement feature', description: 'Description', acceptance: 'Acceptance', status: 'open', priority: 2, type: 'task', assignee: '', labels: [], dependencies: [], updatedAt: '2026-01-01', createdAt: '2026-01-01' };
function fixture(hostId = 'local') {
  const storage = new Map<string, unknown>();
  const files = new Map<string, string>();
  const effects: string[] = [];
  const commands: string[][] = [];
  let issues = [structuredClone(issue)];
  let receipt: unknown = { outcome: { kind: 'terminal', handle: 'term:1' }, prompt: { outcome: 'handed-to-terminal' }, operationId: 'launch:1' };
  let storageFailure = false;
  let mapping = 'original';
  let liveWorkspace = { id: 'repo::/demo', path: '/demo', hostId };
  let nativeIdentity = 'original';
  let providerAvailable = true;
  let readyIds = ['A'], blockedIds: string[] = [];
  const opened: Record<string, unknown>[] = [];
  const service = new WorkflowService({
    host: { async call(method, params) {
      if (method === 'storage.get') return { value: storage.get(String(params?.key)) };
      if (method === 'storage.set') { if (storageFailure) throw new Error('Plugin storage quota exceeded'); storage.set(String(params?.key), structuredClone(params?.value)); return {}; }
      if (method === 'storage.delete') { storage.delete(String(params?.key)); return {}; }
      if (method === 'workspace.list') return { workspaces: [liveWorkspace] };
      if (method === 'editor.open') { opened.push(params ?? {}); effects.push(method); return { opened: true }; }
      effects.push(method); return {};
    } }, settings: { async get() { return ''; } },
  }, {
    async list() { return [{ ...project, hostId }]; },
    async captureIdentity() { return { path: '/demo', hostId, workspaceId: 'repo::/demo', fingerprint: mapping }; },
    async request(request) {
      if (request.method === 'snapshot') return { project, issues: structuredClone(issues), readyIds, blockedIds, fetchedAt: new Date().toISOString() } satisfies Snapshot;
      effects.push(request.method); return {};
    },
    async readText(_project, path) { if (path.endsWith('.ts')) throw new Error('Change content must not be read'); if (!files.has(path)) throw new Error('Missing file'); return { path, text: files.get(path)!, hash: files.get(path)! }; },
    async writeText(_project, path, text) { files.set(path, text); },
    async removeFile(_project, path) { files.delete(path); },
    async inspectFile(_project, path, expected) { if (expected?.fingerprint !== mapping) throw new Error('Project access mapping changed'); if (!files.has(path)) throw new Error('Missing file'); return { path }; },
    async executableAvailable(_project, command) { return command === 'codex' && providerAvailable; },
  }, { async readDocument(_project, path) { return { path, text: files.get(path) ?? 'Document', hash: files.get(path) ?? 'Document' }; } }, {
    async run(argv) {
      commands.push(argv);
      if (argv[0] === 'worktree' && argv[1] === 'show') return { worktree: { id: 'repo::/demo', repoId: 'repo', hostId: hostId.startsWith('runtime:') ? 'local' : hostId, path: '/demo', head: 'base', identity: nativeIdentity } };
      if (argv[0] === 'project' && argv[1] === 'setups') return { setups: [{ projectId: 'github:example/demo', repoId: 'repo', hostId, path: '/demo' }] };
      if (argv[0] === 'worktree' && argv[1] === 'create') { effects.push('worktree.create'); return { id: 'repo::/new', path: '/new' }; }
      if (argv[0] === 'terminal' && argv[1] === 'list') return { terminals: [{ handle: 'term:idle', agentIdentity: 'codex', worktreeId: 'repo::/demo', tabId: 'tab', leafId: 'leaf', connected: true }], truncated: false };
      if (argv[0] === 'worktree' && argv[1] === 'ps') return { worktrees: [{ worktreeId: 'repo::/demo', agents: [{ paneKey: 'tab:leaf', state: 'idle' }] }], truncated: false };
      if (argv[0] === 'agent') { effects.push('launch'); if (receipt instanceof Error) throw receipt; return receipt; }
      throw new Error(`Unexpected CLI: ${argv.join(' ')}`);
    },
  });
  const group: HandoffGroup = { tasks: [{ project: 'source', id: 'A' }], target: 'source', recipient: { kind: 'new', agent: 'codex' }, mode: 'implementation', documents: [] };
  return { service, group, files, effects, commands, opened, setIssues(value: Issue[]) { issues = value; }, setReceipt(value: unknown) { receipt = value; }, failStorage() { storageFailure = true; }, remap() { mapping = 'different-host'; }, changeWorkspace(value: typeof liveWorkspace) { liveWorkspace = value; }, changeNativeIdentity() { nativeIdentity = 'replacement'; }, removeProvider() { providerAvailable = false; }, setReadiness(ready: string[], blocked: string[]) { readyIds = ready; blockedIds = blocked; } };
}

test('preview preserves complete context and dispatch never claims or closes a task', async () => {
  const f = fixture();
  const [preview] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  assert.match(preview.prompt, /Acceptance/);
  assert.match(preview.prompt, /--actor/);
  assert.equal(preview.errors.length, 0);
  const result = await f.service.request({ method: 'handoff.send', input: { id: preview.id } }) as HistoryEntry;
  assert.equal(result.delivery, 'handed-to-terminal');
  assert.deepEqual(f.effects, ['launch']);
  assert.equal(result.preview.prompt, preview.prompt);
});

test('a changed acceptance criterion or explicitly included document requires a new preview', async () => {
  const f = fixture();
  f.group.documents = [{ project: 'source', path: 'spec.md' }];
  const [preview] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  f.setIssues([{ ...issue, acceptance: 'Changed acceptance' }]);
  await assert.rejects(f.service.request({ method: 'handoff.send', input: { id: preview.id } }), /new preview/);
  assert.deepEqual(f.effects, []);
  f.setIssues([issue]); f.files.set('spec.md', 'Changed document');
  await assert.rejects(f.service.request({ method: 'handoff.send', input: { id: preview.id } }), /new preview/);
  assert.deepEqual(f.effects, []);
});

test('document fragments preserve inclusive boundaries and original line endings without changing whole-file context', async () => {
  const f = fixture();
  const original = 'First\r\nMiddle\r\nLast';
  f.files.set('spec.md', original);
  for (const [startLine, endLine, expected] of [[1, 1, 'First\r\n'], [2, 3, 'Middle\r\nLast'], [3, 3, 'Last']] as const) {
    f.group.documents = [{ project: 'source', path: 'spec.md', startLine, endLine }];
    const [preview] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
    assert.deepEqual(preview.documents, [{ project: 'source', path: 'spec.md', startLine, endLine, text: expected, hash: original }]);
    assert.deepEqual(preview.group.documents, f.group.documents);
    assert.ok(preview.prompt.includes(JSON.stringify(expected)));
    const entry = await f.service.request({ method: 'history.get', input: { id: preview.id } }) as HistoryEntry;
    assert.deepEqual(entry.preview.documents, preview.documents);
  }
  f.group.documents = [{ project: 'source', path: 'spec.md' }];
  const [whole] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  assert.deepEqual(whole.documents, [{ project: 'source', path: 'spec.md', text: original, hash: original }]);
});

test('fragment validation rejects unpaired, noninteger, reversed and out-of-file ranges without clipping', async () => {
  const f = fixture();
  f.files.set('spec.md', 'First\nLast\n');
  for (const range of [
    { startLine: 1 }, { endLine: 1 }, { startLine: 0, endLine: 1 },
    { startLine: 2, endLine: 1 }, { startLine: 1.5, endLine: 2 },
    { startLine: '1', endLine: 2 }, { startLine: null, endLine: null },
    { startLine: 1, endLine: 3 }, { startLine: 3, endLine: 3 },
    { startLine: 1, endLine: Number.MAX_SAFE_INTEGER + 1 },
  ]) {
    const group = { ...f.group, documents: [{ project: 'source', path: 'spec.md', ...range }] };
    await assert.rejects(f.service.request({ method: 'handoff.preview', input: { groups: [group] } }), /spec\.md line range/);
  }
  f.group.documents = [{ project: 'source', path: 'spec.md', startLine: 2, endLine: 2 }];
  const [last] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  assert.equal(last.documents[0].text, 'Last\n');
  f.files.set('spec.md', '');
  await assert.rejects(f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }), /0 lines/);
  f.files.set('spec.md', '\n');
  f.group.documents = [{ project: 'source', path: 'spec.md', startLine: 1, endLine: 1 }];
  const [blank] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  assert.equal(blank.documents[0].text, '\n');
  assert.deepEqual(f.effects, []);
});

test('history import preserves fragments and rejects malformed or mismatched archived bounds', async () => {
  const f = fixture();
  f.files.set('spec.md', 'Private prefix\nSelected\nPrivate suffix\n');
  f.group.documents = [{ project: 'source', path: 'spec.md', startLine: 2, endLine: 2 }];
  const [preview] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  const exported = await f.service.request({ method: 'history.export', input: { ids: [preview.id] } }) as WorkflowResults['history.export'];
  const data = JSON.parse(exported.text);
  const other = fixture();
  await other.service.request({ method: 'history.import', input: { data } });
  const imported = await other.service.request({ method: 'history.get', input: { id: preview.id } }) as HistoryEntry;
  assert.deepEqual(imported.preview.group.documents, f.group.documents);
  assert.deepEqual(imported.preview.documents, preview.documents);
  assert.equal(imported.preview.documents[0].text, 'Selected\n');
  assert.equal(imported.imported, true);
  for (const collection of ['documents', 'group'] as const) {
    for (const range of [{ startLine: 0, endLine: 2 }, { startLine: 2 }, { endLine: 2 }, { startLine: 3, endLine: 2 }, { startLine: 1.5, endLine: 2 }, { startLine: 1, endLine: 2 }]) {
      const malformed = structuredClone(data);
      const docs = collection === 'group' ? malformed.entries[0].preview.group.documents : malformed.entries[0].preview.documents;
      delete docs[0].startLine; delete docs[0].endLine;
      Object.assign(docs[0], range);
      await assert.rejects(fixture().service.request({ method: 'history.import', input: { data: malformed } }), /line range|document selection/);
    }
  }
});

test('changes outside a selected excerpt reject delivery with its document path and preserve the approved history', async () => {
  const f = fixture();
  f.files.set('spec.md', 'Before\nSelected\nAfter');
  f.group.documents = [{ project: 'source', path: 'spec.md', startLine: 2, endLine: 2 }];
  const [preview] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  f.files.set('spec.md', 'Changed outside selection\nSelected\nAfter');
  await assert.rejects(f.service.request({ method: 'handoff.send', input: { id: preview.id } }), /Documents: source\/spec\.md.*new preview/s);
  const stored = await f.service.request({ method: 'history.get', input: { id: preview.id } }) as HistoryEntry;
  assert.deepEqual(stored.preview, preview);
  assert.equal(stored.delivery, 'rejected');
  assert.deepEqual(f.effects, []);
  f.files.set('spec.md', 'Before\nSelected\nAfter');
  await assert.rejects(f.service.request({ method: 'handoff.send', input: { id: preview.id } }), /new preview/);
  assert.deepEqual(f.effects, []);
});

test('stale rejection identifies issue, recipient, workspace, dependency and readiness changes', async () => {
  const dependency = { ...issue, id: 'B', title: 'Prerequisite', status: 'closed' };
  const task = { ...issue, dependencies: [{ id: 'B', type: 'blocks' }] };
  const changes = {
    issue: /Issues: source\/A/,
    recipient: /Recipient: codex/,
    workspace: /Workspace: source.*\/demo/,
    mapping: /Workspace: source.*\/demo/,
    dependency: /Dependencies: source\/B/,
    readiness: /Readiness: source\/A/,
  };
  for (const [category, expected] of Object.entries(changes)) {
    const f = fixture(); f.setIssues([task, dependency]);
    const [preview] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
    if (category === 'issue') f.setIssues([{ ...task, acceptance: 'New acceptance' }, dependency]);
    else if (category === 'recipient') f.removeProvider();
    else if (category === 'workspace') f.changeNativeIdentity();
    else if (category === 'mapping') f.remap();
    else if (category === 'dependency') f.setIssues([task, { ...dependency, title: 'Changed prerequisite' }]);
    else f.setReadiness([], ['A']);
    await assert.rejects(f.service.request({ method: 'handoff.send', input: { id: preview.id } }), (error: Error) => {
      assert.match(error.message, expected, category);
      assert.match(error.message, /new preview/);
      return true;
    });
    const entry = await f.service.request({ method: 'history.get', input: { id: preview.id } }) as HistoryEntry;
    assert.equal(entry.preview.prompt, preview.prompt);
    assert.deepEqual(f.effects, []);
  }
});

test('existing idle sessions remain unavailable without an atomic native gate', async () => {
  const f = fixture();
  f.group.recipient = { kind: 'existing', terminal: 'term:idle' };
  const [preview] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  assert.equal(preview.recipientState?.state, 'idle');
  assert.match(preview.errors.join(' '), /atomic idle-only/);
  await assert.rejects(f.service.request({ method: 'handoff.send', input: { id: preview.id } }), /atomic idle-only/);
  assert.deepEqual(f.effects, []);
});

test('an ambiguous launch stays unknown and cannot be retried by double-click or restart semantics', async () => {
  const f = fixture(); f.setReceipt(new Error('Connection lost after launch'));
  const [preview] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  const result = await f.service.request({ method: 'handoff.send', input: { id: preview.id } }) as HistoryEntry;
  assert.equal(result.delivery, 'unknown');
  await assert.rejects(f.service.request({ method: 'handoff.send', input: { id: preview.id } }), /new preview/);
  assert.deepEqual(f.effects, ['launch']);
});

test('external blockers refuse implementation but an explicit research preview preserves them', async () => {
  const f = fixture();
  f.setIssues([{ ...issue, dependencies: [{ id: 'B', type: 'blocks' }] }]);
  const [preview] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  assert.deepEqual(preview.blockers, [{ task: 'A', dependency: 'B', internal: false }]);
  assert.match(preview.errors.join(' '), /External blockers/);
  f.group.mode = 'research';
  const [research] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  assert.equal(research.errors.length, 0);
  assert.match(research.prompt, /Research only/);
});

test('reports stay executor claims until explicit per-task publication; cleanup cannot remove work files', async () => {
  const f = fixture();
  const [preview] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  await f.service.request({ method: 'handoff.send', input: { id: preview.id } });
  f.files.set(preview.reportPath, JSON.stringify({ version: 1, handoffId: preview.id, summary: 'Partial', comparisonBase: null, tasks: [{ id: 'A', outcome: 'partial', summary: 'Needs review', changes: ['src/feature.ts'], checks: [] }] }));
  const entry = await f.service.request({ method: 'handoff.report', input: { id: preview.id } }) as HistoryEntry;
  assert.equal(entry.report?.tasks[0].outcome, 'partial');
  assert.deepEqual(f.effects, ['launch']);
  await assert.rejects(f.service.request({ method: 'handoff.cleanup', input: { id: preview.id, paths: ['src/feature.ts'] } }), /exact previewed/);
  await f.service.request({ method: 'history.publish', input: { id: preview.id, taskIds: ['A'] } });
  assert.deepEqual(f.effects, ['launch', 'comment']);
  await f.service.request({ method: 'handoff.cleanup', input: { id: preview.id, paths: [preview.reportPath] } });
  assert.equal(f.files.has(preview.reportPath), false);
  assert.equal((await f.service.request({ method: 'history.get', input: { id: preview.id } }) as HistoryEntry).report?.summary, 'Partial');
});

test('quota failure before an unknown intent is persisted prevents agent and artifact effects', async () => {
  const f = fixture();
  const [preview] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  f.failStorage();
  await assert.rejects(f.service.request({ method: 'handoff.send', input: { id: preview.id } }), /storage failure/);
  assert.deepEqual(f.effects, []);
  assert.equal(f.files.size, 0);
});

test('private export/import preserves exact context but imported drafts are never executable', async () => {
  const f = fixture();
  f.group.documents = [{ project: 'source', path: 'large.md' }];
  f.files.set('large.md', 'Explicit document content. '.repeat(4000));
  const [preview] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  let serialized = '', offset = 0, hash: string | undefined;
  do {
    const chunk = await f.service.request({ method: 'history.export', input: { ids: [preview.id], offset, hash } }) as WorkflowResults['history.export'];
    serialized += chunk.text; hash = chunk.hash;
    if (chunk.nextOffset === null) break;
    offset = chunk.nextOffset;
  } while (true);
  const other = fixture();
  const upload = await other.service.request({ method: 'history.import.begin' }) as { id: string };
  for (let start = 0; start < serialized.length; start += 8192) await other.service.request({ method: 'history.import.chunk', input: { id: upload.id, text: serialized.slice(start, start + 8192) } });
  assert.deepEqual(await other.service.request({ method: 'history.list' }), { entries: [], nextOffset: null });
  await other.service.request({ method: 'history.import.finish', input: { id: upload.id } });
  const imported = await other.service.request({ method: 'history.get', input: { id: preview.id } }) as HistoryEntry;
  assert.equal(imported.preview.prompt, preview.prompt);
  assert.equal(imported.imported, true);
  await assert.rejects(other.service.request({ method: 'handoff.send', input: { id: preview.id } }), /new preview/);
  await assert.rejects(other.service.request({ method: 'handoff.cleanup', input: { id: preview.id, paths: [preview.reportPath] } }), /read-only/);
  await assert.rejects(other.service.request({ method: 'handoff.openChange', input: { id: preview.id, path: 'src/feature.ts' } }), /read-only/);
  await other.service.request({ method: 'history.delete', input: { ids: [preview.id] } });
  assert.deepEqual(await other.service.request({ method: 'history.list' }), { entries: [], nextOffset: null });
  assert.deepEqual(other.effects, []);
});

test('native worktree creation requires preview, requests no agent, and never repeats the same operation', async () => {
  const f = fixture();
  const preview = await f.service.request({ method: 'worktree.preview', input: { project: 'source', name: 'Feature', branch: 'feature/test' } }) as WorktreePreview;
  assert.deepEqual(f.effects, []);
  assert.ok(!preview.argv.includes('--agent'));
  assert.ok(preview.argv.includes('--no-parent'));
  const first = await f.service.request({ method: 'worktree.create', input: { id: preview.id } });
  const again = await f.service.request({ method: 'worktree.create', input: { id: preview.id } });
  assert.deepEqual(again, first);
  assert.deepEqual(f.effects, ['worktree.create']);
});

test('a changed SSH/access mapping invalidates the preview before any artifact write', async () => {
  const f = fixture();
  const [preview] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  f.remap();
  await assert.rejects(f.service.request({ method: 'handoff.send', input: { id: preview.id } }), /new preview/);
  assert.equal(f.files.size, 0);
  assert.deepEqual(f.effects, []);
});

test('history pages expose an explicit cursor instead of dropping older entries', async () => {
  const f = fixture();
  for (let i = 0; i < 3; i++) await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } });
  const first = await f.service.request({ method: 'history.list', input: { limit: 2 } }) as WorkflowResults['history.list'];
  assert.equal(first.entries.length, 2);
  assert.equal(first.nextOffset, 2);
  const second = await f.service.request({ method: 'history.list', input: { offset: first.nextOffset, limit: 2 } }) as WorkflowResults['history.list'];
  assert.equal(second.entries.length, 1);
  assert.equal(second.nextOffset, null);
  assert.equal(new Set([...first.entries, ...second.entries].map((entry) => entry.id)).size, 3);
});

test('SSH worktree creation uses project and host, and agent launch does not invent --host', async () => {
  const f = fixture('ssh:ssh-demo');
  const preview = await f.service.request({ method: 'worktree.preview', input: { project: 'source', name: 'Feature', branch: 'feature/ssh' } }) as WorktreePreview;
  assert.ok(preview.argv.includes('--project'));
  assert.ok(preview.argv.includes('--host'));
  assert.equal(preview.argv[preview.argv.indexOf('--host') + 1], 'ssh:ssh-demo');
  assert.equal(preview.argv.includes('--repo'), false);
  const [handoff] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  assert.equal(handoff.errors.length, 0);
  await f.service.request({ method: 'handoff.send', input: { id: handoff.id } });
  const launch = f.commands.find((argv) => argv[0] === 'agent');
  assert.ok(launch);
  assert.equal(launch?.includes('--host'), false);
  assert.equal(launch?.[launch.indexOf('--worktree') + 1], 'id:repo::/demo');
});

test('explicitly mapped paired targets use the selected native environment, never the local runtime target', async () => {
  const f = fixture('runtime:remote-server');
  const [preview] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  await f.service.request({ method: 'handoff.send', input: { id: preview.id } });
  assert.ok(f.commands.length > 0);
  for (const argv of f.commands) assert.deepEqual(argv.slice(-2), ['--environment', 'remote-server']);
  const launch = f.commands.find((argv) => argv[0] === 'agent')!;
  assert.equal(launch[launch.indexOf('--worktree') + 1], 'path:/demo');
});

test('reported changes open only a confined existing file in its unchanged native workspace, without reading content', async () => {
  const f = fixture();
  const [preview] = await f.service.request({ method: 'handoff.preview', input: { groups: [f.group] } }) as HandoffPreview[];
  await f.service.request({ method: 'handoff.send', input: { id: preview.id } });
  f.files.set(preview.reportPath, JSON.stringify({ version: 1, handoffId: preview.id, summary: 'Partial', comparisonBase: null, tasks: [{ id: 'A', outcome: 'partial', summary: 'Needs review', changes: ['src/feature.ts'], checks: [] }] }));
  await f.service.request({ method: 'handoff.report', input: { id: preview.id } });
  await assert.rejects(f.service.request({ method: 'handoff.openChange', input: { id: preview.id, path: 'src/unreported.ts' } }), /reported/);
  await assert.rejects(f.service.request({ method: 'handoff.openChange', input: { id: preview.id, path: 'src/feature.ts' } }), /Missing file/);
  f.files.set('src/feature.ts', 'private implementation content');
  assert.deepEqual(await f.service.request({ method: 'handoff.openChange', input: { id: preview.id, path: 'src/feature.ts' } }), { path: 'src/feature.ts', opened: true });
  assert.deepEqual(f.opened, [{ workspaceId: 'repo::/demo', path: 'src/feature.ts' }]);
  assert.deepEqual(f.effects, ['launch', 'editor.open']);
  for (const changed of [
    { id: 'other', path: '/demo', hostId: 'local' },
    { id: 'repo::/demo', path: '/elsewhere', hostId: 'local' },
    { id: 'repo::/demo', path: '/demo', hostId: 'ssh:other' },
  ]) {
    f.changeWorkspace(changed);
    await assert.rejects(f.service.request({ method: 'handoff.openChange', input: { id: preview.id, path: 'src/feature.ts' } }), /registered Orca workspace/);
  }
  f.changeWorkspace({ id: 'repo::/demo', path: '/demo', hostId: 'local' });
  f.remap();
  await assert.rejects(f.service.request({ method: 'handoff.openChange', input: { id: preview.id, path: 'src/feature.ts' } }), /mapping changed/);
  assert.equal(f.opened.length, 1);
});
