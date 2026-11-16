import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager, ModelRuntime, initTheme } from '@earendil-works/pi-coding-agent';
import { registerFast, setFast } from './fast.ts';

// Use actual SDK sessions and the model handoff used by the existing native controller.
test('Fast follows native model inheritance and remains independent in the child', async t => {
  initTheme();
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  runtime.checkAuth = async () => true; // Exercise local request configuration.
  const model = runtime.getModels('openai-codex')[0];
  /** Load only the Fast extension and keep each session's real API binding. */
  async function open(selected) {
    let api;
    const services = await createAgentSessionServices({ cwd: process.cwd(), modelRuntime: runtime,
      settingsManager: SettingsManager.inMemory(), resourceLoaderOptions: { noExtensions: true, noSkills: true,
        noThemes: true, noPromptTemplates: true, noContextFiles: true,
        extensionFactories: [{ name: 'fast', factory: pi => { api = pi; registerFast(pi); } }] } });
    const { session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(), model: selected });
    await session.bindExtensions({ onError: error => { throw new Error(error.error); } });
    t.after(() => session.dispose());
    return { session, api, ctx: session.extensionRunner.createContext() };
  }
  const parent = await open(model), thinking = parent.api.getThinkingLevel();
  await setFast(parent.api, parent.ctx, true);
  const child = await open(parent.session.model);
  const body = { model: model.id, input: [] };
  await child.session.extensionRunner.emitBeforeProviderRequest(body);
  assert.equal(body.model, model.id);
  assert.equal(body.service_tier, 'priority');
  await setFast(child.api, child.ctx, false);
  await child.session.extensionRunner.emitBeforeProviderRequest(body);
  assert.equal(body.service_tier, undefined);
  assert.equal(parent.session.model.samplingParams.service_tier, 'priority');
  assert.equal(child.session.model.id, model.id);
  assert.equal(parent.api.getThinkingLevel(), thinking);
});
