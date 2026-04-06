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
  const sessions = new SessionManager(context.globalState);
  const provider = new SidebarProvider(context.extensionUri, sessions, context.globalStorageUri);

  // Clean up images older than 30 days (fire-and-forget)
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
