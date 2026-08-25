/**
 * Background review — learning loop that auto-saves memory every N turns.
 * Ported from hermes-agent/run_agent.py (_spawn_background_review, _memory_nudge_interval).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 *
 * Default transport: in-process complete() side-channel (preserves parent LLM cache).
 * Fallback: pi.exec("pi", ["-p", ...]) subprocess when direct path is unavailable.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { COMBINED_REVIEW_PROMPT, DIRECT_REVIEW_SYSTEM_PROMPT } from "../constants.js";
import { logMemory } from "../constants.js";
import { MemoryStore } from "../store/memory-store.js";
import { describeExitCode, formatSubprocessError } from "./error-codes.js";
import { DatabaseManager } from "../store/db.js";
import type { ConfigOrProvider, MemoryConfig } from "../types.js";
import { resolveConfig } from "../types.js";
import { applyRecentMessageLimit, collectMessageParts } from "./message-parts.js";
import { execChildPrompt, type PiExecResult } from "./pi-child-process.js";
import { runDirectMemoryCompletion, usesDirectTransport, type DirectReviewResult } from "./review-memory-ops.js";

export interface BackgroundReviewOptions {
  dbManager?: DatabaseManager | null;
  projectName?: string | null;
  deps?: BackgroundReviewDeps;
}

export interface BackgroundReviewDeps {
  runDirectReview?: typeof runDirectMemoryCompletion;
  execChildPrompt?: typeof execChildPrompt;
  /** Test-only hook: called once runReview() has fully settled (after the
   * fire-and-forget review work completes and reviewInProgress resets),
   * since production callers never await runReview() directly. */
  onReviewSettled?: () => void;
}

export interface ReviewPromptInput {
  parts: string[];
  currentMemory: string;
  currentUser: string;
  currentProject: string | null;
  /** Brief summary of what the last review extracted (to avoid duplicates). */
  lastReviewSummary?: string | null;
}

export function buildSubprocessReviewPrompt(input: ReviewPromptInput): string {
  const reviewPrompt = [
    COMBINED_REVIEW_PROMPT,
    "",
    "--- Current Memory ---",
    input.currentMemory || "(empty)",
    "",
    "--- Current User Profile ---",
    input.currentUser || "(empty)",
  ];

  if (input.currentProject !== null) {
    reviewPrompt.push(
      "",
      "--- Current Project Memory ---",
      input.currentProject || "(empty)",
    );
  }

  if (input.lastReviewSummary) {
    reviewPrompt.push(
      "",
      "--- Previous Review Summary ---",
      input.lastReviewSummary,
      "",
      "(Do NOT duplicate entries already in current memory. These were extracted in the last review.)",
    );
  }

  reviewPrompt.push(
    "",
    "--- Conversation to Review ---",
    input.parts.join("\n\n"),
  );

  return reviewPrompt.join("\n");
}

export function buildDirectReviewUserPrompt(input: ReviewPromptInput): string {
  const sections = [
    "--- Current Memory ---",
    input.currentMemory || "(empty)",
    "",
    "--- Current User Profile ---",
    input.currentUser || "(empty)",
  ];

  if (input.currentProject !== null) {
    sections.push(
      "",
      "--- Current Project Memory ---",
      input.currentProject || "(empty)",
    );
  }

  if (input.lastReviewSummary) {
    sections.push(
      "",
      "--- Previous Review Summary ---",
      input.lastReviewSummary,
      "",
      "(Do NOT duplicate entries already in current memory. These were extracted in the last review.)",
    );
  }

  sections.push(
    "",
    "--- Conversation to Review ---",
    input.parts.join("\n\n"),
  );

  return sections.join("\n");
}

function shouldNotifyDirect(result: DirectReviewResult): boolean {
  return result.ok && result.appliedCount > 0;
}

function shouldNotifySubprocess(stdout: string | undefined): boolean {
  const output = stdout?.trim();
  return !!output && !output.toLowerCase().includes("nothing to save");
}

async function runSubprocessReview(
  pi: ExtensionAPI,
  prompt: string,
  config: MemoryConfig,
  execChild: typeof execChildPrompt,
): Promise<PiExecResult> {
  // Disable thinking during review — the review prompt is a mechanical
  // "extract durable facts" task. Thinking wastes ~15-20k tokens per
  // operation and contributes to context overflow when the prompt is large.
  // This mirrors the Qwen compaction mitigation (disable thinking during
  // summary generation).
  // Timeout set to configurable reviewTimeoutMs to accommodate cold NPU model loads.
  const subprocessConfig = { ...config };
  logMemory(`backgroundReview subprocess: model=${config.llmModelOverride ?? 'inherited'}, thinking=${config.llmThinkingOverride ?? 'inherited'}`);
  return execChild(pi, prompt, subprocessConfig, {
    signal: undefined,
    timeoutMs: config.reviewTimeoutMs ?? 300000,
  });
}

