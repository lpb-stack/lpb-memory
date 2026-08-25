import { existsSync, readFileSync, readdirSync } from "node:fs";
import * as fs from "node:fs/promises";
import { createHash } from "node:crypto";
import * as os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig, ThinkingLevel } from "../types.js";
import { AGENT_ROOT } from "../paths.js";
import { logMemory } from "../constants.js";

type ChildLlmConfig = Pick<MemoryConfig, "llmModelOverride" | "llmThinkingOverride" | "childExtensionPaths">;

export interface PiExecResult {
  code: number;
  stdout?: string;
  stderr?: string;
  killed?: boolean;
}

interface ExecChildPromptOptions {
  signal?: AbortSignal;
  timeoutMs: number;
  retryWithoutOverrides?: boolean;
}

interface ExecChildPromptDependencies {
  removeTemporaryDirectory: (dir: string) => Promise<void>;
}

const DEFAULT_EXEC_CHILD_PROMPT_DEPENDENCIES: ExecChildPromptDependencies = {
  removeTemporaryDirectory: async (dir) => {
    await fs.rm(dir, { recursive: true, force: true });
  },
};

// ── Shared subprocess gate ──────────────────────────────────────────────────
// Every `pi -p` subprocess (background review, correction, flush, and each
// consolidation batch) is serialized through this single lock. On a local LLM
// host, overlapping subprocesses trigger simultaneous model load/unload and
// risk OOM when large Qwen models cannot be resident at the same time. A single
// in-process promise-chain mutex caps concurrency at 1 without any external
// coordinator while keeping the parent session's event loop unblocked.
let subprocessChain: Promise<unknown> = Promise.resolve();

/**
 * Serialize child-subprocess invocations so only one `pi -p` spawn is in flight
 * at a time across the whole extension. Errors from one call do not break the
 * chain for subsequent callers.
 */
export function withSubprocessLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = subprocessChain.then(fn, fn);
  subprocessChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

const WATCHDOG_EXIT_GRACE_MS = 5000;
const CHILD_PROCESS_WATCHDOG_PATH = fileURLToPath(
  new URL("./child-process-watchdog.mjs", import.meta.url),
);
export interface ChildPiInvocation {
  command: string;
  args: string[];
}

interface ResolveChildPiInvocationOptions {
  platform?: NodeJS.Platform;
  execPath?: string;
  argv?: string[];
  piCliPath?: string | null;
}

const OVERRIDE_FAILURE_SUBJECT = /\b(model|provider|thinking)\b/i;
const OVERRIDE_FAILURE_REASON = /\b(not found|unknown|invalid|unsupported|unavailable|unrecognized|no match|no matches|cannot resolve|failed to resolve)\b/i;

// Resolve the path to lpb-memory's own extension entry point.
// Used to pass -e <path> to child subprocesses so they only load this
// extension instead of all plugins from settings.json.
const OWN_EXTENSION_PATH: string = (() => {
  try {
    return resolve(dirname(fileURLToPath(import.meta.url)), "../index.ts");
  } catch {
    return "";
  }
})();

function normalizedModelOverride(config: ChildLlmConfig): string | undefined {
  const trimmed = config.llmModelOverride?.trim();
  return trimmed ? trimmed : undefined;
}

function effectiveThinkingOverride(config: ChildLlmConfig): ThinkingLevel | undefined {
  return config.llmThinkingOverride ?? (normalizedModelOverride(config) ? "off" : undefined);
}

export function hasChildLlmOverrides(config: ChildLlmConfig): boolean {
  return normalizedModelOverride(config) !== undefined || effectiveThinkingOverride(config) !== undefined;
}

/** @deprecated No longer called after PR #78 — kept for API backward compat. */
export function inheritedExtensionArgs(argv: string[] = process.argv.slice(2)): string[] {
  const args: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const current = argv[i];
    if (current === "-e" || current === "--extension") {
      const next = argv[i + 1];
      if (typeof next === "string" && next.length > 0) {
        args.push(current, next);
        i++;
      }
      continue;
    }

    if (current.startsWith("--extension=")) {
      args.push(current);
    }
  }

  return args;
}

