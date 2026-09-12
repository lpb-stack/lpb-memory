/**
 * Footer status helpers — the "memory" status key shown in the pi footer
 * (and promoted into a dedicated powerline cell by the config repo's
 * powerline.customItems entry).
 *
 * Status is set plain (non-bracketed) on purpose: pi-powerline-footer treats
 * any "["-prefixed status text as a *notification* rendered as a standalone
 * line above the editor, while plain text flows into the footer bar.
 *
 * Two layers:
 * - Baseline (persistent, gated by config.footerStatus): entry count +
 *   project, e.g. "🧠 12 memories · devstack".
 * - Transient overrides: "🧠 memory: reviewing" / "🧠 memory: flushing".
 *   On completion the baseline is restored (or the key cleared when
 *   footerStatus is off).
 */

import type { MemoryStore } from "../store/memory-store.js";

export const MEMORY_STATUS_KEY = "memory";
export const REVIEWING_STATUS_TEXT = "🧠 memory: reviewing";
export const FLUSHING_STATUS_TEXT = "🧠 memory: flushing";

/** Minimal ctx shape needed to touch the footer status — keeps callers
 *  decoupled from the full ExtensionContext (stale-ctx safe: callers wrap
 *  the resulting call in try/catch). */
export type StatusCtx = {
  ui: { setStatus: (key: string, text: string | undefined) => void };
};

/**
 * Build the persistent baseline status text, or undefined when the
 * footerStatus flag is off.
 */
export function buildFooterStatusText(
  enabled: boolean,
  store: MemoryStore,
  projectStore: MemoryStore | null,
  projectName?: string | null,
): string | undefined {
  if (!enabled) return undefined;
  const count = store.getMemoryEntries().length + (projectStore?.getMemoryEntries().length ?? 0);
  const project = projectStore && projectName ? ` · ${projectName}` : "";
  return `🧠 ${count} memor${count === 1 ? "y" : "ies"}${project}`;
}

/**
 * Restore the baseline after a transient override (review/flush).
 * Falls back to clearing the status when no restorer is provided.
 */
export function restoreMemoryStatus(
  ctx: StatusCtx,
  restorer?: (ctx: StatusCtx) => void,
): void {
  if (restorer) {
    restorer(ctx);
    return;
  }
  ctx.ui.setStatus(MEMORY_STATUS_KEY, undefined);
}
