/** True when running inside the Tauri desktop shell. */
export function isSocTauriRuntime(): boolean {
  return typeof window !== 'undefined'
    && (
      Boolean((window as unknown as { __TAURI__?: unknown }).__TAURI__)
      || Boolean((window as unknown as { __TAURI_IPC__?: unknown }).__TAURI_IPC__)
    );
}
