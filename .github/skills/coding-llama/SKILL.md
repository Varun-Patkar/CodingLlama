---
name: coding-llama
description: >
  Complete technical reference for building the CodingLlama VS Code extension
  that replicates GitHub Copilot using local Ollama models instead of cloud LLMs.
  Uses a fully custom Webview sidebar (NOT the VS Code Chat Participant API) so
  we own 100% of the UI — model picker, mode tabs, sessions panel, everything.
  Covers all four build phases: Ask Mode (custom sidebar webview, no tools),
  Plan Mode (read-only workspace + scoped write to .copilot-plan/), Agent Mode
  (full file system + terminal tools), and Custom Agents (user-defined agent registry).
  Use this skill whenever building, scaffolding, debugging, or extending the
  CodingLlama extension. Also use when working on any VS Code extension that
  uses WebviewViewProvider, WorkspaceEdit, terminal execution, or tool-calling
  via Ollama's OpenAI-compatible endpoint.
---

# CodingLlama — Build Reference

This skill is the complete technical reference for building the CodingLlama
VS Code extension. We use a **custom Webview sidebar** — NOT the VS Code Chat
Participant API. This is the correct architectural choice because:

- The Chat Participant API does not allow customising the model picker, toolbar,
  or mode switcher. Those are first-party VS Code chrome only.
- A `WebviewViewProvider` registered in the activity bar gives us full HTML/CSS/JS
  control: mode tabs, sessions list, model dropdown, download progress — everything.

No internet access is assumed during implementation. All API signatures,
patterns, and code samples are self-contained here.

---

## Project Architecture Overview

```
CodingLlama/
├── src/
│   ├── extension.ts          # activate(), register WebviewViewProvider + commands
│   ├── sidebarProvider.ts    # WebviewViewProvider — owns the webview lifecycle
│   ├── ollamaClient.ts       # fetch wrapper: stream, list models, pull model
│   ├── sessionManager.ts     # CRUD sessions in globalState
│   ├── tools/
│   │   ├── readFile.ts       # Phase 2: read workspace files
│   │   ├── writePlan.ts      # Phase 2: write to .copilot-plan/ only
│   │   ├── editFile.ts       # Phase 3: WorkspaceEdit
│   │   └── runTerminal.ts    # Phase 3: terminal execution
│   ├── planFolder.ts         # .copilot-plan/ helpers
│   └── config.ts             # reads/writes VS Code settings
├── media/
│   └── main.js               # webview-side JavaScript (runs in iframe)
├── package.json
└── tsconfig.json
```

---

## package.json — Required Fields

```json
{
  "name": "coding-llama",
  "publisher": "your-publisher-id",
  "engines": { "vscode": "^1.85.0" },
  "activationEvents": ["onStartupFinished"],
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        {
          "id": "codingLlama",
          "title": "CodingLlama",
          "icon": "media/icon.svg"
        }
      ]
    },
    "views": {
      "codingLlama": [
        {
          "type": "webview",
          "id": "codingLlama.chatView",
          "name": "Chat"
        }
      ]
    },
    "commands": [
      { "command": "codingLlama.newChat",    "title": "New Chat",    "icon": "$(add)" },
      { "command": "codingLlama.clearChats", "title": "Clear All Sessions" }
    ],
    "menus": {
      "view/title": [
        {
          "command": "codingLlama.newChat",
          "when": "view == codingLlama.chatView",
          "group": "navigation"
        }
      ]
    },
    "configuration": {
      "title": "CodingLlama",
      "properties": {
        "codingLlama.baseUrl": {
          "type": "string",
          "default": "http://localhost:11434",
          "description": "Ollama server base URL"
        },
        "codingLlama.model": {
          "type": "string",
          "default": "qwen2.5-coder:7b",
          "description": "Active Ollama model"
        }
      }
    }
  }
}
```

**Key notes:**
- `viewsContainers.activitybar` adds our icon to the left activity bar (like the Explorer icon).
- `views.codingLlama` registers a `type: "webview"` view — VS Code renders it using our provider.
- Do NOT register `chatParticipants` — we are fully bypassing that API.
- `"engines": { "vscode": "^1.85.0" }` — WebviewViewProvider has been stable since 1.56;
  1.85 is a safe modern minimum.

---

## Phase 1 — Ask Mode (Custom Webview Sidebar)

