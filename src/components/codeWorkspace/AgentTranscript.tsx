import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, AlertCircle } from 'lucide-react';
import type { AgentStep } from '../../codeWorkspace/types';
import AssistantMarkdown from '../AssistantMarkdown';

function toolStatusLabel(tool?: string): string {
  switch (tool) {
    case 'list_dir':
      return 'Listed directory';
    case 'glob_file_search':
      return 'Searched files';
    case 'grep':
      return 'Searched code';
    case 'codebase_search':
      return 'Searched codebase';
    case 'repo_map':
      return 'Mapped repository';
    case 'find_symbol':
      return 'Found symbols';
    case 'read_symbol':
      return 'Read symbol';
    case 'read_file':
      return 'Read file';
    case 'apply_edit':
      return 'Edited file';
    case 'delete_file':
      return 'Deleted file';
    case 'run_command':
      return 'Ran command';
    case 'ask_followup':
      return 'Asked a follow-up';
    case 'create_plan':
      return 'Created plan';
    case 'update_plan':
      return 'Updated plan';
    case 'mcp_call':
      return 'Called MCP tool';
    default:
      if (tool?.startsWith('mcp__')) {
        return `Called ${tool.slice('mcp__'.length).replace(/__/g, '.')}`;
      }
      return tool ? `Ran ${tool}` : 'Ran tool';
  }
}

function firstLine(text: string, max = 120): string {
  const line = text.trim().split(/\r?\n/).find(Boolean) || '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
}

function ToolResultCard({ tool, result }: { tool?: string; result: string }) {
  const [open, setOpen] = useState(false);
  const preview = firstLine(result, 80);
  return (
    <div className="rounded-md border border-surface-200 dark:border-surface-800 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1.5 text-left text-[11px] text-surface-600 dark:text-surface-300 hover:bg-surface-50 dark:hover:bg-surface-900/80"
      >
        {open ? <ChevronDown className="w-3 h-3 shrink-0" /> : <ChevronRight className="w-3 h-3 shrink-0" />}
        <span className="font-medium shrink-0">{tool || 'result'}</span>
        {!open && (
          <span className="truncate text-surface-400 font-mono">{preview}</span>
        )}
      </button>
      {open && (
        <pre className="px-2.5 pb-2 text-[11px] font-mono whitespace-pre-wrap break-words text-surface-700 dark:text-surface-300 max-h-40 overflow-auto border-t border-surface-100 dark:border-surface-800 pt-2">
          {result}
        </pre>
      )}
    </div>
  );
}

/**
 * Cursor-like transcript: tools stay collapsed behind one line; final answer is clean Markdown.
 * Never dumps the reply into a raw grey "thought" / code wall.
 */
export default function AgentTranscript({
  steps,
  answer,
  forceCollapsed = false,
}: {
  steps: AgentStep[];
  /** Preferred final reply (message body). Used when longer than the done step text. */
  answer?: string | null;
  /** When true (e.g. file-write approval), keep the tool dump collapsed. */
  forceCollapsed?: boolean;
}) {
  const [toolsOpen, setToolsOpen] = useState(false);

  const visible = steps.filter(s => s.kind !== 'assistant');
  const doneStep = [...visible].reverse().find(s => s.kind === 'done');
  const toolsAndErrors = visible.filter(s => s.kind === 'tool' || s.kind === 'error');
  const fromDone = (doneStep?.content || '').trim();
  const fromProp = (answer || '').trim();
  const answerText = fromProp.length > fromDone.length ? fromProp : (fromDone || fromProp);
  const looksFailed = /generation (error|failed)|insufficient balance|payment required|invalid api key/i
    .test(answerText || doneStep?.content || '');
  const finished = Boolean(doneStep) || (Boolean(answerText) && !looksFailed);

  // Keep tool traces collapsed by default; collapse again when the answer lands
  // or when the parent asks (approval gate).
  useEffect(() => {
    if (finished || forceCollapsed) setToolsOpen(false);
  }, [finished, answerText, forceCollapsed, toolsAndErrors.length]);

  if (steps.length === 0 && !(answer || '').trim()) return null;

  if (toolsAndErrors.length === 0 && !answerText) {
    return (
      <p className="text-[13px] text-surface-500 px-0.5 py-1">Working…</p>
    );
  }

  const lastTool = [...toolsAndErrors].reverse().find(s => s.kind === 'tool');
  const liveLabel = lastTool
    ? toolStatusLabel(lastTool.tool)
    : (toolsAndErrors[toolsAndErrors.length - 1]?.kind === 'error' ? 'Hit an issue' : 'Working…');
  const count = toolsAndErrors.length;
  const toolsLabel = toolsOpen
    ? `Hide tool activity (${count})`
    : finished
      ? `Show tool activity (${count})`
      : `${liveLabel} · ${count} step${count === 1 ? '' : 's'} (expand)`;

  const expanded = toolsOpen && !forceCollapsed;

  return (
    <div className="space-y-2.5">
      {toolsAndErrors.length > 0 && (
        <div className="px-0.5">
          <button
            type="button"
            onClick={() => setToolsOpen(v => !v)}
            aria-expanded={expanded}
            className="w-full flex items-center gap-1.5 rounded-sm border border-surface-200/80 dark:border-surface-700/80 bg-surface-50/80 dark:bg-surface-900/60 px-2 py-1.5 text-left text-[12px] leading-snug text-surface-600 dark:text-surface-300 hover:bg-surface-100 dark:hover:bg-surface-800"
          >
            {expanded
              ? <ChevronDown className="w-3.5 h-3.5 shrink-0 opacity-70" />
              : <ChevronRight className="w-3.5 h-3.5 shrink-0 opacity-70" />}
            <span className="min-w-0 truncate font-medium">{toolsLabel}</span>
          </button>
          {expanded && (
            <div className="mt-2 max-h-56 overflow-y-auto space-y-2 border-l border-surface-200 dark:border-surface-800 pl-2.5 pr-1">
              {toolsAndErrors.map((step, idx) => {
                const key = `${step.step}-${idx}`;
                if (step.kind === 'tool') {
                  return (
                    <div key={key} className="space-y-1">
                      <p className="text-[12px] text-surface-600 dark:text-surface-300">
                        {toolStatusLabel(step.tool)}
                        {step.tool === 'apply_edit' && step.toolResult
                          ? ` · ${firstLine(step.toolResult.replace(/^Edit written to\s+/i, ''), 64)}`
                          : ''}
                      </p>
                      {step.toolResult && (
                        <ToolResultCard tool={step.tool} result={step.toolResult} />
                      )}
                    </div>
                  );
                }
                return (
                  <div key={key} className="space-y-1">
                    <p className="text-[12px] text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                      <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                      Issue
                    </p>
                    <p className="text-[12px] leading-relaxed whitespace-pre-wrap break-words text-surface-600 dark:text-surface-300">
                      {step.content}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {answerText && (
        <div className="space-y-1 px-0.5">
          {!finished && !looksFailed ? null : (
            <p className={`text-[12px] flex items-center gap-1.5 ${
              looksFailed
                ? 'text-amber-600 dark:text-amber-400'
                : 'text-emerald-600 dark:text-emerald-400'
            }`}
            >
              {looksFailed
                ? <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                : <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />}
              {looksFailed ? 'Stopped' : 'Done'}
            </p>
          )}
          {looksFailed ? (
            <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words text-surface-800 dark:text-surface-100">
              {answerText}
            </p>
          ) : (
            <AssistantMarkdown content={answerText} className="text-[13px]" />
          )}
        </div>
      )}
    </div>
  );
}
