# CodingLlama

A VS Code extension that replicates GitHub Copilot's chat experience using **local Ollama models** instead of cloud LLMs. Fully offline, fully private, fully yours.

## What It Does

CodingLlama adds a chat sidebar to VS Code — powered by your local Ollama server — with streaming responses, session history, model management, and file/image context. No API keys, no cloud, no telemetry.

## Current Status: Phase 1 — Ask Mode

Phase 1 is complete and functional. You can chat with local models, attach files and images, manage sessions, and get markdown-rendered responses with tables, code blocks, and more.

### Features

- **Custom Webview Sidebar** — not the VS Code Chat Participant API; we own 100% of the UI
- **Streaming Chat** — token-by-token streaming via Ollama's OpenAI-compatible endpoint
- **Model Picker** — 5 recommended models with tier badges, plus any other installed model. Download missing models with a click
- **Auto Model Selection** — picks the best installed model (high tier first)
- **Session Management** — up to 50 sessions persisted in globalState, with titles, timestamps, and full message history
- **File Context** — attach files via `+` button, 📎 file picker, right-click "Add to CodingLlama Chat" in explorer/editor, or editor selection auto-attach
- **Image Support** — paste or attach images for vision models (`-vl`), saved to persistent storage with 30-day retention, clickable modal preview
- **Token Counter** — pie chart showing system prompt + history + input + attachments vs. context window, with hover breakdown
- **Compact Conversation** — summarize long conversations to free up context window (manual or auto at 90%)
- **System Prompt** — built-in Ask mode prompt adapted from Copilot, branded as CodingLlama
- **Edit & Resend** — click any sent message to edit text, add/remove attachments, and resend
- **Stop Generation** — red stop button replaces send during streaming
- **Markdown Rendering** — full GFM support via `marked` library (tables, code blocks, strikethrough, blockquotes, etc.)
- **Ollama Health Check** — startup screen with platform-specific commands (PowerShell, CMD, Bash, Docker) including CORS setup
- **Mode Selector** — Ask/Plan/Agent dropup (Plan and Agent greyed out as "Coming soon")
- **VS Code Theme Integration** — all UI uses VS Code CSS variables for automatic light/dark/high-contrast support

### Settings

| Setting | Default | Description |
|---|---|---|
| `codingLlama.baseUrl` | `http://localhost:11434` | Ollama server URL |
| `codingLlama.model` | `qwen2.5-coder:7b` | Active model |

### Recommended Models

| Model | Tier | Size |
|---|---|---|
| Qwen 2.5 Coder 7B | 🟢 High | 4.7 GB |
| Qwen 2.5 Coder 3B | 🟡 Medium | 1.9 GB |
| DeepSeek Coder 6.7B | 🟢 High | 3.8 GB |
| Llama 3.2 3B | 🟡 Medium | 2.0 GB |
| Phi 3.5 3.8B | 🔴 Low | 2.2 GB |

## Roadmap

### Phase 2 — Plan Mode
- Read workspace files as context
- Write plans to `.copilot-plan/` folder only
- Tool-calling agentic loop (read_file, write_plan)
- "Start Implementation" button

### Phase 3 — Agent Mode
- Full file system access (read, create, edit, delete)
- Terminal command execution
- WorkspaceEdit integration (undo-able diffs)
- Multi-step agentic tool loop

### Phase 4 — Custom Agents
- User-defined agent registry
- Custom system prompts per agent
- Tool restrictions per agent
- Agent selector in the UI

## Architecture

```
src/
  extension.ts         — activate(), register WebviewViewProvider + commands
  sidebarProvider.ts   — WebviewViewProvider, message handler, streaming bridge
  ollamaClient.ts      — streamOllama, listModels, pullModel, checkOllama
  sessionManager.ts    — CRUD for sessions in globalState
  webviewHtml.ts       — getHtml(), CSP, nonce, script injection
  models.ts            — STATIC_MODELS array with tier/context data
  config.ts            — read/write VS Code settings
  prompts.ts           — system prompts (ask, title generator, compact)
media/
  main.js              — all webview-side JS (UI, postMessage, marked)
  style.css            — layout and VS Code variable-based theming
  marked.umd.js        — marked library for markdown rendering
  icon.svg             — activity bar icon
```

**Key architectural decision:** We use a `WebviewViewProvider` instead of the VS Code Chat Participant API. This gives us full control over the model picker, mode tabs, sessions panel, and input box — things the Chat API doesn't expose to extensions.

## Development

```bash
# Install dependencies
npm install

# Compile TypeScript
npm run compile

# Watch mode
npm run watch

# Launch Extension Development Host
# Press F5 in VS Code
```

### Prerequisites

- [VS Code](https://code.visualstudio.com/) 1.85+
- [Ollama](https://ollama.ai/) running locally
- At least one model pulled (e.g. `ollama pull qwen2.5-coder:7b`)

## Contributors

**Varun Anand Patkar**

[![LinkedIn](https://img.shields.io/badge/LinkedIn-0A66C2?style=flat&logo=linkedin&logoColor=white)](https://www.linkedin.com/in/varun-patkar/) [![GitHub](https://img.shields.io/badge/GitHub-181717?style=flat&logo=github&logoColor=white)](https://github.com/Varun-Patkar) [![Twitter](https://img.shields.io/badge/Twitter-1DA1F2?style=flat&logo=x&logoColor=white)](https://x.com/Varun_Patkar) [![Portfolio](https://img.shields.io/badge/Portfolio-000?style=flat&logo=vercel&logoColor=white)](https://varunpatkar.vercel.app/)

## License

MIT — see [LICENSE](LICENSE)