### Goal
Full custom UI in the sidebar. User can type messages, select a model, attach file content
manually, and get a streaming response from Ollama. Sessions are saved locally.
No VS Code Chat API used anywhere.

---

### Core API: WebviewViewProvider

```typescript
// sidebarProvider.ts
import * as vscode from 'vscode';
import { getHtml } from './webviewHtml';
import { streamOllama } from './ollamaClient';
import { SessionManager } from './sessionManager';

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'codingLlama.chatView';
  private _view?: vscode.WebviewView;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessions: SessionManager,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      // Only allow loading resources from our extension directory
      localResourceRoots: [this._extensionUri],
    };

    webviewView.webview.html = getHtml(webviewView.webview, this._extensionUri);

    // Listen for messages FROM the webview
    webviewView.webview.onDidReceiveMessage(msg => this._handleMessage(msg));

    // Send initial state TO the webview after it loads
    webviewView.webview.onDidReceiveMessage(msg => {
      if (msg.type === 'ready') {
        this._sendInitialState();
      }
    });
  }

  // Send a message TO the webview
  private _post(message: unknown) {
    this._view?.webview.postMessage(message);
  }

  private _sendInitialState() {
    this._post({ type: 'sessions', sessions: this._sessions.getAll() });
    this._post({ type: 'activeSession', session: this._sessions.getActive() });
  }

  private async _handleMessage(msg: any) {
    switch (msg.type) {
      case 'ready':
        this._sendInitialState();
        break;

      case 'send':
        await this._handleChat(msg.text, msg.model);
        break;

      case 'newChat':
        this._sessions.createNew();
        this._post({ type: 'sessions', sessions: this._sessions.getAll() });
        this._post({ type: 'activeSession', session: this._sessions.getActive() });
        break;

      case 'selectSession':
        this._sessions.setActive(msg.id);
        this._post({ type: 'activeSession', session: this._sessions.getActive() });
        break;

      case 'getModels':
        await this._handleGetModels();
        break;

      case 'pullModel':
        await this._handlePullModel(msg.model);
        break;
    }
  }

  private async _handleChat(text: string, model: string) {
    const session = this._sessions.getActive();
    if (!session) return;

    session.messages.push({ role: 'user', content: text });
    this._sessions.save();
    this._post({ type: 'userMessage', text });
    this._post({ type: 'streamStart' });

    let fullResponse = '';
    try {
      await streamOllama({
        model,
        messages: session.messages,
        onToken: (chunk) => {
          fullResponse += chunk;
          this._post({ type: 'streamToken', token: chunk });
        },
        onDone: () => {
          session.messages.push({ role: 'assistant', content: fullResponse });
          this._sessions.save();
          this._post({ type: 'streamEnd' });
        },
      });
    } catch (err) {
      this._post({ type: 'streamError', error: String(err) });
    }
  }

  private async _handleGetModels() {
    const { listModels } = await import('./ollamaClient');
    const installed = await listModels();
    this._post({ type: 'models', installed });
  }

  private async _handlePullModel(model: string) {
    const { pullModel } = await import('./ollamaClient');
    this._post({ type: 'pullStart', model });
    await pullModel(model, (progress) => {
      this._post({ type: 'pullProgress', model, progress });
    });
    this._post({ type: 'pullDone', model });
    await this._handleGetModels(); // refresh list
  }

  // Called by the "New Chat" command registered in extension.ts
  public newChat() {
    this._sessions.createNew();
    this._post({ type: 'sessions', sessions: this._sessions.getAll() });
    this._post({ type: 'activeSession', session: this._sessions.getActive() });
  }
}
```

---

### Registering the Provider

```typescript
// extension.ts
import * as vscode from 'vscode';
import { SidebarProvider } from './sidebarProvider';
import { SessionManager } from './sessionManager';

export function activate(context: vscode.ExtensionContext) {
  const sessions = new SessionManager(context.globalState);
  const provider = new SidebarProvider(context.extensionUri, sessions);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewId,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
      // retainContextWhenHidden: true = don't destroy the webview when panel is hidden
      // This preserves scroll position, input text, etc.
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codingLlama.newChat', () => provider.newChat())
  );
}

export function deactivate() {}
```

**`retainContextWhenHidden: true`** — critical for a chat panel. Without it, every time the
user clicks away and back, the webview re-renders from scratch and loses state.

---

### Generating the Webview HTML

