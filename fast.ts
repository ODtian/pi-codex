import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const FAST = "pi-codex:fast"; // Persist the request option across session reloads.
/** Read the selected model's request parameter, which native model inheritance already carries. */
export function isFast(ctx: ExtensionContext): boolean {
  return ctx.model?.samplingParams?.service_tier === "priority";
}
/** Restrict the request option to the Codex provider. */
export function isCodex(ctx: ExtensionContext): boolean { return ctx.model?.provider === "openai-codex"; }
/** Apply Fast as a request parameter while preserving the selected model ID. */
export function priority(payload: unknown, fast: boolean): Record<string, any> {
  const body = payload as Record<string, any>;
  if (fast) body.service_tier = "priority";
  else delete body.service_tier;
  return body;
}
/** Copy this session's model with a request option; native child creation inherits that model. */
export async function setFast(pi: ExtensionAPI, ctx: ExtensionContext, fast: boolean): Promise<void> {
  const samplingParams = { ...ctx.model!.samplingParams };
  if (fast) samplingParams.service_tier = "priority";
  else delete samplingParams.service_tier;
  const thinking = pi.getThinkingLevel(); // A request option keeps the user's current reasoning level.
  if (!await pi.setModel({ ...ctx.model!, samplingParams })) throw new Error("Codex authentication is required");
  pi.setThinkingLevel(thinking);
}
/** Restore the session option and adapt it to the provider request through existing extension hooks. */
export function registerFast(pi: ExtensionAPI): void {
  const restore = async (_event: unknown, ctx: ExtensionContext) => {
    if (!isCodex(ctx)) return;
    const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === FAST);
    if (entry?.type === "custom") {
      if (entry.data !== isFast(ctx)) await setFast(pi, ctx, entry.data as boolean);
    } else pi.appendEntry(FAST, isFast(ctx)); // Save inherited model options before the first child request.
  };
  pi.on("session_start", restore);
  pi.on("session_tree", restore);
  pi.on("model_select", (_event, ctx) => { if (isCodex(ctx)) pi.appendEntry(FAST, isFast(ctx)); });
  pi.on("before_provider_request", (event, ctx) => { if (isCodex(ctx)) return priority(event.payload, isFast(ctx)); });
}
