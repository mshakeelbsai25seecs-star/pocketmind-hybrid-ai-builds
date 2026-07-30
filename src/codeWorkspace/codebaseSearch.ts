import { cwGrep } from '../api/codeWorkspace';
import { rankGrepOutputs, searchTerms } from './codebaseSearchCore';

/**
 * Natural-language search over the workspace, built on the transport's ripgrep.
 *
 * Cursor answers "where is X handled?" with one semantic search; PocketMind models used to
 * emulate that with a long chain of greps and reads. This runs the keyword fan-out once,
 * ranks files by how many query terms they contain, and returns the best lines so the model
 * can jump straight to read_file. It uses only transport calls, so local Tauri and the
 * remote agent-host (server mode) behave identically.
 */
export async function codebaseSearch(
  workspaceRoot: string,
  query: string,
  glob?: string | null,
): Promise<string> {
  const terms = searchTerms(query);
  if (terms.length === 0) {
    return 'codebase_search needs a query with at least one meaningful word (3+ characters).';
  }

  const outputs = await Promise.all(
    terms.map(term => cwGrep(workspaceRoot, term, null, glob || null, true).catch(() => '')),
  );

  return rankGrepOutputs(query, terms, outputs, workspaceRoot);
}
