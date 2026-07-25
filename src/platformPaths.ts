import type { DeploymentConfig } from './deploymentConfig';
import { socIntakeRoot } from './deploymentConfig';

export type PathRootKind = 'data' | 'models' | 'soc' | 'intake' | 'export' | 'embeddings';

export function isWindowsPlatform(): boolean {
  if (typeof navigator === 'undefined') return true;
  return /win/i.test(navigator.platform || navigator.userAgent || '');
}

export function pathSeparator(): string {
  return isWindowsPlatform() ? '\\' : '/';
}

export function joinPath(...parts: string[]): string {
  const sep = pathSeparator();
  return parts
    .map(part => part.trim().replace(/[\\/]+$/, '').replace(/^[\\/]+/, ''))
    .filter(Boolean)
    .join(sep);
}

export function normalizeDisplayPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return isWindowsPlatform() ? trimmed.replace(/\//g, '\\') : trimmed.replace(/\\/g, '/');
}

export function deploymentRoot(config: DeploymentConfig | null | undefined, kind: PathRootKind): string {
  if (!config) return '';
  switch (kind) {
    case 'models':
      return config.modelsDir;
    case 'soc':
      return config.socDataRoot;
    case 'intake':
      return socIntakeRoot(config);
    case 'export':
      return config.exportDir;
    case 'embeddings':
      return joinPath(config.modelsDir, 'embeddings');
    default:
      return config.dataRoot;
  }
}

export function dialogDefaultPath(config: DeploymentConfig | null | undefined, kind: PathRootKind = 'data'): string {
  return deploymentRoot(config, kind) || '';
}

export function pathPlaceholder(config: DeploymentConfig | null | undefined, kind: PathRootKind = 'data'): string {
  const root = deploymentRoot(config, kind);
  if (root) return root;
  if (isWindowsPlatform()) {
    // Portable default (matches Rust preferred_data_root for new installs).
    const base = '%LOCALAPPDATA%\\PocketMind';
    switch (kind) {
      case 'models':
      case 'embeddings':
        return `${base}\\models`;
      case 'soc':
      case 'intake':
        return `${base}\\company-data`;
      case 'export':
        return `${base}\\exports`;
      default:
        return base;
    }
  }
  return kind === 'models'
    ? '/var/lib/pocketmind/models'
    : '/var/lib/pocketmind/company-data';
}

export function embeddingModelPlaceholder(config: DeploymentConfig | null | undefined): string {
  return config?.embeddingModelPath
    || joinPath(pathPlaceholder(config, 'embeddings'), 'Qwen3-Embedding-8B-Q4_K_M.gguf');
}
