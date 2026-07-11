# Ollama Deployment Profile

Use this for simple pilots and smaller teams. It is easy to run and can expose an OpenAI-compatible API path.

## Start

```bash
cd enterprise-server/ollama
chmod +x start_ollama.sh
./start_ollama.sh
```

## Pull a model

```bash
docker exec -it nexusai-ollama ollama pull qwen2.5:7b-instruct
```

## NexusAI URL

```text
http://SERVER_IP:11434/v1
```
