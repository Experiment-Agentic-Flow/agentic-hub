import fs from 'node:fs';
import path from 'node:path';
import simpleGit from 'simple-git';
import fg from 'fast-glob';
import { embedTexts } from '../shared/embeddings.js';

const TMP_ROOT = path.resolve('.tmp');

async function sparseCheckout(repo, branch) {
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

/**
 * Reads each project's config directly from its `project.json` - deliberately bypassing the Nx
 * CLI entirely. Running `npm install` + `npx nx graph` in an arbitrary target repo is fragile in
 * CI (peer-dependency conflicts, postinstall scripts needing permissions we don't want to grant,
 * long install times), so instead of the real computed project graph, this reads each project's
 * declared `implicitDependencies` (a real Nx concept - explicit project-to-project deps authors
 * declare in project.json) as a best-effort dependency list. It won't catch dependencies inferred
 * purely from source imports, but needs no installed node_modules and can't fail on this repo's
 * own dependency conflicts.
 */
function readProjectsFromProjectJson(repoDir) {
  const projectFiles = fg.sync('**/project.json', { cwd: repoDir, ignore: ['**/node_modules/**'] });
  const nodes = {};
  for (const file of projectFiles) {
    const full = path.join(repoDir, file);
    try {
      const project = JSON.parse(fs.readFileSync(full, 'utf-8'));
      const projectPath = path.dirname(file);
      nodes[project.name || projectPath] = {
        data: { root: projectPath, tags: project.tags || [], projectType: project.projectType || 'unknown' },
        dependencies: project.implicitDependencies || [],
      };
    } catch {
      // skip unreadable project.json
    }
  }
  return nodes;
}

export async function ingestMonorepo(entry, runId) {
  const { repo, branch = 'main' } = entry;
  const repoDir = await sparseCheckout(repo, branch);

  try {
    const nodes = readProjectsFromProjectJson(repoDir);
    const records = [];

    for (const [projectName, node] of Object.entries(nodes)) {
      const data = node.data || {};
      const deps = node.dependencies || [];
      const summaryText = [
        `Repository: ${repo}`,
        `Project: ${projectName}`,
        `Path: ${data.root || 'unknown'}`,
        `Type: ${data.projectType || 'unknown'}`,
        `Tags: ${(data.tags || []).join(', ')}`,
        `Depends on: ${deps.map((d) => d.target || d).join(', ')}`,
      ].join('\n');

      const [vector] = await embedTexts([summaryText], 'passage');

      records.push({
        id: `${repo}::${projectName}`,
        values: vector,
        metadata: {
          repo,
          type: 'monorepo_project',
          projectPath: data.root || 'unknown',
          tags: data.tags || [],
          runId,
          updatedAt: new Date().toISOString(),
        },
      });
    }

    return records;
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}
