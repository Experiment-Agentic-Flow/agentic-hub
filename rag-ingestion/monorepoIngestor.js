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
  await git.clone(remoteUrl, dest, [
    '--filter=blob:none',
    '--depth=1',
    '--branch',
    branch,
    '--single-branch',
  ]);
  return dest;
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
