import assert from 'node:assert/strict';
import test from 'node:test';
import { focusedWorkspaceId, pathsInTitle, preferredProjectId } from '../src/ui/project-selection.js';

const projects = [
  { id: 'local' },
  { id: 'remote', current: true },
  { id: 'other' },
];

test('a single current workspace wins over the last selection', () => {
  assert.equal(preferredProjectId(projects, 'local', 'other'), 'remote');
});

test('last selection is the fallback when no workspace is current', () => {
  const idle = projects.map(({ id }) => ({ id }));
  assert.equal(preferredProjectId(idle, 'other', 'local'), 'other');
});

test('an ambiguous current focus does not override the last selection', () => {
  const twins = [
    { id: 'a', current: true },
    { id: 'b', current: true },
  ];
  assert.equal(preferredProjectId(twins, 'b', 'a'), 'b');
});

test('the open board stays when nothing else is remembered', () => {
  const idle = projects.map(({ id }) => ({ id }));
  assert.equal(preferredProjectId(idle, '', 'local'), 'local');
  assert.equal(preferredProjectId(idle, 'missing', ''), 'local');
});

test('focus follows the SSH worktree path, not a local folder with the same name', () => {
  const rows = [
    { id: 'docs', name: 'Documents', path: '/Users/me/Documents', hostId: null, branch: null },
    { id: 'remote', name: 'upsert-umodel-perf', path: '/sls_alimake/wt/upsert-umodel-perf', hostId: 'ssh:new_sls', branch: 'main' },
    { id: 'local-copy', name: 'upsert-umodel-perf', path: '/Users/me/upsert-umodel-perf', hostId: null, branch: 'main' },
  ];
  assert.deepEqual(pathsInTitle('admin@localhost:/sls_alimake/wt/upsert-umodel-perf'), ['/sls_alimake/wt/upsert-umodel-perf']);
  assert.equal(focusedWorkspaceId(rows, {
    displayName: 'upsert-umodel-perf',
    branch: 'refs/heads/main',
    terminals: [{ title: '[ssh] admin@localhost:/sls_alimake/wt/upsert-umodel-perf [main]' }],
  }), 'remote');
});

test('a unique name and branch is enough when the terminal title has no path', () => {
  const rows = [
    { id: 'docs', name: 'Documents', path: '/Users/me/Documents', hostId: null, branch: null },
    { id: 'remote', name: 'upsert-umodel-perf', path: '/sls_alimake/wt/upsert-umodel-perf', hostId: 'ssh:new_sls', branch: 'main' },
  ];
  assert.equal(focusedWorkspaceId(rows, { displayName: 'upsert-umodel-perf', branch: 'main' }), 'remote');
});
