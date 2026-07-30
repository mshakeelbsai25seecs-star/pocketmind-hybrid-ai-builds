import { useEffect, useMemo, useState } from 'react';
import hljs from 'highlight.js/lib/core';
import javascript from 'highlight.js/lib/languages/javascript';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import json from 'highlight.js/lib/languages/json';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import java from 'highlight.js/lib/languages/java';
import kotlin from 'highlight.js/lib/languages/kotlin';
import go from 'highlight.js/lib/languages/go';
import c from 'highlight.js/lib/languages/c';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import bash from 'highlight.js/lib/languages/bash';
import sql from 'highlight.js/lib/languages/sql';
import yaml from 'highlight.js/lib/languages/yaml';
import markdown from 'highlight.js/lib/languages/markdown';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Eye, Code2, FileCode2 } from 'lucide-react';
import 'highlight.js/styles/github-dark.min.css';

hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('jsx', javascript);
hljs.registerLanguage('tsx', typescript);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('html', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('json', json);
hljs.registerLanguage('python', python);
hljs.registerLanguage('rust', rust);
hljs.registerLanguage('java', java);
hljs.registerLanguage('kotlin', kotlin);
hljs.registerLanguage('go', go);
hljs.registerLanguage('c', c);
hljs.registerLanguage('cpp', cpp);
hljs.registerLanguage('csharp', csharp);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('shell', bash);
hljs.registerLanguage('sql', sql);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('yml', yaml);
hljs.registerLanguage('markdown', markdown);
hljs.registerLanguage('md', markdown);

function extOf(path: string): string {
  const base = path.replace(/\\/g, '/').split('/').pop() || '';
  const dot = base.lastIndexOf('.');
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
}

function languageForPath(path: string): string {
  const ext = extOf(path);
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    rs: 'rust',
    py: 'python',
    java: 'java',
    kt: 'kotlin',
    kts: 'kotlin',
    go: 'go',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    css: 'css',
    scss: 'css',
    html: 'html',
    htm: 'html',
    xml: 'xml',
    svg: 'xml',
    sh: 'bash',
    bash: 'bash',
    ps1: 'bash',
    sql: 'sql',
    yml: 'yaml',
    yaml: 'yaml',
    md: 'markdown',
    mdx: 'markdown',
    toml: 'yaml',
  };
  return map[ext] || 'plaintext';
}

function isMarkdownPath(path: string): boolean {
  const ext = extOf(path);
  return ext === 'md' || ext === 'mdx' || ext === 'markdown';
}

/** Strip PocketCode read headers so the preview looks like a real editor. */
function stripReadHeader(raw: string): { body: string; meta: string | null; rangeLabel: string | null } {
  const match = raw.match(/^\/\/ PocketCode read:[^\n]*\n/);
  if (!match) return { body: raw, meta: null, rangeLabel: null };
  const meta = match[0].replace(/^\/\/\s*/, '').trim();
  const range = meta.match(/lines\s+(\d+)\s*-\s*(\d+)/i);
  const rangeLabel = range ? `${range[1]}–${range[2]}` : null;
  return { body: raw.slice(match[0].length), meta, rangeLabel };
}

