/**
 * Configuration helpers — reads/writes the codingLlama.* VS Code settings.
 */
import * as vscode from 'vscode';

/** Returns the current extension configuration values. */
export function getConfig(): { baseUrl: string; model: string } {
  const cfg = vscode.workspace.getConfiguration('codingLlama');
  return {
    baseUrl: cfg.get<string>('baseUrl', 'http://localhost:11434'),
    model:   cfg.get<string>('model', 'qwen2.5-coder:7b'),
  };
}

/** Persists the selected model to the global VS Code settings. */
export async function setModel(model: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('codingLlama');
  await cfg.update('model', model, vscode.ConfigurationTarget.Global);
}
