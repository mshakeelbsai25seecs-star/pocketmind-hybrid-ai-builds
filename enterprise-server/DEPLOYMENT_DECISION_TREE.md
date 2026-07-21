# PocketMind Hybrid AI Enterprise Deployment Decision Tree

Use this guide to choose the safest server profile.

## Step 1: Does the server have NVIDIA GPUs?

### Yes

Use **vLLM** first.

```text
Best path: enterprise-server/vllm/docker-compose.nvidia.yml
Multi-GPU path: enterprise-server/vllm/docker-compose.multi-gpu.yml
```

Choose tensor parallel size based on the number of GPUs used for one model.

### No

Go to Step 2.

## Step 2: Does the server need the easiest possible pilot?

### Yes

Use **Ollama**.

```text
Path: enterprise-server/ollama/docker-compose.yml
```

This is good for demos and medium models. It is not the best path for high-throughput multi-GPU enterprise serving.

### No

Go to Step 3.

## Step 3: Does the company want GGUF quantized models?

### Yes

Use **llama.cpp server**.

```text
CPU path:  enterprise-server/llama-cpp/docker-compose.cpu.yml
CUDA path: enterprise-server/llama-cpp/docker-compose.cuda.yml
```

This is useful for GGUF models and private lightweight deployments.

### No

Go to Step 4.

## Step 4: Does the company already use Hugging Face tooling?

### Yes

Use **Text Generation Inference**.

```text
Path: enterprise-server/tgi/docker-compose.yml
```

### No

Use the simple vLLM or Ollama path depending on available hardware.

## Step 5: Does the company already have an internal AI gateway?

If yes, do not deploy another model server immediately. Ask IT for:

```text
OpenAI-compatible base URL
access token
model IDs
network/VPN access rules
```

Then connect PocketMind Hybrid AI directly through the Organization Server page.
