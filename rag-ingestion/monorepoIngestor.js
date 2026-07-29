import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { embedTexts } from '../shared/embeddings.js';
import { cloneForAnalysis } from './repoClone.js';
import { summarizeMonorepoProject } from './summarizer.js';

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
  const repoDir = await cloneForAnalysis(repo, branch);

  try {
    const nodes = readProjectsFromProjectJson(repoDir);
    const records = [];

    for (const [projectName, node] of Object.entries(nodes)) {
      const data = node.data || {};
      const deps = node.dependencies || [];
      const projectDir = path.resolve(repoDir, data.root || '.');

      // Each project also gets its own read-only agent pass over its actual source, so it has a
      // real semantic "purpose" description to embed - not just structural tags/deps, which match
      // poorly against natural-language ticket descriptions.
      let summary = { purpose: 'unknown', keyModules: [], notablePatterns: [] };
      try {
        summary = await summarizeMonorepoProject({ repo, projectName, cwd: projectDir });
      } catch (err) {
        console.warn(`  agent analysis failed for ${projectName}, continuing with structural metadata only: ${err.message}`);
      }

      const summaryText = [
        `Repository: ${repo}`,
        `Project: ${projectName}`,
        `Path: ${data.root || 'unknown'}`,
        `Type: ${data.projectType || 'unknown'}`,
        `Tags: ${(data.tags || []).join(', ')}`,
        `Depends on: ${deps.map((d) => d.target || d).join(', ')}`,
        `Purpose: ${summary.purpose}`,
        `Key modules: ${(summary.keyModules || []).join(', ')}`,
        `Notable patterns: ${(summary.notablePatterns || []).join(', ')}`,
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
          dependsOn: deps.map((d) => d.target || d),
          purpose: summary.purpose || 'unknown',
          keyModules: summary.keyModules || [],
          notablePatterns: summary.notablePatterns || [],
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
