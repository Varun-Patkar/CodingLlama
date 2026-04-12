/**
 * SessionManager — CRUD operations for chat sessions stored as JSON files.
 *
 * Sessions live in `.codingllama/sessions/` under the workspace root.
 * Each session = `{id}.json`. An `index.json` stores lightweight metadata.
 * No workspace → fallback to `~/.codingllama/sessions/`.
 * Max 50 sessions; oldest dropped when limit hit.
 */
import * as vscode from 'vscode';
import * as path from 'path';

/** Attachment metadata stored with messages. */
export interface StoredAttachment {
  type: 'file' | 'image' | 'selection';
  name: string;
  imagePath?: string;
  imageUri?: string;
}

/** A single message in a chat session. */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  attachments?: StoredAttachment[];
  /** Model that generated this response (assistant messages only). */
  model?: string;
}

/** Session status for UI display. */
export type SessionStatus = 'streaming' | 'unread' | 'read';

/** Lightweight metadata stored in index.json. */
export interface SessionMeta {
  id: string;
  title: string;
  createdAt: number;
  status: SessionStatus;
}

/** A compaction checkpoint — covers messages[0..upTo-1]. */
export interface CompactionCheckpoint {
  /** Messages index up to which this compaction covers (exclusive). */
  upTo: number;
  /** LLM-generated summary of messages[prevUpTo..upTo-1]. */
  summary: string;
}

/** A full persisted chat session. */
export interface Session {
  id: string;
  title: string;
  createdAt: number;
  status: SessionStatus;
  messages: Message[];
  /**
   * Stacking compaction checkpoints.
   * Each entry covers messages from the previous checkpoint's upTo (or 0) to this upTo.
   * On edit at index N: discard all checkpoints where upTo > N.
   * For LLM context: combine all valid checkpoint summaries, then add raw messages after last checkpoint.
   */
  compactions?: CompactionCheckpoint[];
  /**
   * Redo stack — messages that were removed by a checkpoint restore.
   * Redo replays these back onto the session (no LLM call).
   * Cleared when user sends a new message or edits.
   */
  redoStack?: Message[];
}

const MAX_SESSIONS = 50;
const SESSIONS_DIR = '.codingllama/sessions';
const INDEX_FILE = 'index.json';

export class SessionManager {
  private _sessionsDir: vscode.Uri;
  private _activeId: string | null = null;
  private _index: SessionMeta[] = [];
  private _cache: Map<string, Session> = new Map();

  constructor(workspaceFolder: vscode.Uri | undefined) {
    if (workspaceFolder) {
      this._sessionsDir = vscode.Uri.joinPath(workspaceFolder, SESSIONS_DIR);
    } else {
      const home = process.env.USERPROFILE || process.env.HOME || 'C:\\Users\\Default';
      this._sessionsDir = vscode.Uri.file(path.join(home, SESSIONS_DIR));
    }
  }

  async init(): Promise<void> {
    try { await vscode.workspace.fs.createDirectory(this._sessionsDir); } catch { /* exists */ }
    await this._loadIndex();
  }

  private async _loadIndex(): Promise<void> {
    try {
      const uri = vscode.Uri.joinPath(this._sessionsDir, INDEX_FILE);
      const bytes = await vscode.workspace.fs.readFile(uri);
      this._index = JSON.parse(Buffer.from(bytes).toString('utf8'));
    } catch { this._index = []; }
  }

  private async _saveIndex(): Promise<void> {
    const uri = vscode.Uri.joinPath(this._sessionsDir, INDEX_FILE);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(this._index, null, 2), 'utf8'));
  }

  private async _readSession(id: string): Promise<Session | null> {
    if (this._cache.has(id)) { return this._cache.get(id)!; }
    try {
      const uri = vscode.Uri.joinPath(this._sessionsDir, `${id}.json`);
      const bytes = await vscode.workspace.fs.readFile(uri);
      const session = JSON.parse(Buffer.from(bytes).toString('utf8')) as Session;
      this._cache.set(id, session);
      return session;
    } catch { return null; }
  }

  private async _writeSession(session: Session): Promise<void> {
    this._cache.set(session.id, session);
    const uri = vscode.Uri.joinPath(this._sessionsDir, `${session.id}.json`);
    await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(session, null, 2), 'utf8'));
  }

  private async _deleteSessionFile(id: string): Promise<void> {
    this._cache.delete(id);
    try {
      await vscode.workspace.fs.delete(vscode.Uri.joinPath(this._sessionsDir, `${id}.json`));
    } catch { /* file might not exist */ }
  }

  getAllMeta(): SessionMeta[] { return this._index; }

  getActiveId(): string | null { return this._activeId; }

  async getActive(): Promise<Session | null> {
    if (!this._activeId) { return null; }
    return this._readSession(this._activeId);
  }

  async getSession(id: string): Promise<Session | null> {
    return this._readSession(id);
  }

  async createNew(): Promise<Session> {
    const session: Session = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: 'New Chat',
      createdAt: Date.now(),
      status: 'read',
      messages: [],
    };
    this._index.unshift({ id: session.id, title: session.title, createdAt: session.createdAt, status: session.status });
    if (this._index.length > MAX_SESSIONS) {
      const removed = this._index.splice(MAX_SESSIONS);
      for (const r of removed) { await this._deleteSessionFile(r.id); }
    }
    this._activeId = session.id;
    await this._writeSession(session);
    await this._saveIndex();
    return session;
  }

  setActive(id: string): void { this._activeId = id; }

  async saveSession(session: Session): Promise<void> {
    await this._writeSession(session);
    const meta = this._index.find(m => m.id === session.id);
    if (meta) { meta.title = session.title; meta.status = session.status; }
    await this._saveIndex();
  }

  async updateTitle(id: string, title: string): Promise<void> {
    const truncated = title.length > 40 ? title.slice(0, 40) + '...' : title;
    const meta = this._index.find(m => m.id === id);
    if (meta) { meta.title = truncated; }
    const session = this._cache.get(id);
    if (session) { session.title = truncated; await this._writeSession(session); }
    await this._saveIndex();
  }

  async setStatus(id: string, status: SessionStatus): Promise<void> {
    const meta = this._index.find(m => m.id === id);
    if (meta) { meta.status = status; }
    const session = this._cache.get(id);
    if (session) { session.status = status; }
    await this._saveIndex();
  }

  async delete(id: string): Promise<void> {
    this._index = this._index.filter(m => m.id !== id);
    await this._deleteSessionFile(id);
    if (this._activeId === id) { this._activeId = null; }
    await this._saveIndex();
  }

  async clearAll(): Promise<void> {
    for (const meta of this._index) { await this._deleteSessionFile(meta.id); }
    this._index = [];
    this._activeId = null;
    await this._saveIndex();
  }
}
