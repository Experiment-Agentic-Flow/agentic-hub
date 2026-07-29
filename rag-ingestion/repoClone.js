import fs from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';

const TMP_ROOT = path.resolve('.tmp');

/**
 * Shallow, blobless clone of `repo`@`branch` into a scratch directory under `.tmp/`, so ingestion
 * can point a read-only Copilot CLI agent (see shared/copilotCli.js#runCopilotAnalysis) at real
 * checked-out files instead of relying on pre-fetched GitHub API snippets. Caller is responsible
 * for removing the returned directory once done with it.
 */
export async function cloneForAnalysis(repo, branch) {
  const dest = path.join(TMP_ROOT, repo.replace('/', '__'));
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const remoteUrl = `https://x-access-token:${process.env.ORG_GITHUB_PAT}@github.com/${repo}.git`;
  const git = simpleGit();
  try {
    await git.clone(remoteUrl, dest, ['--filter=blob:none', '--depth=1', '--branch', branch, '--single-branch']);
  } catch (err) {
    throw new Error(
      `Failed to clone ${repo}#${branch} - ORG_GITHUB_PAT likely lacks access to this repo (fine-grained PATs need ` +
        `"Contents" permission and must explicitly include this repo; classic PATs need the "repo" scope; orgs with ` +
        `SSO enforcement require the token to be authorized for the org). Original error: ${err.message}`
    );
  }
  return dest;
}
