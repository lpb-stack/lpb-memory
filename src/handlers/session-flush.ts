/**
 * Session flush — gives the agent one turn to save memories before context is lost.
 * Ported from hermes-agent/run_agent.py (flush_memories).
 * See PLAN.md → "Hermes Source File Reference Map" for source lines.
 *
 * Default transport: in-process direct completion (same mechanism as
 * background review — see review-memory-ops.ts). Falls back to a `pi -p`
 * subprocess only if direct mode fails or reviewTransport forces subprocess.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryStore } from "../store/memory-store.js";
import { DatabaseManager } from "../store/db.js";
import { DIRECT_FLUSH_SYSTEM_PROMPT, ENTRY_DELIMITER, FLUSH_PROMPT, logMemory } from "../constants.js";
import type { ConfigOrProvider, MemoryConfig } from "../types.js";
import { resolveConfig } from "../types.js";
import { collectMessageParts } from "./message-parts.js";
import { execChildPrompt } from "./pi-child-process.js";
import { runDirectMemoryCompletion, usesDirectTransport } from "./review-memory-ops.js";
import { FLUSHING_STATUS_TEXT, MEMORY_STATUS_KEY, restoreMemoryStatus, type StatusCtx } from "./footer-status.js";

function buildDirectFlushUserPrompt(
  store: MemoryStore,
  projectStore: MemoryStore | null,
  parts: string[],
): string {
  const sections = [
    "--- Current Memory ---",
    store.getMemoryEntries().join(ENTRY_DELIMITER) || "(empty)",
    "",
    "--- Current User Profile ---",
    store.getUserEntries().join(ENTRY_DELIMITER) || "(empty)",
  ];

  if (projectStore) {
    sections.push(
      "",
      "--- Current Project Memory ---",
      projectStore.getMemoryEntries().join(ENTRY_DELIMITER) || "(empty)",
    );
  }

  sections.push(
    "",
    "--- Conversation ---",
    parts.join("\n\n"),
  );

  return sections.join("\n");
}

export function setupSessionFlush(
  pi: ExtensionAPI,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  config: ConfigOrProvider<MemoryConfig>,
  dbManager: DatabaseManager | null = null,
  projectName?: string | null,
  deps: { runDirectMemoryCompletion?: typeof runDirectMemoryCompletion; restoreFooterStatus?: (ctx: StatusCtx) => void } = {},
): void {
  let userTurnCount = 0;
  const runDirect = deps.runDirectMemoryCompletion ?? runDirectMemoryCompletion;

  pi.on("message_end", async (event, _ctx) => {
    if (event.message.role === "user") userTurnCount++;
  });

  /** Shared flush logic — builds conversation snapshot and saves memories */
  async function flush(
    ctx: Pick<ExtensionContext, "sessionManager" | "model" | "modelRegistry" | "ui">,
    signal?: AbortSignal,
    timeoutMs = 30000,
  ): Promise<void> {
    const cfg = resolveConfig(config);
    if (userTurnCount < cfg.flushMinTurns) return;

    logMemory(`sessionFlush: starting (timeout=${timeoutMs}ms, turns=${userTurnCount})`);

    // Transient footer status so the flush is visible (same pattern as
    // background review); the baseline is restored when the flush settles.
    try { ctx.ui.setStatus(MEMORY_STATUS_KEY, FLUSHING_STATUS_TEXT); } catch {}
    try {
      await doFlush(ctx, signal, timeoutMs);
    } finally {
      try { restoreMemoryStatus(ctx, deps.restoreFooterStatus); } catch {}
    }
  }

  async function doFlush(
    ctx: Pick<ExtensionContext, "sessionManager" | "model" | "modelRegistry" | "ui">,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<void> {
    const cfg = resolveConfig(config);

    let entries;
    try {
      entries = ctx.sessionManager.getBranch();
    } catch {
      logMemory(`sessionFlush: failed to get branch, context stale`, "warn");
      return; // Context already stale
    }

    const parts = collectMessageParts(entries, cfg.flushRecentMessages);

    if (usesDirectTransport(cfg)) {
      try {
        // Disable thinking during flush — the prompt includes the full
        // conversation context, so thinking would waste ~15-20k tokens
        // and contribute to context overflow.
        const flushConfig = { ...cfg };
        const directResult = await runDirect(
          ctx,
          store,
          projectStore,
          {
            systemPrompt: DIRECT_FLUSH_SYSTEM_PROMPT,
            userPrompt: buildDirectFlushUserPrompt(store, projectStore, parts),
            config: flushConfig,
            timeoutMs,
            signal,
          },
          dbManager,
          projectName,
        );
        logMemory(`sessionFlush: direct transport result ok=${directResult.ok}`);
        if (directResult.ok) return;
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        logMemory(`sessionFlush: direct transport failed, falling back to subprocess: ${errMsg}`, "warn");
      }
    }

    const flushMessage = [
      FLUSH_PROMPT,
      "",
      "--- Conversation ---",
      parts.join("\n\n"),
    ].join("\n");

    try {
      // Disable thinking for subprocess flush too
      const flushConfig = { ...cfg };
      await execChildPrompt(pi, flushMessage, flushConfig, {
        signal,
        timeoutMs,
      });
      logMemory(`sessionFlush: subprocess succeeded`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      logMemory(`sessionFlush: subprocess failed: ${errMsg}`, "warn");
      // Best-effort flush — never block shutdown
    }
  }

  // Flush before compaction (can afford to wait)
  pi.on("session_before_compact", async (event, ctx) => {
    if (!resolveConfig(config).flushOnCompact) return;
    await flush(ctx, event.signal, 30000);
  });

  // Flush before session shutdown — await so we know flush completes before
  // the next shutdown handler (in index.ts) closes the DB. The 10s timeout
  // keeps this from blocking Pi's shutdown for too long.
  pi.on("session_shutdown", async (event, ctx) => {
    if (!resolveConfig(config).flushOnShutdown) return;
    await flush(ctx, undefined, 10000).catch(() => {});
  });
}
