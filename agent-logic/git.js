import simpleGit from 'simple-git';

export async function createBranch(workingDir, branchName) {
  const git = simpleGit(workingDir);
  await git.checkoutLocalBranch(branchName);
  return git;
}

/**
 * Stages, commits, and pushes all changes in workingDir. Returns false if there was nothing to commit.
 * `repo` ("owner/name") is used to inject the org PAT into the origin URL just for the push - the
 * clone step (repoWorkspace.js's `cloneCandidate`) deliberately scrubs the token from `.git/config`
 * right after cloning, so pushing over plain `https://github.com/...` would otherwise fail with
 * "could not read Username" (no TTY to prompt in CI). The token is scrubbed again immediately
 * after, win or lose, so it's never left sitting on disk for the rest of the job.
 */
export async function commitAndPush(workingDir, repo, branchName, message) {
  const git = simpleGit(workingDir);
  await git.add('.');
  const status = await git.status();
  if (status.staged.length === 0 && status.files.length === 0) {
    return false;
  }
  await git.addConfig('user.email', 'agent-hub-bot@users.noreply.github.com');
  await git.addConfig('user.name', 'agent-hub-bot');
  await git.commit(message);

  const plainUrl = `https://github.com/${repo}.git`;
  const authedUrl = `https://x-access-token:${process.env.ORG_GITHUB_PAT}@github.com/${repo}.git`;
  await git.remote(['set-url', 'origin', authedUrl]);
  try {
    await git.push(['-u', 'origin', branchName]);
  } finally {
    await git.remote(['set-url', 'origin', plainUrl]);
  }
  return true;
}
