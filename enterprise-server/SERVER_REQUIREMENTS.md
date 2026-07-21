# PocketMind Hybrid AI Enterprise Server Requirements

## Minimum pilot server

Good for small pilots, demos, and medium models.

```text
OS: Ubuntu 22.04/24.04 recommended
CPU: 8+ cores
RAM: 32-64 GB
Storage: 200 GB+ free NVMe recommended
GPU: optional, but strongly recommended
Network: LAN access from employee devices
```

## Recommended GPU server

Good for practical company deployment.

```text
OS: Ubuntu 22.04/24.04
CPU: 16+ cores
RAM: 128 GB+
Storage: 1 TB+ NVMe
GPU: NVIDIA RTX 3090/4090/A5000/A6000/L40S/H100 or similar
VRAM: 24 GB+ for medium models, 48 GB+ for larger models
Docker: installed
NVIDIA Container Toolkit: installed
```

## 70B-class model guidance

70B models are possible only when the server has enough VRAM/RAM and the model is correctly quantized or sharded.

Typical practical paths:

```text
4x 24 GB GPUs    → possible for some 70B quantized/server formats
2x 48 GB GPUs    → better for 70B-class models
1x 80 GB GPU     → strong single-GPU option for many large models
CPU-only server  → not recommended for 70B interactive use
```

Exact requirements depend on:

```text
model size
precision/quantization
context length
number of concurrent users
server engine
batching settings
```

## CPU-only server expectation

CPU-only servers can work for small/medium quantized GGUF models through llama.cpp, but responses will be slower. CPU-only mode should be treated as a compatibility fallback, not the main enterprise performance path.

## Network requirements

For a private office deployment:

```text
Server listens on internal LAN only
Employees connect through office Wi-Fi/LAN or VPN
Firewall allows chosen port, usually 8000 or 8080
Public internet exposure is disabled unless IT approves it
```

## Security requirements

At minimum:

```text
Use an access token
Restrict server access to company network/VPN
Keep OS and GPU drivers updated
Do not expose raw inference ports publicly
Use Nginx or an internal gateway for production access
Document who has access
```
