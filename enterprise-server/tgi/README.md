# Hugging Face Text Generation Inference Profile

Use this profile if the company already uses Hugging Face tooling or wants a production transformer-serving stack.

## Start

```bash
cd enterprise-server/tgi
cp .env.example .env
nano .env
docker compose --env-file .env up -d
```

## Note

TGI compatibility with OpenAI-style endpoints can vary by version and gateway configuration. If NexusAI cannot list models directly, put TGI behind an OpenAI-compatible gateway or use vLLM/Ollama for the first pilot.
