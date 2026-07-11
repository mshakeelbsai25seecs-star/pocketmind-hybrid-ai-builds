# NexusAI hard repair notes

This repair focuses on the real chat-quality problem instead of temporary UI patches.

## Main root cause fixed
The app was flattening chat history and file context into one large string, then sending it as a single user prompt. Combined with missing model-specific chat templates for Mistral/Qwen/Llama/Gemma models, llama.cpp could treat prompts like continuation text instead of chat instructions. That caused unrelated outputs such as workflow-engine documentation and odd Markdown/code artifacts.

## Key changes
- Added structured OpenAI-style chat messages to `GenerationRequest`.
- ChatView now sends recent user/assistant turns as real `{ role, content }` messages.
- Attachment context is included only in the latest user message, not as a fake transcript.
- Local llama.cpp backend now uses the structured messages when available.
- Remote backend also supports the same structured messages.
- Added model-specific chat template detection:
  - Mistral/Mixtral -> `mistral-v1`
  - Llama 3 -> `llama3`
  - Gemma/MedGemma -> `gemma`
  - Phi 3 -> `phi3`
  - Qwen/TinyLlama/OpenChat -> `chatml`
  - Zephyr -> `zephyr`
- Backend defaults are safer: CPU-only, lower temperature, lower top-p, repeat penalty enabled, shorter first responses.
- Added light cleanup of template artifacts such as `workflow_engine:start` if a model still emits them.

## Testing note
Use a fresh chat after installing this version. Old saved chats may still contain bad outputs from previous versions.

First test prompt:

`Say hello in one sentence.`

Recommended first model:
- Phi-3 Mini Instruct GGUF
- Qwen2.5 1.5B Instruct GGUF
- TinyLlama Chat GGUF
- Mistral 7B Instruct GGUF

Avoid MedGemma as the baseline normal-chat test. It is better handled later as a specialized/medical or vision-oriented model.
