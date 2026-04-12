/**
 * SidebarProvider — WebviewViewProvider that owns the CodingLlama chat sidebar.
 *
 * Responsibilities:
 *  - Renders the webview HTML (via webviewHtml.ts)
 *  - Handles all postMessage traffic between the webview and the extension host
 *  - Bridges chat input → Ollama streaming → token-by-token updates to the webview
 *  - Supports parallel streaming across multiple sessions
 *  - Generates session titles via LLM before streaming answers
 *  - Manages model listing + pull via ollamaClient
 *  - Coordinates session CRUD via SessionManager (file-based)
 */
import * as vscode from 'vscode';
import { getHtml } from './webviewHtml';
import { streamOllama, listModels, pullModel, checkOllama, getModelContextSize, ContentPart, MessageContent } from './ollamaClient';
import { SessionManager, Session, CompactionCheckpoint } from './sessionManager';
import { getConfig, setModel } from './config';
import { ASK_SYSTEM_PROMPT, TITLE_GENERATOR_PROMPT, COMPACT_CONVERSATION_PROMPT, SYSTEM_PROMPT_TOKENS } from './prompts';

/** Attachment sent from the webview with each chat message. */
interface Attachment {
  type: 'file' | 'selection' | 'image';
  name: string;
  content?: string;
  dataUrl?: string;
}

/** Tracks an active streaming request for a specific session. */
interface StreamState {
  abortController: AbortController;
  fullResponse: string;
}

