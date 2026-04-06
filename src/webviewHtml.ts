/**
 * Generates the HTML content for the webview sidebar.
 *
 * - Uses webview.asWebviewUri() to convert local file paths to webview-safe URIs
 * - Includes a Content Security Policy with a nonce for script tags
 * - Injects the static models catalogue as a JSON script block so the webview
 *   can access it without a round-trip to the extension host
 */
import * as vscode from 'vscode';
import { STATIC_MODELS, TIER_BADGE } from './models';

/**
 * Returns the full HTML string for the CodingLlama webview.
 *
 * @param webview      - The Webview instance (needed for cspSource and asWebviewUri)
 * @param extensionUri - The root URI of the extension install folder
 */
export function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  // Convert local media paths to webview-safe URIs
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'main.js')
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'style.css')
  );
  const markedUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, 'media', 'marked.umd.js')
  );

  const nonce = getNonce();

  // Content Security Policy: restrict what the webview can load
  const csp = [
    `default-src 'none'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} https: data:`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  // Inject static models data so the webview JS can render the picker
  // without a round-trip postMessage call
  const modelsJson = JSON.stringify(
    STATIC_MODELS.map(m => ({
      id: m.id,
      label: m.label,
      tier: m.tier,
      sizeGb: m.sizeGb,
      contextSize: m.contextSize,
      badge: TIER_BADGE[m.tier],
    }))
  );

  return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>CodingLlama</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}">
    // Injected data — available to main.js as window.__STATIC_MODELS__
    window.__STATIC_MODELS__ = ${modelsJson};
  </script>
  <script nonce="${nonce}" src="${markedUri}"></script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}

/** Generates a random 32-character alphanumeric nonce for CSP script tags. */
function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from(
    { length: 32 },
    () => chars[Math.floor(Math.random() * chars.length)]
  ).join('');
}
