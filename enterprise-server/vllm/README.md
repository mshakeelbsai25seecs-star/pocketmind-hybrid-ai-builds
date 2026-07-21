# vLLM Deployment Profile

Use this profile for serious enterprise GPU servers, especially NVIDIA single-GPU or multi-GPU machines.

## Quick start

```bash
cd enterprise-server/vllm
cp .env.example .env
nano .env
chmod +x start_vllm.sh
./start_vllm.sh
```

For multi-GPU:

```bash
./start_vllm.sh multi
```

## Test

```bash
curl http://localhost:8000/v1/models
```

From PocketMind Hybrid AI, use:

```text
Organization Server URL: http://SERVER_IP:8000/v1
```

## Scaling notes

- Increase `TENSOR_PARALLEL_SIZE` to split one model across multiple GPUs.
- Keep `MAX_MODEL_LEN` reasonable for pilots.
- Reduce `GPU_MEMORY_UTILIZATION` if the server becomes unstable.
- Use a smaller model first, then scale to larger models after the endpoint is stable.
