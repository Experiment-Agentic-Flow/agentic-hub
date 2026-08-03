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
 * from vector-DB similarity - no LLM guessing from metadata alone. RAG's job stops at "which
 * repo(s)": once a repo is a candidate, the coding agent gets the whole checkout and figures out
 * which files to touch itself from the ticket description, the same way it already does when
 * several repos are candidates side by side - there's no attempt here to also narrow down to
 * individual libs/paths within a repo. The candidate count is adaptive, not a fixed number: the
 * top match is always included, and subsequent matches are only kept if they clear an absolute
 * floor OR are close enough to the top score to be genuinely competitive - checked as alternatives,
 * not both required, since whenever the top match itself is a middling score, every other match is
 * guaranteed to score even lower and could never pass an absolute-floor requirement otherwise.
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
    if (match.score < minScore && match.score < topScore - relativeMargin) continue;

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
