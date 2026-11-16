import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { config, registerSettings, restore, SETTINGS } from "./settings.ts";
import { registerReview } from "./review.ts";
import { registerCompaction } from "./compact.ts";
import { registerFast } from "./fast.ts";
import { registerContextManagement } from "./context.ts";

/** Bind the independent features to one Pi extension instance. */
export default function codex(pi: ExtensionAPI): void {
  registerFast(pi);
  let state = structuredClone(config().defaults); // Model selection and inheritance belong to Pi.
  pi.on("session_start", (_event, ctx) => {
    state = restore(ctx);
    pi.appendEntry(SETTINGS, state);
  });
  pi.on("session_tree", (_event, ctx) => { state = restore(ctx); syncContext(); });
  registerSettings(pi, () => state, value => {
    state = value;
    pi.appendEntry(SETTINGS, state);
    syncContext();
  });
  registerReview(pi, () => state);
  registerCompaction(pi, () => state);
  const syncContext = registerContextManagement(pi, () => state);
}
