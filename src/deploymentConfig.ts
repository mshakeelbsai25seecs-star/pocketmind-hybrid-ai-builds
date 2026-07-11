import { invoke } from '@tauri-apps/api/tauri';
import type { GenerationParams } from './types';

export type DeploymentMode = 'workstation' | 'server';

export interface DeploymentConfig {
  deploymentMode: DeploymentMode;
  dataRoot: string;
  modelsDir: string;
  embeddingModelPath: string;
  socDataRoot: string;
  socIntakeSubdir: string;
  exportDir: string;
  denseIndexPath: string;
  contextSize: number;
  maxTokens: number;
  gpuLayers: number;
  batchSize: number;
  threads: number;
  temperature: number;
  retrievalTopK: number;
  embedContextSize: number;
  maxSnippetChars: number;
  rerankerModelPath: string;
}

export interface DeploymentPaths {
  dataRoot: string;
  modelsDir: string;
  embeddingModelPath: string;
  socDataRoot: string;
  socIntakeRoot: string;
  exportDir: string;
  denseIndexPath: string;
  knowledgeDbDir: string;
  appDbDir: string;
}

export interface DeploymentEnsureResult {
  created: string[];
  existing: string[];
}

export const SERVER_INFERENCE_PRESET: Partial<DeploymentConfig> = {
  deploymentMode: 'server',
  contextSize: 8192,
  maxTokens: 1024,
  gpuLayers: -1,
  batchSize: 256,
  retrievalTopK: 12,
  embedContextSize: 2048,
  maxSnippetChars: 1600,
};

export const WORKSTATION_INFERENCE_PRESET: Partial<DeploymentConfig> = {
  deploymentMode: 'workstation',
  contextSize: 4096,
  maxTokens: 512,
  gpuLayers: -1,
  batchSize: 128,
  retrievalTopK: 8,
  embedContextSize: 2048,
  maxSnippetChars: 1400,
};

export function deploymentConfigToGenerationParams(config: DeploymentConfig): Partial<GenerationParams> {
  return {
    context_size: config.contextSize,
    max_tokens: config.maxTokens,
    gpu_layers: config.gpuLayers,
    batch_size: config.batchSize,
    threads: config.threads,
    temperature: config.temperature,
  };
}

export function socIntakeRoot(config: DeploymentConfig): string {
  const base = config.socDataRoot.replace(/[\\/]+$/, '');
  const sub = (config.socIntakeSubdir || 'intake').replace(/^[\\/]+/, '');
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return `${base}${sep}${sub}`;
}

export async function fetchDeploymentConfig(): Promise<DeploymentConfig> {
  return invoke<DeploymentConfig>('get_deployment_config');
}

export async function saveDeploymentConfig(config: DeploymentConfig): Promise<DeploymentConfig> {
  return invoke<DeploymentConfig>('set_deployment_config', { config: toRustDeploymentConfig(config) });
}

export async function fetchDeploymentPaths(): Promise<DeploymentPaths> {
  return invoke<DeploymentPaths>('get_deployment_paths');
}

export async function ensureDeploymentDirectories(): Promise<DeploymentEnsureResult> {
  return invoke<DeploymentEnsureResult>('ensure_deployment_directories');
}

export async function validateDeploymentPath(path: string): Promise<boolean> {
  return invoke<boolean>('validate_deployment_path', { path });
}

function toRustDeploymentConfig(config: DeploymentConfig) {
  return {
    deployment_mode: config.deploymentMode,
    data_root: config.dataRoot,
    models_dir: config.modelsDir,
    embedding_model_path: config.embeddingModelPath,
    soc_data_root: config.socDataRoot,
    soc_intake_subdir: config.socIntakeSubdir,
    export_dir: config.exportDir,
    dense_index_path: config.denseIndexPath,
    context_size: config.contextSize,
    max_tokens: config.maxTokens,
    gpu_layers: config.gpuLayers,
    batch_size: config.batchSize,
    threads: config.threads,
    temperature: config.temperature,
    retrieval_top_k: config.retrievalTopK,
    embed_context_size: config.embedContextSize,
    max_snippet_chars: config.maxSnippetChars,
    reranker_model_path: config.rerankerModelPath,
  };
}

function fromRustDeploymentConfig(raw: Record<string, unknown>): DeploymentConfig {
  return {
    deploymentMode: (raw.deployment_mode as DeploymentMode) || 'server',
    dataRoot: String(raw.data_root || ''),
    modelsDir: String(raw.models_dir || ''),
    embeddingModelPath: String(raw.embedding_model_path || ''),
    socDataRoot: String(raw.soc_data_root || ''),
    socIntakeSubdir: String(raw.soc_intake_subdir || 'intake'),
    exportDir: String(raw.export_dir || ''),
    denseIndexPath: String(raw.dense_index_path || ''),
    contextSize: Number(raw.context_size || 4096),
    maxTokens: Number(raw.max_tokens || 512),
    gpuLayers: Number(raw.gpu_layers ?? -1),
    batchSize: Number(raw.batch_size || 128),
    threads: Number(raw.threads || 0),
    temperature: Number(raw.temperature || 0.35),
    retrievalTopK: Number(raw.retrieval_top_k || 10),
    embedContextSize: Number(raw.embed_context_size || 2048),
    maxSnippetChars: Number(raw.max_snippet_chars || 1400),
    rerankerModelPath: String(raw.reranker_model_path || ''),
  };
}

export async function loadDeploymentConfigMapped(): Promise<DeploymentConfig> {
  const raw = await invoke<Record<string, unknown>>('get_deployment_config');
  return fromRustDeploymentConfig(raw);
}

export async function saveDeploymentConfigMapped(config: DeploymentConfig): Promise<DeploymentConfig> {
  const saved = await invoke<Record<string, unknown>>('set_deployment_config', { config: toRustDeploymentConfig(config) });
  return fromRustDeploymentConfig(saved);
}

export function isPathUnderDeploymentRoots(path: string, config: DeploymentConfig): boolean {
  const normalized = path.trim().toLowerCase().replace(/\//g, '\\');
  if (!normalized) return false;
  const roots = [
    config.dataRoot,
    config.modelsDir,
    config.socDataRoot,
    socIntakeRoot(config),
    config.exportDir,
    config.denseIndexPath,
    config.rerankerModelPath,
  ]
    .map(value => value.trim().toLowerCase().replace(/\//g, '\\'))
    .filter(Boolean);

  return roots.some(root => normalized === root || normalized.startsWith(`${root}\\`) || normalized.startsWith(`${root}/`));
}

export function applyDeploymentToAppState(
  config: DeploymentConfig,
  setters: {
    setModelsDir: (dir: string) => void;
    setSocKnowledgeCollectionRoot: (root: string) => void;
    setDefaultParams: (params: Partial<GenerationParams>) => void;
    setSocDenseEmbeddingSettings: (settings: { modelPath: string }) => void;
    setKnowledgeEmbeddingPath?: (path: string) => void;
    setKnowledgeTopK?: (topK: number) => void;
  },
): void {
  setters.setModelsDir(config.modelsDir);
  setters.setSocKnowledgeCollectionRoot(config.socDataRoot);
  setters.setDefaultParams(deploymentConfigToGenerationParams(config));
  setters.setSocDenseEmbeddingSettings({ modelPath: config.embeddingModelPath });
  setters.setKnowledgeEmbeddingPath?.(config.embeddingModelPath);
  setters.setKnowledgeTopK?.(config.retrievalTopK);
}
