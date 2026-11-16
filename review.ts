import { SessionManager, createReadTool, createGrepTool, createFindTool, createLsTool,
  type ExtensionAPI, type ExtensionContext, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { cleanupSessionResources, validateToolCall, type Message, type ToolCall } from "@earendil-works/pi-ai";
import { config, policy, type State } from "./settings.ts";
import { FAST_SUFFIX, priority } from "./fast.ts";

type Decision = { outcome: "allow" | "deny"; rationale?: string };
type Evidence = { role: string; content: unknown };

type Job = { run: (lane: number) => Promise<unknown>; resolve: (value: any) => void; reject: (error: unknown) => void };
type Slot = { busy: boolean; prepared?: Promise<unknown> };
type Pool = { slots: Slot[]; jobs: Job[]; users: number };
const pool: Pool = (globalThis as any)[Symbol.for("pi-codex:review-connections")] ??= { slots: [], jobs: [], users: 0 }; // Share transport connections across loaded sessions.
const connectionId = (lane: number) => `pi-codex-review-${lane}`; // Stable IDs let the SDK reuse WebSockets.

/** Dispatch waiting reviews through the single concurrency limit. */
function dispatch(): void {
  for (const [lane, slot] of pool.slots.entries()) {
    if (slot.busy || !pool.jobs.length) continue;
    const job = pool.jobs.shift()!;
    slot.busy = true;
    void job.run(lane).then(job.resolve, job.reject).finally(() => { slot.busy = false; dispatch(); });
  }
}

/** Reserve a connection lane for an actual review or a generate:false warmup. */
function schedule<T>(count: number, run: (lane: number) => Promise<T>): Promise<T> {
  while (pool.slots.length < count) pool.slots.push({ busy: false });
  return new Promise<T>((resolve, reject) => { pool.jobs.push({ run, resolve, reject }); dispatch(); });
}

/** Render evidence with its original role and visible content. */
function transcript(messages: { role: string; content?: unknown; summary?: string; sections?: unknown }[]): Evidence[] {
  return messages.map(message => ({
    role: message.role === "system" ? "developer" : message.role,
    content: message.sections ?? (Array.isArray(message.content)
      ? message.content.filter(block => block.type !== "thinking").map(block => block.type === "image" ? { type: "text", text: "[image]" } : block)
      : message.content ?? message.summary),
  }));
}

/** Preserve user instructions first, then fill the configured budget with recent evidence. */
function limitHistory(entries: Evidence[]): Evidence[] {
  const limits = config().review.context;
  if (!limits) return entries;
  const bounded = entries.map(entry => {
    const text = JSON.stringify(entry.content) ?? "";
    return text.length > limits.entryChars && entry.role !== "user"
      ? { ...entry, content: text.slice(0, limits.entryChars / 2) + "\n[review context truncated]\n" + text.slice(-limits.entryChars / 2) }
      : entry;
  });
  let remaining = limits.maxChars;
  const selected = new Set<number>();
  const users = bounded.flatMap((entry, i) => entry.role === "user" ? [i] : []);
  for (const i of [...users, ...bounded.map((_, i) => i).reverse()]) {
    if (selected.has(i)) continue;
    const size = JSON.stringify(bounded[i]).length;
    if (remaining >= size || bounded[i].role === "user") { selected.add(i); remaining -= size; }
  }
  return bounded.filter((_, i) => selected.has(i));
}

/** Recover authorization evidence across both supported context strategies. */
function sessionTranscript(manager: ExtensionContext["sessionManager"]): Evidence[] {
  const branch = manager.getBranch();
  const compacted = branch.findLast(e => e.type === "compaction");
  const native = compacted?.type === "compaction" ? compacted.details as { kind?: string; input?: { role: string; content: unknown }[] } : undefined;
  const retained = native?.kind === "pi-codex" ? native.input!.filter(m => ["user", "developer", "system"].includes(m.role)) : [];
  if (native?.kind === "pi-codex:context-window") retained.push(...branch.flatMap(e =>
    e.type === "message" && e.message.role === "user" ? [{ role: "user", content: e.message.content }] : []));
  const result = transcript([...retained, ...manager.buildSessionProjection().messages]);
  if (manager.getHeader()?.parentSession) {
    const delegated = result.find(e => e.role === "user");
    if (delegated) delegated.role = "delegated";
  }
  return result;
}

/** Follow the SDK's session ancestry when the current task was delegated. */
function parentHistory(manager: ExtensionContext["sessionManager"]): Evidence[] {
  const file = manager.getHeader()?.parentSession;
  if (!file) return [];
  const parent = SessionManager.open(file);
  return limitHistory([...parentHistory(parent), ...sessionTranscript(parent)]);
}

/** Decode the official allow/deny contract, including a fenced JSON response. */
function parseDecision(text: string): Decision {
  const value = JSON.parse(text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1));
  if (value.outcome !== "allow" && value.outcome !== "deny") throw new Error("Reviewer must return allow or deny");
  return value;
}

