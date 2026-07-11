/** Post-process grounded Knowledge Chat answers for clean Markdown display. */

export type CitationHit = {
  file_name: string;
  sectionLabel: string;
  line_start?: number;
  line_end?: number;
  page_start?: number;
  page_end?: number;
};

export type FormatAnswerOptions = {
  question?: string;
  notFoundFallback?: string;
  /** When true, skip heuristic low-quality rewrite (use for structured/evidence answers). */
  skipQualityGate?: boolean;
  /** Prefer this citation when the answer body has no [Source: …] tag. */
  preferredCitation?: CitationHit;
  /** Demo cheatsheet mode: enforce one-line Answer + line citations. */
  demoMode?: boolean;
};

const UNWANTED_LEAD_PATTERNS = [
  /^\s*\*{0,2}\s*retrieval confidence\s*:?\s*\*{0,2}\s*[^\n]*\n+/i,
  /^\s*\*{0,2}\s*evidence insufficiency[^*\n]*\*{0,2}\s*\n+/i,
  /^\s*confidence\s*:\s*(high|medium|low|partial|none)[^\n]*\n+/i,
];

const PROMPT_LEAK_PATTERNS = [
  /\boutput format\b/i,
  /\bcitation guide\b/i,
  /\bretrieval instructions?\b/i,
  /\bmarkdown utilization\b/i,
  /\bwriters should\b/i,
  /\bcompany data intake\b/i,
  /\bfull indexing\b/i,
  /\bdo not introduce new elements\b/i,
  /\bconfined exclusively to contents found under\b/i,
  /\bnever fabricate unsupported\b/i,
  /\bsoc offline\b/i,
  /\breimport data after processing\b/i,
];

const TOPIC_PATTERNS = [
  /\bAction Plan Purpose\b/i,
  /\bKnowledge Sharing(?:\s+Initiatives?)?\b/i,
  /\bpost-?mortem analyses?\b/i,
  /\bLesson Learning\b/i,
  /\bPage\s+\d+\b/i,
];

const FILE_TOKENS = ['policies', 'policy', 'ocr', 'handbook', 'index', 'intake', 'notes'];

export function prepareKnowledgeDisplayMarkdown(
  text: string,
  citationHits: CitationHit[] = [],
  options: Omit<FormatAnswerOptions, 'skipQualityGate'> = {},
): string {
  return formatKnowledgeAnswer(text, citationHits, { ...options, skipQualityGate: true });
}

export function isListStyleQuestion(question: string): boolean {
  return /\b(list|enumerate|\d+\s+(company\s+)?polic(y|ies)|top\s+\d+|tell me about \d+)\b/i.test(question)
    || /\bwhat are the (\d+|three|four|five)\b/i.test(question)
    || /\b\d+\s+layers?\b/i.test(question);
}

export function isConciseQuestion(question: string): boolean {
  return /\b(concise(ly)?|brief(ly)?|short( answer)?|in one sentence|summarize)\b/i.test(question);
}

export function isStructuredKnowledgeAnswer(text: string): boolean {
  return /^##\s+Evidence\b/m.test(text);
}

export function unescapeLlmLiterals(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\\n\\n/g, '\n\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, ' ')
    .replace(/\]\s*n(?=[A-Z])/g, ']\n\n');
}

function collapseInlineWhitespace(text: string): string {
  return text
    .split('\n')
    .map(line => line.replace(/[ \t]{2,}/g, ' ').trimEnd())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n');
}

