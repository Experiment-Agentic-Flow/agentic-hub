import { runCopilotPrompt } from '../shared/copilotCli.js';
import { loadPrompt } from '../shared/promptTemplate.js';
import { loadRepoDirectory } from '../shared/repoDirectory.js';

// Each Stage-2 chunk call stays comfortably within any model's context window regardless of how
// large a monorepo's project list grows - see docs/WORKFLOW.md for the sizing rationale.
const PROJECTS_PER_CHUNK = 80;

function chunk(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

/** Runs a "which of these numbered candidates are relevant" prompt and returns the valid 1-based indices. */
async function judgeRelevantIndices(promptName, vars, candidateCount) {
  try {
    const text = await runCopilotPrompt(loadPrompt(promptName, vars));
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    const indices = JSON.parse(jsonMatch ? jsonMatch[0] : text);
    if (!Array.isArray(indices)) throw new Error('response was not a JSON array');
    return indices.filter((n) => Number.isInteger(n) && n >= 1 && n <= candidateCount);
  } catch (err) {
    console.warn(`  relevance judgment failed, treating this batch as no matches: ${err.message}`);
    return [];
  }
}

/** Stage 1: which repo(s) in repo-directory.json this ticket likely belongs to - cheap, since the
 * directory only ever has a handful of top-level entries (one per real target repo). */
async function classifyRepos(description, directory) {
  const repoNames = Object.keys(directory).filter((key) => !key.startsWith('_'));
  if (repoNames.length === 0) return [];

  const repoList = repoNames.map((repo, i) => `${i + 1}. repo: ${repo}, purpose: ${directory[repo].purpose || 'unknown'}`).join('\n');
  const indices = await judgeRelevantIndices('classify-repo', { DESCRIPTION: description, REPO_LIST: repoList }, repoNames.length);
  return indices.map((n) => repoNames[n - 1]);
}

/** Stage 2: within one already-identified monorepo, which project(s)/path(s) this ticket applies
 * to - split into fixed-size chunks judged in parallel, so this never depends on the whole
 * project list fitting in a single model call no matter how large the monorepo grows. */
async function classifyProjectsInRepo(description, projects) {
  const chunks = chunk(projects, PROJECTS_PER_CHUNK);
  const chunkResults = await Promise.all(
    chunks.map(async (chunkItems) => {
      const candidateList = chunkItems
        .map(
          (p, i) =>
            `${i + 1}. path: ${p.path}, purpose: ${p.purpose || 'unknown'}, keyModules: ${
              (p.keyModules || []).join(', ') || 'none'
            }, dependencies: ${(p.dependencies || []).join(', ') || 'none'}, notablePatterns: ${
              (p.notablePatterns || []).join(', ') || 'none'
            }, tags: ${(p.tags || []).join(', ') || 'none'}`
        )
        .join('\n');
      const indices = await judgeRelevantIndices(
        'filter-relevant-candidates',
        { DESCRIPTION: description, CANDIDATE_LIST: candidateList },
        chunkItems.length
      );
      return indices.map((n) => chunkItems[n - 1]);
    })
  );
  return chunkResults.flat();
}

/**
 * Candidate resolution driven entirely by the continuously-summarized, plain-JSON
 * `data/repo-directory.json` instead of vector search - see docs/WORKFLOW.md for the rationale.
 * Two stages, both plain LLM relevance judgment, no embeddings:
 *   1. Which repo(s) - trivial, the directory only ever has a handful of top-level entries.
 *   2. For each identified monorepo, which project(s)/path(s) within it - chunked (see above).
 *
 * Returns the same shape agent-logic/contextRetrieval.js's resolveCandidatesFromVectorSearch does
 * - [{ repo, score, paths }] - so agent-logic/repoCandidates.js can use either interchangeably.
 */
export async function resolveCandidatesFromRepoDirectory(description) {
  const directory = loadRepoDirectory();
  const relevantRepos = await classifyRepos(description, directory);

  const candidates = [];
  for (const repo of relevantRepos) {
    const entry = directory[repo];
    if (entry.type === 'monorepo' && entry.projects?.length > 0) {
      const relevantProjects = await classifyProjectsInRepo(description, entry.projects);
      candidates.push({ repo, score: 1, paths: relevantProjects.length ? relevantProjects.map((p) => p.path) : ['.'] });
    } else {
      candidates.push({ repo, score: 1, paths: ['.'] });
    }
  }
  return candidates;
}
