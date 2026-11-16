import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { setFast, isFast, isCodex } from "./fast.ts";

export const SETTINGS = "pi-codex:settings"; // Store only review and context mode on the session branch.
const CONTEXT_LABELS = { remote: "远程压缩", experimental: "实验性上下文管理" };
const VALUES: Record<string, string[]> = { fast: ["on", "off"], review: ["on", "off"], compaction: Object.keys(CONTEXT_LABELS) };
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
/** Show the current request option and plugin settings in the existing status bar. */
export function status(ctx: ExtensionContext, state: State): void {
  ctx.ui.setStatus("pi-codex", `Codex · Fast ${isFast(ctx) ? "开启" : "关闭"} · 审查${state.review ? "开启" : "关闭"} · ${CONTEXT_LABELS[state.compaction]}`);
}
/** Bind GUI dialogs and slash commands to the same configuration operations. */
export function registerSettings(pi: ExtensionAPI, get: () => State, set: (state: State, ctx: ExtensionContext) => void): void {
  /** Apply a choice from either the command arguments or the settings panel. */
  const change = async (key: string, value: string, ctx: ExtensionContext) => {
    if (key === "fast") {
      if (!isCodex(ctx)) throw new Error("请先选择 OpenAI Codex 模型");
      await setFast(pi, ctx, value === "on");
      status(ctx, get());
    } else set({ ...get(), [key]: key === "review" ? value === "on" : value }, ctx);
  };
  pi.registerCommand("codex", {
    description: "Codex 设置：Fast、自动审查、上下文策略",
    getArgumentCompletions: prefix => { // Pi's native argument completion replaces the complete argument prefix.
      const [key, value] = prefix.trimStart().split(/\s+/);
      const items = value === undefined ? Object.keys(VALUES) : (VALUES[key] ?? []).map(option => `${key} ${option}`);
      return items.filter(item => item.startsWith(prefix.trimStart())).map(item => ({ value: item, label: item }));
    },
    handler: async (args, ctx) => {
      const [key, requestedValue] = args.trim().split(/\s+/);
      if (!key) {
        for (;;) { // Reopen the same panel with the updated values after each selection.
          const state = get(), fast = isFast(ctx);
          const rows = [
            { key: "fast", value: fast ? "off" : "on", label: `Fast：${fast ? "开启" : "关闭"}` },
            { key: "review", value: state.review ? "off" : "on", label: `自动审查：${state.review ? "开启" : "关闭"}` },
            { key: "compaction", value: state.compaction === "remote" ? "experimental" : "remote", label: `上下文策略：${CONTEXT_LABELS[state.compaction]}` },
          ];
          const selected = await ctx.ui.select("Codex 设置 · 点击切换", [...rows.map(row => row.label), "完成"]);
          const row = rows.find(row => row.label === selected);
          if (!row) return;
          await change(row.key, row.value, ctx);
        }
      }
      const values = VALUES[key];
      if (!values) throw new Error("用法：/codex fast on|off；review on|off；compaction remote|experimental");
      const value = requestedValue || await ctx.ui.select(key, values);
      if (!value) return;
      if (!values.includes(value)) throw new Error(`请选择 ${values.join(" | ")}`);
      await change(key, value, ctx);
    },
  });
}