export function formatKnowledgeAnswer(
  text: string,
  citationHits: CitationHit[] = [],
  options: FormatAnswerOptions = {},
): string {
  if (!text) return '';

  let out = unescapeLlmLiterals(text).trim();

  for (const pattern of UNWANTED_LEAD_PATTERNS) {
    out = out.replace(pattern, '');
  }

  out = stripMetaCommentary(out);
  out = normalizeStructuredAnswerMarkdown(out);
  out = stripProseSourceArtifacts(out);
  out = normalizeListItems(out);
  out = normalizeShorthandCitations(out, citationHits);
  out = normalizeCitations(out, citationHits);
  if (!isStructuredKnowledgeAnswer(out)) {
    out = consolidateCitations(out, citationHits, options.question, options.preferredCitation);
  }
  out = stripPlaceholderUrls(out);
  out = stripProseSourceArtifacts(out);
  out = stripMultiSourceNoise(out);

  if (options.question && isListStyleQuestion(options.question)) {
    out = restructureAsNumberedList(out);
  }

  out = out
    .replace(/\[([^\]]+)\]\(\s*#?\s*\)/g, '$1')
    .replace(/\(\s*\[[^\]]+\]\([^)]*\)\s*,\s*[^)]+\)/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (!options.skipQualityGate && !isStructuredKnowledgeAnswer(out) && isLowQualityAnswer(out)) {
    return options.notFoundFallback
      || 'I could not find enough evidence in the selected folder index to answer this question reliably.';
  }

  if (options.demoMode) {
    out = enforceDemoAnswerShape(out);
  }

  if (options.question && isConciseQuestion(options.question) && !isStructuredKnowledgeAnswer(out)) {
    out = truncateToConcise(out, 420);
  }

  return out;
}

