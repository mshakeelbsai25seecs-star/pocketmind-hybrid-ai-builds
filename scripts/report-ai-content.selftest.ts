import {
  AI_CONTENT_REPORT_EMAIL,
  buildAiContentReportClipboard,
  buildAiContentReportMailto,
  truncateForReport,
} from '../src/reportAiContent.ts';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) {
    console.error(msg);
    process.exit(1);
  }
}

const excerpt = 'A'.repeat(2000);
const truncated = truncateForReport(excerpt, 100);
assert(truncated.includes('[truncated]'), 'truncate should mark truncation');
assert(truncated.length <= 100, 'truncate should respect maxChars');

const mailto = buildAiContentReportMailto({
  reason: 'inappropriate',
  details: 'Looks unsafe',
  contentExcerpt: 'Bad AI output example',
  sourceLabel: 'Chat',
  contentKind: 'text',
});
assert(mailto.startsWith(`mailto:${AI_CONTENT_REPORT_EMAIL}?`), 'mailto must target support inbox');
assert(mailto.includes('subject='), 'mailto must include subject');
assert(mailto.includes('body='), 'mailto must include body');
assert(decodeURIComponent(mailto).includes('Report AI content'), 'mailto subject should mention report');

const clipboard = buildAiContentReportClipboard({
  reason: 'harmful',
  details: '',
  contentExcerpt: 'Harmful advice',
  sourceLabel: 'Image Studio',
  contentKind: 'image',
});
assert(clipboard.includes(AI_CONTENT_REPORT_EMAIL), 'clipboard text must include support email');
assert(clipboard.includes('Image Studio'), 'clipboard text must include source');
assert(clipboard.includes('Harmful advice'), 'clipboard text must include excerpt');

console.log('report-ai-content ok');
