/**
 * SessionManager — CRUD operations for chat sessions stored in VS Code globalState.
 *
 * Sessions are stored under the key "codingLlama.sessions" as a JSON array.
 * The active session ID is stored under "codingLlama.activeSessionId".
 * A maximum of 50 sessions are retained; the oldest are dropped when the limit is hit.
 */
import * as vscode from 'vscode';

/** Attachment metadata stored with messages. */
export interface StoredAttachment {
  type: 'file' | 'image' | 'selection';
  name: string;
  /** For images: relative path under globalStorageUri where the image is saved. */
  imagePath?: string;
}

/** A single message in a chat session. */
export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
  /** Attachment names/types for display (content is NOT stored to save space). */
  attachments?: StoredAttachment[];
}

/** A persisted chat session. */
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

  /** Returns all stored sessions, newest first. */
  getAll(): Session[] {
    return this.state.get<Session[]>(STORAGE_KEY, []);
  }

  /** Returns the currently active session, or null if none is set. */
  getActive(): Session | null {
    const id = this.state.get<string>(ACTIVE_KEY);
    if (!id) { return null; }
    return this.getAll().find(s => s.id === id) ?? null;
  }

  /**
   * Creates a new empty session, prepends it to the list, trims to MAX_SESSIONS,
   * and sets it as the active session.
   */
  createNew(): Session {
    const session: Session = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

  /** Sets the active session by ID. */
  setActive(id: string): void {
    this.state.update(ACTIVE_KEY, id);
  }

  /**
   * Re-persists the full sessions array.
   * Call this after mutating a session's messages in place.
   */
  save(sessions: Session[]): void {
    this.state.update(STORAGE_KEY, sessions);
  }

  /**
   * Saves a single mutated session back into the stored sessions array.
   * Finds the session by ID and replaces it, then persists.
   */
  saveSession(session: Session): void {
    const sessions = this.getAll();
    const idx = sessions.findIndex(s => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = session;
    } else {
      sessions.unshift(session);
    }
    this.state.update(STORAGE_KEY, sessions);
  }

  /**
   * Updates the title of a session to the first user message,
   * truncated to 40 characters.
   */
  updateTitle(id: string, firstMessage: string): void {
    const sessions = this.getAll();
    const session = sessions.find(s => s.id === id);
    if (session) {
      session.title = firstMessage.length > 40
        ? firstMessage.slice(0, 40) + '...'
        : firstMessage;
      this.state.update(STORAGE_KEY, sessions);
    }
  }

  /** Deletes a session by ID. */
  delete(id: string): void {
    const sessions = this.getAll().filter(s => s.id !== id);
    this.state.update(STORAGE_KEY, sessions);
    // If the deleted session was active, clear the active key
    const activeId = this.state.get<string>(ACTIVE_KEY);
    if (activeId === id) {
      this.state.update(ACTIVE_KEY, undefined);
    }
  }

  /** Removes all sessions and clears the active session. */
  clearAll(): void {
    this.state.update(STORAGE_KEY, []);
    this.state.update(ACTIVE_KEY, undefined);
  }
}
