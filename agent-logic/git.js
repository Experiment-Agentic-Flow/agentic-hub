import simpleGit from 'simple-git';

export async function createBranch(workingDir, branchName) {
  const git = simpleGit(workingDir);
  await git.checkoutLocalBranch(branchName);
  return git;
}

/** Stages, commits, and pushes all changes in workingDir. Returns false if there was nothing to commit. */
export async function commitAndPush(workingDir, branchName, message) {
  const git = simpleGit(workingDir);
  await git.add('.');
  const status = await git.status();
  if (status.staged.length === 0 && status.files.length === 0) {
    return false;
  }
  await git.addConfig('user.email', 'agent-hub-bot@users.noreply.github.com');
  await git.addConfig('user.name', 'agent-hub-bot');
  await git.commit(message);
  await git.push(['-u', 'origin', branchName]);
  return true;
}
