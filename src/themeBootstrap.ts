/** Apply dark/light class before React paints to avoid a white first frame. */

export type BootTheme = 'light' | 'dark' | 'system';

export function readStoredTheme(): BootTheme {
  try {
    const raw = localStorage.getItem('nexus-ai-storage');
    if (!raw) return 'system';
    const parsed = JSON.parse(raw) as { state?: { theme?: BootTheme } };
    const theme = parsed?.state?.theme;
    if (theme === 'light' || theme === 'dark' || theme === 'system') return theme;
  } catch {
    // ignore corrupt storage
  }
  return 'system';
}

export function resolveDark(theme: BootTheme): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function applyThemeClass(theme: BootTheme = readStoredTheme()): boolean {
  const dark = resolveDark(theme);
  const root = document.documentElement;
  root.classList.toggle('dark', dark);
  root.style.colorScheme = dark ? 'dark' : 'light';
  // Conductor blacks / off-white (match Android PmBlack / PmLightBg)
  root.style.backgroundColor = dark ? '#000000' : '#fafafa';
  if (document.body) {
    document.body.style.backgroundColor = dark ? '#000000' : '#fafafa';
  }
  return dark;
}