// Provider-auth-adapter packages (e.g. Anthropic/xAI/Codex OAuth) inject
// subscription billing headers via pi.registerProvider(). --no-extensions
// strips these from child `pi -p` subprocesses, which silently rebills
// subscription usage as pay-as-you-go "extra usage" instead (see issue #94).
//
// pi has no runtime API to enumerate loaded extensions or map a registered
// provider back to its extension file, so we can't ask pi "what adapter is
// active" directly. Instead we mirror pi's OWN static package-discovery
// convention (package.json -> "pi": { "extensions": [...] }, the same field
// lpb-memory's own package.json declares) and match sibling package
// names against a naming convention, so a future xai-oauth-adapter or
// pi-codex-oauth-adapter is picked up automatically without a code change
// here — no code execution, just JSON reads of sibling package.json files.
const AUTH_ADAPTER_NAME_PATTERNS: readonly RegExp[] = [
  /(^|[-/])oauth-adapter$/,
  /(^|[-/])auth-adapter$/,
];

function isAuthAdapterPackageName(name: string): boolean {
  return AUTH_ADAPTER_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

// Read a sibling package's "pi": { "extensions": [...] } manifest field —
// the same field pi's own loader reads — and resolve declared paths
// relative to that package's directory. Mirrors loader.js#resolveExtensionEntries.
function readPackageExtensionEntries(packageDir: string): string[] {
  const packageJsonPath = join(packageDir, "package.json");
  if (!existsSync(packageJsonPath)) return [];

  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
  } catch {
    return [];
  }

  const declaredExtensions = (manifest as { pi?: { extensions?: unknown } } | null)?.pi?.extensions;
  if (!Array.isArray(declaredExtensions)) return [];

  const entries: string[] = [];
  for (const relativePath of declaredExtensions) {
    if (typeof relativePath !== "string") continue;
    const resolved = resolve(packageDir, relativePath);
    if (existsSync(resolved)) entries.push(resolved);
  }
  return entries;
}

function scanRootForAuthAdapters(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const detected: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith("@")) {
      // Scoped org, e.g. @xai/pi-oauth-adapter — one extra level, no deeper.
      const scopeDir = join(root, entry);
      let scopedPackages: string[];
      try {
        scopedPackages = readdirSync(scopeDir);
      } catch {
        continue;
      }
      for (const scopedName of scopedPackages) {
        if (!isAuthAdapterPackageName(scopedName)) continue;
        detected.push(...readPackageExtensionEntries(join(scopeDir, scopedName)));
      }
      continue;
    }

    if (!isAuthAdapterPackageName(entry)) continue;
    detected.push(...readPackageExtensionEntries(join(root, entry)));
  }
  return detected;
}

// Provider packages (e.g. lemonade-pi-plugin) register a provider via
// pi.registerProvider(). --no-extensions strips these from child subprocesses,
// which means the subprocess has no provider registered and falls back to
// Pi's hardcoded default (Google), hitting an external endpoint and burning
// API credits instead of talking to the local LLM.
//
// We detect provider packages by scanning their extension entry points for
// the pi.registerProvider call. This is more robust than name-matching.
const PROVIDER_CALL_PATTERN = /pi\.registerProvider\b|registerProvider\(/;

function hasProviderRegistration(packageDir: string): boolean {
  try {
    const packageJsonPath = join(packageDir, "package.json");
    if (!existsSync(packageJsonPath)) return false;
    const manifest = JSON.parse(readFileSync(packageJsonPath, "utf-8"));
    const extensions = (manifest as { pi?: { extensions?: unknown } } | null)?.pi?.extensions;
    if (!Array.isArray(extensions)) return false;
    for (const relativePath of extensions) {
      if (typeof relativePath !== "string") continue;
      const resolved = resolve(packageDir, relativePath);
      if (!existsSync(resolved)) continue;
      try {
        const source = readFileSync(resolved, "utf-8");
        if (PROVIDER_CALL_PATTERN.test(source)) return true;
      } catch {
        // unreadable — skip
      }
    }
  } catch {
    // ignore
  }
  return false;
}

function scanRootForProviderExtensions(root: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return [];
  }

  const detected: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith("@")) {
      const scopeDir = join(root, entry);
      let scopedPackages: string[];
      try {
        scopedPackages = readdirSync(scopeDir);
      } catch {
        continue;
      }
      for (const scopedName of scopedPackages) {
        const pkgDir = join(scopeDir, scopedName);
        if (hasProviderRegistration(pkgDir)) {
          detected.push(...readPackageExtensionEntries(pkgDir));
        }
      }
      continue;
    }

    const pkgDir = join(root, entry);
    if (hasProviderRegistration(pkgDir)) {
      detected.push(...readPackageExtensionEntries(pkgDir));
    }
  }
  return detected;
}

