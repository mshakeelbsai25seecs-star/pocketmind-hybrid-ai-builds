import { Bot, Hammer, CheckCircle2, AlertCircle } from 'lucide-react';
import type { AgentStep } from '../../codeWorkspace/types';

export default function AgentTranscript({ steps }: { steps: AgentStep[] }) {
  if (steps.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-surface-300 dark:border-surface-700 p-6 text-sm text-surface-500 text-center">
        Agent transcript will appear here after you run a task.
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {steps.map((step, idx) => (
        <div
          key={`${step.step}-${idx}`}
          className="rounded-xl border border-surface-200 dark:border-surface-800 bg-white/80 dark:bg-surface-950/50 p-3"
        >
          <div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider text-surface-500 mb-2">
            {step.kind === 'assistant' && <Bot className="w-3.5 h-3.5" />}
            {step.kind === 'tool' && <Hammer className="w-3.5 h-3.5 text-amber-500" />}
            {step.kind === 'done' && <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />}
            {step.kind === 'error' && <AlertCircle className="w-3.5 h-3.5 text-red-500" />}
            <span>Step {step.step} · {step.kind}{step.tool ? ` · ${step.tool}` : ''}</span>
          </div>
          <pre className="text-xs font-mono whitespace-pre-wrap break-words text-surface-700 dark:text-surface-300 max-h-48 overflow-auto">
            {step.toolResult ?? step.content}
          </pre>
        </div>
      ))}
    </div>
  );
}
