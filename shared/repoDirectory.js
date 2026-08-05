import fs from 'node:fs';
import path from 'node:path';

const DIRECTORY_PATH = path.resolve('data/repo-directory.json');

/** Reads the plain-JSON continuous-summarization directory, or `{}` if it doesn't exist yet. */
export function loadRepoDirectory() {
  try {
    return JSON.parse(fs.readFileSync(DIRECTORY_PATH, 'utf-8'));
  } catch {
    return {};
  }
}

export function saveRepoDirectory(directory) {
  fs.mkdirSync(path.dirname(DIRECTORY_PATH), { recursive: true });
  fs.writeFileSync(DIRECTORY_PATH, `${JSON.stringify(directory, null, 2)}\n`, 'utf-8');
}

/**
 * Dual-write target for knowledge-ingestion's *existing* Pinecone records (see ingestOnPush.js) - keeps
 * a plain-English JSON mirror of every summary alongside the vectors, so candidate resolution can
 * also work off plain LLM judgment over this file (agent-logic/repoDirectoryLookup.js) without
 * changing anything about how the existing Pinecone ingestion itself runs. Same summaries, second
 * output format, zero extra LLM calls.
 *
 * `fullReplace: true` (a full baseline monorepo pass, where `records` is authoritative for every
 * project that currently exists) replaces the repo's whole `projects` list instead of merging, so
 * projects removed since the last full pass don't linger.
 */
export function upsertRepoDirectoryFromRecords(repo, records, { deletedIds = [], fullReplace = false } = {}) {
  const directory = loadRepoDirectory();
  const existingPurpose = directory[repo]?.purpose;

  if (fullReplace) {
    directory[repo] = { type: 'monorepo', purpose: existingPurpose, projects: [] };
  }

  for (const record of records) {
    const meta = record.metadata || {};

    if (meta.type === 'api_service') {
      directory[repo] = {
        type: 'api_service',
        purpose: meta.purpose,
        techStack: meta.techStack || [],
        keyModules: meta.keyModules || [],
        notablePatterns: meta.notablePatterns || [],
        updatedAt: meta.updatedAt,
      };
      continue;
    }

    if (meta.type === 'monorepo_project') {
      const entry = directory[repo]?.type === 'monorepo' ? directory[repo] : { type: 'monorepo', purpose: existingPurpose, projects: [] };
      entry.projects = entry.projects || [];

      const projectName = record.id.slice(`${repo}::`.length);
      const project = {
        name: projectName,
        path: meta.projectPath,
        purpose: meta.purpose,
        keyModules: meta.keyModules || [],
        notablePatterns: meta.notablePatterns || [],
        tags: meta.tags || [],
        updatedAt: meta.updatedAt,
      };
      const existingIndex = entry.projects.findIndex((p) => p.name === projectName);
      if (existingIndex >= 0) entry.projects[existingIndex] = project;
      else entry.projects.push(project);
      directory[repo] = entry;
    }
  }

  if (deletedIds.length && directory[repo]?.projects) {
    const deletedNames = new Set(deletedIds.map((id) => id.slice(`${repo}::`.length)));
    directory[repo].projects = directory[repo].projects.filter((p) => !deletedNames.has(p.name));
  }

  saveRepoDirectory(directory);
}

/**
 * Local, non-Pinecone replacement for knowledge-ingestion/ingestionState.js's bookkeeping - tracks the
 * last-ingested commit SHA per repo directly in repo-directory.json instead of a Pinecone vector,
 * since Pinecone writes are currently disabled (see shared/pinecone.js). Stored under a reserved
 * `_ingestionState` top-level key, separate from real repo entries, so a `fullReplace` monorepo
 * pass (which overwrites `directory[repo]` wholesale) never wipes it.
 */
export function getLocalIngestionState(repo) {
  const state = loadRepoDirectory()._ingestionState?.[repo];
  return state ? { lastSha: state.lastSha } : null;
}

export function setLocalIngestionState(repo, sha) {
  const directory = loadRepoDirectory();
  directory._ingestionState = directory._ingestionState || {};
  directory._ingestionState[repo] = { lastSha: sha, updatedAt: new Date().toISOString() };
  saveRepoDirectory(directory);
}
