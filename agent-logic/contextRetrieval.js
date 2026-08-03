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
 * Finds the "appropriate" candidate repos for a ticket that doesn't specify one directly. Two
 * signals are used, in priority order:
 *   1. **Explicit path mentions** - if the ticket text literally names a project by its path
 *      (e.g. "libs/livecount/quantity-takeoff/data-access"), that's ground truth, not a guess.
 *      Sibling libs within the same feature (feature/api/ui/data-access tiers) describe such
 *      similar domain purpose that embedding similarity alone can't reliably tell "mentioned" from
 *      "merely related" - an explicit mention always wins outright, uncapped, regardless of score.
 *   2. **Vector-DB similarity** - used only as a fallback for repos/paths the ticket didn't name
 *      explicitly. The count is adaptive, not fixed: the top match is always included, and
 *      subsequent matches are only kept if they're close enough in score to be genuinely
 *      competitive, capped at `maxPathsPerRepo` per repo so a wide relative-margin window around a
 *      middling top score can't sweep in every domain-adjacent project in a monorepo.
 * Candidates dedupe to one entry *per repo*, with a `paths` list (a monorepo ticket can genuinely
 * span several libs at once) - passing these along lets the coding agent jump straight to the
 * right files instead of having to search the whole repo for them. The actual choice of *which*
 * path(s) to modify is still confirmed by the coding agent against the real checked-out code.
 */
export async function resolveCandidatesFromVectorSearch(
  description,
  { topK = 20, minScore = 0.65, relativeMargin = 0.08, maxCandidates = 5, maxPathsPerRepo = 3 } = {}
) {
  const [vector] = await embedTexts([description], 'query');
  const result = await queryByVector(vector, { topK, filter: { type: { $ne: 'ingestion_state' } } });
  const matches = (result.matches || [])
    .map((match) => ({ id: match.id, score: match.score, metadata: match.metadata }))
    .sort((a, b) => b.score - a.score);

  if (matches.length === 0) {
    return [];
  }

  const normalizedDescription = description.toLowerCase();
  // Checks both the full stored path and that path with its root segment (libs/apps/...) stripped,
  // since a ticket is just as likely to say "quantity-takeoff/data-access" as the full
  // "libs/quantity-takeoff/data-access".
  const isExplicitlyMentioned = (projectPath) => {
    if (!projectPath) return false;
    const normalized = projectPath.replace(/\\/g, '/').toLowerCase();
    const withoutRootSegment = normalized.split('/').slice(1).join('/');
    return normalizedDescription.includes(normalized) || (!!withoutRootSegment && normalizedDescription.includes(withoutRootSegment));
  };

  const topScore = matches[0].score;
  const byRepo = new Map();

  for (const match of matches) {
    const repo = match.metadata?.repo;
    const projectPath = match.metadata?.projectPath;
    if (!repo) continue;

    const explicit = isExplicitlyMentioned(projectPath);
    // A match is competitive if it clears the absolute floor OR is close enough to the top score -
    // these must be checked as alternatives, not both required: whenever the top match itself is a
    // middling score (below minScore), every other match is guaranteed to score even lower, so
    // requiring the absolute floor on top of the relative check would make it impossible for any
    // additional candidate to ever qualify.
    if (!explicit && match.score < minScore && match.score < topScore - relativeMargin) continue;

    if (!byRepo.has(repo)) {
      if (byRepo.size >= maxCandidates) continue; // caps distinct repos, not paths within one repo
      byRepo.set(repo, { repo, score: match.score, paths: [], explicitPaths: [] });
    }
    const candidate = byRepo.get(repo);
    if (!projectPath || candidate.paths.includes(projectPath)) continue;

    if (explicit) {
      candidate.explicitPaths.push(projectPath);
      candidate.paths.push(projectPath);
    } else if (candidate.explicitPaths.length === 0 && candidate.paths.length < maxPathsPerRepo) {
      // Only guess from score while nothing in this repo has been explicitly named yet - once the
      // ticket text confirms specific libs, stop padding the list with semantic guesses.
      candidate.paths.push(projectPath);
    }
  }

  // Matches are walked in descending score order, so a semantic guess can be added before a later,
  // lower-scoring but explicitly-named lib is reached - once any explicit mention exists for a
  // repo, drop every guess and keep only what the ticket actually named.
  for (const candidate of byRepo.values()) {
    if (candidate.explicitPaths.length > 0) {
      candidate.paths = candidate.explicitPaths;
    }
    delete candidate.explicitPaths;
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
