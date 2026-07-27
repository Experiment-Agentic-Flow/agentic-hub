import { Octokit } from '@octokit/rest';

let octokit;

function getOctokit() {
  if (!octokit) {
    if (!process.env.ORG_GITHUB_PAT) {
      throw new Error('ORG_GITHUB_PAT is not set');
    }
    octokit = new Octokit({ auth: process.env.ORG_GITHUB_PAT });
  }
  return octokit;
}

/** Fetches a single file's text content from a repo at a given ref, or null if it doesn't exist. */
export async function getFileContent(repo, filePath, ref) {
  const [owner, name] = repo.split('/');
  const client = getOctokit();
  try {
    const { data } = await client.repos.getContent({ owner, repo: name, path: filePath, ref });
    if (Array.isArray(data) || !('content' in data)) return null;
    return Buffer.from(data.content, data.encoding).toString('utf-8');
  } catch (err) {
    if (err.status === 404) return null;
    throw err;
  }
}

/** Returns the list of blob paths under `prefix` (default: whole repo) using the git trees API. */
export async function getFileTree(repo, ref, prefix = '') {
  const [owner, name] = repo.split('/');
  const client = getOctokit();
  const { data: refData } = await client.git.getRef({ owner, repo: name, ref: `heads/${ref}` });
  const commitSha = refData.object.sha;
  const { data: commit } = await client.git.getCommit({ owner, repo: name, commit_sha: commitSha });
  const { data: tree } = await client.git.getTree({
    owner,
    repo: name,
    tree_sha: commit.tree.sha,
    recursive: 'true',
  });
  return tree.tree
    .filter((entry) => entry.type === 'blob' && entry.path.startsWith(prefix))
    .map((entry) => entry.path);
}