/** Use the official review request; an absent action prepares the connection only. */
function assess(event: undefined, ctx: ExtensionContext, history: Evidence[], signal: AbortSignal, lane: number): Promise<void>;
function assess(event: ToolCallEvent, ctx: ExtensionContext, history: Evidence[], signal: AbortSignal, lane: number): Promise<Decision>;
async function assess(event: ToolCallEvent | undefined, ctx: ExtensionContext, history: Evidence[], signal: AbortSignal, lane: number): Promise<Decision | void> {
  const options = config().review;
  const slash = options.model.indexOf("/");
  const provider = options.model.slice(0, slash), selectedId = options.model.slice(slash + 1), id = selectedId.replace(/:fast$/, "");
  const base = ctx.modelRegistry.find(provider, id) ?? ctx.modelRegistry.getAll().find(m => m.provider === provider)!;
  const model = { ...base, id };
  const tools = [createReadTool(ctx.cwd), createGrepTool(ctx.cwd), createFindTool(ctx.cwd), createLsTool(ctx.cwd)];
  const messages: Message[] = event ? [
    { role: "user", content: JSON.stringify({ parent_transcript: parentHistory(ctx.sessionManager), transcript: history }), timestamp: Date.now() },
    { role: "user", content: JSON.stringify({ planned_action: { tool: event.toolName, arguments: event.input, cwd: ctx.cwd } }), timestamp: Date.now() },
  ] : [];
  for (;;) {
    signal.throwIfAborted();
    const answer = await ctx.modelRegistry.streamSimple(model, { systemPrompt: policy(), messages, tools }, {
      signal, reasoning: options.reasoning, transport: "auto", sessionId: connectionId(lane),
      headers: { "x-openai-internal-codex-responses-lite": "true" },
      onPayload: payload => {
        const body = payload as Record<string, any>;
        // Match Codex's Responses Lite request layout for codex-auto-review.
        const prefix = [];
        if (body.instructions) prefix.push({ type: "message", role: "developer", content: [{ type: "input_text", text: body.instructions }] });
        if (body.tools?.length) prefix.push({ type: "additional_tools", role: "developer", tools: body.tools });
        body.input = [...prefix, ...body.input];
        delete body.instructions;
        delete body.tools;
        body.parallel_tool_calls = false;
        body.reasoning = { effort: options.reasoning, context: "all_turns" };
        body.client_metadata = { ...body.client_metadata, ws_request_header_x_openai_internal_codex_responses_lite: "true" };
        if (!event) body.generate = false;
        body.text = { format: { type: "json_schema", name: "approval", strict: false, schema: {
          type: "object", additionalProperties: false,
          properties: { outcome: { type: "string", enum: ["allow", "deny"] }, rationale: { type: "string" },
            risk_level: { type: "string", enum: ["low", "medium", "high", "critical"] },
            user_authorization: { type: "string", enum: ["unknown", "low", "medium", "high"] } },
          required: ["outcome"],
        } } };
        return priority(body, selectedId.endsWith(FAST_SUFFIX));
      },
    }).result();
    signal.throwIfAborted();
    if (answer.stopReason === "error" || answer.stopReason === "aborted") throw new Error(answer.errorMessage || answer.stopReason);
    if (!event) return;
    const calls = answer.content.filter((block): block is ToolCall => block.type === "toolCall");
    if (!calls.length) return parseDecision(answer.content.filter(b => b.type === "text").map(b => b.text).join("\n"));
    messages.push(answer);
    messages.push(...await Promise.all(calls.map(async (call): Promise<Message> => {
      const tool = tools.find(t => t.name === call.name)!;
      let result;
      try { result = await tool.execute(call.id, validateToolCall(tools, call), signal); }
      catch (error) { signal.throwIfAborted(); result = { content: [{ type: "text" as const, text: String(error) }], isError: true }; }
      return { role: "toolResult", toolCallId: call.id, toolName: call.name, content: result.content, isError: result.isError ?? false, timestamp: Date.now() };
    })));
  }
}

