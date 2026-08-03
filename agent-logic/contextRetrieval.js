import { embedTexts } from '../shared/embeddings.js';
import { queryByVector } from '../shared/pinecone.js';
import { runCopilotPrompt } from '../shared/copilotCli.js';
import { loadPrompt } from '../shared/promptTemplate.js';

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
 * Asks a cheap-model LLM to judge which vector matches are genuinely relevant to the ticket,
 * against each match's *full* stored metadata (purpose, keyModules, notablePatterns, tags) - not
 * just its similarity score. Score-based thresholds/margins/caps can't reliably tell "genuinely
 * relevant" from "topically adjacent" (e.g. sibling feature/api/ui/data-access tiers of the same
 * domain describe very similar purpose), whereas an LLM reading the actual metadata text next to
 * the actual ticket text can. Falls back to the single best-scoring match if the call fails or
 * returns something unusable, rather than surfacing zero candidates.
 */
async function filterRelevantMatches(description, matches) {
  const candidateList = matches
    .map((match, index) => {
      const m = match.metadata || {};
      return `${index + 1}. repo: ${m.repo}, path: ${m.projectPath || 'n/a'}, purpose: ${m.purpose || 'unknown'}, keyModules: ${
        (m.keyModules || []).join(', ') || 'none'
      }, notablePatterns: ${(m.notablePatterns || []).join(', ') || 'none'}, tags: ${(m.tags || []).join(', ') || 'none'}`;
    })
    .join('\n');

  const prompt = loadPrompt('filter-relevant-candidates', { DESCRIPTION: description, CANDIDATE_LIST: candidateList });

  try {
    const text = await runCopilotPrompt(prompt);
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const indices = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    if (!Array.isArray(indices)) throw new Error('response was not a JSON array');
    const relevant = indices.map((n) => matches[n - 1]).filter(Boolean);
    return relevant.length > 0 ? relevant : [matches[0]];
  } catch (err) {
    console.warn(`  relevance filtering failed, falling back to the single best match: ${err.message}`);
    return [matches[0]];
  }
}

/**
 * Finds the "appropriate" candidate repos/projects for a ticket that doesn't specify one directly.
 * Vector search surfaces a pool of plausible matches by embedding similarity, then
 * `filterRelevantMatches` judges each one's full metadata against the actual ticket text rather
 * than relying on similarity score alone. There's no artificial cap on how many are returned -
 * every project judged relevant becomes a candidate, and a monorepo ticket can genuinely span
 * several libs at once. Candidates dedupe to one entry *per repo*, with a `paths` list, so the
 * coding agent can jump straight to the right files instead of searching the whole repo for them -
 * the actual choice of *which* path(s) to modify is still confirmed by the agent against the real
 * checked-out code.
 */
export async function resolveCandidatesFromVectorSearch(description, { topK = 20 } = {}) {
  const [vector] = await embedTexts([description], 'query');
  const result = await queryByVector(vector, { topK, filter: { type: { $ne: 'ingestion_state' } } });
  const matches = (result.matches || [])
    .map((match) => ({ id: match.id, score: match.score, metadata: match.metadata }))
    .filter((match) => match.metadata?.repo)
    .sort((a, b) => b.score - a.score);

  if (matches.length === 0) {
    return [];
  }

  const relevant = await filterRelevantMatches(description, matches);

  const byRepo = new Map();
  for (const match of relevant) {
    const repo = match.metadata.repo;
    if (!byRepo.has(repo)) {
      byRepo.set(repo, { repo, score: match.score, paths: [] });
    }
    const candidate = byRepo.get(repo);
    const projectPath = match.metadata.projectPath;
    if (projectPath && !candidate.paths.includes(projectPath)) {
      candidate.paths.push(projectPath);
    }
  }

  return [...byRepo.values()];
}
