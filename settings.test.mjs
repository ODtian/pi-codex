import test from 'node:test';
import assert from 'node:assert/strict';
import { CombinedAutocompleteProvider } from '@earendil-works/pi-tui';
import { registerSettings } from './settings.ts';

// Exercise panel changes and the SDK's completion-to-command path through the same registration.
test('custom settings and completed commands update the same session options', async () => {
  let command, state = { review: true, compaction: 'remote' };
  const ctx = { model: { provider: 'openai-codex', id: 'gpt-6.1-sol' },
    ui: { custom: async factory => {
      let saved;
      const component = factory({}, { fg: (_color, text) => text }, {}, value => { saved = value; });
      component.render(80);
      // Toggle the three settings with the SDK component, then select Save.
      for (const key of [' ', '\x1b[B', ' ', '\x1b[B', ' ', '\x1b[B', '\r']) component.handleInput(key);
      return saved;
    } } };
  const pi = { registerCommand: (name, options) => { command = { name, ...options }; },
    getThinkingLevel: () => 'high', setThinkingLevel() {},
    setModel: async model => { ctx.model = model; return true; } };
  registerSettings(pi, () => state, next => { state = next; });
  await command.handler('fast', ctx);
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