function normalizeStructuredAnswerMarkdown(text: string): string {
  let out = unescapeLlmLiterals(text);

  // Section headings must start on their own line (prevents mid-paragraph color jumps).
  out = out.replace(/([^\n#])\s*(##\s+(?:Answer|Evidence|Explanation)\b)/gi, '$1\n\n$2');

  // LLM sometimes glues ". ## Explanation" or ". Explanation" without a heading break.
  out = out.replace(/\.\s+(##\s+Explanation\b)/gi, '.\n\n$1');
  out = out.replace(/\.\s+(Explanation)\s*$/gim, '.\n\n## $1');

  // Broken underscore "emphasis" artifacts (_ ., _ _, trailing _.)
  out = out.replace(/_\s+\./g, '.');
  out = out.replace(/_\s+_/g, ' ');
  out = out.replace(/\s+_\s*([,.;:!?])/g, '$1');
  out = out.replace(/([^\s`])_\s*$/gm, '$1');

  // Panel already labels the bubble "Answer"; drop redundant heading.
  out = out.replace(/^##\s+Answer\s*\n+/im, '');

  return out.replace(/\n{3,}/g, '\n\n').trim();
}

function enforceDemoAnswerShape(text: string): string {
  let out = normalizeStructuredAnswerMarkdown(text);
  const answerMatch = out.match(/^##\s+Answer\s*\n+([\s\S]*?)(?=\n##\s+(?:Evidence|Explanation)\b|$)/im);
  if (answerMatch) {
    const body = answerMatch[1].replace(/\s+/g, ' ').trim();
    const firstSentence = body.match(/^[^.!?]+[.!?]/)?.[0]?.trim() || body.split(/\n/)[0]?.trim() || body;
    out = out.replace(answerMatch[0], `## Answer\n\n${firstSentence}`);
  }
  if (!/^##\s+Evidence\b/im.test(out) && /\[Source:[^\]]+\]/i.test(out)) {
    const cite = out.match(/\[Source:[^\]]+\]/i)?.[0] || '';
    const body = out.replace(/\[Source:[^\]]+\]/gi, '').trim();
    out = `## Answer\n\n${body}\n\n## Evidence\n\n${cite}`;
  }
  return out.trim();
}

function stripMultiSourceNoise(text: string): string {
  let out = unescapeLlmLiterals(text);

  if (/\[source[^\]]*\]/i.test(out)) {
    const paragraphs = out.split(/\n\n+/);
    const useful = paragraphs.filter(part => !/\b(does not provide|not provide|no relevant|no direct reference)\b/i.test(part));
    if (useful.length > 0 && useful.length < paragraphs.length) {
      out = useful.join('\n\n');
    }
  }

  const properCitation = out.match(/\[Source:[^\]]+\]/i);
  if (properCitation && out.length > 500) {
    const citeIdx = out.indexOf(properCitation[0]);
    const before = out.slice(0, citeIdx + properCitation[0].length);
    const tail = out.slice(citeIdx + properCitation[0].length);
    if (/\[source[^\]]*\]/i.test(tail) || /\bThis source does not\b/i.test(tail)) {
      out = before.trim();
    }
  }

  return out.trim();
}

function stripProseSourceArtifacts(text: string): string {
  const out = text
    .replace(/\bAccording to\s+Source\s+\d+[^[\n.]*/gi, '')
    .replace(/\bAccording to\s+Source\s+\d+\s*[-–—][^[\]]+(?=\[Source:|\s*$)/gi, '')
    .replace(/\bfrom\s+source\s+(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s*(?:["'][^"']*["']|\.\.\.)?/gi, '')
    .replace(/\bNo other sources provided[^.]*\./gi, '')
    .replace(/,\s*""\.[\s\S]*$/g, '.')
    .replace(/,\s*""[\s\S]*$/g, '')
    .replace(/Furthermore,\s*"\[\.\.\.\][\s\S]*$/gi, '')
    .replace(/"\[\.\.\.\][^"]*"[\s\S]*$/g, '')
    .replace(/\[\.\.\.\]/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/page greater than page number twenty[- ]?seven/gi, 'Page 27')
    .replace(/\s+([,.;:!?])/g, '$1');
  return collapseInlineWhitespace(out).trim();
}

function stripMetaCommentary(text: string): string {
  return text
    .replace(/\*?Given (?:only |limitations|constraints)[\s\S]*$/i, '')
    .replace(/\*?Due to constraints[\s\S]*$/i, '')
    .replace(/\*?Note:\s*(?:Given|Due to|limitations|constraints)[\s\S]*$/i, '')
    .replace(/\*Given limitations[\s\S]*$/i, '')
    .replace(/Written by [A-Za-z .]+ from [A-Za-z .]+,?\s*/gi, '')
    .replace(/\bSource\(\d+\)\b/g, '')
    .replace(/\bhowever, no explicit mention[\s\S]*?(?=\[Source:|$)/gi, '')
    .replace(/\bit cannot conclusively answer[\s\S]*?(?=\[Source:|$)/gi, '')
    .replace(/\bwithout speculation[\s\S]*?(?=\[Source:|$)/gi, '')
    .replace(/\bTherefore\.\.\.\s*/gi, '')
    .trim();
}

function isLowQualityAnswer(text: string): boolean {
  if (isStructuredKnowledgeAnswer(text)) return false;
  const leakHits = PROMPT_LEAK_PATTERNS.filter(pattern => pattern.test(text)).length;
  if (leakHits >= 2) return true;
  if (/\bAccording to Source\s+\d+\b/i.test(text)) return true;
  if (/\bno direct mention regarding\b/i.test(text)) return true;
  if (/\bfrom source (?:one|two|three|\d+)\b/i.test(text)) return true;
  if (/\[\.\.\.\]/i.test(text)) return true;
  if (/\[[^\]]*source\s*L\d+[^\]]*\]/i.test(text)) return true;
  if (/https?:\/\/nexusaicorpuscollection/i.test(text)) return true;
  if (/\\n\\n/.test(text)) return true;
  if (/\[source[^\]]*\]/i.test(text) && text.length > 420) return true;
  if (/\bThis source does not provide\b/i.test(text)) return true;
  if (/,\s*""/.test(text)) return true;
  if (/\bdoes not explicitly detail\b/i.test(text)) return true;
  if (/\bNo other sources provided\b/i.test(text)) return true;
  if (/\bemployee termination\b/i.test(text)
    && /\b(rebuild|eradication|hardened network|restoration process|network environment)\b/i.test(text)) {
    return true;
  }
  if (/\bno explicit details\b/i.test(text) && /\bno direct mention\b/i.test(text)) return true;
  if (text.length > 650 && /\b(cannot conclusively|inference can suggest|outside given materials|incomplete snippets|can be infered)\b/i.test(text)) {
    return true;
  }
  if (text.length > 900 && leakHits >= 1) return true;
  return false;
}

function truncateToConcise(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const cite = text.match(/\[\s*Source:[^\]]+\]/i)?.[0] || '';
  const body = text.replace(/\[\s*Source:[^\]]+\]/gi, '').trim();
  const sentences = body.split(/(?<=[.!?])\s+/).filter(Boolean);
  let compact = sentences.slice(0, 2).join(' ').trim();
  if (compact.length > maxChars - cite.length - 4) {
    compact = `${compact.slice(0, maxChars - cite.length - 8).trim()}…`;
  }
  return cite ? `${compact} ${cite}`.trim() : compact;
}

function normalizeListItems(text: string): string {
  return text
    .replace(/^(\s*\d+)\\\.(\s*)/gm, '$1.$2')
    .replace(/^(\s*\d+)\.\s*"+\s*(\*\*)/gm, '$1. $2')
    .replace(/^(\s*\d+)\.\s*"+\s*/gm, '$1. ')
    .replace(/^(\s*\d+)\.\s*"([^*\n])/gm, '$1. $2')
    .replace(/^(\s*\d+)\.\s*"\s*$/gm, '$1.');
}

function wordOrNumberToIndex(value: string): number {
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  const lower = value.toLowerCase().trim();
  if (/^\d+$/.test(lower)) return parseInt(lower, 10);
  return words[lower] || 1;
}

function normalizeShorthandCitations(text: string, citationHits: CitationHit[]): string {
  let out = text
    .replace(/\[\/?\s*source\s*\]/gi, '')
    .replace(/\[\/?SOURCE\s*\]/gi, '');

  const mapRank = (rankRaw: string): string => {
    const idx = Math.max(0, wordOrNumberToIndex(rankRaw) - 1);
    const hit = citationHits[idx];
    if (!hit) return '';
    return `[Source: ${hit.file_name} | ${simplifySectionLabel(hit.sectionLabel)}]`;
  };

  out = out.replace(/\[(?:source|src)\s*(\d+)\]/gi, (_m, rank) => mapRank(rank));
  out = out.replace(/\[Source(\d+)\]/gi, (_m, rank) => mapRank(rank));

  return collapseInlineWhitespace(out).trim();
}

function consolidateCitations(text: string, citationHits: CitationHit[], question?: string, preferred?: CitationHit): string {
  if (question && isListStyleQuestion(question)) return text;
  const citePattern = /\[\s*Source:[^\]]+\]/gi;
  const cites = [...new Set(text.match(citePattern) || [])];
  if (cites.length === 0) {
    const preferredHit = preferred || citationHits[0];
    if (!preferredHit) return collapseInlineWhitespace(text);
    cites.push(`[Source: ${preferredHit.file_name} | ${simplifySectionLabel(preferredHit.sectionLabel)}]`);
  } else if (cites.length === 1) {
    const cite = cites[0];
    const onlyAtEnd = text.trimEnd().endsWith(cite.trim())
      && text.indexOf(cite) === text.lastIndexOf(cite);
    if (onlyAtEnd) return collapseInlineWhitespace(text);
  }

  let body = text.replace(citePattern, '\n');
  body = collapseInlineWhitespace(body).trim();

  return `${body}\n\n${cites.join(' ')}`.trim();
}

function stripPlaceholderUrls(text: string): string {
  const out = text
    .replace(/\(\s*https?:\/\/example[^\s)]*\s*\)/gi, '')
    .replace(/\(\s*https?:\/\/nexusaicorpuscollection[^\s)]*\s*\)/gi, '')
    .replace(/\bhttps?:\/\/example[^\s)]+/gi, '')
    .replace(/\bhttps?:\/\/nexusaicorpuscollection[^\s)]+/gi, '')
    .replace(/\[[^\]]*source\s*L\d+[^\]]*\]/gi, '')
    .trim();
  return collapseInlineWhitespace(out);
}

function normalizeCitations(text: string, citationHits: CitationHit[]): string {
  let out = text.replace(
    /\[\s*Source\s*:\s*([^|\]]+?)(?:\s*\|\s*([^\]]+?))?\s*\]/gi,
    (_m, file, section) => formatCitation(String(file), section ? String(section) : null, citationHits),
  );

  out = out.replace(
    /\[\s*Source\s*:\s*([^,\]|]+?)\s*,\s*([^\]]+?)\s*\]/gi,
    (_m, file, section) => formatCitation(String(file), String(section), citationHits),
  );

  out = out.replace(
    /\[\s*Source\s*:\s*['"]?([^'\]|,\n]+?)['"]?\s*\]/gi,
    (_m, file) => formatCitation(String(file), null, citationHits),
  );

  return out.replace(/(\[Source:[^\]]+\])\s*(?:\1\s*)+/g, '$1 ');
}

