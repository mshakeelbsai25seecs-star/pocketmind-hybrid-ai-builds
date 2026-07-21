import { invoke } from '@tauri-apps/api/tauri';

export type OcrEngineId = 'auto' | 'legacy' | 'docling';

export interface OcrImageRagConfig {
  ocr_engine: OcrEngineId | string;
  ocr_preprocess: boolean;
  ocr_llm_repair: boolean;
  ocr_caption_figures: boolean;
  verify_llm_answer: boolean;
  image_rag_enabled: boolean;
  image_rag_base_url: string;
  image_rag_model: string;
  image_rag_max_regions_per_query: number;
  image_rag_api_key_configured: boolean;
}

export interface OcrCapabilities {
  python_available: boolean;
  legacy_ocr_script_available: boolean;
  docling_importable: boolean;
  opencv_available: boolean;
  image_rag_configured: boolean;
  active_engine_hint: string;
  warnings: string[];
}

export const DEFAULT_OCR_IMAGE_RAG_CONFIG: OcrImageRagConfig = {
  ocr_engine: 'auto',
  ocr_preprocess: true,
  ocr_llm_repair: false,
  ocr_caption_figures: false,
  verify_llm_answer: true,
  image_rag_enabled: false,
  image_rag_base_url: '',
  image_rag_model: '',
  image_rag_max_regions_per_query: 4,
  image_rag_api_key_configured: false,
};

export async function loadOcrImageRagConfig(): Promise<OcrImageRagConfig> {
  return invoke<OcrImageRagConfig>('get_ocr_image_rag_config');
}

export async function saveOcrImageRagConfig(
  config: OcrImageRagConfig,
  apiKey?: string | null,
): Promise<OcrImageRagConfig> {
  return invoke<OcrImageRagConfig>('save_ocr_image_rag_config', {
    request: {
      config,
      api_key: apiKey === undefined ? null : apiKey,
    },
  });
}

export async function loadOcrCapabilities(): Promise<OcrCapabilities> {
  return invoke<OcrCapabilities>('kc_ocr_capabilities');
}

export async function testImageRagConnection(): Promise<string> {
  return invoke<string>('test_image_rag_connection');
}

export async function setCollectionImageRag(
  collectionId: string,
  imageRagOptIn: boolean,
  allowCloudMedia: boolean,
): Promise<void> {
  await invoke('kc_set_collection_image_rag', {
    collectionId,
    imageRagOptIn,
    allowCloudMedia,
  });
}

export interface ImageRagEvidence {
  page_label: string;
  description: string;
  media_path: string;
}

export interface ImageRagEnrichResult {
  evidence: ImageRagEvidence[];
  warning?: string | null;
}

export async function enrichWithImageRag(
  collectionId: string,
  question: string,
  hits: unknown[],
): Promise<ImageRagEnrichResult> {
  return invoke<ImageRagEnrichResult>('kc_image_rag_enrich', {
    collectionId,
    question,
    hits,
  });
}
