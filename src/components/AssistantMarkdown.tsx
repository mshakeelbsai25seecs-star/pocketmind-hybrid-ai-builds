import { memo, useState, isValidElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';
import { Check, Copy } from 'lucide-react';

function extractPlainText(node: ReactNode): string {
  if (node == null || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(extractPlainText).join('');
  if (isValidElement(node)) {
    const props = node.props as { children?: ReactNode };
    return extractPlainText(props?.children);
  }
  return '';
}

function isTinyCodeFragment(code: string): boolean {
  const t = code.trim();
  if (!t) return true;
  if (t.includes('\n')) return false;
  return t.length <= 64 && !/[;{}]/.test(t);
}

/** Prose that was wrongly parsed as a code block — never dump it into a dark code shell. */
function looksLikeMarkdownProse(code: string): boolean {
  const t = code.trim();
  if (!t) return false;
  return (
    /^#{1,6}\s/m.test(t)
    || /^---\s*$/m.test(t)
    || /^\*\*[^*\n]{2,}\*\*/m.test(t)
    || /^#{0,3}\s*Rule Behavior/im.test(t)
    || /Based on the .+ here's what/i.test(t)
  );
}

function looksLikeRealCode(code: string): boolean {
  const t = code.trim();
  if (!t) return false;
  if (looksLikeMarkdownProse(t)) return false;
  return (
    /[{};]|=>|:=/.test(t)
    || /^(import |from |def |class |function |const |let |var |#include|package |fn |pub )/m.test(t)
    || /<\/?[a-zA-Z][\w:-]*[\s/>]/.test(t)
  );
}

function shouldUseCodePanel(code: string, className?: string): boolean {
  if (isTinyCodeFragment(code)) return false;
  if (looksLikeMarkdownProse(code)) return false;
  if (/language-/.test(className || '')) return true;
  return looksLikeRealCode(code);
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
      <pre className="nexus-code-pre">
        <code className={language ? `language-${language}` : undefined}>{code}</code>
      </pre>
    </div>
  );
}

function lightNormalize(text: string): string {
  if (!text) return '';
  return text
    // Escape raw XML/HTML tags in prose so they don't break Markdown parsing
    // (e.g. `<Remediation/>` from vendor XML rules).
    .replace(/(^|[^`])<([A-Za-z][\w.-]*)([^>`]*?)\/>/g, '$1`<$2$3/>`')
    .replace(/```\s*([a-zA-Z0-9_+#.-]+)\s*\n/g, '```$1\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const markdownComponents = {
  h1: ({ children }: { children?: ReactNode }) => <h1 className="nexus-md-h1">{children}</h1>,
  h2: ({ children }: { children?: ReactNode }) => <h2 className="nexus-md-h2">{children}</h2>,
  h3: ({ children }: { children?: ReactNode }) => <h3 className="nexus-md-h3">{children}</h3>,
  h4: ({ children }: { children?: ReactNode }) => <h4 className="nexus-md-h4">{children}</h4>,
  p: ({ children }: { children?: ReactNode }) => <p className="nexus-md-p">{children}</p>,
  strong: ({ children }: { children?: ReactNode }) => <strong className="nexus-md-strong">{children}</strong>,
  em: ({ children }: { children?: ReactNode }) => <em className="nexus-md-em">{children}</em>,
  ul: ({ children }: { children?: ReactNode }) => <ul className="nexus-md-ul">{children}</ul>,
  ol: ({ children }: { children?: ReactNode }) => <ol className="nexus-md-ol">{children}</ol>,
  li: ({ children }: { children?: ReactNode }) => <li className="nexus-md-li">{children}</li>,
  blockquote: ({ children }: { children?: ReactNode }) => (
    <blockquote className="nexus-md-quote">{children}</blockquote>
  ),
  a: ({ children, href }: { children?: ReactNode; href?: string }) => (
    <a
      className="nexus-md-link"
      href={href}
      target="_blank"
      rel="noreferrer"
      title={href || undefined}
    >
      {children}
    </a>
  ),
  table: ({ children }: { children?: ReactNode }) => (
    <div className="nexus-md-table-wrap">
      <table className="nexus-md-table">{children}</table>
    </div>
  ),
  th: ({ children }: { children?: ReactNode }) => <th className="nexus-md-th">{children}</th>,
  td: ({ children }: { children?: ReactNode }) => <td className="nexus-md-td">{children}</td>,
  hr: () => <hr className="nexus-md-hr" />,
  code: (props: { className?: string; children?: ReactNode }) => {
    const { className: codeClass, children, ...rest } = props;
    const rawCode = extractPlainText(children);
    const match = /language-([\w+#.-]+)/.exec(codeClass || '');
    const language = match?.[1] || '';
    const plainCode = rawCode.trim();
    if (!plainCode) return null;

    // react-markdown v9 dropped `inline`; only use the dark code shell for real code.
    if (!shouldUseCodePanel(plainCode, codeClass)) {
      // If a huge prose blob was mis-classified as code, render it as Markdown again
      // without allowing another code-shell pass (plain text fallback for safety).
      if (plainCode.includes('\n') && looksLikeMarkdownProse(plainCode)) {
        return (
          <div className="space-y-2">
            {plainCode.split(/\n{2,}/).map((para, i) => (
              <p key={i} className="nexus-md-p whitespace-pre-wrap">
                {para}
              </p>
            ))}
          </div>
        );
      }
      return (
        <code className="nexus-inline-code" {...rest}>
          {plainCode}
        </code>
      );
    }
    return <CopyableCodeBlock language={language} code={rawCode} />;
  },
  pre: ({ children }: { children?: ReactNode }) => <>{children}</>,
};

/** Shared Markdown renderer for assistant answers (Chat + PocketCode). */
const AssistantMarkdown = memo(function AssistantMarkdown({
  content,
  className = '',
}: {
  content: string;
  className?: string;
}) {
  const normalized = lightNormalize(content);
  if (!normalized) return null;

  return (
    <div className={`nexus-markdown nexus-markdown-assistant ${className}`.trim()}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
});

export default AssistantMarkdown;
