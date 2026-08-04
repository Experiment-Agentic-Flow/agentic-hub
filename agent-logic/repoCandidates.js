import { resolveTargetReposFromParent } from './jira.js';
import { resolveCandidatesFromVectorSearch } from './contextRetrieval.js';
import { resolveCandidatesFromRepoDirectory } from './repoDirectoryLookup.js';
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
 *   1. Bugfix tickets: every repo referenced by the Jira parent ticket's linked PRs/branches - a
 *      parent story/epic can span several repos, so all of them become candidates.
 *   2. Otherwise (any non-bugfix ticket type - Technical Debt, Story, Task, ...; also bugfix
 *      without a resolvable parent): `data/repo-directory.json`'s continuously-summarized, plain
 *      LLM-judged directory ([agent-logic/repoDirectoryLookup.js](repoDirectoryLookup.js)) is tried
 *      first; the existing Pinecone vector search is the fallback if that finds nothing or errors,
 *      so neither path replaces the other. Multiple repos may come back if several are genuinely
 *      competitive matches - the coding agent decides between them after inspecting the actual
 *      checked-out code, rather than us guessing from metadata alone.
 *
 * Returns an array of { repo, branch, paths, source } - `paths` is an array since a single
 * monorepo candidate can have several genuinely relevant project paths for one ticket, not just
 * one - never empty unless nothing at all matched.
 */
export async function gatherCandidates({ ticketKey, ticketType, description, targetBranch }) {
  if (ticketType === 'bugfix-ticket') {
    const parents = await resolveTargetReposFromParent(ticketKey);
    if (parents.length > 0) {
      return Promise.all(
        parents.map(async (p) => ({
          repo: p.repo,
          branch: await resolveBranch(p.repo, targetBranch),
          paths: ['.'],
          source: `${p.source} (${p.parentKey})`,
        }))
      );
    }
  }

  let matches = [];
  let source = 'repo directory';
  try {
    matches = await resolveCandidatesFromRepoDirectory(description);
  } catch (err) {
    console.warn(`  repo-directory candidate resolution failed, falling back to vector search: ${err.message}`);
  }
  if (matches.length === 0) {
    source = 'vector search';
    matches = await resolveCandidatesFromVectorSearch(description);
  }

  return Promise.all(
    matches.map(async (match) => ({
      repo: match.repo,
      branch: await resolveBranch(match.repo, targetBranch),
      paths: match.paths.length ? match.paths : ['.'],
      source: `${source} (score ${match.score.toFixed(3)})`,
    }))
  );
}

