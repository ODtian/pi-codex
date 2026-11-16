import { convertToLlm, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { cleanupSessionResources, getInitialSystemMessage } from "@earendil-works/pi-ai";
import type { State } from "./settings.ts";
import { isCodex, isFast, priority } from "./fast.ts";

type Item = Record<string, any>;
type Checkpoint = { kind: "pi-codex"; version: 1; model: string; input: Item[] };
const SUMMARY = "[Codex remote compaction v2 checkpoint]"; // Pi displays this marker; the provider receives the encrypted payload.

/** Read the active remote checkpoint from the same branch Pi is replaying. */
function checkpoint(ctx: ExtensionContext): Checkpoint | undefined {
  const entry = ctx.sessionManager.getBranch().findLast(e => e.type === "compaction");
  if (entry?.type === "compaction" && (entry.details as Checkpoint)?.kind === "pi-codex") return entry.details as Checkpoint;
}

/** Codex V2 keeps recent user messages alongside the opaque compaction item. */
function retainedUsers(input: Item[]): Item[] {
  let remaining = 20_000 * 4;
  const kept: Item[] = [];
  for (const item of input.slice().reverse()) {
    if (item.role === "developer" || item.role === "system") { kept.push(item); continue; }
    if (item.role !== "user" || remaining <= 0) continue;
    const size = JSON.stringify(item).length;
    if (size <= remaining) { kept.push(item); remaining -= size; }
    else {
      const copy = structuredClone(item);
      let chars = remaining;
      copy.content = copy.content.flatMap((part: Item) => {
        if (part.type !== "input_text" || chars <= 0) return [];
        const text = part.text.slice(0, chars); chars -= text.length;
        return [{ ...part, text: text + "\n[retained user text truncated]" }];
      });
      kept.push(copy); remaining = 0;
    }
  }
  return kept.reverse();
}

/** Merge the remote-protocol feature into Pi's outgoing headers. */
function beta(headers: Record<string, string | null>): void {
  const key = Object.keys(headers).find(k => k.toLowerCase() === "x-codex-beta-features") ?? "x-codex-beta-features";
  headers[key] = [...new Set([...(headers[key] ?? "").split(",").filter(Boolean), "remote_compaction_v2"])].join(",");
}

/** Route GUI and automatic compaction through Codex and persist the returned checkpoint. */
export function registerCompaction(pi: ExtensionAPI, get: () => State): void {
  pi.on("session_shutdown", (_event, ctx) => cleanupSessionResources(`${ctx.sessionManager.getSessionId()}-compact`));
  pi.on("context", (event, ctx) => {
    if (isCodex(ctx) && checkpoint(ctx)) return { messages: event.messages.filter(m => m.role !== "compactionSummary") };
  });
  pi.on("before_provider_request", (event, ctx) => {
    if (!isCodex(ctx)) return;
    const body = event.payload as Item, saved = checkpoint(ctx);
    if (saved) body.input = [...saved.input, ...body.input];
    return body;
  });
  pi.on("before_provider_headers", (event, ctx) => { if (isCodex(ctx) && (get().compaction === "remote" || checkpoint(ctx))) beta(event.headers); });
  pi.on("session_before_compact", async (event, ctx) => {
    if (!isCodex(ctx)) return;
    if (get().compaction !== "remote") return;
    try {
      const saved = checkpoint(ctx);
      const messages = convertToLlm(ctx.sessionManager.buildSessionProjection().messages.filter(m => !saved || m.role !== "compactionSummary"));
      const active = new Set(pi.getActiveTools());
      const context = { messages, ...(!getInitialSystemMessage(messages) ? { systemPrompt: ctx.getSystemPrompt(), tools: pi.getAllTools().filter(t => active.has(t.name)) } : {}) };
      let history: Item[] = [], compacted: Item | undefined; // Capture the SDK's wire input and Codex's completed compaction item.
      const answer = await ctx.modelRegistry.streamSimple(ctx.model!, context, {
        signal: event.signal, transport: "auto", sessionId: `${ctx.sessionManager.getSessionId()}-compact`,
        headers: { "x-codex-beta-features": "remote_compaction_v2" },
        onPayload: payload => {
          const body = payload as Item;
          history = [...(saved?.input ?? []), ...body.input];
          body.input = [...history, { type: "compaction_trigger" }];
          if (event.customInstructions) body.instructions += `\n\nCompaction guidance:\n${event.customInstructions}`;
          return priority(body, isFast(ctx));
        },
        onProviderStreamEvent: data => {
          const e = data as Item;
          if (e.type === "response.output_item.done" && e.item.type === "compaction") compacted = e.item;
          if (e.type === "response.completed") compacted ??= e.response.output?.find((item: Item) => item.type === "compaction");
        },
      }).result();
      if (answer.stopReason === "error" || answer.stopReason === "aborted") throw new Error(answer.errorMessage || answer.stopReason);
      if (!compacted?.encrypted_content) throw new Error("Codex returned no encrypted compaction checkpoint");
      const input = [...retainedUsers(history), compacted];
      // An empty custom entry marks the end of the history consumed by Codex.
      pi.appendEntry("pi-codex:compact-boundary", {});
      return { compaction: {
        summary: SUMMARY,
        firstKeptEntryId: ctx.sessionManager.getLeafId()!,
        tokensBefore: event.preparation.tokensBefore,
        estimatedTokensAfter: Math.ceil(JSON.stringify(input).length / 4),
        usage: answer.usage,
        details: { kind: "pi-codex", version: 1, model: ctx.model!.id, input } satisfies Checkpoint,
      } };
    } catch (error) {
      // Pi's extension dispatcher absorbs thrown errors; cancel explicitly to retain this strategy.
      ctx.ui.notify(`Codex compact: ${error instanceof Error ? error.message : String(error)}`, "error");
      return { cancel: true };
    }
  });
}