```typescript
// webviewHtml.ts
import * as vscode from 'vscode';
import * as path from 'path';

export function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  // Convert local file URIs to webview-safe URIs
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'main.js')
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'style.css')
  );

  // Content Security Policy — required, restricts what the webview can load
  const nonce = getNonce();
  const csp = `
    default-src 'none';
    style-src ${webview.cspSource} 'unsafe-inline';
    script-src 'nonce-${nonce}';
    img-src ${webview.cspSource} https: data:;
    font-src ${webview.cspSource};
  `.replace(/\s+/g, ' ');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>CodingLlama</title>
</head>
<body>
  <div id="app">
    <!-- Injected by main.js -->
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}
```

**Key rules for webview HTML:**
- Always use `webview.asWebviewUri()` to convert local file paths. Raw `file://` URIs are blocked.
- Always include a Content Security Policy `<meta>` tag with a nonce.
- Scripts must have the matching `nonce` attribute.
- `webview.cspSource` is VS Code's allowed origin string (e.g. `vscode-resource:`).

---

### Webview ↔ Extension Message Protocol

All communication is via `postMessage`. Define a shared protocol:

```typescript
// Webview → Extension (sent from media/main.js)
type WebviewMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string; model: string }
  | { type: 'newChat' }
  | { type: 'selectSession'; id: string }
  | { type: 'getModels' }
  | { type: 'pullModel'; model: string };

// Extension → Webview (received in media/main.js)
type ExtensionMessage =
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'activeSession'; session: Session | null }
  | { type: 'userMessage'; text: string }
  | { type: 'streamStart' }
  | { type: 'streamToken'; token: string }
  | { type: 'streamEnd' }
  | { type: 'streamError'; error: string }
  | { type: 'models'; installed: string[] }
  | { type: 'pullStart'; model: string }
  | { type: 'pullProgress'; model: string; progress: number }
  | { type: 'pullDone'; model: string };
```

**In `media/main.js` (webview side):**
```javascript
const vscode = acquireVsCodeApi(); // MUST be called exactly once at top level

// Send to extension
vscode.postMessage({ type: 'ready' });
vscode.postMessage({ type: 'send', text: inputValue, model: selectedModel });

// Receive from extension
window.addEventListener('message', event => {
  const msg = event.data;
  switch (msg.type) {
    case 'streamToken':
      appendToken(msg.token);
      break;
    case 'streamEnd':
      finaliseMessage();
      break;
    // ...
  }
});
```

**`acquireVsCodeApi()`** — call this once at the top of `main.js`, not inside functions.
It returns `{ postMessage, getState, setState }`. `getState/setState` can persist small
amounts of UI state (scroll position, draft text) across webview reloads.

---

### Session Manager

```typescript
// sessionManager.ts
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface Session {
  id: string;
  title: string;
  createdAt: number;
  messages: Message[];
}

const STORAGE_KEY = 'codingLlama.sessions';
const ACTIVE_KEY  = 'codingLlama.activeSessionId';
const MAX_SESSIONS = 50;

export class SessionManager {
  constructor(private state: vscode.Memento) {}

  getAll(): Session[] {
    return this.state.get<Session[]>(STORAGE_KEY, []);
  }

  getActive(): Session | null {
    const id = this.state.get<string>(ACTIVE_KEY);
    return this.getAll().find(s => s.id === id) ?? null;
  }

  createNew(): Session {
    const session: Session = {
      id: Date.now().toString(),
      title: 'New Chat',
      createdAt: Date.now(),
      messages: [],
    };
    let sessions = this.getAll();
    sessions.unshift(session);
    if (sessions.length > MAX_SESSIONS) {
      sessions = sessions.slice(0, MAX_SESSIONS);
    }
    this.state.update(STORAGE_KEY, sessions);
    this.state.update(ACTIVE_KEY, session.id);
    return session;
  }

  setActive(id: string): void {
    this.state.update(ACTIVE_KEY, id);
  }

  save(): void {
    // Sessions are mutated in place — re-save the whole array
    // (SessionManager holds a reference to the active session object)
    const sessions = this.getAll();
    this.state.update(STORAGE_KEY, sessions);
  }

  updateTitle(id: string, firstMessage: string): void {
    const sessions = this.getAll();
    const s = sessions.find(s => s.id === id);
    if (s) {
      s.title = firstMessage.slice(0, 40) + (firstMessage.length > 40 ? '...' : '');
      this.state.update(STORAGE_KEY, sessions);
    }
  }

  delete(id: string): void {
    const sessions = this.getAll().filter(s => s.id !== id);
    this.state.update(STORAGE_KEY, sessions);
  }
}
```

