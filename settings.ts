import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getKeybindings, Text } from "@earendil-works/pi-tui";
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
/** Bind the custom settings component and slash commands to the same session options. */
export function registerSettings(pi: ExtensionAPI, get: () => State, set: (state: State, ctx: ExtensionContext) => void): void {
  /** Apply a choice from either the command arguments or the settings panel. */
  const change = async (key: string, value: string, ctx: ExtensionContext) => {
    if (key === "fast") {
      if (!isCodex(ctx)) throw new Error("请先选择 OpenAI Codex 模型");
      await setFast(pi, ctx, value === "on");
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
      const [key, value] = args.trim().split(/\s+/);
      const values = VALUES[key];
      if (key && !values) throw new Error("用法：/codex fast on|off；review on|off；compaction remote|experimental");
      if (value) {
        if (!values.includes(value)) throw new Error(`请选择 ${values.join(" | ")}`);
        await change(key, value, ctx);
        return;
      }
      const initial = get(), draft = { ...initial, fast: isFast(ctx) }; // Commit the panel's choices together on Save.
      const saved = await ctx.ui.custom<boolean>((_tui, theme, _keys, done) => {
        const fields = ["fast", "review", "compaction", "save"] as const;
        const descriptions = ["为当前会话的模型请求选择优先服务层。", "工具执行前，由 Codex 审查操作。", "远程压缩生成加密摘要；实验性上下文管理通过笔记和历史切换窗口。", "保存当前会话的设置。"];
        const bindings = getKeybindings(), text = new Text();
        let selected = key ? fields.indexOf(key as typeof fields[number]) : 0;
        return {
          render: width => {
            // Equal ASCII prefixes align field labels across the GUI's Latin and CJK fonts.
            const rows = [`[${draft.fast ? "x" : " "}] Fast`, `[${draft.review ? "x" : " "}] 自动审查`, `[>] 上下文策略：${CONTEXT_LABELS[draft.compaction]}`, "[ 保存并关闭 ]"];
            const lines = rows.map((row, index) => index === selected ? theme.fg("accent", `> ${row}`) : `  ${row}`);
            lines.splice(3, 0, ""); // Separate the Save action from the three settings.
            text.setText([theme.fg("accent", "  Codex 设置"), "", ...lines, "", theme.fg("dim", `  ${descriptions[selected]}`), "", theme.fg("dim", "  ↑/↓ 选择 · Enter/空格 切换 · Esc 取消")].join("\n"));
            return text.render(width);
          },
          invalidate: () => text.invalidate(),
          handleInput: data => {
            if (data === "\x03" || bindings.matches(data, "tui.select.cancel")) done(false); // The GUI's Close action sends Ctrl+C.
            else if (bindings.matches(data, "tui.select.up")) selected = (selected + fields.length - 1) % fields.length;
            else if (bindings.matches(data, "tui.select.down")) selected = (selected + 1) % fields.length;
            else if (data === " " || bindings.matches(data, "tui.select.confirm")) {
              const field = fields[selected];
              if (field === "save") done(true);
              else if (field === "compaction") draft.compaction = draft.compaction === "remote" ? "experimental" : "remote";
              else draft[field] = !draft[field];
            }
          },
        };
      });
      if (!saved) return;
      if (draft.fast !== isFast(ctx)) await change("fast", draft.fast ? "on" : "off", ctx);
      if (draft.review !== initial.review || draft.compaction !== initial.compaction) set({ review: draft.review, compaction: draft.compaction }, ctx);
    },
  });
}
