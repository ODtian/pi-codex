import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Container, SettingsList, Text } from "@earendil-works/pi-tui";
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
        const list = new SettingsList([
          { id: "fast", label: "Fast", currentValue: draft.fast ? "开启" : "关闭", values: ["关闭", "开启"], description: "为当前会话的模型请求选择优先服务层。" },
          { id: "review", label: "自动审查", currentValue: draft.review ? "开启" : "关闭", values: ["关闭", "开启"], description: "工具执行前，由 Codex 审查操作。" },
          { id: "compaction", label: "上下文策略", currentValue: CONTEXT_LABELS[draft.compaction], values: Object.values(CONTEXT_LABELS), description: "远程压缩生成加密摘要；实验性上下文管理通过笔记和历史切换窗口。" },
          { id: "save", label: "保存", currentValue: "保存并关闭", values: ["保存并关闭"] },
        ], 4, {
          label: (text, selected) => selected ? theme.fg("accent", text) : text,
          value: text => theme.fg("muted", text),
          description: text => theme.fg("dim", text),
          cursor: theme.fg("accent", "→ "),
          hint: text => theme.fg("dim", text),
        }, (id, next) => {
          if (id === "save") done(true);
          else if (id === "compaction") draft.compaction = next === CONTEXT_LABELS.remote ? "remote" : "experimental";
          else draft[id as "fast" | "review"] = next === "开启";
        }, () => done(false));
        if (key) list.selectItem(key);
        const panel = new Container(); // Use the host-provided theme in both the GUI adapter and Pi's terminal.
        panel.addChild(new Text(theme.fg("accent", "Codex 设置"), 1, 1));
        panel.addChild(list);
        return {
          render: width => panel.render(width),
          invalidate: () => panel.invalidate(),
          handleMouse: event => panel.handleMouse(event),
          handleInput: data => { if (data === "\x03") done(false); else list.handleInput(data); }, // The GUI's Close action sends Ctrl+C.
        };
      });
      if (!saved) return;
      if (draft.fast !== isFast(ctx)) await change("fast", draft.fast ? "on" : "off", ctx);
      if (draft.review !== initial.review || draft.compaction !== initial.compaction) set({ review: draft.review, compaction: draft.compaction }, ctx);
    },
  });
}
