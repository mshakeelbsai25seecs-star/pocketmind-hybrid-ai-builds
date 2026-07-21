# PocketMind Hybrid AI Enterprise Server Deployment Kit

This folder prepares PocketMind Hybrid AI for company-wide server deployment. The PocketMind Hybrid AI desktop/mobile apps are clients. The server runs the heavy AI model and exposes one private OpenAI-compatible API endpoint for employees.

## Core idea

```text
Employees use PocketMind Hybrid AI on Windows, macOS, or Android
        ↓
PocketMind Hybrid AI connects to an internal company AI endpoint
        ↓
The company server runs the model on CPU/GPU hardware
        ↓
Responses stream back to each employee device
```

The client app does not need to know whether the server has 1 GPU, 4 GPUs, or a larger cluster. The server engine handles the model placement and GPU scaling.

## Recommended deployment order

1. Run the server detection script.
2. Choose the deployment profile using the decision tree.
3. Deploy one server engine: vLLM, Ollama, TGI, or llama.cpp.
4. Test `/v1/models` from the server.
5. Test `/v1/chat/completions` from the server.
6. Add Nginx/reverse proxy and access token protection if required.
7. Connect PocketMind Hybrid AI through **Organization Server**.
8. Apply Knowledge Chat **optimal server settings** (models, top-k, RANK, context, temperature): see [`SERVER_OPTIMAL_SETTINGS.md`](./SERVER_OPTIMAL_SETTINGS.md).
9. Run a 3-5 user pilot before wider rollout.

## Supported profiles

| Profile | Best for | Notes |
|---|---|---|
| vLLM NVIDIA | Large models, multi-GPU, enterprise use | Best default for serious GPU servers |
| vLLM multi-GPU | 32B/70B class models | Requires compatible NVIDIA GPUs and enough VRAM |
| Ollama | Simple pilots and smaller teams | Easy setup, OpenAI-compatible API support |
| llama.cpp server | GGUF models, CPU fallback, lightweight setups | Good when quantized GGUF models are preferred |
| Hugging Face TGI | Production transformer serving | Useful where IT teams already use Hugging Face tooling |
| Existing internal AI gateway | Companies with their own API gateway | Must expose OpenAI-compatible endpoints |

## The app-side endpoint format

In PocketMind Hybrid AI, use:

```text
Organization Server URL: http://SERVER_IP:8000/v1
Access token: optional company token
```

The server should support:

```text
GET  /v1/models
POST /v1/chat/completions
```

## Important production rule

Do not promise that one server setup works everywhere. Instead, choose the correct deployment profile for the hardware and security policy. This kit gives multiple safe paths so PocketMind Hybrid AI can be deployed in almost every realistic company environment.
