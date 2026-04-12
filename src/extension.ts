/**
 * Extension entry point — registers the WebviewViewProvider and commands.
 *
 * Architecture: We do NOT use the VS Code Chat Participant API.
 * All UI lives in a custom WebviewViewProvider registered in the activity bar.
 * This gives us full control over the model picker, mode tabs, and sessions panel.
 */
import * as vscode from 'vscode';
import { SidebarProvider } from './sidebarProvider';
import { SessionManager } from './sessionManager';

/**
 * Called by VS Code when the extension is activated.
 * Registers the sidebar webview provider and all commands.
 */
export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri ?? undefined;
  const sessions = new SessionManager(workspaceFolder);
  const provider = new SidebarProvider(context.extensionUri, sessions, context.globalStorageUri);

  // Initialize file-based session storage + clean old images (fire-and-forget)
  sessions.init().then(() => {
    // Ensure .codingllama is gitignored in workspace repos
    if (workspaceFolder) { ensureGitignore(workspaceFolder); }
  });
  provider.cleanupOldImages();

  // Register the webview view provider — retainContextWhenHidden keeps the
  // webview alive when the user navigates away from the sidebar, preserving
  // scroll position, input text, and streaming state.
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      SidebarProvider.viewId,
      provider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // "New Chat" command — wired to the + icon in the view title bar
  context.subscriptions.push(
    vscode.commands.registerCommand('codingLlama.newChat', () => {
      provider.newChat();
    })
  );

  // "Clear All Sessions" command
  context.subscriptions.push(
    vscode.commands.registerCommand('codingLlama.clearChats', () => {
      provider.clearAll();
    })
  );

  // "Add to CodingLlama Chat" — context menu in explorer, editor tab, editor body
  // VS Code passes (clickedUri, allSelectedUris[]) for explorer multi-select
  context.subscriptions.push(
    vscode.commands.registerCommand('codingLlama.addFile', (uri?: vscode.Uri, uris?: vscode.Uri[]) => {
      provider.addFiles(uris && uris.length > 0 ? uris : uri ? [uri] : []);
    })
  );
}

/** Called by VS Code when the extension is deactivated. */
export function deactivate(): void {
  // Nothing to clean up — disposables are managed via context.subscriptions
}

/**
 * Ensures `.codingllama` is in .gitignore for the workspace.
 * Only acts if the workspace is a git repo (.git folder exists).
 * Creates .gitignore if it doesn't exist; appends if it does.
 */
async function ensureGitignore(workspaceUri: vscode.Uri): Promise<void> {
  try {
    // Check if .git folder exists — only add gitignore for git repos
    const gitUri = vscode.Uri.joinPath(workspaceUri, '.git');
    try {
      await vscode.workspace.fs.stat(gitUri);
    } catch {
      return; // Not a git repo, skip
    }

    const gitignoreUri = vscode.Uri.joinPath(workspaceUri, '.gitignore');
    const entry = '.codingllama/';

    try {
      // .gitignore exists — check if already has the entry
      const bytes = await vscode.workspace.fs.readFile(gitignoreUri);
      const content = Buffer.from(bytes).toString('utf8');
      if (content.includes(entry)) { return; } // Already there

      // Append the entry (with newline before if file doesn't end with one)
      const suffix = content.endsWith('\n') ? '' : '\n';
      const updated = content + suffix + '\n# CodingLlama session data\n' + entry + '\n';
      await vscode.workspace.fs.writeFile(gitignoreUri, Buffer.from(updated, 'utf8'));
    } catch {
      // .gitignore doesn't exist — create it
      const newContent = '# CodingLlama session data\n' + entry + '\n';
      await vscode.workspace.fs.writeFile(gitignoreUri, Buffer.from(newContent, 'utf8'));
    }
  } catch {
    // Silently ignore any errors — not critical
  }
}