---

### Ollama Client

```typescript
// ollamaClient.ts
import * as vscode from 'vscode';

function getConfig() {
  const cfg = vscode.workspace.getConfiguration('codingLlama');
  return {
    baseUrl: cfg.get<string>('baseUrl', 'http://localhost:11434'),
    model:   cfg.get<string>('model', 'qwen2.5-coder:7b'),
  };
}

interface StreamOptions {
  model: string;
  messages: Array<{ role: string; content: string }>;
  tools?: OllamaTool[];
  onToken: (chunk: string) => void;
  onDone?: () => void;
}

interface OllamaTool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export async function streamOllama(opts: StreamOptions): Promise<void> {
  const { baseUrl } = getConfig();

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: true,
      tools: opts.tools,
    }),
  });

  if (!res.ok || !res.body) throw new Error(`Ollama ${res.status}: ${res.statusText}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') { opts.onDone?.(); return; }
      try {
        const chunk = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (chunk) opts.onToken(chunk);
      } catch { /* skip */ }
    }
  }
  opts.onDone?.();
}

// Non-streaming, returns content + optional tool_calls
export async function chatOllama(opts: {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tools?: OllamaTool[];
}): Promise<{ content?: string; tool_calls?: OllamaToolCall[] }> {
  const { baseUrl } = getConfig();
  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...opts, stream: false }),
  });
  const data = await res.json();
  const msg = data.choices?.[0]?.message;
  return { content: msg?.content, tool_calls: msg?.tool_calls };
}

// Returns list of installed model names
export async function listModels(): Promise<string[]> {
  const { baseUrl } = getConfig();
  try {
    const res = await fetch(`${baseUrl}/v1/models`);
    const data = await res.json();
    return (data.data ?? []).map((m: any) => m.id as string);
  } catch {
    return [];
  }
}

// Pull a model with streaming progress (Ollama native endpoint)
export async function pullModel(
  model: string,
  onProgress: (pct: number) => void
): Promise<void> {
  const { baseUrl } = getConfig();
  const res = await fetch(`${baseUrl}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: model, stream: true }),
  });
  if (!res.ok || !res.body) throw new Error(`Pull failed: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split('\n')) {
      if (!line.trim()) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.total && obj.completed) {
          onProgress(Math.round((obj.completed / obj.total) * 100));
        }
      } catch { /* skip */ }
    }
  }
}
```

---

## Static Model Catalogue

These models are always shown in the picker regardless of local install status.
Check `listModels()` to determine which are installed.

```typescript
// models.ts
export interface ModelEntry {
  id: string;        // exact Ollama model name for API calls
  label: string;     // display name
  tier: 'high' | 'medium' | 'low';
  sizeGb: number;    // approximate download size
}

export const STATIC_MODELS: ModelEntry[] = [
  { id: 'qwen2.5-coder:7b',    label: 'Qwen 2.5 Coder 7B',    tier: 'high',   sizeGb: 4.7 },
  { id: 'qwen2.5-coder:3b',    label: 'Qwen 2.5 Coder 3B',    tier: 'medium', sizeGb: 1.9 },
  { id: 'deepseek-coder:6.7b', label: 'DeepSeek Coder 6.7B',  tier: 'high',   sizeGb: 3.8 },
  { id: 'llama3.2:3b',         label: 'Llama 3.2 3B',         tier: 'medium', sizeGb: 2.0 },
  { id: 'phi3.5:3.8b',         label: 'Phi 3.5 3.8B',         tier: 'low',    sizeGb: 2.2 },
];

