/** Shared online chat provider list for Settings + Models API key UX. */
export const CHAT_API_PROVIDERS = [
  { id: 'groq', name: 'Groq', url: 'https://console.groq.com/keys', freeModels: true },
  { id: 'cerebras', name: 'Cerebras', url: 'https://cloud.cerebras.ai/', freeModels: true },
  { id: 'openrouter', name: 'OpenRouter', url: 'https://openrouter.ai/keys', freeModels: true },
  { id: 'openai', name: 'OpenAI', url: 'https://platform.openai.com/api-keys', freeModels: false },
  { id: 'anthropic', name: 'Anthropic', url: 'https://console.anthropic.com/settings/keys', freeModels: false },
  { id: 'deepseek', name: 'DeepSeek', url: 'https://platform.deepseek.com/api_keys', freeModels: true },
  { id: 'mistral', name: 'Mistral AI', url: 'https://console.mistral.ai/api-keys/', freeModels: false },
  { id: 'together', name: 'Together AI', url: 'https://api.together.xyz/settings/api-keys', freeModels: false },
  { id: 'gemini', name: 'Google Gemini', url: 'https://aistudio.google.com/app/apikey', freeModels: true },
] as const;

export const IMAGE_API_PROVIDERS = [
  { id: 'openai', name: 'OpenAI Images', url: 'https://platform.openai.com/api-keys' },
  { id: 'together', name: 'Together AI', url: 'https://api.together.xyz/settings/api-keys' },
  { id: 'huggingface', name: 'Hugging Face', url: 'https://huggingface.co/settings/tokens' },
  { id: 'replicate', name: 'Replicate', url: 'https://replicate.com/account/api-tokens' },
  { id: 'stability', name: 'Stability AI', url: 'https://platform.stability.ai/account/keys' },
] as const;

export type ChatApiProviderId = (typeof CHAT_API_PROVIDERS)[number]['id'];
