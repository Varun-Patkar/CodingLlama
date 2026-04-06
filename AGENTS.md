# AGENTS.md — CodingLlama (v0.1.0, Phase 1: Ask Mode)

## Project Overview
CodingLlama is a VS Code extension that provides a Copilot-like chat sidebar powered by local Ollama models. Phase 1 (Ask Mode) is complete. No tools, no file editing — read-only Q&A only.

## Architecture
- **NO Chat Participant API** — all UI is a custom `WebviewViewProvider` in the activity bar
- Extension host (TypeScript) ↔ Webview (plain JS) communicate via `postMessage`
- Ollama is accessed via HTTP (OpenAI-compatible `/v1/chat/completions` for streaming, `/v1/models` for listing, `/api/pull` for downloading)
- Sessions stored in `context.globalState`, images stored on disk under `context.globalStorageUri/images/`

## File Map
| File | Role | Max ~Lines |
|---|---|---|
| `src/extension.ts` | Entry point, registers provider + commands | ~60 |
| `src/sidebarProvider.ts` | WebviewViewProvider, message handler, streaming bridge, image persistence | ~500 |
| `src/ollamaClient.ts` | HTTP client: stream, list, pull, health check | ~170 |
| `src/sessionManager.ts` | Session CRUD on globalState (50 max) | ~110 |
| `src/webviewHtml.ts` | Generates webview HTML with CSP, nonce, script injection | ~80 |
| `src/models.ts` | Static model catalogue (5 models with tier + context size) | ~35 |
| `src/config.ts` | VS Code settings wrapper | ~20 |
| `src/prompts.ts` | System prompts: ask, title generator, compact conversation | ~90 |
| `media/main.js` | Webview-side JS: UI rendering, postMessage protocol, marked integration | ~1400 |
| `media/style.css` | CSS with VS Code variable theming | ~1000 |
| `media/marked.umd.js` | Vendored marked library (do not edit) | N/A |

## Key Conventions
- **500 line limit** per meaningful source file (excluding boilerplate). `media/main.js` and `media/style.css` are exceptions since they're monolithic webview files
- **Docstrings** on every function
- **No extra .md files** besides README.md and AGENTS.md
- **VS Code CSS variables** for all theming — never hardcode colors
- **`retainContextWhenHidden: true`** on the webview provider to preserve state
- **`saveSession(session)`** to persist — never `save(getAll())` which loses mutations

## Important Patterns
- **Streaming flow:** `send` → `streamStart` → N × `streamToken` → `streamEnd` → `activeSession` (updated)
- **`justFinishedStreaming` flag:** prevents `activeSession` from re-rendering the chat area after stream ends (avoids flicker/disappearing content). Only skips render if same session ID
- **Image persistence:** Images saved to `globalStorageUri/images/{timestamp}-{name}`. Cleaned up after 30 days on activation. Paths resolved via `webview.asWebviewUri()` for rendering
- **Token counter:** Counts system prompt + history + input + attachments + selection. Auto-compacts at 90%
- **Model auto-select:** On startup, picks best installed static model by tier (high > medium > low), falls back to first installed

## Build & Test
```bash
npm install
npm run compile    # tsc -p ./
# Press F5 to launch Extension Development Host
```

## Current Phase Scope
**Included:** Sidebar UI, streaming chat, sessions, model picker + download, file/image attachments, token counter, compact conversation, system prompts, edit/resend, stop generation, markdown rendering, Ollama health check

**Excluded (future phases):** Plan mode, Agent mode, tool calling, file editing, terminal execution, custom agents, inline completions, tests, CI/CD, VSIX packaging
