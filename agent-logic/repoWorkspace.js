import fs from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';

/** Deterministic, filesystem-safe directory name for a repo, e.g. "owner/repo" -> "owner__repo". */
export function sanitizeRepoDirName(repo) {
  return repo.replace('/', '__');
}

/**
 * Shallow-clones a candidate repo into its own subfolder of `workspaceRoot`. The org PAT is used
 * transiently in the clone URL and then scrubbed from the local git config immediately after, so
 * it isn't left sitting in `.git/config` on disk for the rest of the job.
 */
export async function cloneCandidate(workspaceRoot, candidate) {
  const dir = path.join(workspaceRoot, sanitizeRepoDirName(candidate.repo));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const remoteUrl = `https://x-access-token:${process.env.ORG_GITHUB_PAT}@github.com/${candidate.repo}.git`;
  await simpleGit().clone(remoteUrl, dir, ['--depth=1', '--branch', candidate.branch, '--single-branch']);

  await simpleGit(dir).remote(['set-url', 'origin', `https://github.com/${candidate.repo}.git`]);

  return dir;
}
