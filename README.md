<div align="center">

# 🧠 lpb-memory

**Persistent memory + session search + background learning for [Pi](https://pi.dev)**

</div>

> **⚡ [← Back to LocalPibox](https://github.com/lpb-stack/devstack)** — project overview, architecture, and the full stack.

---

> **Origin:** This project originated from
> [chandra447/pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)
> (Pi Hermes Memory). It has been extensively refactored — architecture, storage,
> review mechanism, and configuration — and is now **fully detached from
> upstream**. It should be treated as an independent project.

## What it does

Your Pi agent normally forgets everything when you close a session. This
extension fixes that.

- 🔍 **Search every conversation** — "what did we discuss about auth?" finds it instantly
- 🧠 **Persistent memory** — facts, preferences, corrections survive across sessions
- ⚠️ **Learns from failures** — remembers what didn't work so you don't repeat mistakes
- ⚡ **Background learning** — subprocess-based reviews every 10 turns, saves what matters
- 🛡️ **Secret scanning** — API keys and tokens are blocked from being saved
- 📚 **Procedural skills** — the agent saves *how* it solved problems, not just what
- 🔄 **Auto-consolidation** — merges entries when full, never loses data

## Key differences from the original Hermes Memory

| Aspect | Original Hermes | lpb-memory |
|---|---|---|
| **Review transport** | In-process | **Subprocess** (`pi -p`) for context isolation |
| **Model override** | Limited | Full `llmModelOverride` / `llmThinkingOverride` |
| **Footer status** | Basic | Plain status text (`🧠 memory: reviewing`) — inline in the Pi powerline footer, not a bracketed notification line |
| **Configuration** | `lpb-memory-config.json` at extension root | Centralized in `~/.pi/agent/` via `pi-defaults.json` |
| **Spawn serialization** | Parallel (race-prone) | **Serialized** with review backoff |
| **Upstream** | Tracked `chandra447/pi-hermes-memory` | **Independent** — no upstream |

## Quick Start

```bash
# Install from LocalPibox fork
pi install git:github.com/lpb-stack/lpb-memory@main

# Index your past sessions (one-time)
/memory-index-sessions

# Backfill older Markdown memories into SQLite search (optional)
/memory-sync-markdown
```

## Features

| Feature | What happens |
|---|---|
| 🔍 **Session Search** | Search across all past conversations via SQLite FTS5 |
| 🧠 **Persistent Memory** | Facts, preferences, lessons saved to Markdown files |
| 🔄 **Memory Search Sync** | Successful Markdown writes mirrored into SQLite for `memory_search` |
| ⚠️ **Failure Memory** | Learn from failures — stores what didn't work and why |
| 📚 **Procedural Skills** | The agent saves *how* it solved problems as reusable docs |
| ⚡ **Background Learning** | Every 10 turns (or 15 tool calls) the agent reviews and saves |
| 🔧 **Correction Detection** | When you correct the agent, it saves immediately |
| 🔄 **Auto-Consolidation** | When memory hits capacity, auto-merges instead of erroring |
| 🛡️ **Secret Scanning** | API keys, tokens, SSH keys blocked from persistence |
| 📊 **Memory Aging** | Entries carry timestamps — consolidation knows what's stale |
| 🏗️ **Two-Tier Memory** | Global + per-project memory, both searchable |
| 💾 **Extended Store** | Unlimited searchable memories beyond core 5,000-char limit |
| 🎓 **Onboarding** | `/memory-interview` pre-fills your profile on first session |

## Memory Architecture

The extension manages three types of knowledge:

| Type | Storage | Scope |
|---|---|---|
| **Memory** | Markdown + SQLite | Global facts, project conventions, tool quirks |
| **User Profile** | Markdown + SQLite | Name, preferences, communication style |
| **Skills** | `SKILL.md` files | Reusable procedures and workflows |

### Two-Tier Storage

| Tier | Location | What goes here |
|---|---|---|
| **Global** | `~/.pi/agent/lpb-memory/` | Facts that apply everywhere |
| **Project** | `~/.pi/agent/projects-memory/<project>/` | Facts scoped to one codebase |

### Failure Memory Categories

| Category | What it stores | Example |
|---|---|---|
| `failure` | What didn't work and why | "Tried localStorage for tokens — XSS vulnerability" |
| `correction` | User corrections | "Use pnpm, not npm" |
| `insight` | Learnings from experience | "Auth0 SDK handles refresh tokens automatically" |
| `preference` | User preferences | "Prefers dark theme" |
| `convention` | Project conventions | "Monorepo uses turborepo" |
| `tool-quirk` | Tool-specific knowledge | "CI needs --frozen-lockfile" |

## Configuration

Configuration lives in `lpb-memory-config.json` (sourced from `~/.pi/agent/`):

```json
{
  "reviewTransport": "subprocess",
  "llmModelOverride": null,
  "llmThinkingOverride": "low",
  "reviewTimeoutMs": 300000,
  "consolidationTimeoutMs": 300000,
  "memoryPolicyStyle": "full"
}
```

| Setting | Values | Default | Description |
|---|---|---|---|
| `reviewTransport` | `"subprocess"`, `"direct"` | `"subprocess"` | How background reviews execute |
| `llmModelOverride` | `null` or `"provider/modelId"` | `null` | Model for review sessions |
| `llmThinkingOverride` | `"off"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"` | unset (inherit session) | Thinking level for reviews |
| `consolidationTimeoutMs` | milliseconds | `300000` (5 min) | Timeout for consolidation |
| `reviewTimeoutMs` | milliseconds | `300000` (5 min) | Timeout for background review subprocess and direct calls — tune for NPU cold load times |
| `memoryPolicyStyle` | `"full"`, `"compact"`, `"custom"`, `"none"` | `"full"` | System prompt verbosity (used when `memoryMode` is `policy-only`) |

## Development

```bash
git clone https://github.com/lpb-stack/lpb-memory.git
cd lpb-memory
npm install
npm run check
npm test
```

### Local testing

```bash
pi -e /path/to/lpb-memory/src/index.ts
```

## License

See [LICENSE](LICENSE).