// `roots` is overridable so tests can point this at fixture directories
// instead of the real sibling-packages trees. Two roots are scanned by
// default: packages installed alongside lpb-memory's own package
// (the common npm-managed-extensions layout), and AGENT_ROOT's npm
// directory (covers lpb-memory being loaded from elsewhere, e.g. a
// local dev checkout via -e, while the adapter is still npm-managed).
export function detectAuthAdapterExtensionPaths(roots?: string[]): string[] {
  const searchRoots = roots ?? [
    OWN_EXTENSION_PATH ? resolve(dirname(dirname(OWN_EXTENSION_PATH)), "..") : "",
    join(AGENT_ROOT, "npm", "node_modules"),
  ].filter((root) => root.length > 0);

  const seenRoots: string[] = [];
  const detected: string[] = [];
  for (const root of searchRoots) {
    if (seenRoots.includes(root)) continue;
    seenRoots.push(root);
    detected.push(...scanRootForAuthAdapters(root));
  }
  return detected;
}

/**
 * Detect provider plugin extensions that register a provider via
 * pi.registerProvider(). This ensures child subprocesses have the same
 * provider available as the parent — preventing them from falling back
 * to an external provider and burning API credits.
 */
export function detectProviderExtensionPaths(roots?: string[]): string[] {
  const searchRoots = roots ?? [
    join(AGENT_ROOT, "npm", "node_modules"),
    // Also scan sibling packages (covers git-installed extensions like
    // github.com/localpibox/lemonade-pi-plugin that live next to this
    // extension — same convention used by detectAuthAdapterExtensionPaths).
    OWN_EXTENSION_PATH ? resolve(dirname(dirname(OWN_EXTENSION_PATH)), "..") : "",
  ].filter((root) => root.length > 0);

  const seenPaths = new Set<string>();
  const detected: string[] = [];

  // Exclude paths already detected as auth adapters (they already register
  // their providers, so we don't load them twice).
  for (const p of detectAuthAdapterExtensionPaths(roots)) {
    seenPaths.add(resolve(p));
  }

  for (const root of searchRoots) {
    const providerEntries = scanRootForProviderExtensions(root);
    for (const ep of providerEntries) {
      const normalized = resolve(ep);
      if (!seenPaths.has(normalized)) {
        seenPaths.add(normalized);
        detected.push(normalized);
      }
    }
  }
  return detected;
}

function childExtensionPaths(config: ChildLlmConfig): string[] {
  const candidates = [
    OWN_EXTENSION_PATH,
    ...(config.childExtensionPaths ?? []),
    ...detectAuthAdapterExtensionPaths(),
    ...detectProviderExtensionPaths(),
  ];
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (!trimmed) continue;
    const normalized = resolve(trimmed);
    if (seen.has(normalized) || !existsSync(normalized)) continue;
    seen.add(normalized);
    paths.push(normalized);
  }
  return paths;
}

function appendOwnExtensionArgs(args: string[], config: ChildLlmConfig): void {
  // Skip all packages from settings.json (--no-extensions) — the subprocess
  // loads only Hermes, explicitly required provider adapters, and any
  // detected provider plugins (e.g. lemonade-pi-plugin). This ensures the
  // subprocess has the same provider available as the parent.
  args.push("--no-extensions");
  for (const extensionPath of childExtensionPaths(config)) {
    args.push("-e", extensionPath);
  }
}

export function buildChildPiPromptArgs(
  prompt: string,
  config: ChildLlmConfig,
  _argv: string[] = process.argv.slice(2),
): string[] {
  const args = ["-p", "--no-session"];
  const model = normalizedModelOverride(config);
  const thinking = effectiveThinkingOverride(config);

  // DEBUG: log what we're about to pass to pi -p
  if (model) {
    logMemory(`execChildPrompt: model=${model}, thinking=${thinking ?? 'off'}`);
  }

  // Skip --model for invalid identifiers (e.g., "unknown/unknown").
  // These appear when the parent session hasn't fully loaded its provider
  // yet — falling back to Pi's default model is safer than crashing.
  const isValidModel = model && !model.includes("unknown");
  if (isValidModel) args.push("--model", model);
  if (thinking) args.push("--thinking", thinking);
  appendOwnExtensionArgs(args, config);
  args.push(prompt);

  return args;
}

function basePromptArgs(prompt: string, config: ChildLlmConfig): string[] {
  // Always use --no-extensions + own path so the retry also avoids loading
  // all settings.json packages — matching the primary code path.
  const args = ["-p", "--no-session"];
  appendOwnExtensionArgs(args, config);
  args.push(prompt);
  return args;
}

function isCliJsPath(value: string | undefined): value is string {
  if (!value) return false;
  return value.replace(/\\/g, "/").toLowerCase().endsWith("/cli.js");
}

