import { Octokit } from '@octokit/rest';

function getOctokit() {
  if (!process.env.ORG_GITHUB_PAT) {
    throw new Error('ORG_GITHUB_PAT is not set');
  }
  return new Octokit({ auth: process.env.ORG_GITHUB_PAT });
}

export async function openPullRequest({ repo, base, head, title, body }) {
  const [owner, name] = repo.split('/');
  const octokit = getOctokit();
  const { data } = await octokit.pulls.create({ owner, repo: name, base, head, title, body });
  return data.html_url;
}

/**
 * Returns the open PR for `head` -> `base` in `repo`, if one already exists, so callers can
 * skip re-running the agent and just report the existing PR instead of creating a duplicate.
 */
export async function findExistingPullRequest({ repo, head, base }) {
  const [owner, name] = repo.split('/');
  const octokit = getOctokit();
  const { data } = await octokit.pulls.list({
    owner,
    repo: name,
    state: 'open',
    head: `${owner}:${head}`,
    base,
  });
  return data[0] || null;
}
