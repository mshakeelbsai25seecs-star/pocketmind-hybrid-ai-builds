import { useState } from 'react';
import { ChevronDown, ChevronRight, CheckCircle2, AlertCircle } from 'lucide-react';
import type { AgentStep } from '../../codeWorkspace/types';

function toolStatusLabel(tool?: string): string {
  switch (tool) {
    case 'list_dir':
      return 'Listed directory';
    case 'glob_file_search':
      return 'Searched files';
    case 'grep':
      return 'Searched code';
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
        <pre className="px-2.5 pb-2 text-[11px] font-mono whitespace-pre-wrap break-words text-surface-700 dark:text-surface-300 max-h-48 overflow-auto border-t border-surface-100 dark:border-surface-800 pt-2">
          {result}
        </pre>
      )}
    </div>
  );
}

/**
 * Cursor-like transcript: narrative / status as plain text; tool outputs in compact cards.
 */
export default function AgentTranscript({ steps }: { steps: AgentStep[] }) {
  if (steps.length === 0) return null;

  // Collapse consecutive assistant JSON noise — only show tools, done, errors as the story.
  const visible = steps.filter(s => s.kind !== 'assistant');

  if (visible.length === 0) {
    return (
      <p className="text-[13px] text-surface-500 px-0.5 py-1">Working…</p>
    );
  }

  return (
    <div className="space-y-2.5">
      {visible.map((step, idx) => {
        const key = `${step.step}-${idx}`;

        if (step.kind === 'tool') {
          return (
            <div key={key} className="space-y-1">
              <p className="text-[13px] text-surface-600 dark:text-surface-300 px-0.5">
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

        if (step.kind === 'done') {
          return (
            <div key={key} className="space-y-1 px-0.5">
              <p className="text-[12px] text-emerald-600 dark:text-emerald-400 flex items-center gap-1.5">
                <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
                Done
              </p>
              <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words text-surface-800 dark:text-surface-100">
                {step.content}
              </p>
            </div>
          );
        }

        if (step.kind === 'error') {
          return (
            <div key={key} className="space-y-1 px-0.5">
              <p className="text-[12px] text-amber-600 dark:text-amber-400 flex items-center gap-1.5">
                <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                Issue
              </p>
              <p className="text-[13px] leading-relaxed whitespace-pre-wrap break-words text-surface-700 dark:text-surface-200">
                {step.content}
              </p>
            </div>
          );
        }

        return null;
      })}
    </div>
  );
}
