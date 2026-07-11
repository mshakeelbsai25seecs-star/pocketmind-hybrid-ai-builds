# macOS Server Notes

Mac Studio, Mac mini, and MacBook Pro machines can be used as private AI servers for smaller teams.

Recommended paths:

- Ollama for simple setup.
- llama.cpp Metal for GGUF models.

Apple Silicon uses unified memory, so large models depend on total unified memory. A 16 GB Mac is not suitable for 70B models. A 64 GB/128 GB Mac Studio is much more realistic for larger local models.
