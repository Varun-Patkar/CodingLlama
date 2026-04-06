/**
 * Static model catalogue — always shown in the model picker regardless of install status.
 * Ollama's /v1/models endpoint is checked at runtime to determine which are installed.
 */

/** Represents a model entry in the static catalogue. */
export interface ModelEntry {
  /** Exact Ollama model name used in API calls (e.g. "qwen2.5-coder:7b"). */
  id: string;
  /** Human-readable display name. */
  label: string;
  /** Quality tier: high, medium, or low. */
  tier: 'high' | 'medium' | 'low';
  /** Approximate download size in GB. */
  sizeGb: number;
  /** Context window size in tokens. */
  contextSize: number;
}

/** The five default models always shown in the picker. */
export const STATIC_MODELS: ModelEntry[] = [
  { id: 'qwen2.5-coder:7b',    label: 'Qwen 2.5 Coder 7B',   tier: 'high',   sizeGb: 4.7, contextSize: 32768  },
  { id: 'qwen2.5-coder:3b',    label: 'Qwen 2.5 Coder 3B',   tier: 'medium', sizeGb: 1.9, contextSize: 32768  },
  { id: 'deepseek-coder:6.7b', label: 'DeepSeek Coder 6.7B',  tier: 'high',   sizeGb: 3.8, contextSize: 16384  },
  { id: 'llama3.2:3b',         label: 'Llama 3.2 3B',         tier: 'medium', sizeGb: 2.0, contextSize: 131072 },
  { id: 'phi3.5:3.8b',         label: 'Phi 3.5 3.8B',         tier: 'low',    sizeGb: 2.2, contextSize: 131072 },
];

/** Maps tier values to emoji badge strings for display. */
export const TIER_BADGE: Record<ModelEntry['tier'], string> = {
  high:   '🟢 High',
  medium: '🟡 Medium',
  low:    '🔴 Low',
};
