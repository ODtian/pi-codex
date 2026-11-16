import test from 'node:test';
import assert from 'node:assert/strict';
import { registerReview } from './review.ts';

// Exercise the public tool gate with controlled provider results.
test('prefetch overlaps sibling reviews and applies each complete decision', async () => {
  const handlers = new Map();
  let active = 0, maximum = 0, requests = 0;
  const actions = ['allowed.txt', 'denied.txt'].map((path, index) => ({ type: 'toolCall', id: `call-${index}`, name: 'read', arguments: { path } }));
  const model = { id: 'codex-auto-review', provider: 'openai-codex', api: 'openai-codex-responses' };
  const messages = [{ role: 'user', content: 'Read the requested files.' }, { role: 'assistant', content: actions }];
  const pi = { on: (name, fn) => { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); }, getActiveTools: () => ['read'] };
  const ctx = { cwd: process.cwd(), ui: { setStatus() {} }, sessionManager: {
    getBranch: () => [], getHeader: () => ({}), getLeafId: () => 'batch', buildSessionProjection: () => ({ messages }),
  }, modelRegistry: { find: () => model, getAll: () => [model], streamSimple: (_model, context) => ({ result: async () => {
    requests++; active++; maximum = Math.max(maximum, active);
    const path = JSON.parse(context.messages[1].content).planned_action.arguments.path;
    await new Promise(resolve => setTimeout(resolve, 20)); active--;
    return { stopReason: 'stop', content: [{ type: 'text', text: JSON.stringify({ outcome: path === 'allowed.txt' ? 'allow' : 'deny', rationale: 'Fixture decision' }) }] };
  } }) } };
  registerReview(pi, () => ({ review: true, compaction: 'remote' }));
  for (const start of handlers.get('session_start')) await start({}, ctx);
  const results = [];
  for (const action of actions) results.push(await handlers.get('tool_call')[0]({ type: 'tool_call', toolName: action.name, toolCallId: action.id, input: action.arguments }, ctx));
  for (const shutdown of handlers.get('session_shutdown')) await shutdown({}, ctx);
  assert.equal(requests, actions.length);
  assert.equal(maximum, actions.length);
  assert.equal(results[0], undefined);
  assert.equal(results[1].block, true);
});
