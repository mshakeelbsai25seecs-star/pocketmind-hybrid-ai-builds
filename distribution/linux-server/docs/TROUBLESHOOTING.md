# NexusAI Troubleshooting

See `../windows-server/docs/TROUBLESHOOTING.md`.

Linux notes:
- Ensure `/var/lib/nexusai` is owned by the service account running NexusAI.
- For AppImage, set `NEXUS_DATA_ROOT=$HOME/.local/share/nexusai` if not using system paths.
