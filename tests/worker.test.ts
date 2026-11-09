import assert from 'node:assert/strict';
import test from 'node:test';
import activate from '../src/orca/worker.js';
import type { Project } from '../src/shared.js';
import { createPanelTransport } from '../src/orca/panel-transport.js';

test('workspaces on unsupported hosts remain visible and cannot reach a local Beads twin', async () => {
  let request: (input: unknown) => Promise<unknown> = async () => { throw new Error('Worker not activated'); };
  const workspaces = [
    { id: 'local-current', name: 'Current local', path: '/demo/project', hostId: 'local' },
    { id: 'local-legacy', name: 'Legacy local', path: '/demo/legacy', hostId: null },
    { id: 'ssh-project', name: 'SSH twin', path: '/demo/project', hostId: 'ssh:demo' },
    { id: 'wsl-project', name: 'WSL twin', path: '/demo/project', hostId: 'wsl:demo' },
    { id: 'paired-project', name: 'Paired twin', path: '/demo/project', hostId: 'runtime:demo' },
  ];
  activate({
    host: { async call(method) {
      if (method === 'workspace.list') return { workspaces, truncated: false };
      throw new Error(`Unexpected host method: ${method}`);
    } },
    settings: { async get() { return ''; } },
    panels: { handle(_name, handler) { request = handler; } },
  });
  const transport = createPanelTransport({
    async call(method, params) {
      assert.equal(method, 'plugin.request');
      assert.equal(params.name, 'beads');
      const encodedInput = JSON.stringify(params.input);
      assert.ok(Buffer.byteLength(encodedInput) <= 64 * 1024);
      const output = await request(JSON.parse(encodedInput));
      const encoded = JSON.stringify({ output });
      assert.ok(Buffer.byteLength(encoded) < 1024 * 1024);
      return JSON.parse(encoded) as { output: unknown };
    },
  });
  const projects = await transport.request<Project[]>({ method: 'projects' });
  assert.deepEqual(projects.map((project) => project.id), ['ssh-project', 'wsl-project', 'paired-project']);
  for (const project of ['ssh-project', 'wsl-project', 'paired-project']) {
    assert.equal(projects.find((candidate) => candidate.id === project)?.availability, 'unsupported');
    await assert.rejects(transport.request({ method: 'snapshot', project }), /unsupported|mapping/i);
  }
});

test('registered worker routes large project replies through the bounded native panel transport', async () => {
  let request: (input: unknown) => Promise<unknown> = async () => { throw new Error('Worker not activated'); };
  const workspaces = Array.from({ length: 1262 }, (_, index) => ({
    id: `paired-${index}`, name: `${index} ${'Задачи🙂"\\'.repeat(100)}`,
    path: `/demo/project-${index}`, hostId: 'runtime:demo',
  }));
  let discoveries = 0;
  activate({
    host: { async call(method) {
      if (method === 'workspace.list') { discoveries++; return { workspaces, truncated: false }; }
      throw new Error(`Unexpected host method: ${method}`);
    } },
    settings: { async get() { return ''; } },
    panels: { handle(_name, handler) { request = handler; } },
  });
  let replies = 0;
  const transport = createPanelTransport({
    async call(method, params) {
      assert.equal(method, 'plugin.request');
      assert.equal(params.name, 'beads');
      const encodedInput = JSON.stringify(params.input);
      assert.ok(Buffer.byteLength(encodedInput) <= 64 * 1024);
      const output = await request(JSON.parse(encodedInput));
      const encoded = JSON.stringify({ output });
      assert.ok(Buffer.byteLength(encoded) < 1024 * 1024);
      replies++;
      return JSON.parse(encoded) as { output: unknown };
    },
  });
  const projects = await transport.request<Project[]>({ method: 'projects' });
  assert.deepEqual(projects.map(({ id, name }) => ({ id, name })), workspaces.map(({ id, name }) => ({ id, name })));
  assert.ok(Buffer.byteLength(JSON.stringify(projects)) > 1024 * 1024);
  assert.equal(discoveries, 1, 'chunk reads do not rerun application discovery');
  assert.ok(replies > 2);
});
