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
 * kept if they're close enough in score to be genuinely competitive. Candidates dedupe to one
 * entry *per repo*, but a monorepo can have several genuinely relevant Nx projects for a single
 * ticket - every competitive match for the same repo contributes its own `projectPath` into that
 * repo's `paths` list, rather than only the single best-scoring project surviving. The actual
 * choice of *which* candidate/path to modify is deferred to the coding agent, which can inspect
 * the real checked-out code rather than just text summaries.
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
  const byRepo = new Map();

  for (const match of matches) {
    const repo = match.metadata?.repo;
    if (!repo) continue;
    // A match is competitive if it clears the absolute floor OR is close enough to the top score -
    // these must be checked as alternatives, not both required: whenever the top match itself is a
    // middling score (below minScore), every other match is guaranteed to score even lower, so
    // requiring the absolute floor on top of the relative check would make it impossible for any
    // additional candidate to ever qualify.
    if (match.score < minScore && match.score < topScore - relativeMargin) continue;

    if (!byRepo.has(repo)) {
      if (byRepo.size >= maxCandidates) continue; // caps distinct repos, not paths within one repo
      byRepo.set(repo, { repo, score: match.score, paths: [] });
    }
    const projectPath = match.metadata?.projectPath;
    const candidate = byRepo.get(repo);
    if (projectPath && !candidate.paths.includes(projectPath)) {
      candidate.paths.push(projectPath);
    }
  }

  const candidates = [...byRepo.values()];

  // Always surface at least the single best match, even if it's below the usual thresholds.
  if (candidates.length === 0) {
    const best = matches[0];
    candidates.push({
      repo: best.metadata?.repo,
      score: best.score,
      paths: best.metadata?.projectPath ? [best.metadata.projectPath] : [],
    });
  }

  return candidates;
}
