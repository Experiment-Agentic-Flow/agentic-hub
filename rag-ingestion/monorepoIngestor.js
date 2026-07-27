import { execSync } from 'node:child_process';
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
 * Installs dependencies so `npx nx` resolves to the workspace's own locally installed nx/plugins
 * instead of the generic ad-hoc version npx would otherwise auto-install (which can't see this
 * workspace's config and fails with "Could not find Nx modules"). Best-effort: if install fails
 * (or there's no lockfile), readProjectGraph's own fallback still kicks in.
 */
function installDependencies(repoDir) {
  const hasLockfile = fs.existsSync(path.join(repoDir, 'package-lock.json'));
  if (!fs.existsSync(path.join(repoDir, 'package.json'))) {
    return false;
  }
  try {
    // --legacy-peer-deps: we only need node_modules populated enough for `nx graph` to resolve
    // plugins - we're not building/running the app, so strict peer-dep conflicts don't matter here.
    const cmd = hasLockfile
      ? 'npm ci --ignore-scripts --no-audit --no-fund --legacy-peer-deps'
      : 'npm install --ignore-scripts --no-audit --no-fund --legacy-peer-deps';
    execSync(cmd, { cwd: repoDir, stdio: 'pipe' });
    return true;
  } catch (err) {
    console.warn(`  npm install failed for ${repoDir}, nx graph will likely fall back to project.json scan: ${err.message}`);
    return false;
  }
}

/** Runs `npx nx graph` to get the authoritative project dependency graph. */
function readProjectGraph(repoDir) {
  const outFile = path.join(repoDir, '.nx-graph.json');
  try {
    execSync(`npx nx graph --file=${outFile}`, { cwd: repoDir, stdio: 'pipe' });
    const graph = JSON.parse(fs.readFileSync(outFile, 'utf-8'));
    return graph.graph?.nodes || null;
  } catch (err) {
    console.warn(`  nx graph failed for ${repoDir}, falling back to project.json scan: ${err.message}`);
    return null;
  }
}

/** Fallback: directly scan for project.json files if `nx graph` isn't available. */
function readProjectJsonFallback(repoDir) {
  const projectFiles = fg.sync('**/project.json', { cwd: repoDir, ignore: ['**/node_modules/**'] });
  const nodes = {};
  for (const file of projectFiles) {
    const full = path.join(repoDir, file);
    try {
      const project = JSON.parse(fs.readFileSync(full, 'utf-8'));
      const projectPath = path.dirname(file);
      nodes[project.name || projectPath] = {
        data: { root: projectPath, tags: project.tags || [], projectType: project.projectType || 'unknown' },
        dependencies: [],
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
    installDependencies(repoDir);
    const nodes = readProjectGraph(repoDir) || readProjectJsonFallback(repoDir);
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
