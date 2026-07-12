/**
 * TEMPORARY overnight auto-question queue for Knowledge Chat.
 *
 * TODO(overnight-eval): REMOVE AFTER OVERNIGHT EVAL
 *
 * How to remove (undo this step):
 * 1. Delete this file: `src/knowledgeChat/overnightEval.ts`
 * 2. In `KnowledgeChatPanel.tsx`, remove every `TODO(overnight-eval)` / `overnightEval` import,
 *    effect, progress state, and banner.
 *
 * How to disable without deleting:
 * - Set `OVERNIGHT_AUTO_EVAL = false` below, OR
 * - In the browser/devtools console: `localStorage.setItem('kc-overnight-eval', '0')` then reload
 *
 * Questions are proven QA-corpus / Codebase Explorer code prompts (see
 * `QA_SAMPLE_QUESTIONS`, `test-fixtures/kc-qa-corpus/TEST_QUESTIONS.md`).
 */

// TODO(overnight-eval): REMOVE — flip to false to disable overnight auto-queue
export const OVERNIGHT_AUTO_EVAL = true;

/** localStorage key: set to `'0'` or `'false'` to disable even when the const is true */
export const OVERNIGHT_STORAGE_KEY = 'kc-overnight-eval';

export const OVERNIGHT_START_DELAY_MS = 2500;
export const OVERNIGHT_BETWEEN_DELAY_MS = 3500;

/** Five code/retrieval questions that exercise the QA corpus + answer pipeline. */
export const OVERNIGHT_QUESTIONS: readonly string[] = [
  'What does handleSend do in ChatView.tsx?',
  'What environment variable controls the API timeout?',
  'What Rust function validates JWT tokens?',
  'What functions are defined in ChatView.tsx?',
  'Where is the API timeout read from the environment and what is its default?',
];

export function isOvernightEvalEnabled(): boolean {
  if (!OVERNIGHT_AUTO_EVAL) return false;
  try {
    const flag = localStorage.getItem(OVERNIGHT_STORAGE_KEY);
    if (flag === '0' || flag === 'false') return false;
  } catch {
    // ignore (SSR / restricted storage)
  }
  return true;
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => {
    window.setTimeout(resolve, ms);
  });
}

export type OvernightEvalProgress = {
  /** How many questions have finished (0..total). */
  completed: number;
  total: number;
  /** True while the queue is still running. */
  running: boolean;
  /** 1-based index of the question currently being asked, or null when idle/done. */
  asking: number | null;
};
