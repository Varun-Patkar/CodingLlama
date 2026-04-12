/**
 * Ollama HTTP client — streaming chat, model listing, and model pulling.
 *
 * Uses Node's global fetch (available in VS Code 1.85+ / Node 18+).
 * All endpoints target the Ollama server at the configured baseUrl.
 *
 * Endpoints used:
 *  - POST /v1/chat/completions  — OpenAI-compatible streaming chat
 *  - GET  /v1/models            — list installed models
 *  - POST /api/pull             — download a model (Ollama-native, NDJSON progress)
 */
import { getConfig } from './config';

/** A content part for multimodal messages (text or image). */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** Message content can be a simple string or a multimodal array. */
export type MessageContent = string | ContentPart[];

/**
 * Checks if the Ollama server is reachable.
 * Returns true if the server responds, false otherwise.
 */
export async function checkOllama(): Promise<boolean> {
  const { baseUrl } = getConfig();
  try {
    const res = await fetch(baseUrl, { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

/** Options for a streaming chat request. */
interface StreamOptions {
  model: string;
  messages: Array<{ role: string; content: MessageContent }>;
  /** Called for each text token as it arrives. */
  onToken: (chunk: string) => void;
  /** Called once when the stream is fully consumed. */
  onDone?: () => void;
  /** Optional AbortSignal to cancel streaming mid-flight. */
  signal?: AbortSignal;
}

/**
 * Sends a streaming chat completion request to Ollama.
 * Parses the SSE response line-by-line, calling onToken for each content delta.
 * Resolves when the stream ends (data: [DONE]) or the body is exhausted.
 * Can be cancelled via opts.signal (AbortController).
 */
export async function streamOllama(opts: StreamOptions): Promise<void> {
  const { baseUrl } = getConfig();

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      stream: true,
    }),
    signal: opts.signal,
  });

  if (!res.ok || !res.body) {
    throw new Error(`Ollama error ${res.status}: ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) { break; }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    // Keep the last partial line in the buffer
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) { continue; }
      const data = line.slice(6).trim();
      if (data === '[DONE]') {
        opts.onDone?.();
        return;
      }
      try {
        const chunk = JSON.parse(data)?.choices?.[0]?.delta?.content;
        if (chunk) { opts.onToken(chunk); }
      } catch {
        // Skip malformed JSON lines
      }
    }
  }

  opts.onDone?.();
}

/**
 * Returns the list of model IDs currently installed in Ollama.
 * Returns an empty array if the server is unreachable.
 */
export async function listModels(): Promise<string[]> {
  const { baseUrl } = getConfig();
  try {
    const res = await fetch(`${baseUrl}/v1/models`);
    const data = (await res.json()) as { data?: Array<{ id: string }> };
    return (data.data ?? []).map((m) => m.id);
  } catch {
    return [];
  }
}

/**
 * Fetches model info from Ollama's /api/show endpoint.
 * Returns the context window size in tokens.
 * Checks both model_info (e.g. "qwen2.context_length") and parameters ("num_ctx").
 * Falls back to 8192 if unable to determine.
 */
export async function getModelContextSize(model: string): Promise<number> {
  const { baseUrl } = getConfig();
  try {
    const res = await fetch(`${baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: model }),
    });
    if (!res.ok) { return 8192; }
    const data = await res.json() as Record<string, unknown>;

    // Check model_info for any key ending in "context_length"
    const modelInfo = data.model_info as Record<string, unknown> | undefined;
    if (modelInfo) {
      for (const key of Object.keys(modelInfo)) {
        if (key.endsWith('.context_length') || key === 'context_length') {
          const val = Number(modelInfo[key]);
          if (val > 0) { return val; }
        }
      }
    }

    // Check parameters string for num_ctx (custom modelfile override)
    const params = String(data.parameters ?? '');
    const numCtxMatch = params.match(/num_ctx\s+(\d+)/);
    if (numCtxMatch) {
      const val = Number(numCtxMatch[1]);
      if (val > 0) { return val; }
    }

    return 8192;
  } catch {
    return 8192;
  }
}

/**
 * Pulls (downloads) a model from the Ollama registry.
 * Uses the Ollama-native /api/pull endpoint with streaming NDJSON progress.
 *
 * @param model  - Model name to pull (e.g. "qwen2.5-coder:7b")
 * @param onProgress - Called with a percentage (0–100) as data arrives
 */
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

  if (!res.ok || !res.body) {
    throw new Error(`Model pull failed: ${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) { break; }

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';

    for (const line of lines) {
      if (!line.trim()) { continue; }
      try {
        const obj = JSON.parse(line) as { total?: number; completed?: number };
        if (obj.total && obj.completed) {
          onProgress(Math.round((obj.completed / obj.total) * 100));
        }
      } catch {
        // Skip malformed lines
      }
    }
  }
}
