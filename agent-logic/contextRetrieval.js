import { embedTexts } from '../shared/embeddings.js';
import { queryByVector } from '../shared/pinecone.js';

/** Re-queries the vector DB (used by n8n originally) for extra architectural context near a repo/path. */
export async function retrieveRelatedContext(description, repo, topK = 5) {
  const [vector] = await embedTexts([description], 'query');
  const result = await queryByVector(vector, {
    topK,
    filter: { repo: { $eq: repo }, type: { $ne: 'ingestion_state' } },
  });
  return (result.matches || []).map((match) => ({
    id: match.id,
    score: match.score,
    metadata: match.metadata,
  }));
}

/**
 * Finds the "appropriate" candidate repos for a ticket that doesn't specify one directly, purely
 * from vector-DB similarity - no LLM guessing from metadata alone. The candidate count is
 * adaptive, not a fixed number: the top match is always included, and subsequent matches are only
 * kept if they're close enough in score to be genuinely competitive (and dedupe to one entry per
 * repo). The actual choice of *which* candidate to modify is deferred to the coding agent, which
 * can inspect the real checked-out code rather than just text summaries.
 */
export async function resolveCandidatesFromVectorSearch(
  description,
  { topK = 8, minScore = 0.65, relativeMargin = 0.08, maxCandidates = 5 } = {}
) {
  const [vector] = await embedTexts([description], 'query');
  const result = await queryByVector(vector, { topK, filter: { type: { $ne: 'ingestion_state' } } });
  const matches = (result.matches || [])
    .map((match) => ({ id: match.id, score: match.score, metadata: match.metadata }))
    .sort((a, b) => b.score - a.score);

  if (matches.length === 0) {
    return [];
  }

  const topScore = matches[0].score;
  const seenRepos = new Set();
  const candidates = [];

  for (const match of matches) {
    const repo = match.metadata?.repo;
    if (!repo || seenRepos.has(repo)) continue;
    if (match.score < minScore && match !== matches[0]) continue;
    if (match.score < topScore - relativeMargin) continue;

    seenRepos.add(repo);
    candidates.push(match);
    if (candidates.length >= maxCandidates) break;
  }

  // Always surface at least the single best match, even if it's below the usual thresholds.
  if (candidates.length === 0) {
    candidates.push(matches[0]);
  }

  return candidates;
}
