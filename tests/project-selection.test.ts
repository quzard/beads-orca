import assert from 'node:assert/strict';
import test from 'node:test';
import { preferredProjectId } from '../src/ui/project-selection.js';

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
