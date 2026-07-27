import { resolveTargetReposFromParent } from './jira.js';
import { resolveCandidatesFromVectorSearch } from './contextRetrieval.js';
import { findRegistryBranch } from '../rag-ingestion/registry.js';

/**
 * Gathers the candidate repo(s) a ticket might target, in priority order:
 *   1. An explicit target repo (from the payload / matrix entry) always wins outright.
 *   2. Bugfix tickets: every repo referenced by the Jira parent ticket's linked PRs/branches - a
 *      parent story/epic can span several repos, so all of them become candidates.
 *   3. Otherwise (tech-debt always, bugfix without a resolvable parent): the vector DB surfaces
 *      an adaptive set of "appropriate" candidate repos, each using its registered branch from
 *      rag-registry.json. Multiple repos may come back if several are genuinely competitive
 *      matches - the coding agent decides between them after inspecting the actual checked-out
 *      code, rather than us guessing from metadata alone.
 *
 * Returns an array of { repo, branch, path, source } - never empty unless nothing at all matched.
 */
export async function gatherCandidates({ ticketKey, ticketType, description, targetRepo, targetBranch, targetPath }) {
  if (targetRepo) {
    return [{ repo: targetRepo, branch: targetBranch || 'main', path: targetPath || '.', source: 'explicit' }];
  }

  if (ticketType === 'bugfix-ticket') {
    const parents = await resolveTargetReposFromParent(ticketKey);
    if (parents.length > 0) {
      return parents.map((p) => ({
        repo: p.repo,
        branch: targetBranch || findRegistryBranch(p.repo) || 'main',
        path: '.',
        source: `${p.source} (${p.parentKey})`,
      }));
    }
  }

  const matches = await resolveCandidatesFromVectorSearch(description);
  return matches.map((match) => ({
    repo: match.metadata?.repo,
    branch: targetBranch || findRegistryBranch(match.metadata?.repo) || 'main',
    path: match.metadata?.projectPath || '.',
    source: `vector search (score ${match.score.toFixed(3)})`,
  }));
}
