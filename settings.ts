import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PROVIDER_OPTIONS, isCodex } from "./fast.ts";

export const SETTINGS = "pi-codex:settings"; // Store only review and context mode on the session branch.
export type State = { review: boolean; compaction: "remote" | "experimental" };
export type Config = {
  defaults: State;
  review: { model: string; serviceTier?: "priority"; reasoning: "low" | "medium" | "high"; timeoutMs: number; concurrency: number; tools: string[];
    policyFile: string; context?: { maxChars: number; entryChars: number } };
};
export const configPath = resolve(process.env.PI_CODEX_CONFIG || fileURLToPath(new URL("./config.json", import.meta.url)));
/** Read user-editable defaults and review options at use time. */
export function config(): Config { return JSON.parse(readFileSync(configPath, "utf8")); }
/** Resolve the policy beside its config so the package can move intact. */
export function policy(): string { return readFileSync(resolve(dirname(configPath), config().review.policyFile), "utf8"); }
/** Select current fields explicitly when reading an older session entry. */
export function restore(ctx: ExtensionContext): State {
  const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === SETTINGS);
  const value = entry?.type === "custom" ? entry.data as State : undefined;
  const defaults = config().defaults;
  return { review: value?.review ?? defaults.review, compaction: value?.compaction ?? defaults.compaction };
}
/** Show review and context strategy in the native extension status bar. */
export function status(ctx: ExtensionContext, state: State): void {
  ctx.ui.setStatus("pi-codex", `Codex · Review ${state.review ? "on" : "off"} · Context ${state.compaction}`);
}
/** Bind GUI dialogs and slash commands to the same configuration operations. */
export function registerSettings(pi: ExtensionAPI, get: () => State, set: (state: State, ctx: ExtensionContext) => void): void {
  pi.registerCommand("codex", {
    description: "Codex: fast on|off, review on|off, compaction remote|experimental",
    handler: async (args, ctx) => { // Fast writes the GUI's native request option; review and compaction stay plugin settings.
      let [key, value] = args.trim().split(/\s+/);
      if (!key) {
        const choice = await ctx.ui.select("Codex 设置", ["Fast", "Review", "Compaction"]);
        if (!choice) return;
        key = choice.toLowerCase();
      }
      const values = key === "compaction" ? ["remote", "experimental"] : ["on", "off"];
      if (!["fast", "review", "compaction"].includes(key)) throw new Error("Usage: /codex fast on|off; review on|off; compaction remote|experimental");
      value ||= await ctx.ui.select(key, values) as string;
      if (!value) return;
      if (!values.includes(value)) throw new Error(`Choose ${values.join(" | ")}`);
      if (key === "fast") {
        if (!isCodex(ctx)) throw new Error("Select an OpenAI Codex model first");
        pi.appendEntry(PROVIDER_OPTIONS, { serviceTier: value === "on" ? "priority" : null });
      } else {
        set({ ...get(), [key]: key === "review" ? value === "on" : value }, ctx);
      }
      ctx.ui.notify(`Codex：${key} = ${value}`, "info");
    },
  });
}