export const TIER_BADGE: Record<ModelEntry['tier'], string> = {
  high:   '🟢 High',
  medium: '🟡 Medium',
  low:    '🔴 Low',
};
```

The webview receives `installed: string[]` from the extension. In the UI:
- If `installed.includes(model.id)` → show model name + tier badge, selectable
- Otherwise → show model name greyed out + **Download** button

---

## Webview UI Structure (media/main.js)

The webview renders entirely in JavaScript. Structure to build:

```
┌─────────────────────────────────┐
│  [Ask]  [Plan·]  [Agent·]       │  ← mode tabs; Plan/Agent greyed + "WIP" tooltip
├──────────────┬──────────────────┤
│ Sessions     │ Chat area        │
│ ──────────── │ ──────────────── │
│ + New Chat   │  messages here   │
│              │                  │
│ • Session 1  │                  │
│ • Session 2  │                  │
│ ...          │ ──────────────── │
│              │ [Model ▼] [Send] │
│              │ [ input box    ] │
└──────────────┴──────────────────┘
```

**Mode tabs:** Render 3 buttons. Ask is fully styled. Plan and Agent have `opacity: 0.4`,
`cursor: not-allowed`, and a `title="Work in progress"` tooltip.

**Sessions panel:** Left column. Clicking a session sends `{ type: 'selectSession', id }`.
New Chat button sends `{ type: 'newChat' }`.

**Model picker:** A `<select>` or custom dropdown. On open, populates from `STATIC_MODELS`.
Shows tier badge next to each. If not installed, shows "(Download)" suffix and is not
selectable — clicking it sends `{ type: 'pullModel', model: id }`.

**Chat area:** Append messages as divs. Streaming: update the last `assistant` div token-by-token.
Use a simple markdown renderer (e.g. inline `marked` or regex for code blocks).

**Styling:** Mirror VS Code's sidebar aesthetic using CSS variables:
```css
body { background: var(--vscode-sideBar-background); color: var(--vscode-foreground); }
.tab-active { border-bottom: 2px solid var(--vscode-focusBorder); }
.session-item { padding: 6px 8px; cursor: pointer; border-radius: 4px; }
.session-item:hover { background: var(--vscode-list-hoverBackground); }
.model-badge-high   { color: #4caf50; }
.model-badge-medium { color: #ff9800; }
.model-badge-low    { color: #f44336; }
```
Full list of VS Code CSS variables: `--vscode-editor-background`, `--vscode-input-background`,
`--vscode-input-border`, `--vscode-button-background`, `--vscode-button-foreground`,
`--vscode-list-activeSelectionBackground`, `--vscode-list-hoverBackground`, `--vscode-focusBorder`.

---

## Phase 2 — Plan Mode (Tool-Calling, Scoped Writes)

### Goal
Agent can READ any workspace file and WRITE only to `.copilot-plan/`.
No actual source code is modified. Ends by posting a "Start Implementation" button
message to the webview.

### Tool: read_file

```typescript
// tools/readFile.ts
import * as vscode from 'vscode';

export const readFileTool = {
  type: 'function' as const,
  function: {
    name: 'read_file',
    description: 'Read the content of a file in the workspace',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path from workspace root, e.g. "src/index.ts"' },
      },
      required: ['path'],
    },
  },
};

export async function execReadFile(args: { path: string }): Promise<string> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error('No workspace open');
  const uri = vscode.Uri.joinPath(ws.uri, args.path);
  const bytes = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(bytes).toString('utf8');
}
```

### Tool: write_plan (scoped to .copilot-plan/)

```typescript
// tools/writePlan.ts
import * as vscode from 'vscode';

export const writePlanTool = {
  type: 'function' as const,
  function: {
    name: 'write_plan',
    description: 'Write or update a file inside the .copilot-plan/ folder only',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Filename only, e.g. "plan.md"' },
        content:  { type: 'string', description: 'Full file content' },
      },
      required: ['filename', 'content'],
    },
  },
};

export async function execWritePlan(args: { filename: string; content: string }): Promise<string> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error('No workspace open');
  const safeFilename = args.filename.replace(/[/\\]/g, '_');
  const planUri = vscode.Uri.joinPath(ws.uri, '.copilot-plan');
  await vscode.workspace.fs.createDirectory(planUri);
  const fileUri = vscode.Uri.joinPath(planUri, safeFilename);
  await vscode.workspace.fs.writeFile(fileUri, Buffer.from(args.content, 'utf8'));
  return `Written: .copilot-plan/${safeFilename}`;
}
```

### Tool-Call Agentic Loop

```typescript
async function runPlanAgent(userMessage: string, model: string, postToWebview: (msg: any) => void) {
  const messages: any[] = [
    { role: 'system', content: 'You are a planning assistant. Read files to understand the codebase. Write only to .copilot-plan/ files. Do NOT edit source code.' },
    { role: 'user', content: userMessage },
  ];

  for (let i = 0; i < 10; i++) {
    const response = await chatOllama({ model, messages, tools: [readFileTool, writePlanTool] });

    if (response.tool_calls?.length) {
      messages.push({ role: 'assistant', content: response.content ?? '', tool_calls: response.tool_calls });
      for (const call of response.tool_calls) {
        const args = JSON.parse(call.function.arguments);
        postToWebview({ type: 'planToolUse', tool: call.function.name, args });
        let result: string;
        try {
          result = call.function.name === 'read_file'
            ? await execReadFile(args)
            : await execWritePlan(args);
        } catch (e) { result = `Error: ${e}`; }
        messages.push({ role: 'tool', tool_call_id: call.id, content: result });
      }
    } else {
      if (response.content) postToWebview({ type: 'streamEnd', content: response.content });
      postToWebview({ type: 'showImplementButton' }); // webview renders a button
      break;
    }
  }
}
```

---

## Phase 3 — Agent Mode (Full Tools)

### Tool: edit_file (WorkspaceEdit — undo-able, shows diff)

```typescript
// tools/editFile.ts
import * as vscode from 'vscode';

