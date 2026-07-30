/**
 * Open a URL or local path in the system browser / default app.
 * Plain `<a href>` / `window.open` are unreliable inside the Tauri webview.
 *
 * Note: on Windows, `@tauri-apps/api/shell` `open()` often opens the browser
 * successfully and still rejects the Promise — do not treat that as a hard failure.
 */
function isTauriRuntime(): boolean {
  return typeof window !== 'undefined' && '__TAURI_IPC__' in window
    || typeof window !== 'undefined' && '__TAURI__' in window;
}

export async function openExternal(target: string): Promise<void> {
  const value = (target || '').trim();
  if (!value) {
    throw new Error('Nothing to open.');
  }

  try {
    const { open } = await import('@tauri-apps/api/shell');
    await open(value);
    return;
  } catch (err) {
    // Browser likely already opened; Tauri commonly rejects after a successful open.
    if (isTauriRuntime()) {
      console.warn('shell.open settled with an error (usually harmless):', err);
      return;
    }
  }

  if (typeof window !== 'undefined' && typeof window.open === 'function') {
    const opened = window.open(value, '_blank', 'noopener,noreferrer');
    if (opened) return;
  }

  throw new Error(`Could not open: ${value}`);
}

/** Click handler helper for buttons/links that should open externally. */
export function onOpenExternal(target: string): (e?: { preventDefault?: () => void }) => void {
  return (e) => {
    e?.preventDefault?.();
    void openExternal(target).catch((err) => {
      // Only surface real failures (e.g. empty URL outside Tauri).
      console.error(err);
      if (typeof window !== 'undefined') {
        window.alert(String(err));
      }
    });
  };
}
