"""Application configuration loader for PocketMind Hybrid AI services."""

import os

DEFAULT_API_TIMEOUT_SECONDS = 30
API_TIMEOUT_ENV = "NEXUS_API_TIMEOUT"


def load_api_timeout() -> int:
    """Read API timeout from NEXUS_API_TIMEOUT or fall back to 30 seconds."""
    raw = os.environ.get(API_TIMEOUT_ENV, "").strip()
    if not raw:
        return DEFAULT_API_TIMEOUT_SECONDS
    try:
        return max(5, int(raw))
    except ValueError:
        return DEFAULT_API_TIMEOUT_SECONDS