function relativeDisplayPath(workspaceRoot: string, filePath: string): string {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const root = norm(workspaceRoot);
  let file = norm(filePath);
  file = file.replace(/^\/\/\?\//, '').replace(/^\/\?\//, '');
  const rootBare = root.replace(/^\/\/\?\//, '').replace(/^\/\?\//, '');
  if (rootBare && file.toLowerCase().startsWith(`${rootBare.toLowerCase()}/`)) {
    return file.slice(rootBare.length + 1);
  }
  if (file.startsWith('./')) return file.slice(2);
  if (!/^[a-zA-Z]:\//.test(file) && !file.startsWith('//')) return file.replace(/^\//, '');
  const parts = file.split('/');
  return parts[parts.length - 1] || file;
}

function breadcrumbParts(relPath: string): string[] {
  return relPath.split('/').filter(Boolean);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

export default function FilePreviewPane({
  workspaceRoot,
  filePath,
  content,
  error,
}: {
  workspaceRoot: string;
  filePath: string | null;
  content: string;
  error: string | null;
}) {
  const relPath = filePath ? relativeDisplayPath(workspaceRoot, filePath) : '';
  const crumbs = filePath ? breadcrumbParts(relPath) : [];
  const markdown = filePath ? isMarkdownPath(filePath) : false;
  const [mdMode, setMdMode] = useState<'preview' | 'code'>('preview');

  useEffect(() => {
    if (markdown) setMdMode('preview');
  }, [filePath, markdown]);

  const { body, meta, rangeLabel } = useMemo(() => stripReadHeader(content || ''), [content]);
  const language = filePath ? languageForPath(filePath) : 'plaintext';
  const langLabel = markdown ? 'md' : language === 'typescript' ? 'ts' : language === 'javascript' ? 'js' : language;
  const lineCount = useMemo(() => (body.length ? body.split('\n').length : 1), [body]);

  const highlighted = useMemo(() => {
    if (!body) return '';
    try {
      if (language !== 'plaintext' && hljs.getLanguage(language)) {
        return hljs.highlight(body, { language, ignoreIllegals: true }).value;
      }
      return hljs.highlightAuto(body).value;
    } catch {
      return escapeHtml(body);
    }
  }, [body, language]);

  if (error) {
    return <p className="p-4 text-sm text-red-600 dark:text-red-400">{error}</p>;
  }

  if (!filePath) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-2 text-sm text-surface-400 p-8 text-center bg-[#0d1117]">
        <FileCode2 className="w-8 h-8 opacity-50" />
        <p>Select a file to preview it here.</p>
        <p className="text-xs text-surface-500 max-w-sm">
          Markdown opens in preview mode. Source files get syntax coloring. Paths are shown relative to the project root.
        </p>
      </div>
    );
  }

  return (
    <div className="h-full min-h-0 flex flex-col bg-[#0d1117] text-surface-100">
      <div
        className="flex-shrink-0 h-8 border-b border-white/10 px-2.5 flex items-center gap-1.5 min-w-0 bg-[#161b22]"
        title={meta ? `${relPath}\n${meta}` : relPath}
      >
        <div className="min-w-0 flex-1 flex items-center gap-1 text-[11px] overflow-hidden whitespace-nowrap">
          {crumbs.map((part, i) => (
            <span key={`${part}-${i}`} className="inline-flex items-center gap-1 min-w-0">
              {i > 0 && <span className="text-surface-600 shrink-0">›</span>}
              <span
                className={
                  i === crumbs.length - 1
                    ? 'text-surface-50 font-medium truncate'
                    : 'text-surface-500 truncate max-w-[7rem]'
                }
              >
                {part}
              </span>
            </span>
          ))}
        </div>
        {rangeLabel && (
          <span className="text-[10px] text-surface-500 font-mono shrink-0 tabular-nums" title={meta || undefined}>
            {rangeLabel}
          </span>
        )}
        <span className="text-[9px] uppercase tracking-wider text-emerald-300/80 font-semibold shrink-0 px-1 py-0.5 rounded bg-emerald-500/10">
          {langLabel}
        </span>
        {markdown && (
          <div className="flex items-center rounded-md border border-white/10 overflow-hidden shrink-0">
            <button
              type="button"
              onClick={() => setMdMode('preview')}
              className={`p-1 ${mdMode === 'preview' ? 'bg-white/10 text-white' : 'text-surface-400 hover:bg-white/5'}`}
              title="Markdown preview"
            >
              <Eye className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => setMdMode('code')}
              className={`p-1 ${mdMode === 'code' ? 'bg-white/10 text-white' : 'text-surface-400 hover:bg-white/5'}`}
              title="Source"
            >
              <Code2 className="w-3 h-3" />
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 min-h-0 overflow-auto">
        {markdown && mdMode === 'preview' ? (
          <div className="pc-md-preview px-6 py-5 max-w-3xl text-[14px] leading-relaxed text-surface-200">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => <h1 className="text-2xl font-bold text-white mt-2 mb-3 border-b border-white/10 pb-2">{children}</h1>,
                h2: ({ children }) => <h2 className="text-xl font-semibold text-white mt-5 mb-2">{children}</h2>,
                h3: ({ children }) => <h3 className="text-lg font-semibold text-surface-100 mt-4 mb-2">{children}</h3>,
                p: ({ children }) => <p className="my-2.5 text-surface-200">{children}</p>,
                ul: ({ children }) => <ul className="my-2.5 pl-5 list-disc space-y-1">{children}</ul>,
                ol: ({ children }) => <ol className="my-2.5 pl-5 list-decimal space-y-1">{children}</ol>,
                li: ({ children }) => <li className="text-surface-200">{children}</li>,
                a: ({ href, children }) => (
                  <a href={href} className="text-sky-400 underline underline-offset-2 hover:text-sky-300" target="_blank" rel="noreferrer">
                    {children}
                  </a>
                ),
                code: ({ className, children }) => {
                  const text = String(children ?? '');
                  const block = Boolean(className) || text.includes('\n');
                  if (block) {
                    return (
                      <code className={`hljs block rounded-lg p-3 my-3 text-[12px] overflow-x-auto ${className || ''}`}>
                        {children}
                      </code>
                    );
                  }
                  return (
                    <code className="px-1.5 py-0.5 rounded bg-white/10 text-emerald-300 text-[0.9em]">{children}</code>
                  );
                },
                pre: ({ children }) => <pre className="my-3 overflow-x-auto">{children}</pre>,
                blockquote: ({ children }) => (
                  <blockquote className="border-l-2 border-emerald-500/50 pl-3 my-3 text-surface-400 italic">{children}</blockquote>
                ),
                table: ({ children }) => (
                  <div className="my-3 overflow-x-auto rounded-lg border border-white/10">
                    <table className="w-full text-sm">{children}</table>
                  </div>
                ),
                th: ({ children }) => <th className="text-left px-3 py-2 bg-white/5 font-semibold">{children}</th>,
                td: ({ children }) => <td className="px-3 py-2 border-t border-white/5">{children}</td>,
                hr: () => <hr className="my-5 border-white/10" />,
              }}
            >
              {body}
            </ReactMarkdown>
          </div>
        ) : (
          <div className="flex min-w-0 font-mono text-[12.5px] leading-[1.55]">
            <div
              className="select-none text-right pr-3 pl-3 text-[#6e7681] shrink-0 sticky left-0 bg-[#0d1117] py-3 border-r border-white/5"
              aria-hidden
            >
              {Array.from({ length: lineCount }, (_, i) => (
                <div key={i}>{i + 1}</div>
              ))}
            </div>
            <pre className="m-0 py-3 pr-4 pl-3 overflow-x-auto flex-1 min-w-0">
              <code
                className={`hljs language-${language} !bg-transparent !p-0 block whitespace-pre`}
                dangerouslySetInnerHTML={{ __html: highlighted || '&nbsp;' }}
              />
            </pre>
          </div>
        )}
      </div>
    </div>
  );
}