function formatCitation(rawFile: string, rawSection: string | null, citationHits: CitationHit[]): string {
  const knownFiles = [...new Set(citationHits.map(hit => hit.file_name))];
  const file = resolveFileName(rawFile, knownFiles);
  const fileHits = citationHits.filter(hit => hit.file_name === file);
  const pool = fileHits.length ? fileHits : citationHits;

  let section = rawSection ? humanizeSection(rawSection, pool) : null;
  if (!section || isGarbageSection(section)) {
    section = bestSectionMatch(rawSection || rawFile, pool)
      || inferTopicFromChunkText(rawSection || rawFile)
      || pool[0]?.sectionLabel
      || 'Section';
  }

  return `[Source: ${file} | ${simplifySectionLabel(section)}]`;
}

function isGarbageSection(section: string): boolean {
  if (section.length > 72) return true;
  if (!section.includes(' ') && section.length > 22) return true;
  if (/[&]{1,}|documentcomponent|themetings|unautranced|billionary|full indexing|next steps for/i.test(section)) {
    return true;
  }
  return false;
}

function normalizeKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/^polices/, 'policies')
    .replace(/^polcies/, 'policies')
    .replace(/[^a-z0-9]/g, '');
}

function resolveFileName(raw: string, knownFiles: string[]): string {
  const cleaned = raw.replace(/^['"]|['"]$/g, '').trim();
  if (!cleaned) return knownFiles[0] || cleaned;

  const key = normalizeKey(cleaned);
  let best = knownFiles[0] || cleaned;
  let bestScore = 0;

  for (const file of knownFiles) {
    const fileKey = normalizeKey(file);
    let score = 0;
    if (fileKey === key) return file;
    if (fileKey.includes(key) || key.includes(fileKey)) {
      score = Math.min(fileKey.length, key.length) / Math.max(fileKey.length, key.length);
    }
    for (const token of FILE_TOKENS) {
      if (key.includes(token) && fileKey.includes(token)) score += 0.18;
    }
    if (score > bestScore) {
      bestScore = score;
      best = file;
    }
  }

  if (bestScore >= 0.35) return best;
  if (/\.(md|markdown|txt)$/i.test(cleaned)) return cleaned;
  return knownFiles[0] || `${cleaned}.md`;
}

function humanizeSection(raw: string, citationHits: CitationHit[]): string {
  const trimmed = raw.trim();
  if (!trimmed) return citationHits[0]?.sectionLabel || 'Section';

  const fromHits = bestSectionMatch(trimmed, citationHits);
  if (fromHits) return fromHits;

  const topic = inferTopicFromChunkText(trimmed);
  if (topic) return topic;

  return splitCamelCase(trimmed);
}

function bestSectionMatch(mangled: string, citationHits: CitationHit[]): string | null {
  const key = normalizeKey(mangled);
  let best: string | null = null;
  let bestScore = 0;

  for (const hit of citationHits) {
    const sectionKey = normalizeKey(hit.sectionLabel);
    let score = 0;
    if (sectionKey === key) return hit.sectionLabel;
    if (sectionKey.includes(key) || key.includes(sectionKey)) {
      score = Math.min(sectionKey.length, key.length) / Math.max(sectionKey.length, key.length);
    }
    for (const token of FILE_TOKENS) {
      if (key.includes(token) && sectionKey.includes(token)) score += 0.12;
    }
    if (key.includes('actionplan') && sectionKey.includes('actionplan')) score += 0.5;
    if (key.includes('termination') && sectionKey.includes('termination')) score += 0.5;
    if (key.includes('intake') && sectionKey.includes('intake')) score += 0.4;
    if (score > bestScore) {
      bestScore = score;
      best = hit.sectionLabel;
    }
  }

  return bestScore >= 0.35 ? best : null;
}

function splitCamelCase(value: string): string {
  return value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/_/g, ' ')
    .replace(/&/g, ' and ')
    .replace(/\s+/g, ' ')
    .trim();
}

function restructureAsNumberedList(text: string): string {
  if (/^\s*\d+\.\s+\*\*/m.test(text)) return text;

  const citationPattern = /\[\s*Source:[^\]]+\]/gi;
  const citations = text.match(citationPattern);
  if (!citations || citations.length < 2) return text;

  const chunks = text.split(/(?=\[\s*Source\s*:)/i).map(part => part.trim()).filter(Boolean);
  if (chunks.length < 2) return text;

  let intro: string | null = null;
  if (!/^\[\s*Source\s*:/i.test(chunks[0])) {
    intro = chunks.shift() || null;
  }

  const items = chunks.map((chunk, index) => {
    const cite = chunk.match(citationPattern)?.[0] || '';
    let body = chunk.replace(citationPattern, '').trim();
    const bold = body.match(/\*\*([^*]+)\*\*/);
    if (bold) {
      body = body.replace(/^\*\*[^*]+\*\*\s*[-—]?\s*/, '').trim();
      return `${index + 1}. **${bold[1].trim()}** — ${body} ${cite}`.trim();
    }
    const title = inferTopicFromChunkText(body) || body.split(/[.!?]/)[0]?.trim();
    if (title && title.length <= 64) {
      const rest = body.slice(title.length).replace(/^[.!?]\s*/, '').trim();
      return `${index + 1}. **${title}**${rest ? ` — ${rest}` : ''} ${cite}`.trim();
    }
    return `${index + 1}. ${body} ${cite}`.trim();
  });

  return [intro, ...items].filter(Boolean).join('\n\n');
}

export function inferTopicFromChunkText(text: string): string | null {
  const flat = splitCamelCase(text.replace(/\s+/g, ' ').trim());
  for (const pattern of TOPIC_PATTERNS) {
    const match = flat.match(pattern);
    if (match) return match[0].slice(0, 80);
  }
  return null;
}

export function cleanSnippetPreview(text: string): string {
  const lines = text.split('\n').filter((line) => {
    const trimmed = line.trim();
    if (!trimmed) return false;
    if (trimmed.startsWith('#')) return false;
    if (/^generated:/i.test(trimmed)) return false;
    if (/^source pdf:/i.test(trimmed)) return false;
    return true;
  });

  const body = (lines.length ? lines.join(' ') : text).replace(/\s+/g, ' ').trim();

  return body
    .replace(/^\s*nt\s+(?=Company)/i, 'In the ')
    .replace(/^\s*nl\s+(?=[A-Z])/i, 'The ')
    .replace(/^\s*i\s+(?=Company)/i, 'In the ')
    .replace(/Written by [A-Za-z .]+ from [A-Za-z .]+,?\s*/gi, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

export function simplifySectionLabel(label: string): string {
  return label
    .replace(/^H\d+\s*>\s*/i, '')
    .replace(/^Page\s*>\s*Page\s*/i, 'Page ')
    .replace(/^Page\s*>\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function retrievalStatusLabel(
  confidence: 'high' | 'medium' | 'low' | 'none',
  answerMode: 'found' | 'partial' | 'evidence' | 'not_found',
): string {
  if (answerMode === 'evidence') return 'Answer from indexed source excerpts';
  if (answerMode === 'not_found' || confidence === 'none') {
    return 'No strong matches in the indexed folder';
  }
  if (confidence === 'high') return 'Strong matches in the indexed folder';
  if (confidence === 'medium') return 'Relevant matches in the indexed folder';
  return 'Partial matches — answer may be incomplete';
}