function resolvedInstalledPiCliPath(): string | undefined {
  try {
    const packageEntry = import.meta.resolve("@earendil-works/pi-coding-agent");
    const entryPath = fileURLToPath(packageEntry);
    const cliPath = join(dirname(entryPath), "cli.js");
    return existsSync(cliPath) ? cliPath : undefined;
  } catch {
    return undefined;
  }
}

function resolvedPiCliPath(options: ResolveChildPiInvocationOptions): string | undefined {
  if (options.piCliPath !== undefined) {
    return options.piCliPath ?? undefined;
  }

  const argv = options.argv ?? process.argv;
  const currentCli = argv[1];
  if (isCliJsPath(currentCli) && existsSync(currentCli)) {
    return currentCli;
  }

  return resolvedInstalledPiCliPath();
}

function resolvedWindowsPiInvocation(
  args: string[],
  execPath: string,
): ChildPiInvocation | undefined {
  const pathEntries = (process.env.PATH ?? process.env.Path ?? "")
    .split(";")
    .map((entry) => entry.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);

  for (const directory of pathEntries) {
    for (const executableName of ["pi.exe", "pi.com"]) {
      const executablePath = join(directory, executableName);
      if (existsSync(executablePath)) {
        return { command: executablePath, args };
      }
    }

    if (!existsSync(join(directory, "pi.cmd")) && !existsSync(join(directory, "pi.bat"))) {
      continue;
    }

    for (const cliPath of [
      join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"),
      join(directory, "node_modules", "@earendil-works", "pi-coding-agent", "cli.js"),
    ]) {
      if (existsSync(cliPath)) {
        return { command: execPath, args: [cliPath, ...args] };
      }
    }
  }

  return undefined;
}

export function resolveChildPiInvocation(
  args: string[],
  options: ResolveChildPiInvocationOptions = {},
): ChildPiInvocation {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") {
    return { command: "pi", args };
  }

  const piCliPath = resolvedPiCliPath(options);
  if (piCliPath) {
    return {
      command: options.execPath ?? process.execPath,
      args: [piCliPath, ...args],
    };
  }

  const fallback = resolvedWindowsPiInvocation(args, options.execPath ?? process.execPath);
  if (fallback) return fallback;

  throw new Error("Unable to resolve a directly executable Pi CLI on Windows");
}

export function resolveWatchedChildPiInvocation(
  invocation: ChildPiInvocation,
  timeoutMs: number,
  cancellationPath = "-",
): ChildPiInvocation {
  return {
    command: process.execPath,
    args: [
      CHILD_PROCESS_WATCHDOG_PATH,
      String(timeoutMs),
      cancellationPath,
      invocation.command,
      ...invocation.args,
    ],
  };
}

function shouldRetryWithoutOverridesFromText(text: string | undefined): boolean {
  if (!text) return false;
  return OVERRIDE_FAILURE_SUBJECT.test(text) && OVERRIDE_FAILURE_REASON.test(text);
}

function shouldRetryWithoutOverrides(result: PiExecResult): boolean {
  return shouldRetryWithoutOverridesFromText(result.stderr) || shouldRetryWithoutOverridesFromText(result.stdout);
}

function shouldRetryWithoutOverridesForError(error: unknown): boolean {
  return shouldRetryWithoutOverridesFromText(String(error));
}

// Shared temp dir for subprocess prompts — avoids accumulating orphaned
// mkdtemp directories when a subprocess hangs, times out, or the watchdog
// is killed. A single dir with hash-based filenames means identical prompts
// reuse the same file, and unique prompts get unique names without a counter.
const SUBPROCESS_PROMPT_DIR = join(os.tmpdir(), "lpb-memory-subprocess-prompts");

/**
 * How long to keep a subprocess prompt file after its invocation settles before
 * unlinking. The detached `pi` child reads the @file reference lazily, and
 * pi.exec resolves on the watchdog exit — deleting immediately can race that
 * read. Fire-and-forget cleanup uses unref() so this never holds the process.
 */
const SUBPROCESS_PROMPT_CLEANUP_GRACE_MS = 5000;

/** Ensure the shared prompt dir exists. Called once at first use. */
async function ensurePromptDir(): Promise<void> {
  await fs.mkdir(SUBPROCESS_PROMPT_DIR, { recursive: true });
}

/**
 * Write a prompt to a unique file in the shared temp dir.
 * Uses a hash-based filename so identical prompts reuse the same file,
 * and unique prompts get deterministic unique names.
 */
