import fs from 'node:fs';
import path from 'node:path';
import fg from 'fast-glob';
import { embedTexts } from '../shared/embeddings.js';
import { upsertRecords } from '../shared/pinecone.js';
import { summarizeMonorepoProject } from './summarizer.js';
import { readFileAtRevision } from './gitDiff.js';

// Each project is a separate `copilot` CLI process (tens of seconds each); with hundreds of
// projects in a large Nx workspace, running them one at a time turns a full baseline ingest into a
// multi-hour run. RAG_INGEST_CONCURRENCY lets that be tuned per environment.
const DEFAULT_CONCURRENCY = 6;

/** Runs `worker` over `items` with at most `limit` in flight at once, preserving result order. */
async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runNext() {
    while (nextIndex < items.length) {
      const current = nextIndex++;
      results[current] = await worker(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
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
export function readProjectsFromProjectJson(repoDir) {
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

/** Summarizes + embeds one already-checked-out Nx project. Shared by the full and incremental paths below. */
async function buildProjectRecord({ repo, projectName, node }, runId) {
  const data = node.data || {};
  const deps = node.dependencies || [];

  // Each project also gets its own read-only agent pass over its actual source, so it has a
  // real semantic "purpose" description to embed - not just structural tags/deps, which match
  // poorly against natural-language ticket descriptions.
  let summary = { purpose: 'unknown', keyModules: [], notablePatterns: [] };
  try {
    summary = await summarizeMonorepoProject({ repo, projectName, cwd: node.projectDir });
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

  return {
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
  };
}

/** (Re)analyzes only the named projects out of an already-checked-out monorepo at `repoDir`,
 * upserting each project's vector to Pinecone as soon as it's ready rather than waiting for every
 * project in the batch to finish analysis first. */
export async function ingestMonorepoProjects({ repo, repoDir, projectNames }, runId) {
  const nodes = readProjectsFromProjectJson(repoDir);
  const projectsToBuild = projectNames
    .map((projectName) => ({ projectName, node: nodes[projectName] }))
    .filter(({ node }) => node); // project no longer exists (moved/deleted) - nothing to re-embed

  const concurrency = Number(process.env.RAG_INGEST_CONCURRENCY) || DEFAULT_CONCURRENCY;
  let completed = 0;

  return mapWithConcurrency(projectsToBuild, concurrency, async ({ projectName, node }) => {
    node.projectDir = path.resolve(repoDir, node.data.root || '.');
    const record = await buildProjectRecord({ repo, projectName, node }, runId);
    await upsertRecords([record]);
    completed += 1;
    console.log(`  [${completed}/${projectsToBuild.length}] analyzed + upserted ${projectName}`);
    return record;
  });
}

/** Full baseline pass: (re)analyzes every Nx project in an already-checked-out monorepo at `repoDir`. */
export async function ingestMonorepoFull({ repo, repoDir }, runId) {
  const nodes = readProjectsFromProjectJson(repoDir);
  return ingestMonorepoProjects({ repo, repoDir, projectNames: Object.keys(nodes) }, runId);
}

/**
 * Maps a flat list of changed file paths (from a git diff) to the set of Nx project names they
 * fall under, so a push only triggers re-analysis of the project(s) actually touched instead of
 * every project.json in the monorepo. A file belongs to whichever declared project root is its
 * longest (most specific) matching ancestor path.
 */
export function resolveAffectedProjectNames({ repoDir, changedFiles }) {
  const nodes = readProjectsFromProjectJson(repoDir);
  const projectsByRoot = Object.entries(nodes)
    .map(([name, node]) => [(node.data.root || '').replace(/\\/g, '/'), name])
    .sort((a, b) => b[0].length - a[0].length);

  const affected = new Set();
  for (const file of changedFiles) {
    const normalized = file.replace(/\\/g, '/');
    const match = projectsByRoot.find(
      ([root]) => root === '' || root === '.' || normalized === root || normalized.startsWith(`${root}/`)
    );
    if (match) affected.add(match[1]);
  }
  return affected;
}

/**
 * For every `project.json` a diff shows as deleted, resolves the project's old name (as of
 * `fromSha`) and returns its vector id for deletion - but only if that name isn't still present in
 * the current (post-change) project list, which would mean it was actually just moved/renamed
 * rather than removed (its new path is picked up separately via `resolveAffectedProjectNames`).
 */
export function resolveDeletedProjectIds({ repo, repoDir, fromSha, deletedProjectJsonPaths }) {
  if (!deletedProjectJsonPaths?.length) return [];
  const currentNames = new Set(Object.keys(readProjectsFromProjectJson(repoDir)));
  const ids = [];

  for (const filePath of deletedProjectJsonPaths) {
    try {
      const oldProject = JSON.parse(readFileAtRevision(repoDir, fromSha, filePath));
      const oldName = oldProject.name || path.dirname(filePath);
      if (!currentNames.has(oldName)) {
        ids.push(`${repo}::${oldName}`);
      }
    } catch {
      // old blob unreadable (e.g. shallow history) - a subsequent full baseline pass reconciles it
    }
  }
  return ids;
}
