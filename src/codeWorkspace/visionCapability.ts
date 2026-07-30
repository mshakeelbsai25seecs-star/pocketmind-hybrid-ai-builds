import { invoke } from '@tauri-apps/api/tauri';
import { ONLINE_CHAT_MODELS } from '../modelCatalog';
import { remoteModelPath } from '../answerModel';

const localVisionCache = new Map<string, boolean>();

/** Synchronous check used by UI chips; local paths use cache + heuristics. */
export function modelSupportsVision(modelPath: string | null | undefined): boolean {
  if (!modelPath) return false;
  const lower = modelPath.toLowerCase();
  if (lower.includes('capabilities.vision=true')) return true;

  if (modelPath.startsWith('enterprise:')) {
    return (
      lower.includes('vision')
      || lower.includes('gpt-4o')
      || lower.includes('gpt-4.1')
      || lower.includes('gpt-5')
      || lower.includes('gemini')
      || lower.includes('llava')
      || lower.includes('qwen-vl')
      || lower.includes('qwen2-vl')
      || lower.includes('pixtral')
      || lower.includes('claude-3')
      || lower.includes('claude-sonnet')
      || lower.includes('claude-opus')
    );
  }

  if (modelPath.startsWith('remote:')) {
    const catalog = ONLINE_CHAT_MODELS.find(m => remoteModelPath(m) === modelPath);
    if (catalog?.categories?.includes('vision')) return true;
    return (
      lower.includes('/vision')
      || lower.includes('gpt-4o')
      || lower.includes('gpt-4.1')
      || lower.includes('gpt-5')
      || lower.includes('gemini')
      || lower.includes('pixtral')
      || lower.includes('llava')
      || lower.includes('qwen-vl')
      || lower.includes('claude-3')
      || lower.includes('claude-sonnet')
      || lower.includes('claude-opus')
      // DeepSeek V4 is multimodal (Flash / Pro + legacy IDs that route to V4).
      || lower.includes('deepseek-v4')
      || lower.includes('deepseek/deepseek-chat')
      || lower.includes('deepseek/deepseek-reasoner')
      || lower.includes('deepseek/deepseek-v4')
      || lower.includes('kimi-k3')
      || lower.includes('kimi-k2.6')
      || lower.includes('llama-4-maverick')
    );
  }

  if (localVisionCache.has(modelPath)) {
    return localVisionCache.get(modelPath)!;
  }
  // Heuristic until async probe fills cache (native multimodal MoE names included).
  return /\b(vl|llava|vision|mmproj|qwen3\.5|minimax-m3|kimi-k2|kimi-k3|llama-4-maverick|maverick)\b/i.test(modelPath);
}

/** Probe disk for mmproj next to a local GGUF and cache the result. */
export async function refreshLocalVisionCapability(modelPath: string | null | undefined): Promise<boolean> {
  if (!modelPath || modelPath.startsWith('remote:') || modelPath.startsWith('enterprise:')) {
    return modelSupportsVision(modelPath);
  }
  try {
    const res = await invoke<{ ready: boolean }>('local_model_vision_ready', { path: modelPath });
    localVisionCache.set(modelPath, !!res.ready);
    return !!res.ready;
  } catch {
    localVisionCache.set(modelPath, false);
    return false;
  }
}
