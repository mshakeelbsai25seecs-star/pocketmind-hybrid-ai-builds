export interface BuiltinSkill {
  id: string;
  name: string;
  description: string;
  body: string;
}

/** Read-only starter skills shipped with the app. */
export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    id: 'builtin:code-review',
    name: 'Code review',
    description: 'Structured review: correctness, edge cases, security, tests.',
    body: `When reviewing or improving code:
1. Prefer evidence from repo_map / find_symbol / grep / small read_file windows.
2. Call out bugs, missing edge cases, and unsafe assumptions before style nits.
3. Suggest the smallest safe change; for Agent mode use apply_edit with exact old_string from tool results.
4. Mention test ideas (unit/integration) when behavior changes.
5. Do not invent files or APIs you have not seen in tool results.`,
  },
  {
    id: 'builtin:debug-playbook',
    name: 'Debug playbook',
    description: 'Evidence-first debugging workflow.',
    body: `Debug workflow:
1. Restate the failure symptom in one sentence.
2. Gather evidence: logs, stack traces, attached screenshots, grep for error strings.
3. Form 1–2 hypotheses; verify with targeted reads or allowlisted run_command before large edits.
4. Apply a minimal fix; re-check the failing path.
5. Summarize root cause + fix in done.summary.`,
  },
  {
    id: 'builtin:pr-hygiene',
    name: 'PR hygiene',
    description: 'Keep changes reviewable and scoped.',
    body: `For multi-file work:
1. Keep the change set focused on the user request; avoid drive-by refactors.
2. Match existing naming, imports, and formatting in touched files.
3. Update nearby tests or note why tests were skipped.
4. In Plan mode, list files to touch and risks before Build.`,
  },
];
