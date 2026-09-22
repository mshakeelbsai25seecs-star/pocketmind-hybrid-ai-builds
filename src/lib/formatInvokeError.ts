/** Tauri/JS errors are often objects — never show "[object Object]". */
export function formatInvokeError(err: unknown): string {
  if (err == null) return 'Unknown error';
  if (typeof err === 'string') {
    return err.replace(/^error:\s*/i, '').trim() || 'Unknown error';
  }
  if (err instanceof Error) {
    return (err.message || String(err)).replace(/^error:\s*/i, '').trim() || 'Unknown error';
  }
  if (typeof err === 'object') {
    const o = err as Record<string, unknown>;
    for (const key of ['message', 'error', 'msg', 'reason', 'Unknown', 'InferenceError', 'DownloadError', 'NetworkError']) {
      const v = o[key];
      if (typeof v === 'string' && v.trim()) {
        return v.replace(/^error:\s*/i, '').trim();
      }
    }
    // Serialized AppError enum: { "Unknown": "…" } / { "InferenceError": "…" }
    const keys = Object.keys(o);
    if (keys.length === 1 && typeof o[keys[0]] === 'string') {
      return String(o[keys[0]]).replace(/^error:\s*/i, '').trim();
    }
    try {
      const json = JSON.stringify(err);
      if (json && json !== '{}' && json !== '[object Object]') return json;
    } catch {
      /* fall through */
    }
  }
  const raw = String(err);
  return raw === '[object Object]' ? 'Unexpected error (see Diagnostics).' : raw;
}
