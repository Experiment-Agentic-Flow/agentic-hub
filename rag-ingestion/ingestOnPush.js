import 'dotenv/config';
import crypto from 'node:crypto';
import { ensureIndexExists, upsertRecords, deleteRecords, pruneStale } from '../shared/pinecone.js';
import { ingestApiServiceFromDir } from './apiServiceIngestor.js';
import {
  ingestMonorepoFull,
  ingestMonorepoProjects,
  resolveAffectedProjectNames,
  resolveDeletedProjectIds,
} from './monorepoIngestor.js';
import { diffBetween, currentHeadSha } from './gitDiff.js';
import { upsertRepoDirectoryFromRecords, getLocalIngestionState, setLocalIngestionState } from '../shared/repoDirectory.js';

const ZERO_SHA = '0'.repeat(40);

/**
 * Per-repo incremental ingestion, run by a workflow living *in the target repo itself* (not
 * agentic-hub) on every push, or manually via `workflow_dispatch`.
 * Env vars are supplied entirely by that workflow - see e.g. mepworkspace's
 * `.github/workflows/rag-ingestion.yml`.
 *
 * Required: REPO (org/name), REPO_TYPE ("api_service" | "monorepo"), REPO_DIR (existing checkout).
 * Optional: EVENT_NAME, BEFORE_SHA, AFTER_SHA (default: current HEAD), FORCE_FULL ("true" to force
 * a full re-ingestion regardless of diff state), RAG_INGEST_CONCURRENCY (monorepo full-baseline
 * passes only - how many Nx projects to analyze in parallel; default 6).
 */
function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var ${name}`);
  return value;
}

async function main() {
  const repo = requireEnv('REPO');
  const repoType = requireEnv('REPO_TYPE');
  const repoDir = requireEnv('REPO_DIR');
  const eventName = process.env.EVENT_NAME || 'workflow_dispatch';
  const forceFull = process.env.FORCE_FULL === 'true';
  const afterSha = process.env.AFTER_SHA || currentHeadSha(repoDir);
  const beforeShaRaw = process.env.BEFORE_SHA;

  const runId = crypto.randomUUID();
  console.log(`[${repo}] ingestion run ${runId} (event=${eventName}, sha=${afterSha.slice(0, 7)})`);

  await ensureIndexExists();

  const state = getLocalIngestionState(repo);
  // A real push event's own before/after range is authoritative. A manual workflow_dispatch has
  // no "before" of its own, so it falls back to whatever was last successfully ingested - this is
  // also what lets a re-run catch up on any push whose own workflow run failed.
  const fromSha = beforeShaRaw && beforeShaRaw !== ZERO_SHA ? beforeShaRaw : state?.lastSha;

  if (!forceFull && fromSha === afterSha) {
    console.log('  already up to date - skipping');
    return;
  }

  const diff = !forceFull && fromSha ? diffBetween(repoDir, fromSha, afterSha) : null;

  if (repoType === 'api_service') {
    // Whole-project analysis - one summary call is cheap, so there's no benefit to diffing at
    // file granularity here; just skip the call entirely when nothing actually changed.
    if (diff && diff.changedFiles.length === 0) {
      console.log('  no file changes detected - skipping');
    } else {
      const records = await ingestApiServiceFromDir({ repo, repoDir }, runId);
      await upsertRecords(records);
      upsertRepoDirectoryFromRecords(repo, records);
      console.log(`  summarized and wrote ${records.length} record(s) to repo-directory.json`);
    }
  } else if (repoType === 'monorepo') {
    if (!diff) {
      console.log('  no prior ingestion state (or diff unavailable) - running full baseline ingest');
      const records = await ingestMonorepoFull({ repo, repoDir }, runId);
      const pruned = await pruneStale(repo, runId);
      upsertRepoDirectoryFromRecords(repo, records, { fullReplace: true });
      console.log(`  analyzed ${records.length} project(s), wrote them to repo-directory.json (pruned ${pruned} stale Pinecone record(s))`);
    } else if (diff.changedFiles.length === 0) {
      console.log('  no file changes detected - skipping');
    } else {
      const affected = resolveAffectedProjectNames({ repoDir, changedFiles: diff.changedFiles });
      const deletedIds = resolveDeletedProjectIds({
        repo,
        repoDir,
        fromSha,
        deletedProjectJsonPaths: diff.deletedProjectJsonPaths,
      });

      if (affected.size === 0 && deletedIds.length === 0) {
        console.log('  changed files did not map to any Nx project - skipping');
      } else {
        const records = await ingestMonorepoProjects({ repo, repoDir, projectNames: [...affected] }, runId);
        if (deletedIds.length) await deleteRecords(deletedIds);
        upsertRepoDirectoryFromRecords(repo, records, { deletedIds });
        console.log(
          `  re-analyzed ${records.length} affected project(s), updated repo-directory.json: ${[...affected].join(', ') || 'none'}; ` +
            `removed ${deletedIds.length} deleted project(s)`
        );
      }
    }
  } else {
    throw new Error(`Unknown REPO_TYPE "${repoType}" (expected "api_service" or "monorepo")`);
  }

  setLocalIngestionState(repo, afterSha);
  console.log('Done.');
}

main().catch((err) => {
  console.error('Fatal ingestion error:', err);
  process.exit(1);
});
