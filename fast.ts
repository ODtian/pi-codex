import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const PROVIDER_OPTIONS = "pi-web:provider-options"; // The GUI owns session settings and native profile inheritance.
/** Read the current session's request option, with the configured model as its default. */
export function isFast(ctx: ExtensionContext): boolean {
  const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === PROVIDER_OPTIONS);
  const value = entry?.type === "custom" ? (entry.data as { serviceTier: string | null }).serviceTier : ctx.model?.samplingParams?.service_tier;
  return value === "priority";
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
/** Adapt the native provider option to Codex's request field. */
export function registerFast(pi: ExtensionAPI): void {
  pi.on("before_provider_request", (event, ctx) => { if (isCodex(ctx)) return priority(event.payload, isFast(ctx)); });
}