export class SidebarProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'codingLlama.chatView';

  private _view?: vscode.WebviewView;
  /** Active streams per session — enables parallel streaming. */
  private _streams: Map<string, StreamState> = new Map();

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private readonly _sessions: SessionManager,
    private readonly _storageUri: vscode.Uri,
  ) {}

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
    webviewView.webview.onDidReceiveMessage((msg) => this._handleMessage(msg));
    vscode.window.onDidChangeActiveTextEditor(() => this._sendEditorContext());
    vscode.window.onDidChangeTextEditorSelection(() => this._sendEditorContext());
  }

  // ── Public API ────────────────────────────────────────────────────────

  public async newChat(): Promise<void> {
    await this._sessions.createNew();
    this._postSessions();
    await this._postActiveSession();
  }

  public async clearAll(): Promise<void> {
    // Abort all active streams
    for (const [, s] of this._streams) { s.abortController.abort(); }
    this._streams.clear();
    await this._sessions.clearAll();
    this._postSessions();
    await this._postActiveSession();
  }

  public async addFiles(uris: vscode.Uri[]): Promise<void> {
    if (uris.length === 0) {
      const activeUri = vscode.window.activeTextEditor?.document.uri;
      if (activeUri) { uris = [activeUri]; }
    }
    for (const fileUri of uris) { await this.addFile(fileUri); }
    if (uris.length > 0 && this._view) { this._view.show?.(true); }
  }

  public async addFile(uri?: vscode.Uri): Promise<void> {
    const fileUri = uri ?? vscode.window.activeTextEditor?.document.uri;
    if (!fileUri) { return; }
    const fileName = fileUri.path.split('/').pop() ?? fileUri.path;
    try {
      const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
      const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
      if (imageExts.includes(ext)) {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        const base64 = Buffer.from(bytes).toString('base64');
        const mimeType = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        this._post({ type: 'imageAdded', name: fileName, dataUrl: `data:${mimeType};base64,${base64}` });
      } else {
        const bytes = await vscode.workspace.fs.readFile(fileUri);
        this._post({ type: 'fileAdded', name: fileName, content: Buffer.from(bytes).toString('utf8') });
      }
    } catch {
      this._post({ type: 'fileAdded', name: fileName, content: `(Failed to read ${fileName})` });
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────

  private _post(message: unknown): void {
    this._view?.webview.postMessage(message);
  }

  private _postSessions(): void {
    this._post({ type: 'sessions', sessions: this._sessions.getAllMeta() });
  }

  /** Pushes active session with resolved image URIs to webview. */
  private async _postActiveSession(): Promise<void> {
    const session = await this._sessions.getActive();
    const { model } = getConfig();
    let resolved = session;
    if (session) {
      resolved = {
        ...session,
        messages: session.messages.map(m => {
          if (!m.attachments) { return m; }
          return { ...m, attachments: m.attachments.map(a => {
            if (a.type === 'image' && a.imagePath) {
              return { ...a, imageUri: this._resolveImageUri(a.imagePath) ?? undefined };
            }
            return a;
          })};
        }),
      };
    }
    this._post({ type: 'activeSession', session: resolved, selectedModel: model, systemPromptTokens: SYSTEM_PROMPT_TOKENS });
  }

  private async _sendInitialState(): Promise<void> {
    this._postSessions();
    await this._postActiveSession();
    this._sendEditorContext();
    await this._handleGetModels();
  }

  // ── Message dispatch ──────────────────────────────────────────────────

  private async _handleMessage(msg: Record<string, unknown>): Promise<void> {
    switch (msg.type) {
      case 'ready':
        await this._sendInitialState();
        break;
      case 'checkOllama':
        await this._handleCheckOllama();
        break;
      case 'send':
        await this._handleChat(msg.text as string, msg.model as string, (msg.attachments as Attachment[] | undefined) || []);
        break;
      case 'newChat':
        await this.newChat();
        break;
      case 'selectSession':
        this._sessions.setActive(msg.id as string);
        await this._sessions.setStatus(msg.id as string, 'read');
        await this._postActiveSession();
        this._postSessions();
        // If target session is still streaming, replay its state
        this._replayStreamState(msg.id as string);
        break;
      case 'deleteSession': {
        const delId = msg.id as string;
        const stream = this._streams.get(delId);
        if (stream) { stream.abortController.abort(); this._streams.delete(delId); }
        await this._sessions.delete(delId);
        this._postSessions();
        await this._postActiveSession();
        break;
      }
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
        this._handleStopGeneration(msg.sessionId as string | undefined);
        break;
      case 'resend':
        await this._handleResend(msg.messageIndex as number, msg.text as string, msg.model as string, (msg.attachments as Attachment[] | undefined) || []);
        break;
      case 'compactConversation':
        await this._handleCompactConversation(msg.model as string);
        break;
      case 'compactAndSend':
        await this._handleCompactConversation(msg.model as string);
        await this._handleChat(msg.text as string, msg.model as string, (msg.attachments as Attachment[] | undefined) || []);
        break;
      case 'restoreCheckpoint':
        await this._handleRestoreCheckpoint(msg.messageIndex as number);
        break;
      case 'redoMessages':
        await this._handleRedo();
        break;
      case 'forkConversation':
        await this._handleFork(msg.messageIndex as number);
        break;
    }
  }

  // ── Chat streaming (parallel-capable) ─────────────────────────────────

  /**
   * Handles a user chat message with title generation + parallel streaming.
   * Flow for new sessions: user msg → generate title → stream answer.
   * Flow for existing sessions: user msg → stream answer directly.
   */
  private async _handleChat(text: string, model: string, attachments: Attachment[]): Promise<void> {
    let session = await this._sessions.getActive();
    if (!session) {
      session = await this._sessions.createNew();
      this._postSessions();
      await this._postActiveSession();
    }

    // Save images to persistent storage
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

    // New message invalidates redo stack
    session.redoStack = undefined;

    // Title generation for new sessions (first user message)
    const userMessages = session.messages.filter(m => m.role === 'user');
    if (userMessages.length === 1) {
      // Generate title via quick non-streaming LLM call
      await this._generateTitle(session, text, model);
      this._postSessions();
    }

    // Persist user message
    session.status = 'streaming';
    await this._sessions.saveSession(session);
    this._postSessions();
    // Push updated session so webview has the user message before streaming starts
    await this._postActiveSession();
    this._post({ type: 'streamStart', sessionId: session.id });

    await setModel(model);

    // Build Ollama messages
    // Use stacking compaction: combine all checkpoint summaries, then raw messages after last checkpoint
    const ollamaMessages: Array<{ role: string; content: MessageContent }> = [
      { role: 'system', content: ASK_SYSTEM_PROMPT },
    ];

    const prevMessages = session.messages.slice(0, -1); // all but current user message
    const checkpoints = session.compactions || [];

    if (checkpoints.length > 0) {
      // Combine all checkpoint summaries into context
      const combinedSummary = checkpoints.map((cp, i) => {
        const label = checkpoints.length > 1 ? `Summary (part ${i + 1}):` : 'Previous conversation summary:';
        return `${label}\n${cp.summary}`;
      }).join('\n\n');
      ollamaMessages.push({ role: 'system', content: combinedSummary });

      // Add only messages after the last checkpoint
      const lastUpTo = checkpoints[checkpoints.length - 1].upTo;
      const postCompactMsgs = prevMessages.slice(lastUpTo);
      ollamaMessages.push(...postCompactMsgs.map(m => ({ role: m.role, content: m.content })));
    } else {
      ollamaMessages.push(...prevMessages.map(m => ({ role: m.role, content: m.content })));
    }

    const fileAtts = attachments.filter(a => a.type === 'file' || a.type === 'selection');
    const imageAtts = attachments.filter(a => a.type === 'image');
    let contextText = '';
    if (fileAtts.length > 0) {
      contextText = fileAtts.map(a => {
        const label = a.type === 'selection' ? `Selection from ${a.name}` : `File: ${a.name}`;
        return `--- ${label} ---\n\`\`\`\n${a.content}\n\`\`\``;
      }).join('\n\n') + '\n\n';
    }
    const fullText = contextText + text;

    if (imageAtts.length > 0) {
      const parts: ContentPart[] = [{ type: 'text', text: fullText }];
      for (const img of imageAtts) {
        if (img.dataUrl) { parts.push({ type: 'image_url', image_url: { url: img.dataUrl } }); }
      }
      ollamaMessages.push({ role: 'user', content: parts });
    } else {
      ollamaMessages.push({ role: 'user', content: fullText });
    }

    // Create stream state for parallel tracking
    const abortController = new AbortController();
    const streamState: StreamState = { abortController, fullResponse: '' };
    this._streams.set(session.id, streamState);

    try {
      await streamOllama({
        model,
        messages: ollamaMessages,
        signal: abortController.signal,
        onToken: (chunk) => {
          streamState.fullResponse += chunk;
          this._post({ type: 'streamToken', token: chunk, sessionId: session!.id });
        },
        onDone: async () => {
          session!.messages.push({ role: 'assistant', content: streamState.fullResponse, model });
          session!.status = 'unread';
          // If user is viewing this session, mark as read
          if (this._sessions.getActiveId() === session!.id) {
            session!.status = 'read';
          }
          await this._sessions.saveSession(session!);
          this._streams.delete(session!.id);
          this._post({ type: 'streamEnd', sessionId: session!.id });
          this._postSessions();
          await this._postActiveSession();
        },
      });
    } catch (err: unknown) {
      if (abortController.signal.aborted) {
        if (streamState.fullResponse) {
          session!.messages.push({ role: 'assistant', content: streamState.fullResponse, model });
        }
        session!.status = 'read';
        await this._sessions.saveSession(session!);
        this._post({ type: 'streamEnd', sessionId: session!.id });
        await this._postActiveSession();
      } else {
        session!.status = 'read';
        await this._sessions.saveSession(session!);
        const errorMsg = err instanceof Error ? err.message : String(err);
        this._post({ type: 'streamError', error: errorMsg, sessionId: session!.id });
      }
      this._streams.delete(session!.id);
      this._postSessions();
    }
  }

  /** Generates a title for a new session using the LLM (non-streaming). */
  private async _generateTitle(session: Session, userMessage: string, model: string): Promise<void> {
    try {
      const { baseUrl } = getConfig();
      const res = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: TITLE_GENERATOR_PROMPT },
            { role: 'user', content: userMessage },
          ],
          stream: false,
        }),
      });
      if (res.ok) {
        const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
        const title = data.choices?.[0]?.message?.content?.trim();
        if (title && title.length > 0) {
          const truncated = title.length > 50 ? title.slice(0, 50) + '...' : title;
          session.title = truncated;
          await this._sessions.updateTitle(session.id, truncated);
        }
      }
    } catch {
      // Fallback: use truncated first message
      await this._sessions.updateTitle(session.id, userMessage);
    }
  }

  /** Stops generation for a specific session (or the active one). */
  private _handleStopGeneration(sessionId?: string): void {
    const id = sessionId ?? this._sessions.getActiveId();
    if (id) {
      const stream = this._streams.get(id);
      if (stream) { stream.abortController.abort(); }
    }
  }

  /** If the target session has an active stream, replay current content. */
  private _replayStreamState(sessionId: string): void {
    const stream = this._streams.get(sessionId);
    if (stream) {
      this._post({ type: 'streamStart', sessionId });
      if (stream.fullResponse) {
        this._post({ type: 'streamReplay', sessionId, content: stream.fullResponse });
      }
    }
  }

  /** Handles editing and resending a previous user message. */
  private async _handleResend(messageIndex: number, text: string, model: string, attachments: Attachment[]): Promise<void> {
    const session = await this._sessions.getActive();
    if (!session) { return; }

    // Discard any compaction checkpoints past the edit point
    // Keep only checkpoints where upTo <= messageIndex (those are still valid)
    if (session.compactions && session.compactions.length > 0) {
      session.compactions = session.compactions.filter(cp => cp.upTo <= messageIndex);
      if (session.compactions.length === 0) { session.compactions = undefined; }
    }

    session.messages = session.messages.slice(0, messageIndex);
    // Clear redo stack since user is sending new content
    session.redoStack = undefined;
    await this._sessions.saveSession(session);
    await this._postActiveSession();
    await this._handleChat(text, model, attachments);
  }

  // ── Checkpoint / Fork ─────────────────────────────────────────────────

  /**
   * Restores a checkpoint: truncates session to messageIndex, saves removed
   * messages to redoStack so user can redo (replay without LLM call).
   */
  private async _handleRestoreCheckpoint(messageIndex: number): Promise<void> {
    const session = await this._sessions.getActive();
    if (!session) { return; }

    // Save messages after the checkpoint to redo stack
    const removed = session.messages.slice(messageIndex);
    session.redoStack = removed;

    // Truncate messages
    session.messages = session.messages.slice(0, messageIndex);

    // Trim compaction checkpoints past this point
    if (session.compactions && session.compactions.length > 0) {
      session.compactions = session.compactions.filter(cp => cp.upTo <= messageIndex);
      if (session.compactions.length === 0) { session.compactions = undefined; }
    }

    await this._sessions.saveSession(session);
    this._postSessions();
    await this._postActiveSession();
  }

  /**
   * Redo: replays messages from the redo stack back onto the session.
   * No LLM call — just restores what was removed by checkpoint restore.
   */
  private async _handleRedo(): Promise<void> {
    const session = await this._sessions.getActive();
    if (!session || !session.redoStack || session.redoStack.length === 0) { return; }

    // Push all redo messages back
    session.messages.push(...session.redoStack);
    session.redoStack = undefined;

    await this._sessions.saveSession(session);
    this._postSessions();
    await this._postActiveSession();
  }

  /**
   * Fork: creates a new session with messages up to messageIndex copied from current.
   * The original session is unchanged.
   */
  private async _handleFork(messageIndex: number): Promise<void> {
    const session = await this._sessions.getActive();
    if (!session) { return; }

    const forked = await this._sessions.createNew();
    forked.title = session.title + ' (fork)';
    forked.messages = session.messages.slice(0, messageIndex).map(m => ({ ...m }));

    // Copy compaction checkpoints that are still valid for the forked range
    if (session.compactions) {
      forked.compactions = session.compactions.filter(cp => cp.upTo <= messageIndex).map(cp => ({ ...cp }));
      if (forked.compactions.length === 0) { forked.compactions = undefined; }
    }

    await this._sessions.saveSession(forked);
    this._postSessions();
    await this._postActiveSession();
  }

  /**
   * Stacking compaction: summarizes messages since the last checkpoint.
   * Pushes a new CompactionCheckpoint. Original messages preserved for display.
   * Multiple compactions stack — each covers its own range.
   */
  private async _handleCompactConversation(model: string): Promise<void> {
    const session = await this._sessions.getActive();
    if (!session || session.messages.length < 2) { return; }

    const checkpoints = session.compactions || [];
    // Only compact messages after the last checkpoint
    const lastUpTo = checkpoints.length > 0 ? checkpoints[checkpoints.length - 1].upTo : 0;
    const messagesToCompact = session.messages.slice(lastUpTo);
    if (messagesToCompact.length < 2) { return; }

    // Include previous summaries as context for continuity
    let contextPrefix = '';
    if (checkpoints.length > 0) {
      contextPrefix = 'Previous summaries:\n' + checkpoints.map(cp => cp.summary).join('\n---\n') + '\n\nNew messages to summarize:\n';
    }

    const transcript = messagesToCompact.map(m => {
      const role = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'System';
      return `${role}: ${m.content}`;
    }).join('\n\n');

    this._post({ type: 'streamStart', sessionId: session.id });
    this._post({ type: 'compactStart' });
    let summary = '';

    try {
      await streamOllama({
        model,
        messages: [
          { role: 'system', content: COMPACT_CONVERSATION_PROMPT },
          { role: 'user', content: contextPrefix + transcript },
        ],
        onToken: (chunk) => {
          summary += chunk;
          this._post({ type: 'streamToken', token: chunk, sessionId: session.id });
        },
        onDone: async () => {
          // Push new checkpoint
          if (!session.compactions) { session.compactions = []; }
          session.compactions.push({ upTo: session.messages.length, summary });
          await this._sessions.saveSession(session);
          this._post({ type: 'streamEnd', sessionId: session.id });
          await this._postActiveSession();
        },
      });
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this._post({ type: 'streamError', error: errorMsg, sessionId: session.id });
    }
  }

  // ── Model management ──────────────────────────────────────────────────

  private async _handleCheckOllama(): Promise<void> {
    const online = await checkOllama();
    this._post({ type: 'ollamaStatus', online });
  }

  // ── Image persistence ─────────────────────────────────────────────────

  private async _saveImage(dataUrl: string, fileName: string): Promise<string> {
    const imagesDir = vscode.Uri.joinPath(this._storageUri, 'images');
    try { await vscode.workspace.fs.createDirectory(imagesDir); } catch { /* exists */ }
    const uniqueName = `${Date.now()}-${fileName.replace(/[^a-zA-Z0-9.-]/g, '_')}`;
    const fileUri = vscode.Uri.joinPath(imagesDir, uniqueName);
    const base64Match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
    if (base64Match) {
      await vscode.workspace.fs.writeFile(fileUri, Buffer.from(base64Match[1], 'base64'));
    }
    return `images/${uniqueName}`;
  }

  private _resolveImageUri(imagePath: string): string | null {
    if (!this._view) { return null; }
    return this._view.webview.asWebviewUri(vscode.Uri.joinPath(this._storageUri, imagePath)).toString();
  }

  public async cleanupOldImages(): Promise<void> {
    const imagesDir = vscode.Uri.joinPath(this._storageUri, 'images');
    const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
    const cutoff = Date.now() - THIRTY_DAYS_MS;
    try {
      const entries = await vscode.workspace.fs.readDirectory(imagesDir);
      for (const [name, type] of entries) {
        if (type !== vscode.FileType.File) { continue; }
        const tsMatch = name.match(/^(\d+)-/);
        if (tsMatch && parseInt(tsMatch[1], 10) < cutoff) {
          await vscode.workspace.fs.delete(vscode.Uri.joinPath(imagesDir, name));
        }
      }
    } catch { /* dir might not exist */ }
  }

  /** Fetches installed models + context sizes and sends to webview. */
  private async _handleGetModels(): Promise<void> {
    const installed = await listModels();
    const contextSizes: Record<string, number> = {};
    await Promise.all(installed.map(async (id) => {
      contextSizes[id] = await getModelContextSize(id);
    }));
    this._post({ type: 'models', installed, contextSizes });
  }

  private async _handlePullModel(model: string): Promise<void> {
    this._post({ type: 'pullStart', model });
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Downloading ${model}...`, cancellable: false },
        async (progress) => {
          let lastPct = 0;
          await pullModel(model, (pct) => {
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
    await this._handleGetModels();
  }

  private async _handleSelectModel(model: string): Promise<void> {
    await setModel(model);
  }

  // ── Editor context ────────────────────────────────────────────────────

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
    this._post({
      type: 'editorContext',
      fileName,
      hasSelection,
      selectionText: hasSelection ? doc.getText(selection) : undefined,
      selectionRange: hasSelection ? `${selection.start.line + 1}-${selection.end.line + 1}` : undefined,
    });
  }

  private async _handleAddCurrentFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) { return; }
    const doc = editor.document;
    const fileName = doc.fileName.split(/[\\/]/).pop() ?? doc.fileName;
    this._post({ type: 'fileAdded', name: fileName, content: doc.getText() });
  }

  private _handleAddSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) { return; }
    const doc = editor.document;
    const fileName = doc.fileName.split(/[\\/]/).pop() ?? doc.fileName;
    const selection = editor.selection;
    const range = `${selection.start.line + 1}-${selection.end.line + 1}`;
    this._post({ type: 'selectionAdded', name: `${fileName}:${range}`, content: doc.getText(selection) });
  }

  private async _handleAttachFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true, canSelectFiles: true, canSelectFolders: false, openLabel: 'Attach' });
    if (!uris || uris.length === 0) { return; }
    for (const uri of uris) {
      const fileName = uri.path.split('/').pop() ?? uri.path;
      try {
        const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
        const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
        if (imageExts.includes(ext)) {
          const bytes = await vscode.workspace.fs.readFile(uri);
          const base64 = Buffer.from(bytes).toString('base64');
          const mimeType = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
          this._post({ type: 'imageAdded', name: fileName, dataUrl: `data:${mimeType};base64,${base64}` });
        } else {
          const bytes = await vscode.workspace.fs.readFile(uri);
          this._post({ type: 'fileAdded', name: fileName, content: Buffer.from(bytes).toString('utf8') });
        }
      } catch {
        this._post({ type: 'fileAdded', name: fileName, content: `(Failed to read ${fileName})` });
      }
    }
  }

  private async _handleReadDroppedUri(uriStr: string, name: string): Promise<void> {
    try {
      const uri = vscode.Uri.parse(uriStr);
      const ext = name.split('.').pop()?.toLowerCase() ?? '';
      const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];
      if (imageExts.includes(ext)) {
        const bytes = await vscode.workspace.fs.readFile(uri);
        const base64 = Buffer.from(bytes).toString('base64');
        const mimeType = ext === 'svg' ? 'image/svg+xml' : ext === 'jpg' ? 'image/jpeg' : `image/${ext}`;
        this._post({ type: 'imageAdded', name, dataUrl: `data:${mimeType};base64,${base64}` });
      } else {
        const bytes = await vscode.workspace.fs.readFile(uri);
        this._post({ type: 'fileAdded', name, content: Buffer.from(bytes).toString('utf8') });
      }
    } catch {
      this._post({ type: 'fileAdded', name, content: `(Failed to read ${name})` });
    }
  }
}
