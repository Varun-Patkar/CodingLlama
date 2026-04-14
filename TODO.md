# CodingLlama — Phase Checklist

## Phase 1 — Ask Mode (Custom Webview Sidebar)
> Status: **Nominally Complete** — manual testing in progress

- [x] WebviewViewProvider registered in activity bar
- [x] Custom sidebar UI (HTML/CSS/JS via postMessage)
- [x] Streaming chat with Ollama (`/v1/chat/completions` SSE)
- [x] Session CRUD (create, switch, delete, rename)
- [x] Session persistence in globalState (50 max)
- [x] Model picker with static catalogue + tier badges
- [x] Model download with streaming progress (`/api/pull`)
- [x] Model auto-select on startup (best installed by tier)
- [x] File attachments (read file content into context)
- [x] Image attachments (persist to globalStorageUri, 30-day cleanup)
- [x] Editor selection attachment
- [x] Token counter (system prompt + history + input + attachments)
- [x] Auto-compact conversation at 90% token usage
- [x] System prompts (ask mode, title generator, compact)
- [x] Title generation via LLM on first message
- [x] Edit/resend user messages
- [x] Stop generation (AbortController)
- [x] Markdown rendering (vendored marked.js)
- [x] Code block syntax highlighting + copy button
- [x] Ollama health check on startup
- [x] VS Code CSS variable theming (dark/light compatible)
- [x] CSP + nonce security on webview
- [x] `retainContextWhenHidden: true`
- [x] Marketplace icon (logo.png) + activity bar SVG icon
- [x] Checkpoint restore (⏪ rewind to any message)
- [x] Redo stack after checkpoint restore
- [x] Fork conversation (🔀 branch from any message)
- [x] Stacking compaction (non-destructive summaries)
- [ ] Manual testing pass — verify all features end-to-end
- [ ] Bug fixes from manual testing

## Phase 2 — Plan Mode (Read-Only Workspace + Scoped Writes)
> Status: **Not Started**

- [ ] Mode tabs UI (Ask / Plan / Agent) — Plan tab enabled
- [ ] Tool-calling via Ollama's OpenAI-compatible endpoint
- [ ] `read_file` tool — read any workspace file
- [ ] `write_plan` tool — write only to `.copilot-plan/` folder
- [ ] Path sanitization guard on write_plan filenames
- [ ] Agentic loop (up to 10 iterations of tool calls)
- [ ] Tool-use rendering in chat (show which file was read/written)
- [ ] "Start Implementation" button after plan is complete
- [ ] Plan file viewer / diff display
- [ ] System prompt for plan mode
- [ ] Non-streaming `chatOllama()` for tool-call responses
- [ ] Fork support for plan exploration (namespace plan files per fork)
- [ ] Error handling for tool execution failures

## Phase 3 — Agent Mode (Full File System + Terminal Tools)
> Status: **Not Started**

- [ ] Agent tab enabled in mode switcher
- [ ] `edit_file` tool — WorkspaceEdit (undo-able, shows diff)
- [ ] `run_terminal` tool — send commands to terminal
- [ ] Terminal output capture via `child_process.exec`
- [ ] File-edit rollback on checkpoint restore
- [ ] File-edit replay on redo
- [ ] WorkspaceEdit integration (diff decorations, undo stack)
- [ ] Agent system prompt
- [ ] Safety confirmations before destructive operations
- [ ] Parallel streaming across multiple sessions
- [ ] Stream replay on session switch (accumulated content)

## Phase 4 — Custom Agents (User-Defined Agent Registry)
> Status: **Not Started**

- [ ] `AgentConfig` schema (id, name, systemPrompt, tools, model)
- [ ] Agent CRUD via VS Code settings (`codingLlama.agents`)
- [ ] Agent picker UI in webview (sidebar or separate tab)
- [ ] Per-agent tool restrictions (subset of available tools)
- [ ] Per-agent model override
- [ ] Agent import/export