export const editFileTool = {
  type: 'function' as const,
  function: {
    name: 'edit_file',
    description: 'Replace the entire content of a file, or create it if not exists',
    parameters: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Relative path from workspace root' },
        content: { type: 'string', description: 'New full content of the file' },
      },
      required: ['path', 'content'],
    },
  },
};

export async function execEditFile(args: { path: string; content: string }): Promise<string> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) throw new Error('No workspace open');
  const uri = vscode.Uri.joinPath(ws.uri, args.path);

  const edit = new vscode.WorkspaceEdit();
  edit.createFile(uri, { overwrite: true });
  edit.insert(uri, new vscode.Position(0, 0), args.content);

  const ok = await vscode.workspace.applyEdit(edit);
  return ok ? `Edited: ${args.path}` : `Failed: ${args.path}`;
}
```

**WorkspaceEdit key methods:**
| Method | Purpose |
|---|---|
| `edit.createFile(uri, opts)` | Create file. `opts.overwrite` replaces if exists |
| `edit.deleteFile(uri, opts)` | Delete. `opts.ignoreIfNotExists` prevents errors |
| `edit.renameFile(oldUri, newUri)` | Move/rename |
| `edit.insert(uri, pos, text)` | Insert at position |
| `edit.replace(uri, range, text)` | Replace range |
| `edit.delete(uri, range)` | Delete range |
| `vscode.workspace.applyEdit(edit)` | Apply. Returns `Promise<boolean>` |

**Use WorkspaceEdit (not `workspace.fs.writeFile`) for source files** — it participates in
the undo stack and triggers VS Code's diff decorations.

### Tool: run_terminal

```typescript
// tools/runTerminal.ts
import * as vscode from 'vscode';

export async function execRunTerminal(args: { command: string }): Promise<string> {
  let terminal = vscode.window.terminals.find(t => t.name === 'CodingLlama Agent');
  if (!terminal) {
    terminal = vscode.window.createTerminal({ name: 'CodingLlama Agent' });
  }
  terminal.show(true); // true = preserve focus
  terminal.sendText(args.command, true); // true = press Enter
  return `Sent: ${args.command}`;
}

// If you need to CAPTURE output (terminal.sendText cannot), use child_process:
import { exec } from 'child_process';
import { promisify } from 'util';
const execAsync = promisify(exec);

export async function runAndCapture(command: string): Promise<string> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  const cwd = ws?.uri.fsPath;
  const { stdout, stderr } = await execAsync(command, { cwd });
  return stdout + (stderr ? `\nSTDERR: ${stderr}` : '');
}
```

---

## Phase 4 — Custom Agents

```typescript
interface AgentConfig {
  id: string;
  name: string;
  systemPrompt: string;
  tools: Array<'read_file' | 'write_plan' | 'edit_file' | 'run_terminal'>;
  model?: string;
}

function getAgents(): AgentConfig[] {
  return vscode.workspace.getConfiguration('codingLlama').get<AgentConfig[]>('agents', []);
}
async function saveAgents(agents: AgentConfig[]): Promise<void> {
  await vscode.workspace.getConfiguration('codingLlama').update('agents', agents, vscode.ConfigurationTarget.Global);
}
```

Agents are rendered as entries in the Sessions panel sidebar, or as a separate "Agents" tab
in the webview. Selecting an agent sets the system prompt for the current session.

---

## VS Code Workspace APIs — Quick Reference

```typescript
// Workspace root
const root = vscode.workspace.workspaceFolders?.[0]?.uri;

