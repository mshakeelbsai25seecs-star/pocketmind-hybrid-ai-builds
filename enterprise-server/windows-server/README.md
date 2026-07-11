# Windows Server Notes

For serious NVIDIA multi-GPU LLM hosting, Ubuntu Linux is usually the cleaner deployment target. If the company only has Windows Server, choose one of these:

## Option A: WSL2 Ubuntu + vLLM

Use this when IT allows WSL2 and NVIDIA GPU passthrough is working.

## Option B: Native Ollama

Use this for simpler pilots and medium models.

## Option C: Windows acts only as a client host

Keep the model server on a Linux GPU machine and use Windows laptops as NexusAI clients.
