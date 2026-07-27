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

  for (const service of api_services) {
    console.log(`Processing API service: ${service.repo}`);
    try {
      const records = await ingestApiService(service, runId);
      await upsertRecords(records);
      const pruned = await pruneStale(service.repo, runId);
      console.log(`  upserted ${records.length} record(s), pruned ${pruned} stale record(s)`);
    } catch (err) {
      console.error(`  failed to ingest ${service.repo}: ${err.message}`);
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
    }
  }

  console.log('RAG ingestion complete.');
}

main().catch((err) => {
  console.error('Fatal ingestion error:', err);
  process.exit(1);
});