// Read file
const bytes = await vscode.workspace.fs.readFile(uri);
const text  = Buffer.from(bytes).toString('utf8');

// Write file (no undo stack — use for generated/plan files)
await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));

// Create directory
await vscode.workspace.fs.createDirectory(uri);

// Delete
await vscode.workspace.fs.delete(uri, { recursive: true });

// Stat (existence check)
try { await vscode.workspace.fs.stat(uri); } catch { /* not found */ }

// List directory  → Array<[string, vscode.FileType]>
const entries = await vscode.workspace.fs.readDirectory(folderUri);

// Glob search
const files = await vscode.workspace.findFiles('**/*.ts', '**/node_modules/**');

// Open + read as TextDocument
const doc  = await vscode.workspace.openTextDocument(uri);
const text = doc.getText();
```

---

## VS Code Window APIs — Quick Reference

```typescript
vscode.window.showInformationMessage('Done!');
vscode.window.showErrorMessage('Failed', 'Retry').then(action => {});
const val  = await vscode.window.showInputBox({ prompt: 'Enter model name' });
const pick = await vscode.window.showQuickPick(['a', 'b'], {});

await vscode.window.withProgress(
  { location: vscode.ProgressLocation.Notification, title: 'Pulling model...', cancellable: false },
  async (progress) => { progress.report({ message: '50%' }); }
);

// Active editor info
const editor = vscode.window.activeTextEditor;
editor?.document.uri;
editor?.selection; // Range of current selection
```

---

## Configuration API

```typescript
const cfg = vscode.workspace.getConfiguration('codingLlama');
const model = cfg.get<string>('model', 'qwen2.5-coder:7b');
await cfg.update('model', 'llama3.2', vscode.ConfigurationTarget.Global);

vscode.workspace.onDidChangeConfiguration(e => {
  if (e.affectsConfiguration('codingLlama.model')) { /* reload */ }
});
```

---

## Extension Context & Storage

```typescript
context.globalState.get<T>('key');          // persistent cross-workspace
context.globalState.update('key', value);
context.workspaceState.get<T>('key');       // workspace-scoped
context.globalStorageUri;                   // writable URI for larger files
context.extensionUri;                       // extension install root
context.subscriptions.push(disposable);
```

---

## Ollama Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/v1/chat/completions` | POST | Chat, streaming or not (OpenAI-compatible) |
| `/v1/models` | GET | List installed models |
| `/api/pull` | POST | Download a model (Ollama-native, streaming JSON) |
| `/api/tags` | GET | Alternative model list (Ollama-native) |

**Streaming format:** SSE `data: {...}\n\n` lines, ends with `data: [DONE]`.
**Pull progress format:** newline-delimited JSON, each line has `{ status, completed, total }`.
**Tool calling:** Pass `tools` array in request body. Check `choices[0].message.tool_calls` in response.
**Models that support tool calling:** `qwen2.5-coder:7b`, `qwen2.5-coder:3b`, `llama3.1:8b`, `mistral-nemo`.

---

## tsconfig.json

```json
{
  "compilerOptions": {
    "module": "commonjs",
    "target": "ES2020",
    "lib": ["ES2020"],
    "outDir": "./out",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  }
}
```

---

## Checkpoint, Fork & Compaction System

These features are built in Phase 1 and become critical in Phase 2 (Plan) and Phase 3 (Agent).

### Session Storage

Sessions are stored as JSON files in `.codingllama/sessions/` under the workspace root.
Each session = `{id}.json`. An `index.json` stores lightweight metadata (id, title, status, createdAt).
No workspace → fallback to `~/.codingllama/sessions/`.
The `.codingllama/` folder is auto-added to `.gitignore` on activation (only if `.git/` exists).

### Checkpoint Restore

Every message has a restore checkpoint button (⏪). Clicking it:
1. Saves all messages after that point to `session.redoStack`
2. Truncates `session.messages` to the checkpoint index
3. Trims any compaction checkpoints past that point
4. Shows a "↩ Redo (N messages)" button at the bottom of the chat

**In Phase 2/3:** This is where file-edit rollback will hook in. The `_handleRestoreCheckpoint`
method is the integration point — extend it to also revert `WorkspaceEdit` changes tracked
since that message.

### Redo

Replays messages from `redoStack` back onto the session with no LLM call.
Redo stack is cleared when the user sends a new message or edits.

