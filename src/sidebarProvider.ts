/**
 * SidebarProvider — WebviewViewProvider that owns the CodingLlama chat sidebar.
 *
 * Responsibilities:
 *  - Renders the webview HTML (via webviewHtml.ts)
 *  - Handles all postMessage traffic between the webview and the extension host
 *  - Bridges chat input → Ollama streaming → token-by-token updates to the webview
 *  - Manages model listing + pull via ollamaClient
 *  - Coordinates session CRUD via SessionManager
 */
import * as vscode from 'vscode';
import { getHtml } from './webviewHtml';
import { streamOllama, listModels, pullModel, checkOllama, ContentPart, MessageContent } from './ollamaClient';
import { SessionManager, Session } from './sessionManager';
import { getConfig, setModel } from './config';
import { ASK_SYSTEM_PROMPT, COMPACT_CONVERSATION_PROMPT, SYSTEM_PROMPT_TOKENS } from './prompts';

/** Attachment sent from the webview with each chat message. */
interface Attachment {
  type: 'file' | 'selection' | 'image';
  name: string;
  content?: string;   // text content for file/selection
  dataUrl?: string;    // base64 data URL for images
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  /** The view ID — must match views contribution in package.json. */
  public static readonly viewId = 'codingLlama.chatView';

  private _view?: vscode.WebviewView;
  /** AbortController for the current streaming request — null when idle. */
  private _abortController: AbortController | null = null;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessions: SessionManager,
    private readonly _storageUri: vscode.Uri,
  ) {}

  /**
   * Called by VS Code when the webview view becomes visible.
   * Sets up the webview HTML, options, and message listener.
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this._extensionUri, this._storageUri],
    };

    webviewView.webview.html = getHtml(webviewView.webview, this._extensionUri);

    // Single message listener dispatches to the handler switch
    webviewView.webview.onDidReceiveMessage(
      (msg) => this._handleMessage(msg)
    );

    // Track active editor changes to update the "add current file" button
    vscode.window.onDidChangeActiveTextEditor(() => this._sendEditorContext());
    vscode.window.onDidChangeTextEditorSelection(() => this._sendEditorContext());
  }

  // ── Public API (for commands registered in extension.ts) ──────────────

  /** Creates a new chat session and refreshes the webview. */
  public newChat(): void {
    this._sessions.createNew();
    this._postSessions();
    this._postActiveSession();
  }

  /** Clears all sessions and refreshes the webview. */
  public clearAll(): void {
    this._sessions.clearAll();
    this._postSessions();
    this._postActiveSession();
  }

  /**
   * Adds one or more files to the chat as attachments.
   * Called from the explorer/editor context menu command.
   */
  public async addFiles(uris: vscode.Uri[]): Promise<void> {
    // If no URIs passed, try the active editor
    if (uris.length === 0) {
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      if (activeUri) { uris = [activeUri]; }
    }

    for (const fileUri of uris) {
      await this.addFile(fileUri);
    }

    // Reveal the sidebar so the user sees the added files
    if (uris.length > 0 && this._view) {
      this._view.show?.(true);
    }
  }

  /**
   * Adds a single file to the chat as an attachment.
   */
  public async addFile(uri?: vscode.Uri): Promise<void> {
    // If no URI passed, try the active editor
    const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!fileUri) { return; }

    const fileName = fileUri.path.split('/').pop() ?? fileUri.path;
    try {
      const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
      const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];

      if (imageExts.includes(ext)) {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const base64 = Buffer.from(bytes).toString('base64');
        const mimeType = ext === 'svg' ? 'image/svg+xml'
          : ext === 'jpg' ? 'image/jpeg'
          : `image/${ext}`;
        this._post({ type: 'imageAdded', name: fileName, dataUrl: `data:${mimeType};base64,${base64}` });
      } else {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const content = Buffer.from(bytes).toString('utf8');
        this._post({ type: 'fileAdded', name: fileName, content });
      }
    } catch {
      this._post({ type: 'fileAdded', name: fileName, content: `(Failed to read ${fileName})` });
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────

  /** Sends a message to the webview. */
  private _post(message: unknown): void {
    this._view?.webview.postMessage(message);
  }

  /** Pushes the full sessions list to the webview. */
  private _postSessions(): void {
    this._post({ type: 'sessions', sessions: this._sessions.getAll() });
  }

  /** Pushes the active session (with its messages) to the webview. */
  private _postActiveSession(): void {
    const session = this._sessions.getActive();
    const { model } = getConfig();

    // Resolve stored image paths to webview-safe URIs for rendering
    let resolvedSession = session;
    if (session) {
      resolvedSession = {
        ...session,
        messages: session.messages.map(m => {
          if (!m.attachments) { return m; }
          return {
            ...m,
            attachments: m.attachments.map(a => {
              if (a.type === 'image' && a.imagePath) {
                const webviewUri = this._resolveImageUri(a.imagePath);
                return { ...a, imageUri: webviewUri ?? undefined };
              }
              return a;
            }),
          };
        }),
      };
    }

    this._post({ type: 'activeSession', session: resolvedSession, selectedModel: model, systemPromptTokens: SYSTEM_PROMPT_TOKENS });
  }

  /** Sends the initial state to the webview once it signals "ready". */
  private async _sendInitialState(): Promise<void> {
    this._postSessions();
    this._postActiveSession();
    this._sendEditorContext();
    // Send installed models so the webview can auto-select the best one
    await this._handleGetModels();
  }

  // ── Message dispatch ──────────────────────────────────────────────────

  /** Routes incoming webview messages to the appropriate handler. */
  private async _handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this._sendInitialState();
        break;

      case 'checkOllama':
        await this._handleCheckOllama();
        break;

      case 'send':
        await this._handleChat(
          msg.text as string,
          msg.model as string,
          (msg.attachments as Attachment[] | undefined) || [],
        );
        break;

      case 'newChat':
        this.newChat();
        break;

      case 'selectSession':
        this._sessions.setActive(msg.id as string);
        this._postActiveSession();
        break;

      case 'deleteSession':
        this._sessions.delete(msg.id as string);
        this._postSessions();
        this._postActiveSession();
        break;

      case 'getModels':
        await this._handleGetModels();
        break;

      case 'pullModel':
        await this._handlePullModel(msg.model as string);
        break;

      case 'selectModel':
        await this._handleSelectModel(msg.model as string);
        break;

      case 'getEditorContext':
        this._sendEditorContext();
        break;

      case 'addCurrentFile':
        await this._handleAddCurrentFile();
        break;

      case 'addSelection':
        this._handleAddSelection();
        break;

      case 'attachFile':
        await this._handleAttachFile();
        break;

      case 'readDroppedUri':
        await this._handleReadDroppedUri(msg.uri as string, msg.name as string);
        break;

      case 'stopGeneration':
        this._handleStopGeneration();
        break;

      case 'resend':
        await this._handleResend(
          msg.messageIndex as number,
          msg.text as string,
          msg.model as string,
          (msg.attachments as Attachment[] | undefined) || [],
        );
        break;

      case 'compactConversation':
        await this._handleCompactConversation(msg.model as string);
        break;

      case 'compactAndSend':
        await this._handleCompactConversation(msg.model as string);
        await this._handleChat(
          msg.text as string,
          msg.model as string,
          (msg.attachments as Attachment[] | undefined) || [],
        );
        break;
    }
  }

  // ── Chat streaming ────────────────────────────────────────────────────

  /**
   * Handles a user chat message:
   *  1. Appends the user message to the active session
   *  2. Updates the session title if it's the first message
   *  3. Builds context-augmented messages (files, selections, images)
   *  4. Streams the Ollama response token-by-token to the webview
   *  5. Appends the completed assistant response to the session
   */
  private async _handleChat(text: string, model: string, attachments: Attachment[]): Promise<void> {
    // Ensure there's an active session (auto-create if needed)
    let session = this._sessions.getActive();
    if (!session) {
      session = this._sessions.createNew();
      this._postSessions();
    }

    // Append the user message with attachment metadata for display on reload
    // Save images to persistent storage so they survive across sessions
    const storedAttachments = attachments.length > 0
      ? await Promise.all(attachments.map(async (a) => {
          if (a.type === 'image' && a.dataUrl) {
            const imagePath = await this._saveImage(a.dataUrl, a.name);
            return { type: 'image' as const, name: a.name, imagePath };
          }
          return { type: a.type as 'file' | 'image' | 'selection', name: a.name };
        }))
      : undefined;
    session.messages.push({ role: 'user', content: text, attachments: storedAttachments });

    // Set the session title from the first user message
    const userMessages = session.messages.filter(m => m.role === 'user');
    if (userMessages.length === 1) {
      this._sessions.updateTitle(session.id, text);
      this._postSessions();
    }

    // Persist the user message immediately
    this._sessions.saveSession(session);
    this._post({ type: 'userMessage', text });
    this._post({ type: 'streamStart' });

    // Persist selected model
    await setModel(model);

    // Build the final messages array for Ollama
    // Prepend system prompt, then previous messages, then current user message
    const ollamaMessages: Array<{ role: string; content: MessageContent }> = [
      { role: 'system', content: ASK_SYSTEM_PROMPT },
      ...session.messages
        .slice(0, -1) // all but the last (current user message)
        .map(m => ({ role: m.role, content: m.content })),
    ];

    // Build the current user message with context + images
    const fileAttachments = attachments.filter(a => a.type === 'file' || a.type === 'selection');
    const imageAttachments = attachments.filter(a => a.type === 'image');

    let contextText = '';
    if (fileAttachments.length > 0) {
      contextText = fileAttachments.map(a => {
        const label = a.type === 'selection' ? `Selection from ${a.name}` : `File: ${a.name}`;
        return `--- ${label} ---\n\`\`\`\n${a.content}\n\`\`\``;
      }).join('\n\n') + '\n\n';
    }
    const fullText = contextText + text;

    if (imageAttachments.length > 0) {
      // Multimodal message: text + images
      const parts: ContentPart[] = [{ type: 'text', text: fullText }];
      for (const img of imageAttachments) {
        if (img.dataUrl) {
          parts.push({ type: 'image_url', image_url: { url: img.dataUrl } });
        }
      }
      ollamaMessages.push({ role: 'user', content: parts });
    } else {
      ollamaMessages.push({ role: 'user', content: fullText });
    }

    let fullResponse = '';

    this._abortController = new AbortController();
    const { signal } = this._abortController;

    try {
      await streamOllama({
        model,
        messages: ollamaMessages,
        signal,
        onToken: (chunk) => {
          fullResponse += chunk;
          this._post({ type: 'streamToken', token: chunk });
        },
        onDone: () => {
          // Append the full assistant response and persist
          session!.messages.push({ role: 'assistant', content: fullResponse });
          this._sessions.saveSession(session!);
          this._post({ type: 'streamEnd' });
          // Push updated session so the webview has current message history
          this._postActiveSession();
        },
      });
    } catch (err: unknown) {
      if (signal.aborted) {
        // User stopped generation — save whatever was generated so far
        if (fullResponse) {
          session!.messages.push({ role: 'assistant', content: fullResponse });
          this._sessions.saveSession(session!);
        }
        this._post({ type: 'streamEnd' });
        this._postActiveSession();
      } else {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this._post({ type: 'streamError', error: errorMsg });
      }
    } finally {
      this._abortController = null;
    }
  }

  /** Aborts the current streaming request. */
  private _handleStopGeneration(): void {
    if (this._abortController) {
      this._abortController.abort();
    }
  }

  /**
   * Handles editing and resending a previous user message.
   * Truncates the session to the edited message index, then streams a new response.
   */
  private async _handleResend(
    messageIndex: number,
    text: string,
    model: string,
    attachments: Attachment[]
  ): Promise<void> {
    const session = this._sessions.getActive();
    if (!session) { return; }

    // Truncate: remove the edited message and everything after it
    session.messages = session.messages.slice(0, messageIndex);
    this._sessions.saveSession(session);

    // Re-render the chat area with truncated history
    this._postActiveSession();

    // Now handle as a new chat message (it will push user msg + stream response)
    await this._handleChat(text, model, attachments);
  }

  // ── Model management ──────────────────────────────────────────────────

  /**
   * Compacts the current session by summarizing all messages into a single
   * system-style summary, replacing the message history. This reduces token
   * usage while preserving context for continued conversation.
   */
  private async _handleCompactConversation(model: string): Promise<void> {
    const session = this._sessions.getActive();
    if (!session || session.messages.length < 2) { return; }

    // Build a transcript of the conversation for the LLM to summarize
    const transcript = session.messages.map(m => {
      const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System';
      return `${role}: ${m.content}`;
    }).join('\n\n');

    this._post({ type: 'streamStart' });
    this._post({ type: 'compactStart' });

    let summary = '';

    try {
      await streamOllama({
        model,
        messages: [
          { role: 'system', content: COMPACT_CONVERSATION_PROMPT },
          { role: 'user', content: `Here is the conversation to summarize:\n\n${transcript}` },
        ],
        onToken: (chunk) => {
          summary += chunk;
          this._post({ type: 'streamToken', token: chunk });
        },
        onDone: () => {
          // Replace the session messages with a single summary + marker
          session.messages = [
            { role: 'assistant', content: `**[Conversation Compacted]**\n\n${summary}` },
          ];
          this._sessions.saveSession(session);
          this._post({ type: 'streamEnd' });
          this._postActiveSession();
        },
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this._post({ type: 'streamError', error: errorMsg });
    }
  }

  /** Checks if Ollama is running and tells the webview. */
  private async _handleCheckOllama(): Promise<void> {
    const online = await checkOllama();
    this._post({ type: 'ollamaStatus', online });
  }

  // ── Image persistence ─────────────────────────────────────────────────

  /**
   * Saves a base64 data URL image to the extension's persistent storage.
   * Returns the relative path (from storageUri) for the saved file.
   */
  private async _saveImage(dataUrl: string, fileName: string): Promise<string> {
    // Ensure the images directory exists
    const imagesDir = vscode.Uri.joinPath(this._storageUri, 'images');
    try { await vscode.workspace.fs.createDirectory(imagesDir); } catch { /* exists */ }

    // Generate a unique filename to avoid collisions
    const uniqueName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const fileUri = vscode.Uri.joinPath(imagesDir, uniqueName);

    // Extract the base64 portion from the data URL
    const base64Match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
    if (base64Match) {
      const buffer = Buffer.from(base64Match[1], 'base64');
      await vscode.workspace.fs.writeFile(fileUri, buffer);
    }

    return `images/${uniqueName}`;
  }

  /**
   * Resolves a stored image path to a webview-safe URI.
   * Returns null if the webview isn't available.
   */
  private _resolveImageUri(imagePath: string): string | null {
    if (!this._view) { return null; }
    const fileUri = vscode.Uri.joinPath(this._storageUri, imagePath);
    return this._view.webview.asWebviewUri(fileUri).toString();
  }

  /**
   * Deletes images older than 30 days from the persistent storage.
   * Called once on extension activation via resolveWebviewView.
   */
  public async cleanupOldImages(): Promise<void> {
    const imagesDir = vscode.Uri.joinPath(this._storageUri, 'images');
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - THIRTY_DAYS_MS;

    try {
      const entries = await vscode.workspace.fs.readDirectory(imagesDir);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File) { continue; }
        // Filename starts with a timestamp: "1712345678901-image.png"
        const tsMatch = name.match(/^(\d+)-/);
        if (tsMatch) {
          const fileTs = parseInt(tsMatch[1], 10);
          if (fileTs < cutoff) {
            const fileUri = vscode.Uri.joinPath(imagesDir, name);
            await vscode.workspace.fs.delete(fileUri);
          }
        }
      }
    } catch {
      // Images directory might not exist yet — that's fine
    }
  }

  /** Fetches installed models from Ollama and sends the list to the webview. */
  private async _handleGetModels(): Promise<void> {
    const installed = await listModels();
    this._post({ type: 'models', installed });
  }

  /**
   * Pulls a model from the Ollama registry with a VS Code progress notification.
   * After the pull completes, refreshes the model list.
   */
  private async _handlePullModel(model: string): Promise<void> {
    this._post({ type: 'pullStart', model });

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Downloading ${model}...`,
          cancellable: false,
        },
        async (progress) => {
          let lastPct = 0;
          await pullModel(model, (pct) => {
            // Report incremental progress
            progress.report({ increment: pct - lastPct, message: `${pct}%` });
            lastPct = pct;
            this._post({ type: 'pullProgress', model, progress: pct });
          });
        }
      );

      this._post({ type: 'pullDone', model });
      vscode.window.showInformationMessage(`Model ${model} downloaded successfully.`);
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this._post({ type: 'pullError', model, error: errorMsg });
      vscode.window.showErrorMessage(`Failed to download ${model}: ${errorMsg}`);
    }

    // Refresh the installed models list
    await this._handleGetModels();
  }

  /** Persists the selected model to VS Code settings. */
  private async _handleSelectModel(model: string): Promise<void> {
    await setModel(model);
  }

  // ── Editor context ────────────────────────────────────────────────────

  /** Sends current editor file info + selection state to the webview. */
  private _sendEditorContext(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this._post({ type: 'editorContext', fileName: null, hasSelection: false });
      return;
    }

    const doc = editor.document;
    const fileName = doc.fileName.split(/[\\/]/).pop() ?? doc.fileName;
    const selection = editor.selection;
    const hasSelection = !selection.isEmpty;
    const selectionText = hasSelection ? doc.getText(selection) : undefined;
    const selectionRange = hasSelection
      ? `${selection.start.line + 1}-${selection.end.line + 1}`
      : undefined;

    this._post({
      type: 'editorContext',
      fileName,
      hasSelection,
      selectionText,
      selectionRange,
    });
  }

  /** Reads the entire active editor file and sends it to the webview. */
  private async _handleAddCurrentFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }
    const doc = editor.document;
    const fileName = doc.fileName.split(/[\\/]/).pop() ?? doc.fileName;
    const content = doc.getText();
    this._post({
      type: 'fileAdded',
      name: fileName,
      content,
    });
  }

  /** Reads the current selection and sends it to the webview. */
  private _handleAddSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) { return; }
    const doc = editor.document;
    const fileName = doc.fileName.split(/[\\/]/).pop() ?? doc.fileName;
    const selection = editor.selection;
    const range = `${selection.start.line + 1}-${selection.end.line + 1}`;
    const content = doc.getText(selection);
    this._post({
      type: 'selectionAdded',
      name: `${fileName}:${range}`,
      content,
    });
  }

  /** Opens VS Code file picker and sends the selected file(s) to the webview. */
  private async _handleAttachFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: true,
      canSelectFiles: true,
      canSelectFolders: false,
      openLabel: 'Attach',
    });
    if (!uris || uris.length === 0) { return; }

    for (const uri of uris) {
      const fileName = uri.path.split('/').pop() ?? uri.path;
      try {
        // Check if it's an image by extension
        const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
        const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];

        if (imageExts.includes(ext)) {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const base64 = Buffer.from(bytes).toString('base64');
          const mimeType = ext === 'svg' ? 'image/svg+xml'
            : ext === 'jpg' ? 'image/jpeg'
            : `image/${ext}`;
          this._post({
            type: 'imageAdded',
            name: fileName,
            dataUrl: `data:${mimeType};base64,${base64}`,
          });
        } else {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const content = Buffer.from(bytes).toString('utf8');
          this._post({ type: 'fileAdded', name: fileName, content });
        }
      } catch {
        this._post({ type: 'fileAdded', name: fileName, content: `(Failed to read ${fileName})` });
      }
    }
  }

  /** Reads a file from a URI string (e.g. from a drop) and sends it to the webview. */
  private async _handleReadDroppedUri(uriStr: string, name: string): Promise<void> {
    try {
      const uri = vscode.Uri.parse(uriStr);
      const ext = name.split('.').pop()?.toLowerCase() ?? '';
      const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];

      if (imageExts.includes(ext)) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const base64 = Buffer.from(bytes).toString('base64');
        const mimeType = ext === 'svg' ? 'image/svg+xml'
          : ext === 'jpg' ? 'image/jpeg'
          : `image/${ext}`;
        this._post({
          type: 'imageAdded',
          name,
          dataUrl: `data:${mimeType};base64,${base64}`,
        });
      } else {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(bytes).toString('utf8');
        this._post({ type: 'fileAdded', name, content });
      }
    } catch {
      this._post({ type: 'fileAdded', name, content: `(Failed to read ${name})` });
    }
  }
}
