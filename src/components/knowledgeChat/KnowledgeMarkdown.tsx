import { memo } from 'react';

import ReactMarkdown from 'react-markdown';

import remarkGfm from 'remark-gfm';

import { prepareKnowledgeDisplayMarkdown, type CitationHit } from '../../knowledgeChat/formatAnswer';

const KnowledgeMarkdown = memo(function KnowledgeMarkdown({
  content,
  citationHits = [],
  question = '',
  alreadyFormatted = false,
}: {
  content: string;
  citationHits?: CitationHit[];
  question?: string;
  /** When true, content was already formatKnowledgeAnswer'd at publish time. */
  alreadyFormatted?: boolean;
}) {
  const normalized = prepareKnowledgeDisplayMarkdown(content, citationHits, {
    question,
    alreadyFormatted,
    notFoundFallback: 'I could not find enough evidence in the selected folder index to answer this question reliably.',
  });

  return (
    <div className="nexus-markdown nexus-markdown-knowledge">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="nexus-kc-subsection">{children}</h1>,
          h2: ({ children }) => {
            const label = String(children).trim();
            const isKcSection = /^(Answer|Evidence|Explanation)$/i.test(label);
            return isKcSection
              ? <h2 className="nexus-kc-section">{children}</h2>
              : <h2 className="nexus-kc-subsection">{children}</h2>;
          },
          h3: ({ children }) => <h3 className="nexus-kc-subsection">{children}</h3>,
          h4: ({ children }) => <h4 className="nexus-kc-subsection">{children}</h4>,
          p: ({ children }) => <p className="nexus-kc-p">{children}</p>,
          strong: ({ children }) => <strong className="nexus-kc-strong">{children}</strong>,
          em: ({ children }) => <em className="nexus-kc-em">{children}</em>,
          ul: ({ children }) => <ul className="nexus-kc-ul">{children}</ul>,
          ol: ({ children }) => <ol className="nexus-kc-ol">{children}</ol>,
          li: ({ children }) => <li className="nexus-kc-li">{children}</li>,
          blockquote: ({ children }) => <blockquote className="nexus-kc-quote">{children}</blockquote>,
          hr: () => <hr className="nexus-kc-hr" />,
          code: ({ className, children, ...props }) => {
            const text = String(children ?? '');
            // react-markdown v9: bare ``` fences have no language- class; treat
            // multiline / classed nodes as blocks (extractive evidence uses bare fences).
            const isBlock = Boolean(className) || text.includes('\n');
            if (isBlock) {
              return (
                <code className={`nexus-kc-code-block ${className || ''}`} {...props}>
                  {children}
                </code>
              );
            }
            return <code className="nexus-kc-code" {...props}>{children}</code>;
          },
          pre: ({ children }) => <pre className="nexus-kc-pre">{children}</pre>,
          a: ({ children }) => (
            <span className="nexus-kc-p">{children}</span>
          ),
        }}
      >
        {normalized}
      </ReactMarkdown>
    </div>
  );
});

export default KnowledgeMarkdown;