**In Phase 2/3:** The `_handleRedo` method will also replay file changes (re-apply
`WorkspaceEdit` or `workspace.fs` writes that were rolled back).

### Fork Conversation

The 🔀 button creates a new session with messages copied up to that point.
Original session is untouched. Compaction checkpoints within the forked range are copied.

**In Phase 2/3:** Fork is essential for planning — user can fork from a plan checkpoint,
explore an alternative approach, and switch back if needed. Plan files in `.copilot-plan/`
should be duplicated or namespaced per fork.

### Stacking Compaction

Compaction is **non-destructive** — original messages are always preserved.

```typescript
interface CompactionCheckpoint {
  upTo: number;    // messages[0..upTo-1] are covered by this + all prior checkpoints
  summary: string; // LLM-generated summary of messages since last checkpoint
}

interface Session {
  messages: Message[];
  compactions?: CompactionCheckpoint[];  // stacking checkpoints
  redoStack?: Message[];                 // redo after checkpoint restore
}
```

**Stacking rules:**
- Each compaction covers messages from the previous checkpoint's `upTo` to the current message count
- For LLM context: combine all checkpoint summaries as system messages, then add raw messages
  after the last checkpoint
- On edit at index N: discard all checkpoints where `upTo > N` (keep older ones)
- Auto-compact triggers at 90% token usage before sending

**LLM context building:**
```typescript
const checkpoints = session.compactions || [];
if (checkpoints.length > 0) {
  // All summaries as context
  const combined = checkpoints.map(cp => cp.summary).join('\n---\n');
  ollamaMessages.push({ role: 'system', content: `Previous conversation summary:\n${combined}` });
  // Only raw messages after last checkpoint
  const lastUpTo = checkpoints[checkpoints.length - 1].upTo;
  ollamaMessages.push(...session.messages.slice(lastUpTo, -1).map(m => ({ role: m.role, content: m.content })));
} else {
  ollamaMessages.push(...session.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content })));
}
```

### Parallel Streaming

Multiple sessions can stream simultaneously via `Map<sessionId, StreamState>`.
All stream messages carry `sessionId`. On session switch, if target is still streaming,
accumulated content is replayed via `streamReplay` message.

```typescript
interface StreamState {
  abortController: AbortController;
  fullResponse: string;
}
// In SidebarProvider:
private _streams: Map<string, StreamState> = new Map();
```

### Title Generation

New sessions get their title generated by the LLM (non-streaming call with `TITLE_GENERATOR_PROMPT`)
**before** the answer is streamed. This ensures the sessions list shows a meaningful title immediately.

---

## Key Gotchas

1. **No Chat Participant API.** We do NOT use `vscode.chat.createChatParticipant`,
   `vscode.lm`, or anything in the `chatParticipants` contributes section. All UI lives
   in our `WebviewViewProvider`.

2. **`acquireVsCodeApi()` — call exactly once.** In `media/main.js`, call it at the top
   level. Calling it inside a function or twice throws.

3. **`retainContextWhenHidden: true`** on the provider registration — without this,
   navigating away from the sidebar destroys the webview and loses all in-memory state.

4. **`webview.asWebviewUri()`** — always convert local file paths before putting them
   in HTML `src` or `href` attributes. Raw `file://` paths are blocked by CSP.

5. **CSP nonce** — every `<script>` tag must have the matching `nonce` attribute or it
   will be blocked. Regenerate the nonce on each `getHtml()` call.

6. **`workspace.fs` vs `WorkspaceEdit`:** Use `workspace.fs` for `.copilot-plan/` and
   other generated files. Use `WorkspaceEdit + applyEdit` for source files (shows diff,
   participates in undo stack).

7. **Terminal output capture:** `terminal.sendText` is fire-and-forget. Use
   `child_process.exec` (Node.js, available in extension host) if you need stdout.

8. **Streaming in webview:** Don't batch tokens — call `postMessage` for each token so
   the UI feels live. Batching even a few tokens introduces noticeable lag.

9. **Model pull progress** comes from `/api/pull` (Ollama-native), not `/v1/`. The response
   is newline-delimited JSON (not SSE), each line: `{ "status": "...", "completed": N, "total": N }`.

10. **Plan scope guard:** Sanitise the filename from the LLM (`args.filename.replace(/[/\\]/g, '_')`)
    before writing. Never trust raw paths from tool call arguments.
