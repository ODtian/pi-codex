import test from 'node:test';
import assert from 'node:assert/strict';
import { registerFast, PROVIDER_OPTIONS } from './fast.ts';

// Exercise the request hook against the same native model before and after a Fast toggle.
test('Fast changes service tier while preserving the model identity', () => {
  let request;
  const entries = [{ type: 'custom', customType: PROVIDER_OPTIONS, data: { serviceTier: 'priority' } }];
  const model = { provider: 'openai-codex', id: 'gpt-6.1-sol' };
  registerFast({ on: (_event, handler) => { request = handler; } });
  const ctx = { model, sessionManager: { getBranch: () => entries } };
  const body = { model: model.id, input: [] };
  request({ payload: body }, ctx);
  assert.equal(body.model, model.id);
  assert.equal(body.service_tier, 'priority');
  entries.push({ type: 'custom', customType: PROVIDER_OPTIONS, data: { serviceTier: null } });
  request({ payload: body }, ctx);
  assert.equal(body.model, model.id);
  assert.equal(body.service_tier, undefined);
});