export function setupBackgroundReview(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  config: ConfigOrProvider<MemoryConfig>,
  options: BackgroundReviewOptions = {},
): void {
  const dbManager = options.dbManager ?? null;
  const projectName = options.projectName ?? null;
  const runDirectReview = options.deps?.runDirectReview ?? runDirectMemoryCompletion;
  const execChild = options.deps?.execChildPrompt ?? execChildPrompt;
  const onReviewSettled = options.deps?.onReviewSettled;

  let turnsSinceReview = 0;
  let toolCallsSinceReview = 0;
  let userTurnCount = 0;
  let reviewInProgress = false;
  // Consecutive failed reviews. Drives exponential backoff so a persistently
  // broken subprocess (e.g. unreachable model) doesn't spawn a wasteful local-LLM
  // subprocess every few turns forever.
  let consecutiveFailures = 0;
  let lastReviewSummary: string | null = null;

  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role === "user") {
      userTurnCount++;
    }
  });

  pi.on("turn_end", async (event, ctx) => {
    const cfg = resolveConfig(config);
    turnsSinceReview++;

    if (!cfg.reviewEnabled) return;
    if (reviewInProgress) return;

    try {
      const msg = event.message;
      if (msg?.role === "assistant") {
        const content = msg?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && typeof block === "object" && block.type === "toolCall") {
              toolCallsSinceReview++;
            }
          }
        }
      }
    } catch {
      // If we can't count tool calls, fall back to turn-based only
    }

    // Exponential backoff on the turn threshold: each consecutive failure
    // doubles the effective interval (capped at 8x the base) so a broken path
    // stops hammering the local LLM. Tool-call threshold is unaffected.
    const backoffFactor = Math.min(Math.pow(2, consecutiveFailures), 8);
    const effectiveNudgeInterval = Math.max(
      cfg.nudgeInterval,
      Math.round(cfg.nudgeInterval * backoffFactor),
    );
    const turnThresholdMet = turnsSinceReview >= effectiveNudgeInterval;
    const toolCallThresholdMet = toolCallsSinceReview >= cfg.nudgeToolCalls;

    if (!turnThresholdMet && !toolCallThresholdMet) return;
    if (userTurnCount < 3) return;

    logMemory(`backgroundReview: threshold met (turns=${turnsSinceReview}/${effectiveNudgeInterval}, toolCalls=${toolCallsSinceReview}/${cfg.nudgeToolCalls}, consecutiveFailures=${consecutiveFailures})`);

    turnsSinceReview = 0;
    toolCallsSinceReview = 0;
    reviewInProgress = true;

    // Show status in footer so user knows review is in progress (not stuck)
    ctx.ui.setStatus("memory", "[reviewing]");

    let allParts: string[] = [];
    try {
      const entries = ctx.sessionManager.getBranch();
      allParts = collectMessageParts(entries);
    } catch {
      reviewInProgress = false;
      ctx.ui.setStatus("memory", undefined);
      return;
    }
    if (allParts.length < 4) {
      reviewInProgress = false;
      ctx.ui.setStatus("memory", undefined);
      return;
    }

    const parts = applyRecentMessageLimit(allParts, cfg.reviewRecentMessages);
    const promptInput: ReviewPromptInput = {
      parts,
      currentMemory: store.getMemoryEntries().join("\n§\n"),
      currentUser: store.getUserEntries().join("\n§\n"),
      currentProject: projectStore ? projectStore.getMemoryEntries().join("\n§\n") : null,
      lastReviewSummary,
    };

    const subprocessPrompt = buildSubprocessReviewPrompt(promptInput);
    const directPrompt = buildDirectReviewUserPrompt(promptInput);

    const finishReview = () => {
      reviewInProgress = false;
      // Wrap in try/catch — ctx may be stale if session was replaced during review.
      // Stale ctx would throw "stale after session replacement" error.
      try { ctx.ui.setStatus("memory", undefined); } catch {}
      onReviewSettled?.();
    };

    const notifyIfSaved = (saved: boolean) => {
      if (saved) {
        ctx.ui.notify("💾 Memory auto-reviewed and updated", "info");
      }
    };

    // Build a brief summary of what this review extracted (for next review).
    // Used to avoid duplicate extraction in subsequent reviews.
    const buildReviewSummary = (result: DirectReviewResult | null, subprocessStdout?: string): string => {
      if (result && result.appliedCount > 0) {
        const adds = result.operations?.filter(o => o.action === "add").length ?? 0;
        const replaces = result.operations?.filter(o => o.action === "replace").length ?? 0;
        const removes = result.operations?.filter(o => o.action === "remove").length ?? 0;
        return `Extracted: ${adds} add, ${replaces} replace, ${removes} remove.`;
      }
      if (subprocessStdout) {
        const output = subprocessStdout.trim();
        if (output.toLowerCase().includes("nothing to save")) {
          return "No durable facts found.";
        }
        // Subprocess may have output other than JSON operations — summarize.
        return `Subprocess output: ${output.slice(0, 200)}...`;
      }
      return "Review completed (no changes).";
    };

    const runReview = async (): Promise<void> => {
      if (usesDirectTransport(cfg)) {
        try {
          // Disable thinking for direct review too — prevents overflow when
          // the prompt includes the full conversation context. Mirrors the
          // Qwen compaction mitigation (disable thinking during summary gen).
          const reviewConfig = { ...cfg };
          logMemory(`backgroundReview: attempting direct transport review`);
          const directResult = await runDirectReview(
            ctx as Pick<ExtensionContext, "model" | "modelRegistry">,
            store,
            projectStore,
            { userPrompt: directPrompt, systemPrompt: DIRECT_REVIEW_SYSTEM_PROMPT, config: reviewConfig, timeoutMs: reviewConfig.reviewTimeoutMs ?? 300000 },
            dbManager,
            projectName,
          );

          if (directResult.ok) {
            consecutiveFailures = 0;
            logMemory(`backgroundReview: direct transport review result: ok=${directResult.ok}, applied=${directResult.appliedCount}`);
            notifyIfSaved(shouldNotifyDirect(directResult));
            // Capture summary for next review
            lastReviewSummary = buildReviewSummary(directResult);
            return;
          }

          if (directResult.fallbackReason === "empty") {
            logMemory(`backgroundReview: direct transport review skipped (empty)`, "warn");
            return;
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // Don't propagate stale-context errors — they mean the session was
          // replaced/reloaded and the memory extension's captured ctx is now
          // invalid. Continuing is correct: the session will get a fresh ctx.
          const isStaleCtx = errMsg.includes("stale after session replacement");
          if (isStaleCtx) {
            logMemory(`backgroundReview: direct transport review skipped (stale ctx, session was replaced)`, "warn");
          } else {
            logMemory(`backgroundReview: direct transport review failed, falling back to subprocess: ${errMsg}`, "error");
          }
        }
      }

      // Guard: check if the session context is still accessible before
      // spawning a subprocess review. If ctx was invalidated (session
      // replacement), the exec call would throw "stale ctx".
      try {
        ctx.sessionManager.getBranch();
      } catch {
        logMemory(`backgroundReview: session ctx unavailable (likely replaced), skipping subprocess review`, "warn");
        return;
      }

      logMemory(`backgroundReview: executing subprocess review`);
      const subprocessResult = await runSubprocessReview(pi, subprocessPrompt, cfg, execChild);
      if (subprocessResult.code === 0) {
        consecutiveFailures = 0;
        logMemory(`backgroundReview: subprocess review succeeded`);
        notifyIfSaved(shouldNotifySubprocess(subprocessResult.stdout));
        lastReviewSummary = buildReviewSummary(null, subprocessResult.stdout);
      } else {
        consecutiveFailures++;
        const errorMsg = formatSubprocessError(subprocessResult.code, subprocessResult.stdout, subprocessResult.stderr);
        logMemory(`backgroundReview: subprocess review failed (consecutiveFailures=${consecutiveFailures}): ${errorMsg}`, "error");
        lastReviewSummary = `Review failed (code=${subprocessResult.code}).`;
      }
    };

    runReview()
      .catch((err) => {
        // Log the error before swallowing — critical for debugging failed reviews.
        const errMsg = err instanceof Error ? err.message : String(err);
        const isStaleCtx = errMsg.includes("stale after session replacement");
        if (isStaleCtx) {
          logMemory(`backgroundReview: session replaced during review, review skipped`, "warn");
        } else {
          logMemory(`backgroundReview: review failed with error: ${errMsg}`, "error");
        }
      })
      .finally(() => {
        // Use inline arrow + try/catch to handle stale ctx in finishReview.
        // The named function would re-capture ctx which could be stale by then.
        try { finishReview(); } catch {}
      });
  });
}