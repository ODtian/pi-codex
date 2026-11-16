import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, ModelRuntime, initTheme } from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream, cleanupSessionResources } from '@earendil-works/pi-ai';

// Drive the real SDK boundary, including the automatic next request.
test('a new context preserves notes and exposes prior branch history', async () => {
  initTheme();
  const cwd = process.cwd(), runtime = await ModelRuntime.create({ refreshOnCreate: false });
  const services = await createAgentSessionServices({ cwd, modelRuntime: runtime, settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      additionalExtensionPaths: [fileURLToPath(new URL('./index.ts', import.meta.url))] } });
  const manager = SessionManager.inMemory(cwd), model = runtime.getModels('openai-codex')[0];
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model });
  await session.bindExtensions({ onError: error => { throw new Error(error.error); } });
  const command = text => session.extensionRunner.getCommand('codex').handler(text, session.extensionRunner.createContext());
  await command('review off'); await command('compaction experimental');
  const contexts = [];
  session.agent.streamFunction = (selected, context) => {
    contexts.push(context.messages);
    const first = contexts.length === 1, stream = new AssistantMessageEventStream();
    const message = { role: 'assistant', content: first ? [
      { type: 'toolCall', id: 'notes', name: 'notes', arguments: { text: 'Goal ALPHA; continue the original task.' } },
      { type: 'toolCall', id: 'window', name: 'new_context', arguments: {} },
    ] : [{ type: 'text', text: 'Continued.' }], api: selected.api, provider: selected.provider, model: selected.id,
      stopReason: first ? 'toolUse' : 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, totalTokens: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    stream.push({ type: 'done', reason: message.stopReason, message }); stream.end(message); return stream;
  };
  await session.prompt('Original task ALPHA.', { source: 'rpc' });
  assert.equal(contexts.length, 2);
  assert(contexts[1].some(message => JSON.stringify(message).includes('Goal ALPHA')));
  assert(!contexts[1].some(message => message.role === 'user' && JSON.stringify(message.content).includes('Original task ALPHA.')));
  const history = session.agent.state.tools.find(tool => tool.name === 'history');
  const entries = JSON.parse((await history.execute('recover', { query: 'Original task ALPHA.' })).content[0].text);
  const recovered = JSON.parse((await history.execute('read', { id: entries[0].id })).content[0].text);
  assert(JSON.stringify(recovered.content).includes('Original task ALPHA.'));
  session.dispose(); cleanupSessionResources();
});
