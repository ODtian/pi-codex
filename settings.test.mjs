import test from 'node:test';
import assert from 'node:assert/strict';
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import { registerSettings } from './settings.ts';

// Exercise panel changes and the SDK's completion-to-command path through the same registration.
test('panel choices and completed commands update the same session settings', async () => {
  let command, state = { review: true, compaction: 'remote' };
  const selections = [0, 1, 2, 3];
  const ctx = { model: { provider: 'openai-codex', id: 'gpt-6.1-sol' },
    ui: { select: async (_title, options) => options[selections.shift()] } };
  const pi = { registerCommand: (name, options) => { command = { name, ...options }; },
    getThinkingLevel: () => 'high', setThinkingLevel() {},
    setModel: async model => { ctx.model = model; return true; } };
  registerSettings(pi, () => state, next => { state = next; });
  await command.handler('', ctx);
  assert.equal(ctx.model.samplingParams.service_tier, 'priority');
  assert.deepEqual(state, { review: false, compaction: 'experimental' });

  const provider = new CombinedAutocompleteProvider([command], process.cwd());
  const line = '/codex fast of', signal = new AbortController().signal;
  const suggestions = await provider.getSuggestions([line], 0, line.length, { signal });
  const completed = provider.applyCompletion([line], 0, line.length, suggestions.items[0], suggestions.prefix);
  await command.handler(completed.lines[0].slice('/codex '.length), ctx);
  assert.equal(ctx.model.samplingParams.service_tier, undefined);
  assert.equal(ctx.model.id, 'gpt-6.1-sol');
});
