# NexusAI Admin Handover Guide

## What the admin receives

- NexusAI client app for employees.
- Server deployment profile selected for the company hardware.
- Model server endpoint.
- Access token policy.
- Pilot checklist and support notes.

## Key server settings to record

```text
Server hostname/IP:
Server OS:
GPU model(s):
RAM:
Storage:
Model engine: vLLM / Ollama / llama.cpp / TGI / other
Model ID:
Endpoint URL:
Access token owner:
Deployment date:
Admin contact:
```

## Daily checks

- Server is reachable.
- GPU memory is not exhausted.
- Disk is not full.
- Model container/process is running.
- Employee clients can load `/v1/models`.

## Common fixes

### Server not reachable

Check firewall, port mapping, VPN/LAN access, and container status.

### Model out of memory

Use a smaller model, lower context length, lower concurrency, or add GPUs.

### Slow responses

Check GPU utilization, CPU fallback, model size, context length, and number of concurrent users.

### Authentication failure

Verify the token in NexusAI and rotate the server token if necessary.
