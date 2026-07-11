# NexusAI Knowledge Chat QA Corpus

This folder is copied to `D:\NexusAI\qa-corpus` on app startup and indexed automatically.

See `TEST_QUESTIONS.md` for suggested validation questions.

## Demo cheatsheet (guided RAG)

Place `demo_cheatsheet.json` at the root of any indexed folder to enable **cheatsheet-guided answers**:

1. Index the client folder in Knowledge Chat.
2. Copy `demo_cheatsheet.template.json` → `demo_cheatsheet.json` in the folder root.
3. For each important file, add an `entries` item:
   - `file` — relative path (e.g. `code/ChatView.tsx`)
   - `symbols` — function names, env vars, error codes
   - `topics` — phrases users may ask
   - `line_start` / `line_end` — citation range
   - `summary` — one-sentence answer hint for the LLM
   - `evidence_hint` — exact quote or signature to cite
4. Add `question_routes` with `patterns` (paraphrases) mapping to `entry_ids`.
5. Re-index or restart the app. The cheatsheet is loaded automatically from the collection root.

The LLM still generates answers, but receives the cheatsheet plus pinned source files so it knows **which file and lines** to use. Answers follow: **Answer** (one line) → **Evidence** (file + line citations) → **Explanation**.

Disable via Settings → Security → **Knowledge Chat demo cheatsheet** (`knowledge_chat_demo_cheatsheet`).