async function writePromptToSharedFile(prompt: string): Promise<{ filePath: string; cleanup: () => Promise<void> }> {
  await ensurePromptDir();
  // Hash the prompt for a deterministic unique name. Append random suffix
  // to handle hash collisions (extremely unlikely with SHA-256).
  const hash = createHash("sha256").update(prompt).digest("hex").slice(0, 16);
  const suffix = Math.random().toString(36).slice(2, 8);
  const fileName = `prompt-${hash}-${suffix}.md`;
  const filePath = join(SUBPROCESS_PROMPT_DIR, fileName);
  await fs.writeFile(filePath, prompt, { encoding: "utf-8", mode: 0o600 });
  return {
    filePath,
    cleanup: async () => {
      try { await fs.unlink(filePath); } catch {}
    },
  };
}

export async function execChildPrompt(
  pi: Pick<ExtensionAPI, "exec">,
  prompt: string,
  config: ChildLlmConfig,
  options: ExecChildPromptOptions,
  dependencies: ExecChildPromptDependencies = DEFAULT_EXEC_CHILD_PROMPT_DEPENDENCIES,
): Promise<PiExecResult> {
  // Serialize this invocation through the shared subprocess gate so that at most
  // one `pi -p` subprocess runs at a time across review/correction/flush/
  // consolidation — prevents overlapping model loads on a local LLM host.
  return withSubprocessLock(() => execChildPromptInner(pi, prompt, config, options, dependencies));
}

async function execChildPromptInner(
  pi: Pick<ExtensionAPI, "exec">,
  prompt: string,
  config: ChildLlmConfig,
  options: ExecChildPromptOptions,
  dependencies: ExecChildPromptDependencies = DEFAULT_EXEC_CHILD_PROMPT_DEPENDENCIES,
): Promise<PiExecResult> {
  const execOptions = {
    timeout: options.timeoutMs + WATCHDOG_EXIT_GRACE_MS,
  };
  // Use shared temp dir with unique file names — no orphaned directories.
  const promptFile = await writePromptToSharedFile(prompt);
  const promptReference = `@${promptFile.filePath}`;
  const cancellationPath = `${promptFile.filePath}.cancel`;
  const requestCancellation = () => {
    void fs.writeFile(cancellationPath, "", { mode: 0o600 }).catch(() => {});
  };
  options.signal?.addEventListener("abort", requestCancellation, { once: true });
  if (options.signal?.aborted) requestCancellation();

  try {
    try {
      const invocation = resolveWatchedChildPiInvocation(
        resolveChildPiInvocation(buildChildPiPromptArgs(promptReference, config)),
        options.timeoutMs,
        cancellationPath,
      );
      // DEBUG: log the actual args being passed to pi.exec
      logMemory(`execChildPrompt: command=${invocation.command}, args=${JSON.stringify(invocation.args)}`);
      const result = await pi.exec(invocation.command, invocation.args, execOptions) as PiExecResult;
      if (
        result.code === 0 ||
        !options.retryWithoutOverrides ||
        !hasChildLlmOverrides(config) ||
        !shouldRetryWithoutOverrides(result)
      ) {
        return result;
      }
    } catch (error) {
      if (
        !options.retryWithoutOverrides ||
        !hasChildLlmOverrides(config) ||
        !shouldRetryWithoutOverridesForError(error)
      ) {
        throw error;
      }
    }

    const retryInvocation = resolveWatchedChildPiInvocation(
      resolveChildPiInvocation(basePromptArgs(promptReference, config)),
      options.timeoutMs,
      cancellationPath,
    );
    return await pi.exec(retryInvocation.command, retryInvocation.args, execOptions) as PiExecResult;
  } finally {
    options.signal?.removeEventListener("abort", requestCancellation);
    // Clean up the prompt file and cancel marker after a short grace period.
    // pi.exec resolves when the *watchdog* process exits, which can be just
    // before the detached `pi` child finishes reading the @file reference. Deleting
    // it immediately races that read and surfaces as "File not found" in stderr.
    // Fire-and-forget so the caller (e.g. shutdown flush) isn't delayed by the grace.
    scheduleDelayedCleanup(promptFile.cleanup);
    void fs.unlink(cancellationPath).catch(() => {});
  }
}

/**
 * Delete a subprocess temp file after a grace period so a detached child that
 * reads the @file reference lazily has time to finish. Files are small and
 * named uniquely (hash + random suffix), so a short TTL does not cause
 * collisions; unref() keeps the process from being held open by the timer.
 */
function scheduleDelayedCleanup(cleanup: () => Promise<void>): void {
  const timer = setTimeout(() => {
    void cleanup().catch(() => {});
  }, SUBPROCESS_PROMPT_CLEANUP_GRACE_MS);
  timer.unref?.();
}

