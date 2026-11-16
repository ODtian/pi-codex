import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { State } from "./settings.ts";

const CONTEXT = "pi-codex:context-window"; // Distinguish local windows from encrypted remote checkpoints.
const NOTE = "pi-codex:notes"; // Notes follow the session branch through forks and window resets.
const tools = ["new_context", "history", "notes"]; // The experimental mode activates these tools together.
const result = (value: unknown) => ({ content: [{ type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value) }], details: {} }); // Use Pi's normal text tool result.

/** Read the latest note on the active branch. */
function notes(ctx: ExtensionContext): string {
  const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "custom" && e.customType === NOTE);
  return entry?.type === "custom" ? entry.data as string : "";
}
const details = { kind: CONTEXT, version: 1 }; // The marker selects local history recovery after the reset.

/** Register local window transitions and recovery tools; return the mode-change binding. */
export function registerContextManagement(pi: ExtensionAPI, get: () => State): () => void {
  let requested = false; // Commit a tool-requested reset after every sibling result has been recorded.
  const enabled = () => get().compaction === "experimental"; // Both context strategies read the same explicit selection.
  /** Apply the selected mode to Pi's active tool set. */
  const sync = () => {
    const active = pi.getActiveTools().filter(name => !tools.includes(name));
    pi.setActiveTools(enabled() ? [...active, ...tools] : active);
  };
  pi.registerTool({
    name: "new_context", label: "New context", description: "Start a fresh context window. Save task state with notes first; recover previous conversation with history afterwards. Environment files stay in place.",
    defaultActive: false, parameters: Type.Object({}),
    async execute() { requested = true; return result("A new context window starts after this tool batch. Continue using notes and history."); }, // The turn boundary owns the reset.
  });
  pi.registerTool({
    name: "history", label: "History", description: "Recover conversation from the current session branch. List recent entries or read one entry by its id. Images and private reasoning are omitted from this text view.",
    defaultActive: false, parameters: Type.Object({ id: Type.Optional(Type.String()), query: Type.Optional(Type.String()), limit: Type.Optional(Type.Number()) }),
    async execute(_id, args, _signal, _update, ctx) { // Read visible history directly from the canonical branch.
      const messages = ctx.sessionManager.getBranch().flatMap(e => {
        if (e.type !== "message" || e.message.role === "system") return [];
        const message = e.message as { role: string; content?: unknown };
        const content = Array.isArray(message.content) ? message.content.filter(block => block.type !== "thinking" && block.type !== "image").map(block => block.type === "text" ? block.text : block) : message.content;
        return [{ id: e.id, role: message.role, content }];
      });
      if (args.id) return result(messages.find(m => m.id === args.id));
      return result(messages.filter(m => !args.query || JSON.stringify(m.content).toLowerCase().includes(args.query.toLowerCase()))
        .slice(-(args.limit ?? 12)).map(m => ({ id: m.id, role: m.role, preview: JSON.stringify(m.content)?.slice(0, 400) })));
    },
  });
  pi.registerTool({
    name: "notes", label: "Notes", description: "Read persistent task notes, or replace them by supplying text. Record the goal, decisions and next steps before starting a new context window.",
    defaultActive: false, parameters: Type.Object({ text: Type.Optional(Type.String()) }),
    async execute(_id, args, _signal, _update, ctx) { // Store notes as ordinary branch entries.
      if (args.text !== undefined) pi.appendEntry(NOTE, args.text);
      return result(notes(ctx));
    },
  });
  pi.on("session_start", () => { requested = false; sync(); });
  pi.on("agent_end", () => { requested = false; });
  pi.on("before_agent_start", (event, ctx) => {
    if (enabled()) return { systemPrompt: `${event.systemPrompt}\n\nContext management: use notes to save durable task state, new_context to start a fresh window, and history to recover prior details. Save the goal, decisions and next steps before starting a new context. Context tokens used: ${ctx.getContextUsage()?.tokens ?? "unknown"}.` };
  });
  // Pi applies this self-retaining compaction atomically before the next provider request.
  pi.on("turn_end", (event, ctx) => {
    if (!enabled() || !requested) return;
    requested = false;
    return { entries: [...event.entries, { type: "compaction" as const, summary: "[New context window]", firstKeptEntryId: null, details }], continue: true };
  });
  // GUI and automatic compaction use the same local window mechanism.
  pi.on("session_before_compact", (event, ctx) => {
    if (!enabled()) return;
    requested = false;
    pi.appendEntry("pi-codex:compact-boundary", {});
    return { compaction: { summary: "[New context window]", firstKeptEntryId: ctx.sessionManager.getLeafId()!, tokensBefore: event.preparation.tokensBefore, details } };
  });
  // Reintroduce saved notes as a recovery hint while Pi restores the current system prompt.
  pi.on("context", (event, ctx) => {
    const last = ctx.sessionManager.getBranch().findLast(e => e.type === "compaction");
    if (last?.type !== "compaction" || (last.details as { kind?: string })?.kind !== CONTEXT) return;
    return { messages: event.messages.map(message => message.role === "compactionSummary" ? {
      role: "custom" as const, customType: CONTEXT, display: false, timestamp: Date.now(),
      content: `A new context window has started. Continue the task using notes and history.\nSaved notes:\n${notes(ctx)}`,
    } : message) };
  });
  return sync;
}