/** Gate tools on full decisions and prepare sibling reviews before sequential SDK checks. */
export function registerReview(pi: ExtensionAPI, get: () => State): void {
  type Result = { decision?: Decision; error?: string };
  let attached = false; // Count each live extension instance once for connection cleanup.
  let batch: { key: string | null; controller: AbortController; pending: Map<string, { input: string; result: Promise<Result> }> } | undefined;
  const clear = () => { batch?.controller.abort(); batch = undefined; }; // A new turn cancels its unused prefetches.
  pi.on("session_start", () => { clear(); if (!attached) { attached = true; pool.users++; } });
  pi.on("session_shutdown", () => {
    clear();
    if (attached && --pool.users === 0) pool.slots.forEach((slot, lane) => {
      cleanupSessionResources(connectionId(lane)); slot.prepared = undefined;
    });
    attached = false;
  });
  // Overlap connection preparation with the main agent's inference.
  pi.on("agent_start", (_event, ctx) => {
    if (!get().review) return;
    const review = config().review, count = review.concurrency;
    if (!pi.getActiveTools().some(name => review.tools.includes("*") || review.tools.includes(name))) return;
    while (pool.slots.length < count) pool.slots.push({ busy: false });
    for (const slot of pool.slots) slot.prepared ??= schedule(count, lane =>
      assess(undefined, ctx, [], AbortSignal.timeout(config().review.timeoutMs), lane)).catch(() => { slot.prepared = undefined; });
  });
  pi.on("agent_end", clear);
  pi.on("input", clear);
  pi.on("tool_call", async (event, ctx) => {
    const state = get(), options = config().review;
    if (!state.review || !(options.tools.includes("*") || options.tools.includes(event.toolName))) return;
    const started = Date.now();
    const messages = ctx.sessionManager.buildSessionProjection().messages;
    const history = limitHistory(sessionTranscript(ctx.sessionManager));
    const key = ctx.sessionManager.getLeafId(); // Reassess after earlier tool results change the available evidence.
    if (batch?.key !== key) clear();
    /** Give each action one shared deadline for queueing, review and investigation. */
    async function run(action: ToolCallEvent, batchSignal?: AbortSignal): Promise<Result> {
      const timeout = AbortSignal.timeout(options.timeoutMs);
      const signal = AbortSignal.any([timeout, ...(ctx.signal ? [ctx.signal] : []), ...(batchSignal ? [batchSignal] : [])]);
      try { return { decision: await schedule(options.concurrency, lane => assess(action, ctx, history, signal, lane)) }; }
      catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
    }
    if (!batch && !event.parentToolCallId) {
      const owner = messages.findLast(m => m.role === "assistant" && m.content.some(b => b.type === "toolCall" && b.id === event.toolCallId));
      const calls = owner?.role === "assistant" ? owner.content.filter((b): b is ToolCall => b.type === "toolCall") : [];
      const controller = new AbortController(), pending = new Map<string, { input: string; result: Promise<Result> }>();
      batch = { key, controller, pending };
      // The shared queue already limits concurrency; submit sibling reviews directly.
      for (const call of calls.filter(c => options.tools.includes("*") || options.tools.includes(c.name))) {
        const action = { ...event, toolCallId: call.id, toolName: call.name, input: structuredClone(call.arguments) } as ToolCallEvent;
        pending.set(call.id, { input: JSON.stringify([action.toolName, action.input]), result: run(action, controller.signal) });
      }
    }
    const pending = event.parentToolCallId ? undefined : batch?.pending.get(event.toolCallId);
    batch?.pending.delete(event.toolCallId);
    const result = pending?.input === JSON.stringify([event.toolName, event.input]) ? await pending.result : await run(event);
    const ms = Date.now() - started;
    ctx.ui.setStatus("pi-codex-review", `Review · ${result.decision?.outcome ?? "error"} · ${event.toolName} · ${ms}ms`);
    if (result.error) return { block: true, reason: `Codex review: ${result.error}` };
    if (result.decision?.outcome === "deny") return { block: true, reason: result.decision.rationale || "Codex review: deny" };
  });
}
