import { resolveTargetReposFromParent } from './jira.js';
import { resolveCandidatesFromVectorSearch } from './contextRetrieval.js';
import { getDefaultBranch } from './githubPr.js';

/** Resolves `repo`'s actual default branch via the GitHub API, falling back to "main" if the lookup fails. */
async function resolveBranch(repo, targetBranch) {
  if (targetBranch) return targetBranch;
  try {
    return await getDefaultBranch(repo);
  } catch (err) {
    console.warn(`  couldn't resolve default branch for ${repo}, falling back to "main": ${err.message}`);
    return 'main';
  }
}

/**
 * Gathers the candidate repo(s) a ticket might target, in priority order:
 *   1. An explicit target repo (from the payload / matrix entry) always wins outright.
 *   2. Bugfix tickets: every repo referenced by the Jira parent ticket's linked PRs/branches - a
 *      parent story/epic can span several repos, so all of them become candidates.
 *   3. Otherwise (tech-debt always, bugfix without a resolvable parent): the vector DB surfaces
 *      an adaptive set of "appropriate" candidate repos, each using its actual GitHub default
 *      branch. Multiple repos may come back if several are genuinely competitive matches - the
 *      coding agent decides between them after inspecting the actual checked-out code, rather
 *      than us guessing from metadata alone.
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
      return Promise.all(
        parents.map(async (p) => ({
          repo: p.repo,
          branch: await resolveBranch(p.repo, targetBranch),
          path: '.',
          source: `${p.source} (${p.parentKey})`,
        }))
      );
    }
  }

  const matches = await resolveCandidatesFromVectorSearch(description);
  return Promise.all(
    matches.map(async (match) => ({
      repo: match.metadata?.repo,
      branch: await resolveBranch(match.metadata?.repo, targetBranch),
      path: match.metadata?.projectPath || '.',
      source: `vector search (score ${match.score.toFixed(3)})`,
    }))
  );
}

