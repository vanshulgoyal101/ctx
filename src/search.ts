/**
 * Query-focused repo reading: return only the passages of a repo that match a
 * query, ranked by relevance, each tagged with its file path and line number.
 *
 * This is the token-saver — an agent asks "where is auth handled?" and gets the
 * three relevant blocks instead of the whole repository.
 *
 * Deterministic and dependency-free: case-insensitive term scoring over blocks
 * (runs of non-blank lines), no LLM and no embeddings.
 */

export interface FileMatch {
  /** File the passage came from, e.g. "src/auth/session.ts". */
  path: string;
  /** 1-based line where the matching block starts. */
  line: number;
  /** The matching block, trimmed to the context budget. */
  snippet: string;
  /** Number of query-term occurrences in the block (higher = more relevant). */
  score: number;
}

interface Searchable {
  path: string;
  text: string;
}

export function searchFiles(
  files: Searchable[],
  query: string,
  maxMatches = 5,
  contextChars = 500,
): FileMatch[] {
  const terms = tokenize(query);
  if (terms.length === 0) return [];

  const limit = clamp(maxMatches, 1, 50);
  const budget = clamp(contextChars, 80, 4000);

  const matches: Array<FileMatch & { order: number }> = [];
  let order = 0;

  for (const file of files) {
    for (const block of blocksOf(file.text)) {
      const score = scoreBlock(block.text, terms);
      if (score > 0) {
        matches.push({
          path: file.path,
          line: block.line,
          snippet: windowAround(block.text, terms, budget),
          score,
          order: order++,
        });
      }
    }
  }

  matches.sort((a, b) => b.score - a.score || a.order - b.order);
  return matches.slice(0, limit).map(({ order: _order, ...m }) => m);
}

interface Block {
  text: string;
  line: number;
}

/** Split a file into blocks (runs of non-blank lines), tracking the start line. */
function blocksOf(text: string): Block[] {
  const lines = text.split('\n');
  const blocks: Block[] = [];
  let current: string[] = [];
  let startLine = 0;

  lines.forEach((line, i) => {
    if (line.trim() === '') {
      if (current.length) {
        blocks.push({ text: current.join('\n'), line: startLine + 1 });
        current = [];
      }
    } else {
      if (current.length === 0) startLine = i;
      current.push(line);
    }
  });
  if (current.length) blocks.push({ text: current.join('\n'), line: startLine + 1 });
  return blocks;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function scoreBlock(block: string, terms: string[]): number {
  const hay = block.toLowerCase();
  let score = 0;
  for (const term of terms) {
    let from = 0;
    for (;;) {
      const at = hay.indexOf(term, from);
      if (at === -1) break;
      score++;
      from = at + term.length;
    }
  }
  return score;
}

/** Trim a block to `budget` chars, centred on the first matched term. */
function windowAround(block: string, terms: string[], budget: number): string {
  const collapsed = block.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
  if (collapsed.length <= budget) return collapsed;

  const hay = collapsed.toLowerCase();
  let first = collapsed.length;
  for (const term of terms) {
    const at = hay.indexOf(term);
    if (at !== -1 && at < first) first = at;
  }
  if (first === collapsed.length) first = 0;

  let start = Math.max(0, first - Math.floor(budget / 2));
  const end = Math.min(collapsed.length, start + budget);
  start = Math.max(0, end - budget);

  let snippet = collapsed.slice(start, end).trim();
  if (start > 0) snippet = `…${snippet}`;
  if (end < collapsed.length) snippet = `${snippet}…`;
  return snippet;
}

function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.floor(n)));
}
