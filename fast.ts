import { getModels } from "@earendil-works/pi-ai/compat";
import { getSupportedThinkingLevels, type Model, type Api } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const FAST_SUFFIX = ":fast"; // Pi persists this catalog selection in its native model_change entry.
/** Read Fast from the selected model, including a natively inherited selection. */
export function isFast(model: ExtensionContext["model"]): boolean { return model?.id.endsWith(FAST_SUFFIX) ?? false; }
/** Match both physical Codex models and their virtual Fast selections. */
export function isCodex(ctx: ExtensionContext): boolean { return ctx.model?.provider === "openai-codex"; }
/** Direct compaction requests need the physical provider model. */
export function physicalModel(ctx: ExtensionContext) {
  return isFast(ctx.model) ? ctx.modelRegistry.find("openai-codex", ctx.model!.id.slice(0, -FAST_SUFFIX.length))! : ctx.model!;
}
/** Add the service tier while preserving the physical model and sampling settings. */
export function priority(payload: unknown, fast: boolean): Record<string, any> {
  const body = payload as Record<string, any>;
  if (fast) body.service_tier = "priority";
  return body;
}

/** Expose Fast through Pi's model catalog and ordinary request hook. */
export function registerFast(pi: ExtensionAPI): void {
  /** The SDK resolves each returned model ID against its current configured catalog. */
  const register = (models: Model<Api>[]) => {
    for (const model of models.filter(m => m.provider === "openai-codex" && m.api !== "pi-virtual")) {
      pi.registerVirtualModel({
        provider: model.provider, id: model.id + FAST_SUFFIX, name: `${model.name} · Fast`,
        input: model.input, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
        thinkingLevels: getSupportedThinkingLevels(model),
        route: request => ({ model, thinkingLevel: request.thinkingLevel }),
      });
    }
  };
  register(getModels("openai-codex")); // Populate the GUI catalog before a session starts.
  pi.on("session_start", (_event, ctx) => register(ctx.modelRegistry.getAll())); // Include configured Codex models.
  pi.on("before_provider_request", (event, ctx) => { if (isCodex(ctx)) return priority(event.payload, isFast(ctx.model)); });
}
