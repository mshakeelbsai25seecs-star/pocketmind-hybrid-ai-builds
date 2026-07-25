import { invoke } from '@tauri-apps/api/tauri';
import { cwImageBase64 } from '../api/codeWorkspace';
import { modelSupportsVision } from '../codeWorkspace/visionCapability';
import type { AttachmentContext } from '../types';

export type AttachUnderstand = 'vision' | 'doc-text' | 'unavailable';

export interface PreparedAttachChip {
  path: string;
  name: string;
  kind: 'image' | 'pdf' | 'doc';
  understand: AttachUnderstand;
  notice?: string;
}

export interface GenerationImagePayload {
  mime: string;
  base64: string;
}

export interface PrepareAttachmentsResult {
  textBlock: string;
  images: GenerationImagePayload[];
  notices: string[];
  chips: PreparedAttachChip[];
  /** Raw processed docs (for Chat indexed UI). */
  processedDocs: AttachmentContext[];
}

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tif', 'tiff']);
const DOC_TEXT_CAP = 24_000;

export const ATTACH_FILE_FILTERS = [
  {
    name: 'Documents and images',
    extensions: [
      'pdf', 'docx', 'pptx', 'xlsx', 'xlsm', 'csv', 'txt', 'md', 'json', 'xml', 'html',
      'py', 'js', 'ts', 'tsx', 'java', 'cpp', 'c', 'cs', 'go', 'rs', 'sql',
      'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif',
    ],
  },
];

function extOf(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() || path;
  const i = base.lastIndexOf('.');
  return i >= 0 ? base.slice(i + 1).toLowerCase() : '';
}

function basename(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || path;
}

function meaningfulPdfText(text: string): boolean {
  const letters = (text.match(/[A-Za-z\u00C0-\u024F]/g) || []).length;
  return letters >= 120;
}

function isImagePath(path: string): boolean {
  return IMAGE_EXT.has(extOf(path));
}

function isPdfPath(path: string): boolean {
  return extOf(path) === 'pdf';
}

export function chipForPath(path: string, modelPath: string | null | undefined): PreparedAttachChip {
  const name = basename(path);
  const vision = modelSupportsVision(modelPath);
  if (isImagePath(path)) {
    return {
      path,
      name,
      kind: 'image',
      understand: vision ? 'vision' : 'unavailable',
      notice: vision
        ? 'Model will see this image'
        : 'Selected model cannot see images — switch to a vision online/org model',
    };
  }
  if (isPdfPath(path)) {
    return {
      path,
      name,
      kind: 'pdf',
      understand: vision ? 'vision' : 'doc-text',
      notice: vision
        ? 'PDF text + first pages for vision'
        : 'PDF text will be extracted for the model',
    };
  }
  return {
    path,
    name,
    kind: 'doc',
    understand: 'doc-text',
    notice: 'Document text will be extracted for the model',
  };
}

async function fetchPdfPageImages(path: string, maxPages = 3): Promise<GenerationImagePayload[]> {
  try {
    const pages = await invoke<Array<{ page: number; mime: string; base64: string }>>(
      'cw_pdf_page_images',
      { path, maxPages },
    );
    return (pages || []).map(p => ({ mime: p.mime || 'image/png', base64: p.base64 }));
  } catch (err) {
    throw err;
  }
}

/**
 * Shared Chat + PocketCode attachment preparation.
 * Vision models get image parts; docs always get text extract; PDFs on vision also get page images.
 */
export async function prepareAttachmentsForModel(
  paths: string[],
  modelPath: string | null | undefined,
  opts?: { maxCharsPerFile?: number; maxTotalChars?: number; pdfPages?: number },
): Promise<PrepareAttachmentsResult> {
  const notices: string[] = [];
  const images: GenerationImagePayload[] = [];
  const textParts: string[] = [];
  const chips: PreparedAttachChip[] = [];
  const processedDocs: AttachmentContext[] = [];
  const vision = modelSupportsVision(modelPath);
  const pdfPages = opts?.pdfPages ?? 3;

  const imagePaths = paths.filter(isImagePath);
  const docPaths = paths.filter(p => !isImagePath(p));

  for (const path of imagePaths) {
    const chip = chipForPath(path, modelPath);
    chips.push(chip);
    if (vision) {
      try {
        const [mime, base64] = await cwImageBase64(path);
        images.push({ mime: mime || 'image/png', base64 });
      } catch (err) {
        notices.push(`Could not attach image ${basename(path)}: ${String(err)}`);
        chip.understand = 'unavailable';
        chip.notice = String(err);
      }
    } else {
      notices.push(`${basename(path)}: model is not vision-capable (image not sent as pixels).`);
    }
  }

  if (docPaths.length > 0) {
    try {
      const processed = await invoke<AttachmentContext[]>('process_attachments', {
        paths: docPaths,
        maxCharsPerFile: opts?.maxCharsPerFile ?? 12_000,
        maxTotalChars: opts?.maxTotalChars ?? DOC_TEXT_CAP,
      });
      for (const doc of processed) {
        processedDocs.push(doc);
        const isPdf = (doc.kind || '').toLowerCase() === 'pdf' || isPdfPath(doc.path);
        const chip = chipForPath(doc.path, modelPath);
        const text = (doc.text || '').trim();
        const hasText = isPdf ? meaningfulPdfText(text) : text.length > 20 && !text.startsWith('No extractable text');

        if (hasText) {
          const body = text.length > DOC_TEXT_CAP ? `${text.slice(0, DOC_TEXT_CAP)}\n…[truncated]` : text;
          textParts.push(`## Attached ${doc.kind || 'document'}: ${doc.name}\n${body}`);
          chip.understand = vision && isPdf ? 'vision' : 'doc-text';
          chip.notice = vision && isPdf
            ? 'PDF text extracted; page images included when available'
            : (doc.warnings?.[0] || 'Document text extracted');
        } else if (isPdf && vision) {
          chip.understand = 'vision';
          chip.notice = 'Little/no PDF text — sending page images to vision model';
          notices.push(`${doc.name}: scanned or empty text layer; using page images.`);
        } else if (isPdf && !vision) {
          chip.understand = 'unavailable';
          chip.notice = 'Scanned PDF needs a vision model (or a PDF with a text layer)';
          notices.push(`${doc.name}: no extractable text. Switch to a vision model to send page images.`);
        } else {
          chip.understand = 'unavailable';
          chip.notice = doc.warnings?.[0] || 'No extractable text';
          notices.push(`${doc.name}: no extractable text.`);
        }

        if (doc.warnings?.length) {
          for (const w of doc.warnings.slice(0, 2)) notices.push(`${doc.name}: ${w}`);
        }

        if (isPdf && vision) {
          try {
            const pages = await fetchPdfPageImages(doc.path, pdfPages);
            images.push(...pages);
            if (pages.length === 0) {
              notices.push(`${doc.name}: PDF page render returned no images.`);
            }
          } catch (err) {
            if (!hasText) {
              chip.understand = 'unavailable';
              chip.notice = String(err);
            }
            notices.push(`${doc.name}: page images unavailable (${String(err)})`);
          }
        }

        chips.push(chip);
      }
    } catch (err) {
      notices.push(`Document extract failed: ${String(err)}`);
      for (const path of docPaths) {
        chips.push({
          ...chipForPath(path, modelPath),
          understand: 'unavailable',
          notice: String(err),
        });
      }
    }
  }

  const textBlock = textParts.length > 0 ? `\n\n${textParts.join('\n\n')}` : '';
  return { textBlock, images, notices, chips, processedDocs };
}
