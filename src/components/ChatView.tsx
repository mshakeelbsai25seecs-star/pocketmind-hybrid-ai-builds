import { useState, useRef, useEffect, isValidElement, memo, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/tauri';
import { open } from '@tauri-apps/api/dialog';
import { listen } from '@tauri-apps/api/event';
import {
  Send, Square, Bot, User, Copy, Check, Trash2,
  Paperclip, Sparkles, AlertCircle, Download, MessageSquare,
  SlidersHorizontal, ClipboardCopy, RotateCcw, FileText, X,
  UploadCloud, Info, Power
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { useAppStore } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { AttachmentContext, Conversation } from '../types';
import {
  mergeGenerationParams,
  PendingChatOptions,
  shouldUseSocGeneration,
  SOC_GENERATION_PARAMS,
  SOC_SYSTEM_PROMPT,
} from '../socChatHandoff';
import { exportChatAs, type ChatExportKind } from '../chatExport';
import ContextBudgetBar from './ContextBudgetBar';
import DiffViewer from './DiffViewer';
import { computeContextBudget, defaultKeepLastN } from '../contextBudget';
import { FEATURE_FLAGS } from '../featureFlags';
import { getSetting, setSetting } from '../api/powerFeatures';

function humanError(err: unknown): string {
  let raw = '';
  if (err instanceof Error) raw = err.message;
  else if (typeof err === 'string') raw = err;
  else if (err && typeof err === 'object') {
    const anyErr = err as any;
    if (typeof anyErr.message === 'string') raw = anyErr.message;
    else if (typeof anyErr.error === 'string') raw = anyErr.error;
    else {
      try { raw = JSON.stringify(err, null, 2); } catch { raw = String(err); }
    }
  } else {
    raw = String(err || 'Unknown error');
  }
  const lower = raw.toLowerCase();
  if (lower.includes('out of memory') || lower.includes('oom')) {
    return 'Ran out of memory. Try a smaller GGUF (Q4), reduce GPU layers, or close other apps.';
  }
  if (lower.includes('vram') || lower.includes('ggml_cuda') || lower.includes('failed to allocate')) {
    return 'GPU / VRAM allocation failed. Lower GPU layers or switch Runtime to CPU.';
  }
  if (lower.includes('no such file') || lower.includes('not found') || lower.includes('does not exist')) {
    return 'A required file was not found. Check the model path in Models.';
  }
  if (lower.includes('connection refused') || lower.includes('failed to connect')) {
    return 'Could not reach the server. Check Org Server / network, then retry.';
  }
  return raw;
}

function modelFileName(path: string | null): string {
  return path ? path.split(/[\\/]/).pop() || path : 'No model selected';
}

function mb(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(2)} MB`;
}

function compactChars(count?: number): string {
  if (!count || count <= 0) return '0 chars';
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M chars`;
  if (count >= 1_000) return `${Math.round(count / 100) / 10}k chars`;
  return `${count} chars`;
}

const ATTACHMENT_STOP_WORDS = new Set([
  'about', 'above', 'after', 'again', 'against', 'also', 'analysis', 'answer', 'attached', 'attachment', 'because', 'before',
  'between', 'could', 'document', 'explain', 'file', 'files', 'from', 'give', 'have', 'into', 'main', 'more', 'please',
  'point', 'points', 'question', 'section', 'should', 'show', 'some', 'summarize', 'summary', 'tell', 'than', 'that',
  'their', 'there', 'these', 'thing', 'this', 'those', 'using', 'want', 'what', 'when', 'where', 'which', 'with', 'would',
  'your', 'the', 'and', 'for', 'are', 'was', 'were', 'has', 'had', 'can', 'will', 'you', 'they', 'them', 'our', 'its'
]);

const ATTACHMENT_TOKEN_EXPANSIONS: Record<string, string[]> = {
  risk: ['risks', 'threat', 'threats', 'vulnerability', 'vulnerabilities', 'issue', 'issues', 'impact', 'mitigation'],
  risks: ['risk', 'threat', 'vulnerability', 'impact', 'mitigation'],
  security: ['secure', 'cybersecurity', 'privacy', 'confidential', 'threat', 'risk', 'vulnerability'],
  policy: ['rule', 'rules', 'procedure', 'procedures', 'guideline', 'guidelines', 'requirement'],
  cost: ['price', 'pricing', 'budget', 'expense', 'expenses', 'financial'],
  legal: ['contract', 'clause', 'agreement', 'compliance', 'liability'],
  deadline: ['date', 'timeline', 'schedule', 'milestone'],
  error: ['bug', 'issue', 'failure', 'exception', 'problem'],
  summary: ['overview', 'key', 'important', 'main'],
  summarize: ['overview', 'key', 'important', 'main'],
};

function clampNumber(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function attachmentRetrievalPlan(contextSize?: number, responseTokens?: number, attachmentCount?: number) {
  // Keep document context intentionally small for local/offline models.
  // Approximate 1 token as 3.2-4 characters, then reserve space for system prompt,
  // recent chat history, the user's question, and the answer being generated.
  const memoryWindow = !contextSize || contextSize <= 0 ? 4096 : contextSize;
  const answerReserve = clampNumber(responseTokens || 256, 128, 1536);
  const overheadReserve = memoryWindow <= 2048 ? 650 : 900;
  const availableTokens = Math.max(360, memoryWindow - answerReserve - overheadReserve);
  const attachmentFactor = attachmentCount && attachmentCount > 2 ? 0.82 : 1;
  const charBudget = Math.floor(clampNumber(availableTokens * 3.35 * attachmentFactor, 1_600, 11_500));
  const maxChunks = memoryWindow <= 1024 ? 2 : memoryWindow <= 2048 ? 4 : memoryWindow <= 4096 ? 6 : 8;
  const maxSectionChars = memoryWindow <= 2048 ? 1_250 : 1_650;
  return { charBudget, maxChunks, maxSectionChars };
}

function normalizeQueryToken(token: string): string {
  let t = token.toLowerCase().trim();
  if (t.length > 5 && t.endsWith('ies')) t = `${t.slice(0, -3)}y`;
  else if (t.length > 6 && t.endsWith('ing')) t = t.slice(0, -3);
  else if (t.length > 5 && t.endsWith('ed')) t = t.slice(0, -2);
  else if (t.length > 4 && t.endsWith('s')) t = t.slice(0, -1);
  return t;
}

function queryTokens(query: string): string[] {
  const normalized = query.toLowerCase().replace(/[^a-z0-9_+#.-]+/g, ' ');
  const base = normalized
    .split(/\s+/)
    .map(t => normalizeQueryToken(t))
    .filter(t => t.length >= 3 && !ATTACHMENT_STOP_WORDS.has(t));
  const expanded = new Set<string>();
  for (const token of base) {
    expanded.add(token);
    for (const related of ATTACHMENT_TOKEN_EXPANSIONS[token] || []) expanded.add(normalizeQueryToken(related));
  }
  return Array.from(expanded).slice(0, 64);
}

function queryPhrases(query: string): string[] {
  const cleaned = query.toLowerCase().replace(/[^a-z0-9_+#.-]+/g, ' ').trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  const phrases = new Set<string>();
  for (let size = 4; size >= 2; size--) {
    for (let i = 0; i <= words.length - size; i++) {
      const phrase = words.slice(i, i + size).join(' ');
      if (phrase.length >= 8 && !phrase.split(' ').every(w => ATTACHMENT_STOP_WORDS.has(w))) {
        phrases.add(phrase);
      }
    }
  }
  return Array.from(phrases).slice(0, 12);
}

function isGeneralAttachmentRequest(query: string): boolean {
  return /\b(summary|summarize|summarise|overview|key points|main points|important points|highlights|explain (this|the) document|what is (this|the) document|document about|file about|briefly explain)\b/i.test(query);
}

function chunkScore(query: string, chunkText: string, title: string, fileName: string): number {
  const tokens = queryTokens(query);
  const haystack = `${fileName}\n${title}\n${chunkText}`.toLowerCase();
  const titleLower = title.toLowerCase();
  const fileLower = fileName.toLowerCase();
  let score = 0;

  for (const phrase of queryPhrases(query)) {
    if (haystack.includes(phrase)) score += 8;
  }

  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const exactMatches = haystack.match(new RegExp(`\\b${escaped}`, 'g'));
    if (exactMatches) score += Math.min(exactMatches.length, 8);
    if (titleLower.includes(token)) score += 4;
    if (fileLower.includes(token)) score += 2;
  }

  if (/\b(risk|risks|security|vulnerab|threat|mitigation|control|privacy|confidential)\b/i.test(query)) {
    const riskMatches = haystack.match(/\b(risk|risks|security|vulnerab\w*|threat\w*|mitigation|control\w*|privacy|confidential\w*)\b/g);
    if (riskMatches) score += Math.min(riskMatches.length, 10) * 1.5;
  }

  if (/\b(action|todo|recommend|next step|improve|fix|solution)\b/i.test(query)) {
    const actionMatches = haystack.match(/\b(should|must|recommend\w*|action\w*|step\w*|fix\w*|solution\w*|improve\w*)\b/g);
    if (actionMatches) score += Math.min(actionMatches.length, 8) * 1.25;
  }

  return score;
}

function trimToChars(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 80)).trim()}\n[...section trimmed for prompt budget...]`;
}

function attachmentContextBlock(
  items: AttachmentContext[],
  query: string,
  contextSize?: number,
  responseTokens?: number
): string {
  if (!items.length) return '';

  const plan = attachmentRetrievalPlan(contextSize, responseTokens, items.length);
  const generalRequest = isGeneralAttachmentRequest(query);
  const selected: Array<{
    file: AttachmentContext;
    index: number;
    title: string;
    text: string;
    score: number;
  }> = [];

  for (const file of items) {
    const chunks = file.chunks?.length
      ? file.chunks
      : [{ index: 0, title: 'Attachment preview', start_char: 0, end_char: file.text?.length || 0, text: file.text || '[No extracted text]' }];

    const scored = chunks.map((chunk) => ({
      file,
      index: chunk.index,
      title: chunk.title || `Section ${chunk.index + 1}`,
      text: chunk.text || '',
      score: generalRequest
        ? Math.max(0, 20 - chunk.index * 2)
        : chunkScore(query, chunk.text || '', chunk.title || '', file.name) + Math.max(0, 3 - chunk.index) * 0.35
    }));

    const perFileLimit = generalRequest ? 3 : 4;
    const best = scored
      .sort((a, b) => b.score - a.score || a.index - b.index)
      .slice(0, perFileLimit);

    // Always include the first section for general summaries or when nothing matched.
    // This keeps broad questions grounded without sending the whole document.
    const hasFirst = best.some(c => c.index === 0);
    if ((generalRequest || best.every(c => c.score <= 0)) && !hasFirst && scored[0]) {
      best.push(scored[0]);
    }

    selected.push(...best);
  }

  const ordered = selected
    .filter(item => item.text.trim())
    .sort((a, b) => {
      if (generalRequest) return a.file.name.localeCompare(b.file.name) || a.index - b.index;
      return b.score - a.score || a.file.name.localeCompare(b.file.name) || a.index - b.index;
    })
    .slice(0, plan.maxChunks);

  const totalSections = items.reduce((sum, f) => sum + (f.chunk_count || f.chunks?.length || 1), 0);
  const lines: string[] = [
    'PocketMind Hybrid AI has indexed the user\'s local attachment(s) and retrieved a small set of relevant sections for this question.',
    `Retrieved sections: ${ordered.length} of ${totalSections}. Attachment prompt budget: about ${plan.charBudget} characters.`,
    'Use only the retrieved sections below as document evidence. If information is missing, say that the indexed sections do not show it.',
    'Do not quote the entire document. Answer clearly with concise headings and bullets when useful.',
    `Latest user question: ${query}`,
    ''
  ];

  let remaining = plan.charBudget;
  for (const item of ordered) {
    if (remaining <= 450) break;
    const warningLine = item.file.warnings?.length ? `Notes: ${item.file.warnings.slice(0, 2).join(' | ')}` : 'Notes: none';
    const header = [
      '--- Retrieved attachment section ---',
      `File: ${item.file.name}`,
      `Type: ${item.file.kind}`,
      `Section: ${item.index + 1} of ${item.file.chunk_count || item.file.chunks?.length || 1}`,
      `Title: ${item.title}`,
      warningLine,
      'Content:'
    ].join('\n');
    const footer = '\n--- End section ---\n';
    const allowed = Math.max(300, Math.min(plan.maxSectionChars, remaining - header.length - footer.length));
    const section = trimToChars(item.text, allowed);
    lines.push(`${header}\n${section}${footer}`);
    remaining -= header.length + section.length + footer.length;
  }

  if (!ordered.length) {
    lines.push('[No searchable attachment text was available. Use the attachment metadata/warnings only.]');
  }

  return lines.join('\n');
}


function isTinyCodeFragment(code: string): boolean {
  const trimmed = code.trim();
  if (!trimmed) return false;
  const lines = trimmed.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  if (lines.length !== 1) return false;

  // Single keywords or labels such as `def`, `return`, `params`, `class`, or
  // `lambda functions` should be inline code, not a large copyable code panel.
  const singleTermOrShortPhrase = /^[A-Za-z_][\w.-]*(?:\s+[A-Za-z_][\w.-]*){0,3}$/.test(trimmed);

  // Real one-line code should remain copyable. Short syntax examples like
  // print("Hello") or result = add(2, 3) are not tiny fragments.
  const hasRunnableStatementShape =
    /[=(){}\[\];:]/.test(trimmed) ||
    /^(import|from)\s+/.test(trimmed) ||
    /^(for|while|if|elif|else|try|except|with)\b/.test(trimmed) ||
    /^def\s+\w+\s*\(/.test(trimmed) ||
    /^class\s+\w+/.test(trimmed) ||
    /^print\s*\(/.test(trimmed) ||
    /^return\s+.+/.test(trimmed);

  return singleTermOrShortPhrase && !hasRunnableStatementShape && trimmed.length <= 48;
}

const COMMON_CODE_LANGUAGES = new Set([
  'bash', 'bat', 'c', 'cpp', 'csharp', 'cs', 'css', 'dockerfile', 'go', 'html',
  'java', 'javascript', 'js', 'json', 'kotlin', 'md', 'php', 'powershell', 'ps1',
  'py', 'python', 'rust', 'rs', 'sh', 'sql', 'swift', 'text', 'ts', 'tsx',
  'typescript', 'txt', 'xml', 'yaml', 'yml'
]);

function isLikelyCodeLanguage(value: string): boolean {
  const lang = value.trim().toLowerCase();
  return /^[a-z][\w+#.-]{0,24}$/.test(lang) && COMMON_CODE_LANGUAGES.has(lang);
}

function normalizeInlineFencedCode(text: string): string {
  // Small local models sometimes write an opening code fence inside a sentence,
  // for example: "Code example: ```python def secure_password(): ...".
  // CommonMark does not treat that as a valid fenced block, and a later stray
  // closing fence can render as an empty code panel. Repair only that malformed
  // same-line pattern and leave normal Markdown fences untouched.
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let suppressNextBareFence = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (suppressNextBareFence && trimmed === '```') {
      suppressNextBareFence = false;
      continue;
    }

    const fenceIndex = line.indexOf('```');
    const startsWithFence = line.trimStart().startsWith('```');
    const hasTextBeforeFence = fenceIndex > 0 && line.slice(0, fenceIndex).trim().length > 0;

    if (!startsWithFence && hasTextBeforeFence) {
      const before = line.slice(0, fenceIndex).trimEnd();
      const payload = line.slice(fenceIndex + 3);
      const closingIndex = payload.indexOf('```');
      const rawPayload = closingIndex >= 0 ? payload.slice(0, closingIndex) : payload;
      const trailing = closingIndex >= 0 ? payload.slice(closingIndex + 3).trim() : '';
      const match = rawPayload.trim().match(/^([A-Za-z][\w+#.-]{0,24})\s+([\s\S]+)$/);

      if (match && isLikelyCodeLanguage(match[1]) && match[2].trim()) {
        const language = match[1].trim();
        const code = match[2].trim();
        out.push(before);
        if (isTinyCodeFragment(code)) {
          out.push(`\`${code}\``);
        } else {
          out.push(`\`\`\`${language}`);
          out.push(code);
          out.push('```');
        }
        if (trailing) out.push(trailing);
        if (closingIndex < 0) suppressNextBareFence = true;
        continue;
      }
    }

    out.push(line);
  }

  return out.join('\n');
}

function normalizeTinyFencedCodeBlocks(text: string): string {
  // Some smaller local models put individual keywords in fenced code blocks, for
  // example ```
  // class
  // ```. Those should render as inline code, while real multi-line examples must
  // stay as copyable code panels.
  return text.replace(/```([^`\n]*)\n?([\s\S]*?)```/g, (_match, language, body) => {
    const lang = String(language || '').trim();
    const code = String(body || '').replace(/^\n+|\n+$/g, '').trim();
    if (!code) return lang && isTinyCodeFragment(lang) ? `\`${lang}\`` : '';
    if (isTinyCodeFragment(code)) return `\`${code}\``;
    const safeLang = isLikelyCodeLanguage(lang) ? lang : '';
    return `\`\`\`${safeLang}\n${code}\n\`\`\``;
  });
}

function normalizeFenceLines(text: string): string {
  // Repair same-line opening fences such as:
  // ```python def check(): return True
  // They are common with small local models and break Markdown rendering.
  return text.split(/\r?\n/).map((line) => {
    const match = line.match(/^(\s*)```([A-Za-z][\w+#.-]{0,24})\s+(.+)$/);
    if (!match || !isLikelyCodeLanguage(match[2])) return line;
    const indent = match[1] || '';
    const language = match[2].trim();
    const rest = match[3].trim();
    if (!rest || rest === '```') return line;
    const closeIndex = rest.indexOf('```');
    const code = closeIndex >= 0 ? rest.slice(0, closeIndex).trim() : rest;
    const trailing = closeIndex >= 0 ? rest.slice(closeIndex + 3).trim() : '';
    const repaired = `${indent}\`\`\`${language}\n${code}\n${indent}\`\`\``;
    return trailing ? `${repaired}\n${trailing}` : repaired;
  }).join('\n');
}

function closeDanglingFence(text: string): string {
  const fenceCount = (text.match(/```/g) || []).length;
  if (fenceCount % 2 === 0) return text;
  return `${text.trimEnd()}\n\`\`\``;
}

const SEVERE_FORMATTING_ARTIFACTS: RegExp[] = [
  /\[asy\]/i,
  /graphsize\s*=/i,
  /\\(?:begin|end)\{(?:verbatim|tikzpicture|asy|axis|tabular|pgfpicture|pspicture|picture)\}/i,
  /\\(?:node|draw|foreach|pgf\w*|hline|cset|coordinate)\b/i,
  /intersections\s*\/\.style/i,
  /\\theoutputlist|\\bracket\*|\\ifnumexpr/i,
];

function stripSevereFormattingArtifacts(segment: string): string {
  let firstBadIndex = -1;
  for (const pattern of SEVERE_FORMATTING_ARTIFACTS) {
    const match = segment.match(pattern);
    if (match && typeof match.index === 'number') {
      firstBadIndex = firstBadIndex === -1 ? match.index : Math.min(firstBadIndex, match.index);
    }
  }

  if (firstBadIndex < 0) return segment;

  let safe = segment.slice(0, firstBadIndex);
  // Remove a dangling list item that introduced the garbage, e.g. "4-...and more".
  safe = safe
    .replace(/\n?\s*\d{1,2}\s*[-.)]?\s*(?:\.{3}|…)\s*(?:and more)?\s*$/i, '')
    .replace(/\n?\s*(?:\.\.\.|…)\s*(?:continued with)?\s*$/i, '')
    .replace(/[\s,;:.-]+$/g, '')
    .trimEnd();
  return safe;
}

function transformOutsideFencedCode(text: string, transform: (segment: string) => string): string {
  // Keep fenced code content untouched. Formatting repair should only affect
  // prose Markdown, otherwise real code examples can be changed accidentally.
  return text
    .split(/(```[\s\S]*?```)/g)
    .map(part => part.startsWith('```') ? part : transform(part))
    .join('');
}

function normalizeCollapsedMarkdown(segment: string): string {
  // Small local models sometimes collapse headings/lists into one paragraph, e.g.
  // "... emails ## Protective Measures 1 - Strong Passwords 2 - Updates".
  // Repair only clear Markdown/list markers outside code blocks.
  let out = segment
    .replace(/(^|\n)(#{1,6})(?=[A-Za-z0-9])/g, '$1$2 ')
    .replace(/([^\n])\s+(#{1,6})\s+(?=[A-Za-z0-9])/g, '$1\n\n$2 ')
    .replace(/([^\n])\s+[-*•]\s+(?=[A-Z0-9`])/g, '$1\n- ')
    .replace(/(^|\n)(#{1,6}\s+[^\n]*?)\s+(\d{1,2})\s*[-.)]\s+(?=[A-Z0-9`])/g, '$1$2\n$3. ')
    .replace(/([^\n])\s+(\d{1,2})\s*[-.)]\s+(?=[A-Z][A-Za-z0-9`])/g, '$1\n$2. ')
    .replace(/([.!?])\s+([A-Z][A-Za-z0-9 &/()'’.-]{4,80}:)\s+(?=[A-Z0-9`])/g, '$1\n\n**$2**\n');

  // Clean accidental excessive whitespace created by repairs without flattening
  // intentional blank lines.
  out = out.replace(/\n[ \t]+/g, '\n');
  return out;
}

function normalizeAssistantMarkdown(text: string): string {
  if (!text) return '';
  let out = text
    .replace(/<\|assistant\|>/gi, '')
    .replace(/<\|user\|>/gi, '')
    .replace(/<\|system\|>/gi, '')
    .replace(/\[object Object\]/g, '')
    .replace(/```\s*([a-zA-Z0-9_+#.-]+)\s*\n/g, '```$1\n');

  // Small local models sometimes emit HTML instead of Markdown.
  out = transformOutsideFencedCode(out, convertModelHtmlToMarkdown);
  out = transformOutsideFencedCode(out, fixStrayMarkdownUnderscores);

  // Remove severe TeX/TikZ/Asymptote artifacts that small models sometimes emit
  // after a normal answer. This is a display safety net for demo stability.
  out = transformOutsideFencedCode(out, stripSevereFormattingArtifacts);

  // Repair malformed same-line fences before Markdown rendering. This prevents
  // broken model output from becoming empty copyable code panels.
  out = normalizeFenceLines(out);
  out = normalizeInlineFencedCode(out);

  // Models sometimes wrap single keywords in fenced code blocks, which creates huge
  // empty-looking panels. Convert tiny fragments to inline code; keep real code
  // examples as copyable fenced blocks.
  out = normalizeTinyFencedCodeBlocks(out);

  // Repair collapsed headings/lists only in prose, never inside fenced code.
  out = transformOutsideFencedCode(out, normalizeCollapsedMarkdown);
  out = repairCollapsedFencedCode(out);
  out = closeDanglingFence(out);

  return transformOutsideFencedCode(
    transformOutsideFencedCode(out, stripModelCitationMarkers),
    stripModelMetaNotes,
  )
    .replace(/(^|\n)\s*[-*]\s*`([^`\n]{1,32})`\s*:\s*/g, '$1- **`$2`**: ')
    .replace(/(^|\n)\s*[-*]\s*:\s*/g, '$1- ')
    .replace(/\n\s*:\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}




function appendStreamChunk(current: string, piece: string): string {
  if (!piece) return current;
  if (!current) return piece;
  if (piece.startsWith(current)) return piece;
  if (current.endsWith(piece)) return current;

  const max = Math.min(current.length, piece.length);
  for (let len = max; len > 0; len--) {
    if (current.endsWith(piece.slice(0, len))) {
      return current + piece.slice(len);
    }
  }
  return current + piece;
}

function collapseConsecutiveDuplicateWords(segment: string): string {
  return segment
    .split('\n')
    .map((line) => {
      const words = line.split(/\s+/).filter(Boolean);
      if (words.length < 2) return line;

      const out: string[] = [];
      let lastNorm = '';
      for (const raw of words) {
        const norm = raw.replace(/^[^\w]+|[^\w]+$/g, '').toLowerCase();
        if (norm && norm === lastNorm) continue;
        lastNorm = norm;
        out.push(raw);
      }
      return out.join(' ');
    })
    .join('\n');
}

function stripModelCitationMarkers(segment: string): string {
  return segment.replace(/\[\d+\]\s*/g, '');
}

function convertModelHtmlToMarkdown(segment: string): string {
  let out = segment;

  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<\/?p\b[^>]*>/gi, '\n\n');
  out = out.replace(/<strong\b[^>]*>([\s\S]*?)<\/strong>/gi, '**$1**');
  out = out.replace(/<b\b[^>]*>([\s\S]*?)<\/b>/gi, '**$1**');
  out = out.replace(/<em\b[^>]*>([\s\S]*?)<\/em>/gi, '*$1*');
  out = out.replace(/<i\b[^>]*>([\s\S]*?)<\/i>/gi, '*$1*');
  out = out.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_match, level, content) => {
    const hashes = '#'.repeat(Math.min(6, Math.max(1, Number(level) || 1)));
    return `\n\n${hashes} ${String(content).replace(/<[^>]+>/g, '').trim()}\n\n`;
  });
  out = out.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_match, content) => {
    const text = String(content).replace(/<[^>]+>/g, '').trim();
    return text ? `- ${text}\n` : '';
  });
  out = out.replace(/<\/?(ul|ol)\b[^>]*>/gi, '\n');
  out = out.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  out = out.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_match, content) => `\n\n\`\`\`\n${String(content).trim()}\n\`\`\`\n\n`);
  out = out.replace(/<\/?[a-z][^>]*>/gi, '');
  out = out
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  return out;
}

function fixStrayMarkdownUnderscores(segment: string): string {
  return segment
    .replace(/(\w)_([,.!?;:])/g, '$1$2')
    .replace(/\s+_\./g, '.');
}

function stripModelMetaNotes(segment: string): string {
  return segment
    .replace(/\n+\*Note:[^*\n]{0,240}\*\s*$/i, '')
    .replace(/\n+Note:\s*I didn['']t repeat[^\n]*$/i, '')
    .trimEnd();
}

function repairCollapsedPythonCode(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) return code;

  const newlineCount = (trimmed.match(/\n/g) || []).length;
  if (newlineCount >= 2 && trimmed.length / Math.max(newlineCount, 1) < 120) {
    return code;
  }

  let out = trimmed
    .replace(/\[\d+\]\s*/g, '')
    .replace(/\s+(?=(?:def|class)\s+\w)/g, '\n')
    .replace(/\s+(?=#)/g, '\n')
    .replace(/:\s+(?=self\.|return\b|[A-Za-z_]\w*\s*[=(])/g, ':\n    ')
    .replace(/\)\s+(?=return\b|[A-Za-z_]\w*\s*=)/g, ')\n        ');

  return out
    .split('\n')
    .map(line => line.trimEnd())
    .filter((line, index, lines) => line.length > 0 || (index > 0 && index < lines.length - 1))
    .join('\n');
}

function repairCollapsedFencedCode(text: string): string {
  return text.replace(/```(python|py)\s*\n([\s\S]*?)```/gi, (_match, lang, body) => {
    const repaired = repairCollapsedPythonCode(String(body || ''));
    return `\`\`\`${lang}\n${repaired}\n\`\`\``;
  });
}

function finalizeAssistantText(text: string): string {
  let out = normalizeAssistantMarkdown(text);
  out = transformOutsideFencedCode(out, collapseConsecutiveDuplicateWords);
  const lower = out.toLowerCase();
  const cutMarkers = [
    'can you also',
    'would you like me to',
    'let me know if you',
    'in future messages',
    '\nquestion:',
    '\nq:',
    '\nuser:',
    '\nlatest user message:'
  ];
  for (const marker of cutMarkers) {
    const idx = lower.indexOf(marker);
    if (idx > 40) {
      out = out.slice(0, idx).replace(/[\s:,.\-]+$/g, '').trim();
      break;
    }
  }
  return out;
}

function hasMeaningfulChatMessages(items: Array<{ role?: string; content?: string }> | undefined): boolean {
  return (items || []).some(m => {
    const role = String(m.role || '').toLowerCase();
    const content = String(m.content || '').trim();
    return (role === 'user' || role === 'assistant') && Boolean(content) && content !== 'Thinking...';
  });
}

function extractPlainText(children: unknown): string {
  // react-markdown + rehype-highlight can pass highlighted code as React
  // elements instead of plain strings. String(element) becomes "[object Object]",
  // so we recursively read the element children and only keep real text.
  if (children === null || children === undefined || typeof children === 'boolean') return '';
  if (typeof children === 'string' || typeof children === 'number') return String(children);
  if (Array.isArray(children)) return children.map(extractPlainText).join('');
  if (isValidElement(children)) return extractPlainText((children.props as { children?: unknown }).children);
  if (typeof children === 'object' && 'props' in (children as Record<string, unknown>)) {
    const props = (children as { props?: { children?: unknown } }).props;
    return extractPlainText(props?.children);
  }
  return '';
}

function CopyableCodeBlock({ language, code }: { language: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard.writeText(code.replace(/\n$/, ''));
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="nexus-code-shell">
      <div className="nexus-code-toolbar">
        <span className="nexus-code-language">{language || 'code'}</span>
        <button type="button" onClick={copy} className="nexus-code-copy" title="Copy code block">
          {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="nexus-code-pre"><code className={language ? `language-${language}` : undefined}>{code}</code></pre>
    </div>
  );
}

const MarkdownMessage = memo(function MarkdownMessage({ content, variant = 'assistant' }: { content: string; variant?: 'assistant' | 'user' }) {
  const normalized = variant === 'assistant' ? normalizeAssistantMarkdown(content) : content;

  return (
    <div className={variant === 'assistant' ? 'nexus-markdown nexus-markdown-assistant' : 'nexus-markdown nexus-markdown-user'}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={variant === 'assistant' ? [rehypeHighlight] : []}
        components={{
          h1: ({ children }) => <h1 className="nexus-md-h1">{children}</h1>,
          h2: ({ children }) => <h2 className="nexus-md-h2">{children}</h2>,
          h3: ({ children }) => <h3 className="nexus-md-h3">{children}</h3>,
          h4: ({ children }) => <h4 className="nexus-md-h4">{children}</h4>,
          p: ({ children }) => <p className="nexus-md-p">{children}</p>,
          strong: ({ children }) => <strong className="nexus-md-strong">{children}</strong>,
          em: ({ children }) => <em className="nexus-md-em">{children}</em>,
          ul: ({ children }) => <ul className="nexus-md-ul">{children}</ul>,
          ol: ({ children }) => <ol className="nexus-md-ol">{children}</ol>,
          li: ({ children }) => <li className="nexus-md-li">{children}</li>,
          blockquote: ({ children }) => <blockquote className="nexus-md-quote">{children}</blockquote>,
          a: ({ children, href }) => <a className="nexus-md-link" href={href} target="_blank" rel="noreferrer">{children}</a>,
          table: ({ children }) => <div className="nexus-md-table-wrap"><table className="nexus-md-table">{children}</table></div>,
          th: ({ children }) => <th className="nexus-md-th">{children}</th>,
          td: ({ children }) => <td className="nexus-md-td">{children}</td>,
          hr: () => <hr className="nexus-md-hr" />,
          code: (props: any) => {
            const { inline, className, children, ...rest } = props;
            const rawCode = extractPlainText(children);
            const match = /language-([\w+#.-]+)/.exec(className || '');
            const language = match?.[1] || '';
            const plainCode = rawCode.trim();
            if (!plainCode) return null;
            if (inline || isTinyCodeFragment(plainCode)) {
              return <code className="nexus-inline-code" {...rest}>{plainCode}</code>;
            }
            return <CopyableCodeBlock language={language} code={rawCode} />;
          },
          pre: ({ children }) => <>{children}</>
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
});

function deriveChatTitle(prompt: string): string {
  const cleaned = prompt
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>`\[\]{}()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'New Chat';
  const words = cleaned.split(' ').slice(0, 8).join(' ');
  return words.length > 54 ? `${words.slice(0, 54).trim()}…` : words;
}

function sanitizeHistoryForModel(content: string, role: string): string {
  let cleaned = normalizeAssistantMarkdown(content || '')
    .replace(/_Attachments used:[^\n]+_/gi, '')
    .trim();

  if (role === 'assistant') {
    cleaned = finalizeAssistantText(cleaned);
    if (/^\*\*Generation failed:/i.test(cleaned)) return '';
    if (/^Thinking\.\.\.$/i.test(cleaned)) return '';
    cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
    if (cleaned.length > 3200) cleaned = `${cleaned.slice(0, 3200)}...`;
    return cleaned;
  }

  cleaned = cleaned.replace(/\n{3,}/g, '\n\n');
  if (cleaned.length > 3200) cleaned = `${cleaned.slice(0, 3200)}...`;
  return cleaned;
}

type GenerationResponsePayload = {
  text: string;
  finish_reason?: string | null;
  tokens_generated?: number;
  tokens_per_sec?: number;
};

export default function ChatView() {
  const [input, setInput] = useState('');
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [exportMenuOpen, setExportMenuOpen] = useState(false);
  const [busyCreatingChat, setBusyCreatingChat] = useState(false);
  const [generationStatus, setGenerationStatus] = useState<string | null>(null);
  const [showTuning, setShowTuning] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentContext[]>([]);
  const [attachmentBusy, setAttachmentBusy] = useState(false);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [includeAttachments, setIncludeAttachments] = useState(true);
  const [keepLastN, setKeepLastN] = useState(defaultKeepLastN());
  const [showCompareRewrite, setShowCompareRewrite] = useState(false);
  const [compareOriginal, setCompareOriginal] = useState('');
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamingTextRef = useRef<string>('');
  const streamUiTimerRef = useRef<number | null>(null);
  const streamLastUiAtRef = useRef(0);
  const attachmentCacheRef = useRef<Map<string, AttachmentContext>>(new Map());

  const {
    activeConversationId,
    messages,
    conversations,
    characters,
    isGenerating,
    generationError,
    currentModel,
    activeCharacterId,
    defaultParams,
    pendingChatPrompt,
    pendingChatOptions,
    setIsGenerating,
    setGenerationError,
    addMessage,
    updateMessage,
    replaceMessage,
    setDefaultParams,
    setPendingChatPrompt,
    resetDefaultParams,
    removeConversationLocal,
    renameConversationLocal,
    setActiveView,
    setActiveConversation,
    setMessages,
    setConversations,
  } = useAppStore(useShallow(s => ({
    activeConversationId: s.activeConversationId,
    messages: s.messages,
    conversations: s.conversations,
    characters: s.characters,
    isGenerating: s.isGenerating,
    generationError: s.generationError,
    currentModel: s.currentModel,
    activeCharacterId: s.activeCharacterId,
    defaultParams: s.defaultParams,
    pendingChatPrompt: s.pendingChatPrompt,
    pendingChatOptions: s.pendingChatOptions,
    setIsGenerating: s.setIsGenerating,
    setGenerationError: s.setGenerationError,
    addMessage: s.addMessage,
    updateMessage: s.updateMessage,
    replaceMessage: s.replaceMessage,
    setDefaultParams: s.setDefaultParams,
    setPendingChatPrompt: s.setPendingChatPrompt,
    resetDefaultParams: s.resetDefaultParams,
    removeConversationLocal: s.removeConversationLocal,
    renameConversationLocal: s.renameConversationLocal,
    setActiveView: s.setActiveView,
    setActiveConversation: s.setActiveConversation,
    setMessages: s.setMessages,
    setConversations: s.setConversations,
  })));

  const currentMessages = activeConversationId ? messages[activeConversationId] || [] : [];
  const activeConversation = conversations.find(c => c.id === activeConversationId);
  const activeConversationTitle = activeConversation?.title || 'New Chat';
  const activeCharacter = characters.find(c => c.id === (activeCharacterId || activeConversation?.character_id));
  const selectedModelName = modelFileName(currentModel);
  const canSend = Boolean(input.trim() && activeConversationId && currentModel && !isGenerating);

  useEffect(() => {
    if (!activeConversationId || !FEATURE_FLAGS.contextTrimSlider) return;
    const key = `chat.trim.${activeConversationId}`;
    void getSetting(key).then(v => {
      const n = v ? Number(v) : defaultKeepLastN();
      if (Number.isFinite(n) && n >= 2) setKeepLastN(Math.min(40, Math.max(2, Math.round(n))));
      else setKeepLastN(defaultKeepLastN());
    });
  }, [activeConversationId]);

  const persistKeepLastN = (n: number) => {
    setKeepLastN(n);
    if (activeConversationId) {
      void setSetting(`chat.trim.${activeConversationId}`, String(n));
    }
  };

  const lastAssistantMessage = useMemo(() => {
    const list = currentMessages.filter(m => m.role === 'assistant' && m.content && m.content !== 'Thinking...');
    return list[list.length - 1]?.content ?? '';
  }, [currentMessages]);

  const contextBudget = useMemo(() => {
    if (!FEATURE_FLAGS.contextBudgetBar) return null;
    const fileBlock = includeAttachments && attachments.length > 0
      ? attachmentContextBlock(attachments, input, defaultParams.context_size, defaultParams.max_tokens)
      : '';
    const systemPrompt = activeCharacter?.system_prompt || 'PocketMind Hybrid AI assistant';
    return computeContextBudget({
      systemPrompt,
      messages: currentMessages.filter(m => (m.role === 'user' || m.role === 'assistant') && m.content !== 'Thinking...'),
      attachmentText: fileBlock || null,
      contextSize: defaultParams.context_size,
      keepLastN,
    });
  }, [activeCharacter?.system_prompt, attachments, currentMessages, defaultParams.context_size, defaultParams.max_tokens, includeAttachments, input, keepLastN]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'auto' });
  }, [currentMessages.length, isGenerating]);

  const createChat = async () => {
    setBusyCreatingChat(true);
    setGenerationError(null);
    try {
      const id = await invoke<string>('create_conversation', {
        title: 'New Chat',
        characterId: activeCharacterId || null,
        modelId: currentModel || null,
        mode: 'chat'
      });
      setActiveConversation(id);
      setMessages(id, []);
      const convs = await invoke<Conversation[]>('get_conversations');
      setConversations(convs);
      setActiveView('chat');
    } catch (err) {
      setGenerationError(humanError(err));
    } finally {
      setBusyCreatingChat(false);
    }
  };

  const copyChat = async () => {
    const text = currentMessages.map(m => `${m.role.toUpperCase()}:\n${m.content}`).join('\n\n---\n\n');
    await navigator.clipboard.writeText(text || '');
    setCopiedId('chat');
    setTimeout(() => setCopiedId(null), 2000);
  };

  const exportChat = async (kind: ChatExportKind) => {
    setExportMenuOpen(false);
    try {
      const result = await exportChatAs(
        activeConversationTitle,
        selectedModelName,
        currentMessages,
        kind,
      );
      setGenerationStatus(result.message);
    } catch (err) {
      setGenerationError(humanError(err));
    }
  };

  const deleteChat = async () => {
    if (!activeConversationId) return;
    if (!confirm('Delete this chat from PocketMind Hybrid AI? This cannot be undone.')) return;
    await invoke('delete_conversation', { id: activeConversationId });
    removeConversationLocal(activeConversationId);
  };

  const stopGeneration = async () => {
    try {
      setGenerationStatus('Stopping the local engine...');
      await invoke('stop_generation');
    } catch (err) {
      setGenerationError(humanError(err));
    } finally {
      setIsGenerating(false);
      setGenerationStatus(null);
    }
  };

  const unloadChatModel = async () => {
    if (isGenerating) {
      setGenerationError('Stop the current reply before unloading the model.');
      return;
    }
    const isRemote = !!currentModel && (currentModel.startsWith('remote:') || currentModel.startsWith('enterprise:'));
    if (isRemote) {
      setGenerationError(null);
      setGenerationStatus('Online/server models are not held in local memory.');
      return;
    }
    try {
      setGenerationStatus('Unloading model from memory...');
      const result = await invoke<{ message: string }>('unload_chat_model', { releaseKnowledgeEngines: false });
      // #region agent log
      fetch('http://127.0.0.1:7414/ingest/28bf2132-0f52-40ef-96b9-4e681c1d7653',{method:'POST',headers:{'Content-Type':'application/json','X-Debug-Session-Id':'7d5a77'},body:JSON.stringify({sessionId:'7d5a77',runId:'unload-feature',hypothesisId:'B',location:'ChatView.tsx:unload',message:'fe_unload_chat_model',data:{ok:true},timestamp:Date.now()})}).catch(()=>{});
      // #endregion
      setGenerationError(null);
      setGenerationStatus(result.message || 'Model unloaded from memory.');
    } catch (err) {
      setGenerationError(humanError(err));
      setGenerationStatus(null);
    }
  };

  const attachFiles = async () => {
    setAttachmentBusy(true);
    setAttachmentNotice('Opening attachment picker...');
    setGenerationError(null);
    try {
      const selected = await open({
        multiple: true,
        directory: false,
        filters: [
          { name: 'Useful files', extensions: ['pdf', 'docx', 'pptx', 'xlsx', 'xlsm', 'csv', 'txt', 'md', 'json', 'xml', 'html', 'py', 'js', 'ts', 'tsx', 'java', 'cpp', 'c', 'cs', 'go', 'rs', 'sql', 'png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'] },
          { name: 'All files', extensions: ['*'] }
        ]
      });

      if (!selected) return;
      const paths = Array.isArray(selected) ? selected : [selected];
      const existingPaths = new Set(attachments.map(a => a.path.toLowerCase()));
      const cached: AttachmentContext[] = [];
      const pathsToProcess: string[] = [];

      for (const path of paths) {
        const key = path.toLowerCase();
        const cachedItem = attachmentCacheRef.current.get(key);
        if (cachedItem) {
          cached.push(cachedItem);
        } else if (!existingPaths.has(key)) {
          pathsToProcess.push(path);
        }
      }

      let processed: AttachmentContext[] = [];
      if (pathsToProcess.length > 0) {
        setAttachmentNotice(`Reading and indexing ${pathsToProcess.length} file(s) locally...`);
        processed = await invoke<AttachmentContext[]>('process_attachments', {
          paths: pathsToProcess,
          maxCharsPerFile: 120000,
          maxTotalChars: 240000
        });
        for (const item of processed) {
          attachmentCacheRef.current.set(item.path.toLowerCase(), item);
        }
      }

      const ready = [...cached, ...processed];
      setAttachments(prev => {
        const existing = new Set(prev.map(a => a.path.toLowerCase()));
        const merged = [...prev];
        for (const item of ready) {
          if (!existing.has(item.path.toLowerCase())) merged.push(item);
        }
        return merged;
      });
      const warningCount = ready.reduce((sum, f) => sum + (f.warnings?.length || 0), 0);
      const sectionCount = ready.reduce((sum, f) => sum + (f.chunk_count || f.chunks?.length || 1), 0);
      setAttachmentNotice(
        ready.length
          ? `Attached ${ready.length} file(s) offline and indexed ${sectionCount} section(s). ${cached.length ? `${cached.length} reused from cache. ` : ''}${warningCount ? `${warningCount} extraction/indexing note(s).` : 'Ready for fast document Q&A.'}`
          : 'Selected file(s) are already attached and indexed.'
      );
    } catch (err) {
      setGenerationError(humanError(err));
    } finally {
      setAttachmentBusy(false);
    }
  };

  const removeAttachment = (path: string) => {
    setAttachments(prev => prev.filter(a => a.path !== path));
  };

  const applySpeedPreset = () => {
    setDefaultParams({ max_tokens: 256, context_size: 2048, batch_size: 128, temperature: 0.4, top_p: 0.8, repetition_penalty: 1.2, gpu_layers: -1 });
  };

  const applyQualityPreset = () => {
    setDefaultParams({ max_tokens: 768, context_size: 4096, batch_size: 256, temperature: 0.65, top_p: 0.88, repetition_penalty: 1.16, gpu_layers: -1 });
  };

  const handleSend = async (overrideContent?: string, sendOptions?: PendingChatOptions) => {
    const content = (overrideContent ?? input).trim();
    if (!content || !activeConversationId || isGenerating) return;
    if (!currentModel) {
      setGenerationError('No model selected. Open Models, import or scan a GGUF model, then click Use.');
      return;
    }

    let conversationId = activeConversationId;
    let conversationMessages = currentMessages;
    let conversationForSend = activeConversation;
    let assistantMsgId: string | null = null;

    if (!overrideContent) setInput('');
    setGenerationError(null);
    setIsGenerating(true);
    setGenerationStatus(attachments.length && includeAttachments ? 'Searching indexed attachment sections...' : 'Preparing the selected model...');

    try {
      // Safety guard: if the user changed models while an older chat is still selected,
      // never continue that older chat with the new model. Create a fresh model-specific chat.
      if (conversationForSend?.model_id && conversationForSend.model_id !== currentModel) {
        setGenerationStatus('Starting a new chat for the selected model...');

        // If the currently selected chat is an unused draft from a previous model switch,
        // remove it before creating the new model-specific chat. This keeps the sidebar clean.
        if (conversationId && !hasMeaningfulChatMessages(conversationMessages)) {
          try {
            await invoke('delete_conversation', { id: conversationId });
            removeConversationLocal(conversationId);
          } catch {
            // Cleanup is helpful but not required for generation to continue.
          }
        }

        const newConversationId = await invoke<string>('create_conversation', {
          title: 'New Chat',
          characterId: activeCharacterId || null,
          modelId: currentModel,
          mode: 'chat'
        });
        conversationId = newConversationId;
        conversationMessages = [];
        conversationForSend = undefined;
        setActiveConversation(newConversationId);
        setMessages(newConversationId, []);
        const convs = await invoke<Conversation[]>('get_conversations');
        setConversations(convs);
      }

      const visibleAttachmentSummary = attachments.length && includeAttachments
        ? `\n\n_Attachments used: ${attachments.map(a => a.name).join(', ')}_`
        : '';
      const userVisibleContent = `${content}${visibleAttachmentSummary}`;

      const userMsgId = await invoke<string>('add_message', {
        conversationId,
        role: 'user',
        content: userVisibleContent,
        metadata: null
      });
      addMessage(conversationId, {
        id: userMsgId,
        conversation_id: conversationId,
        role: 'user',
        content: userVisibleContent,
        created_at: Date.now()
      });

      if (conversationMessages.length === 0 && ['New Chat', 'Untitled chat', ''].includes((conversationForSend?.title || 'New Chat').trim())) {
        const title = deriveChatTitle(content);
        try {
          await invoke('update_conversation_title', { id: conversationId, title });
          renameConversationLocal(conversationId, title);
        } catch {
          // Title generation is convenience-only; never block chat generation.
        }
      }

      assistantMsgId = await invoke<string>('add_message', {
        conversationId,
        role: 'assistant',
        content: 'Thinking...',
        metadata: null
      });
      addMessage(conversationId, {
        id: assistantMsgId,
        conversation_id: conversationId,
        role: 'assistant',
        content: 'Thinking...',
        created_at: Date.now()
      });

      const useSocGeneration = shouldUseSocGeneration(content, conversationForSend, sendOptions?.soc);
      const generationParams = useSocGeneration
        ? mergeGenerationParams(defaultParams, SOC_GENERATION_PARAMS)
        : defaultParams;

      const defaultChatSystemPrompt = [
        'You are PocketMind Hybrid AI, a helpful offline desktop assistant.',
        'Answer only the latest user message directly and naturally.',
        'Do not invent follow-up questions, fake user messages, quizzes, or extra prompts.',
        'Do not repeat words, phrases, paragraphs, or the user prompt.',
        'Use plain, clean Markdown with headings, subheadings, bullet points, numbered points, and tables only when useful.',
        'Never use HTML tags such as br, ul, li, p, strong, or em. Use Markdown syntax instead.',
        'Do not add meta notes about repetition, formatting, or your own output quality.',
        'Put every Markdown heading, bullet point, numbered point, and fenced code block on its own line.',
        'Use inline code for single keywords such as `def`, `return`, `params`, and variable names.',
        'Use fenced code blocks only for complete runnable examples, not for single words or fragments.',
        'Do not output LaTeX, TikZ, PGF, Asymptote, tabular, graph, or diagram source unless the user explicitly asks for that exact format.',
        'When the user attaches files, answer using the selected indexed attachment sections. Be honest about extraction limitations and avoid pretending omitted sections were reviewed.',
        'Keep answers practical and concise unless the user asks for detail.',
      ].join(' ');

      const systemPrompt = useSocGeneration
        ? SOC_SYSTEM_PROMPT
        : (activeCharacter?.system_prompt || defaultChatSystemPrompt);

      const fileBlock = includeAttachments ? attachmentContextBlock(attachments, content, generationParams.context_size, generationParams.max_tokens) : '';
      if (fileBlock) setGenerationStatus('Retrieved the most relevant document sections. Starting response...');
      const userModelContent = fileBlock
        ? `${content}\n\n${fileBlock}`
        : content;

      const modelMessages = [
        ...conversationMessages
          .filter(m => (m.role === 'user' || m.role === 'assistant') && m.content && m.content !== 'Thinking...')
          .slice(-keepLastN)
          .map(m => ({
            role: m.role === 'assistant' ? 'assistant' : 'user',
            content: sanitizeHistoryForModel(m.content, m.role)
          }))
          .filter(m => Boolean(m.content)),
        { role: 'user', content: userModelContent }
      ];

      setGenerationStatus('Loading or reusing the selected model...');
      streamingTextRef.current = '';
      let streamError: string | null = null;

      const pushStreamingUi = (text: string) => {
        const flush = () => {
          replaceMessage(conversationId, assistantMsgId!, text);
          streamLastUiAtRef.current = Date.now();
        };
        const elapsed = Date.now() - streamLastUiAtRef.current;
        if (elapsed >= 100) {
          if (streamUiTimerRef.current) {
            window.clearTimeout(streamUiTimerRef.current);
            streamUiTimerRef.current = null;
          }
          flush();
          return;
        }
        if (streamUiTimerRef.current) return;
        streamUiTimerRef.current = window.setTimeout(() => {
          streamUiTimerRef.current = null;
          flush();
        }, Math.max(16, 100 - elapsed));
      };

      const unlistenChunk = await listen<GenerationResponsePayload>('generation-chunk', (event) => {
        const chunkText = event.payload?.text || '';
        const finishReason = event.payload?.finish_reason;
        if (!chunkText) return;

        if (finishReason) {
          streamingTextRef.current = chunkText;
        } else {
          streamingTextRef.current = appendStreamChunk(streamingTextRef.current, chunkText);
        }
        pushStreamingUi(streamingTextRef.current);
        setGenerationStatus('Generating response...');
      });
      const unlistenStatus = await listen<any>('generation-status', (event) => {
        const message = event.payload?.message;
        if (typeof message === 'string' && message.trim()) setGenerationStatus(message);
      });
      const unlistenError = await listen<string>('generation-error', (event) => {
        streamError = humanError(event.payload);
      });

      try {
        await invoke('stream_generate', {
          request: {
            prompt: userModelContent,
            messages: modelMessages,
            system_prompt: systemPrompt,
            params: generationParams,
            model_path: currentModel,
            backend: currentModel.startsWith('enterprise:') ? 'enterprise' : currentModel.startsWith('remote:') ? 'remote' : 'llama.cpp'
          }
        });
      } catch (err) {
        streamError = humanError(err);
      } finally {
        if (streamUiTimerRef.current) {
          window.clearTimeout(streamUiTimerRef.current);
          streamUiTimerRef.current = null;
        }
        unlistenChunk();
        unlistenStatus();
        unlistenError();
      }

      const partialText = finalizeAssistantText(streamingTextRef.current);
      if (streamError && partialText.length < 40) throw new Error(streamError);
      let finalText = partialText || '[The model returned an empty response.]';
      if (streamError && partialText.length >= 40) {
        finalText = `${partialText}\n\n---\n\n**Generation note:** ${streamError}`;
        setGenerationError(streamError);
      } else {
        setGenerationError(null);
      }
      replaceMessage(conversationId, assistantMsgId, finalText);
      await invoke('update_message', { id: assistantMsgId, content: finalText, metadata: null });
      setGenerationStatus(null);
    } catch (err) {
      const msg = humanError(err) || 'Generation failed. Check the selected model, runtime folder, and diagnostics report.';
      setGenerationError(msg);
      if (assistantMsgId) {
        const failed = `**Generation failed:** ${msg}`;
        replaceMessage(conversationId, assistantMsgId, failed);
        try { await invoke('update_message', { id: assistantMsgId, content: failed, metadata: null }); } catch { /* ignore db update failure */ }
      }
      setGenerationStatus(null);
    } finally {
      setIsGenerating(false);
    }
  };

  useEffect(() => {
    if (!pendingChatPrompt) return;
    const prompt = pendingChatPrompt;
    const options = pendingChatOptions || undefined;
    setPendingChatPrompt(null);

    if (options?.autoSend && activeConversationId && currentModel && !isGenerating) {
      void handleSend(prompt, options);
      return;
    }

    setInput(prompt);
    if (options?.autoSend && !currentModel) {
      setGenerationError('SOC prompt loaded. Select a model in Models, then click Send to generate.');
    }
  }, [pendingChatPrompt, pendingChatOptions, setPendingChatPrompt, activeConversationId, currentModel, isGenerating]);

  const handleCopy = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopiedId(id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!activeConversationId) {
    return (
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="text-center space-y-5 max-w-xl px-6 py-8 premium-card">
          <div className="w-16 h-16 rounded-2xl bg-primary-600 flex items-center justify-center mx-auto">
            <Sparkles className="w-8 h-8 text-white" />
          </div>
          <div>
            <h2 className="text-2xl font-black text-surface-900 dark:text-surface-100 mb-2">PocketMind Hybrid AI Desktop</h2>
            <p className="text-surface-600 dark:text-surface-300">Select a model and start a chat.</p>
          </div>
          <div className="rounded-xl border border-surface-200 dark:border-surface-800 p-3 text-left bg-surface-50 dark:bg-surface-900">
            <p className="text-sm font-semibold mb-1">Selected model</p>
            <p className="text-sm text-surface-500 break-all">{selectedModelName}</p>
          </div>
          <div className="flex flex-wrap gap-3 justify-center">
            <button onClick={() => setActiveView('models')} className="btn-primary flex items-center gap-2"><Download className="w-4 h-4" /> Models</button>
            <button onClick={createChat} disabled={!currentModel || busyCreatingChat} className="btn-secondary flex items-center gap-2 disabled:opacity-50 disabled:cursor-not-allowed"><MessageSquare className="w-4 h-4" /> New Chat</button>
            <button onClick={() => setActiveView('characters')} className="btn-secondary">Characters</button>
          </div>
          {!currentModel && <p className="text-sm text-amber-600 dark:text-amber-400">Choose a model in Models first.</p>}
          {generationError && <p className="text-sm text-red-500">{generationError}</p>}
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col h-full min-w-0">
      <div className="min-h-16 border-b border-white/70 dark:border-surface-800/80 flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-4 py-3 glass-panel flex-shrink-0">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-xl bg-primary-600 flex items-center justify-center flex-shrink-0">
            {activeCharacter ? <span className="text-sm font-bold text-white">{activeCharacter.name[0]}</span> : <Bot className="w-4 h-4 text-white" />}
          </div>
          <div className="min-w-0">
            <h3 className="font-semibold text-sm truncate">{activeConversationTitle}</h3>
            <p className="text-xs text-surface-500 truncate">{activeCharacter?.name || 'Assistant'} • {selectedModelName} • {isGenerating ? generationStatus || 'Generating...' : currentModel ? 'Ready' : 'Model required'}</p>
          </div>
        </div>
        <div className="flex items-center gap-2 w-full sm:w-auto overflow-x-auto pb-1 sm:pb-0">
          <button onClick={() => setShowCompareRewrite(v => !v)} className="btn-secondary text-sm whitespace-nowrap">Compare rewrite</button>
          <button onClick={() => setShowTuning(v => !v)} className="btn-secondary text-sm flex items-center gap-2 whitespace-nowrap"><SlidersHorizontal className="w-4 h-4" /> Tuning</button>
          <button onClick={copyChat} className="btn-secondary text-sm flex items-center gap-2 whitespace-nowrap" title="Copy whole chat"><ClipboardCopy className="w-4 h-4" /> {copiedId === 'chat' ? 'Copied' : 'Copy chat'}</button>
          <div className="relative">
            <button
              onClick={() => setExportMenuOpen(v => !v)}
              className="btn-secondary text-sm flex items-center gap-2 whitespace-nowrap"
              title="Export chat"
            >
              <Download className="w-4 h-4" /> Export as…
            </button>
            {exportMenuOpen && (
              <div className="absolute right-0 top-full mt-1 z-40 w-40 rounded-xl border border-surface-200 dark:border-surface-700 bg-white dark:bg-surface-900 shadow-md p-1">
                {(['md', 'json', 'txt'] as const).map(kind => (
                  <button
                    key={kind}
                    className="w-full text-left px-3 py-2 rounded-lg text-sm hover:bg-surface-100 dark:hover:bg-surface-800"
                    onClick={() => { void exportChat(kind); }}
                  >
                    {kind.toUpperCase()}
                  </button>
                ))}
              </div>
            )}
          </div>
          {!isGenerating && (
            <button onClick={() => void unloadChatModel()} className="btn-secondary text-sm flex items-center gap-2 whitespace-nowrap" title="Free RAM/VRAM by unloading the local chat model">
              <Power className="w-4 h-4" /> Unload
            </button>
          )}
          {isGenerating ? (
            <button onClick={stopGeneration} className="px-3 py-2 rounded-lg bg-red-600 hover:bg-red-500 text-white text-sm flex items-center gap-2"><Square className="w-4 h-4" /> Stop</button>
          ) : (
            <button onClick={deleteChat} className="p-2 rounded-lg hover:bg-red-100 dark:hover:bg-red-900/30 transition-colors" title="Delete chat"><Trash2 className="w-4 h-4 text-red-500" /></button>
          )}
        </div>
      </div>

      {showTuning && (
        <div className="border-b border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-950 p-4">
          <div className="max-w-5xl mx-auto space-y-4">
            {FEATURE_FLAGS.contextBudgetBar && contextBudget && (
              <ContextBudgetBar
                budget={contextBudget}
                keepLastN={keepLastN}
                onKeepLastNChange={persistKeepLastN}
                showSlider={FEATURE_FLAGS.contextTrimSlider}
              />
            )}
          <div className="grid md:grid-cols-5 gap-3 text-sm">
            <label>Creativity
              <input className="input-field mt-1" type="number" step="0.05" min="0" max="2" value={defaultParams.temperature} onChange={e => setDefaultParams({ temperature: Number(e.target.value) })} />
            </label>
            <label>Response length <span className="tuning-help" title="Maximum amount of text PocketMind Hybrid AI can generate in one response.">?</span>
              <input className="input-field mt-1" type="number" min="64" max="4096" value={defaultParams.max_tokens} onChange={e => setDefaultParams({ max_tokens: Number(e.target.value) })} />
            </label>
            <label>Memory window <span className="tuning-help" title="How much conversation and file context the model can consider at once. Larger values use more memory.">?</span>
              <input className="input-field mt-1" type="number" min="512" max="32768" value={defaultParams.context_size} onChange={e => setDefaultParams({ context_size: Number(e.target.value) })} />
            </label>
            <label>GPU usage <span className="text-xs text-surface-400">(-1 Auto)</span> <span className="tuning-help" title="-1 lets PocketMind Hybrid AI choose automatically. 0 uses CPU only. Higher values use more GPU memory.">?</span>
              <input className="input-field mt-1" type="number" min="-1" max="999" value={defaultParams.gpu_layers} onChange={e => setDefaultParams({ gpu_layers: Number(e.target.value) })} />
            </label>
            <label>Processing batch <span className="tuning-help" title="How many tokens are processed together. Larger values may be faster but use more memory.">?</span>
              <input className="input-field mt-1" type="number" min="32" max="2048" value={defaultParams.batch_size} onChange={e => setDefaultParams({ batch_size: Number(e.target.value) })} />
            </label>
            <label>Avoid repetition <span className="tuning-help" title="Helps prevent repeated words and repeated sentences. Keep this above 1.0.">?</span>
              <input className="input-field mt-1" type="number" step="0.01" min="1" max="1.6" value={defaultParams.repetition_penalty} onChange={e => setDefaultParams({ repetition_penalty: Number(e.target.value) })} />
            </label>
            <label>Answer variety <span className="tuning-help" title="Controls how many possible word choices are considered. Lower is more focused; higher is more varied.">?</span>
              <input className="input-field mt-1" type="number" step="0.01" min="0.1" max="1" value={defaultParams.top_p} onChange={e => setDefaultParams({ top_p: Number(e.target.value) })} />
            </label>
            <div className="md:col-span-5 flex flex-wrap gap-2 pt-1">
              <button onClick={applySpeedPreset} className="btn-secondary text-sm">Auto fast preset</button>
              <button onClick={applyQualityPreset} className="btn-secondary text-sm">Auto quality preset</button>
              <button onClick={resetDefaultParams} className="btn-secondary text-sm flex items-center gap-1"><RotateCcw className="w-4 h-4" /> Reset automatic defaults</button>
              <span className="text-xs text-surface-500 self-center">Runtime tip: GPU layers -1 lets PocketMind Hybrid AI decide. It tries full GPU, then CPU + GPU split, then CPU fallback.</span>
            </div>
          </div>
          </div>
        </div>
      )}

      {showCompareRewrite && FEATURE_FLAGS.diffViewer && (
        <div className="border-b border-surface-200 dark:border-surface-800 bg-white dark:bg-surface-950 p-4">
          <div className="max-w-5xl mx-auto space-y-3">
            <p className="text-sm font-bold">Compare rewrite vs last assistant message</p>
            <textarea
              value={compareOriginal}
              onChange={e => setCompareOriginal(e.target.value)}
              rows={4}
              placeholder="Paste original text to compare…"
              className="input-field w-full text-sm font-mono"
            />
            {compareOriginal && lastAssistantMessage ? (
              <DiffViewer original={compareOriginal} modified={lastAssistantMessage} />
            ) : (
              <p className="text-xs text-surface-500">Paste original text and ensure the chat has an assistant reply.</p>
            )}
          </div>
        </div>
      )}

      {!currentModel && (
        <div className="mx-4 mt-4 rounded-2xl border border-amber-300/60 bg-amber-50/90 dark:bg-amber-950/20 p-4 flex items-start gap-3 shadow-lg shadow-amber-500/5">
          <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 mt-0.5" />
          <div className="flex-1"><p className="font-semibold text-amber-800 dark:text-amber-300">No model selected</p><p className="text-sm text-amber-700 dark:text-amber-400">Open Models, import or scan a .gguf file, then choose Use in Chat.</p></div>
          <button onClick={() => setActiveView('models')} className="btn-secondary">Open Models</button>
        </div>
      )}

      {generationStatus && (
        <div className="mx-4 mt-4 rounded-2xl border border-primary-300/40 bg-primary-50/85 dark:bg-primary-950/20 p-3 text-sm text-primary-700 dark:text-primary-300 flex items-center gap-2 shadow-lg shadow-primary-500/5">
          <div className="w-2 h-2 rounded-full bg-current animate-pulse" /> {generationStatus}
        </div>
      )}

      {generationError && (
        <div className="mx-4 mt-4 rounded-2xl border border-red-300/50 bg-red-50/90 dark:bg-red-950/20 p-3 text-sm text-red-700 dark:text-red-300 flex items-start gap-2 shadow-lg shadow-red-500/5">
          <AlertCircle className="w-4 h-4 mt-0.5" /> <span>{generationError}</span>
        </div>
      )}

      <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
        {currentMessages.length === 0 && <div className="flex items-center justify-center h-32 text-surface-400 text-sm text-center">{currentModel ? 'Start a conversation below. Attach files when you want PocketMind Hybrid AI to use local document context.' : 'Select a model before sending your first message.'}</div>}

        {currentMessages.map((message) => (
          <div key={message.id} className={`group flex gap-3 sm:gap-4 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}>
            <div className={`w-9 h-9 rounded-xl flex-shrink-0 flex items-center justify-center ${message.role === 'user' ? 'bg-surface-200 dark:bg-surface-700' : 'bg-primary-500'}`}>
              {message.role === 'user' ? <User className="w-4 h-4 text-surface-700 dark:text-surface-200" /> : <Bot className="w-4 h-4 text-surface-950" />}
            </div>
            <div className={`flex-1 min-w-0 max-w-[min(52rem,100%)] ${message.role === 'user' ? 'text-right' : ''}`}>
              <div className={`inline-block chat-message-surface max-w-full rounded-xl px-4 py-3 text-left overflow-hidden ${message.role === 'user' ? 'bg-primary-600 text-white' : 'bg-white dark:bg-surface-900 text-surface-900 dark:text-surface-100 border border-surface-200 dark:border-surface-800' }`}>
                {message.role === 'assistant' ? (
                  <MarkdownMessage content={message.content || generationStatus || 'Starting local model...'} />
                ) : <MarkdownMessage content={message.content} variant="user" />}
              </div>
              {message.role === 'assistant' && message.content && (
                <div className="flex items-center gap-2 mt-2 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button onClick={() => handleCopy(message.content, message.id)} className="p-1.5 rounded-lg hover:bg-surface-100 dark:hover:bg-surface-800 transition-colors">
                    {copiedId === message.id ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-surface-400" />}
                  </button>
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-white/70 dark:border-surface-800/80 p-3 sm:p-4 glass-panel flex-shrink-0">
        <div className="max-w-4xl mx-auto space-y-2">
          {(attachments.length > 0 || attachmentNotice) && (
            <div className="rounded-2xl border border-white/70 dark:border-surface-800 bg-white/70 dark:bg-surface-900/60 p-2 shadow-lg shadow-primary-500/5">
              <div className="flex items-center justify-between gap-2 mb-2">
                <label className="flex items-center gap-2 text-xs text-surface-500"><input type="checkbox" checked={includeAttachments} onChange={e => setIncludeAttachments(e.target.checked)} /> Use indexed attachments in next message</label>
                {attachments.length > 0 && <button onClick={() => setAttachments([])} className="text-xs px-2 py-1 rounded-lg hover:bg-surface-200 dark:hover:bg-surface-800">Clear</button>}
              </div>
              {attachmentNotice && <p className="text-xs text-primary-500 mb-2 flex items-center gap-1"><Info className="w-3 h-3" /> {attachmentNotice}</p>}
              {attachments.length > 0 && includeAttachments && (
                <div className="flex flex-wrap gap-2 mb-2">
                  {[
                    ['Summarize', 'Summarize the attached document with clear headings and bullet points.'],
                    ['Key points', 'List the key points from the attached document.'],
                    ['Risks', 'Find the main risks, issues, or concerns mentioned in the attached document.'],
                    ['Explain', 'Explain the attached document in simple terms.']
                  ].map(([label, prompt]) => (
                    <button
                      key={label}
                      type="button"
                      onClick={() => { setInput(prompt); setIncludeAttachments(true); }}
                      className="text-[11px] px-2.5 py-1 rounded-full border border-primary-200/70 dark:border-primary-800/60 bg-primary-50/80 dark:bg-primary-950/30 text-primary-700 dark:text-primary-300 hover:bg-primary-100 dark:hover:bg-primary-900/50 transition-colors"
                      title={`Use indexed attachments: ${prompt}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              )}
              <div className="flex gap-2 overflow-x-auto pb-1">
                {attachments.map(a => (
                  <div key={a.path} className="shrink-0 max-w-[16rem] rounded-xl border border-surface-200 dark:border-surface-700 bg-white/70 dark:bg-surface-950/50 px-3 py-2 flex items-start gap-2">
                    <FileText className="w-4 h-4 mt-0.5 text-primary-500 shrink-0" />
                    <div className="min-w-0">
                      <div className="text-xs font-semibold truncate">{a.name}</div>
                      <div className="text-[11px] text-surface-500 truncate">{a.kind} • {mb(a.size_bytes)} • {a.chunk_count || a.chunks?.length || 1} section(s)</div>
                      <div className="text-[11px] text-surface-400 truncate">{compactChars(a.indexed_chars)} indexed</div>
                      {a.warnings?.length > 0 && <div className="text-[11px] text-amber-500 truncate">{a.warnings[0]}</div>}
                    </div>
                    <button onClick={() => removeAttachment(a.path)} className="p-0.5 rounded hover:bg-surface-200 dark:hover:bg-surface-800" title="Remove attachment"><X className="w-3.5 h-3.5" /></button>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="composer-shell flex items-end gap-2 sm:gap-3 p-2 sm:p-3">
            <button onClick={attachFiles} disabled={attachmentBusy} className="p-2 rounded-xl hover:bg-surface-200 dark:hover:bg-surface-700 transition-colors flex-shrink-0" title="Attach PDF, DOCX, text, code, spreadsheet, or image"><Paperclip className="w-5 h-5 text-surface-500" /></button>
            <textarea value={input} onChange={(e) => setInput(e.target.value)} onKeyDown={handleKeyDown} placeholder={currentModel ? 'Message PocketMind Hybrid AI...' : 'Select a model before chatting...'} rows={1} disabled={!currentModel || isGenerating} className="flex-1 bg-transparent border-none focus:outline-none resize-none py-2 max-h-32 text-surface-900 dark:text-surface-100 placeholder:text-surface-400 disabled:opacity-60" style={{ minHeight: '24px' }} />
            <button onClick={isGenerating ? stopGeneration : () => void handleSend()} disabled={!isGenerating && !canSend} className={`p-2 rounded-xl transition-all shadow-md ${isGenerating ? 'bg-red-600 hover:bg-red-500 text-white' : canSend ? 'bg-primary-500 hover:bg-primary-600 text-surface-950 shadow-primary-500/20' : 'bg-surface-200 dark:bg-surface-700 text-surface-400 cursor-not-allowed'}`} title={isGenerating ? 'Stop response' : !currentModel ? 'Select a model first' : 'Send'}>
              {isGenerating ? <Square className="w-5 h-5" /> : <Send className="w-5 h-5" />}
            </button>
          </div>
          <p className="text-xs text-center text-surface-400 mt-2">{currentModel?.startsWith('enterprise:') ? 'Organization server mode' : currentModel?.startsWith('remote:') ? 'Online API mode' : currentModel ? 'Local model selected • first response may take longer while the GGUF loads' : 'No model selected'} {attachments.length > 0 ? `• ${attachments.length} indexed attachment(s) ready` : ''}</p>
        </div>
      </div>
    </div>
  );
}
