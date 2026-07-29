import 'dotenv/config';
import crypto from 'node:crypto';
import { readRegistry } from './registry.js';
import { ingestApiService } from './apiServiceIngestor.js';
import { ingestMonorepo } from './monorepoIngestor.js';
import { ensureIndexExists, upsertRecords, pruneStale } from '../shared/pinecone.js';

async function main() {
  const runId = crypto.randomUUID();
  console.log(`Starting RAG ingestion run ${runId}`);

  await ensureIndexExists();
  const { api_services, monorepos } = readRegistry();
  const failures = [];

  for (const service of api_services) {
    console.log(`Processing API service: ${service.repo}`);
    try {
      const records = await ingestApiService(service, runId);
      await upsertRecords(records);
      const pruned = await pruneStale(service.repo, runId);
      console.log(`  upserted ${records.length} record(s), pruned ${pruned} stale record(s)`);
    } catch (err) {
      console.error(`  failed to ingest ${service.repo}: ${err.message}`);
      failures.push({ repo: service.repo, error: err.message });
    }
  }

  for (const monorepo of monorepos) {
    console.log(`Processing monorepo: ${monorepo.repo}`);
    try {
      const records = await ingestMonorepo(monorepo, runId);
      await upsertRecords(records);
      const pruned = await pruneStale(monorepo.repo, runId);
      console.log(`  upserted ${records.length} record(s), pruned ${pruned} stale record(s)`);
    } catch (err) {
      console.error(`  failed to ingest ${monorepo.repo}: ${err.message}`);
      failures.push({ repo: monorepo.repo, error: err.message });
    }
  }

  if (failures.length > 0) {
    console.error(`\nRAG ingestion completed with ${failures.length} failure(s):`);
    for (const failure of failures) {
      console.error(`  - ${failure.repo}: ${failure.error}`);
    }
    // Every repo still gets attempted (a failure here doesn't abort the others), but the process
    // must exit non-zero so the CI run itself shows as failed - otherwise these failures are only
    // visible by actually reading the logs, even though the job reports success.
    process.exitCode = 1;
    return;
  }

  console.log('RAG ingestion complete.');
}

main().catch((err) => {
  console.error('Fatal ingestion error:', err);
  process.exit(1);
});
