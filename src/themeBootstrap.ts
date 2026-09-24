/** Apply dark/light class and accent CSS vars before React paints. */

export type BootTheme = 'light' | 'dark' | 'system';

const STORAGE_KEY = 'nexus-ai-storage';
const DEFAULT_ACCENT = '#4ade80';

export function readStoredTheme(): BootTheme {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return 'system';
    const parsed = JSON.parse(raw) as { state?: { theme?: BootTheme } };
    const theme = parsed?.state?.theme;
    if (theme === 'light' || theme === 'dark' || theme === 'system') return theme;
  } catch {
    // ignore corrupt storage
  }
  return 'system';
}

export function readStoredAccent(): string {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_ACCENT;
    const parsed = JSON.parse(raw) as { state?: { accentColor?: string } };
    const color = parsed?.state?.accentColor;
    if (typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color)) return color.toLowerCase();
  } catch {
    // ignore corrupt storage
  }
  return DEFAULT_ACCENT;
}

export function resolveDark(theme: BootTheme): boolean {
  if (theme === 'dark') return true;
  if (theme === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function hexToRgbTuple(hex: string): [number, number, number] {
  const h = hex.replace('#', '').trim();
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = Number.parseInt(full, 16);
  if (!Number.isFinite(n) || full.length !== 6) return [74, 222, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function mixRgb(
  a: [number, number, number],
  b: [number, number, number],
  t: number,
): string {
  const r = clampByte(a[0] + (b[0] - a[0]) * t);
  const g = clampByte(a[1] + (b[1] - a[1]) * t);
  const bl = clampByte(a[2] + (b[2] - a[2]) * t);
  return `${r} ${g} ${bl}`;
}

/** Push accent into CSS variables consumed by Tailwind `primary-*` utilities. */
export function applyAccentColor(hex: string = readStoredAccent()): void {
  const base = hexToRgbTuple(hex);
  const white: [number, number, number] = [255, 255, 255];
  const black: [number, number, number] = [0, 0, 0];
  const root = document.documentElement;
  const map: Record<string, string> = {
    '--color-primary': mixRgb(base, base, 0),
    '--color-primary-50': mixRgb(base, white, 0.92),
    '--color-primary-100': mixRgb(base, white, 0.84),
    '--color-primary-200': mixRgb(base, white, 0.7),
    '--color-primary-300': mixRgb(base, white, 0.45),
    '--color-primary-400': mixRgb(base, white, 0.2),
    '--color-primary-500': mixRgb(base, base, 0),
    '--color-primary-600': mixRgb(base, black, 0.18),
    '--color-primary-700': mixRgb(base, black, 0.32),
    '--color-primary-800': mixRgb(base, black, 0.45),
    '--color-primary-900': mixRgb(base, black, 0.58),
    '--color-primary-950': mixRgb(base, black, 0.72),
    '--conductor-green': mixRgb(base, base, 0),
    '--conductor-green-dim': mixRgb(base, white, 0.25),
  };
  for (const [key, value] of Object.entries(map)) {
    root.style.setProperty(key, value);
  }
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
