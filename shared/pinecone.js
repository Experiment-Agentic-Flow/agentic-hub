import { getPineconeClient } from './embeddings.js';
import { PINECONE_INDEX, EMBEDDING_DIMENSION } from './config.js';

export async function getIndex() {
  const client = getPineconeClient();
  return client.index(PINECONE_INDEX);
}

/** Creates the serverless index if it doesn't already exist. Safe to call every run. */
export async function ensureIndexExists() {
  const client = getPineconeClient();
  const existing = await client.listIndexes();
  const found = existing.indexes?.some((i) => i.name === PINECONE_INDEX);
  if (!found) {
    await client.createIndex({
      name: PINECONE_INDEX,
      dimension: EMBEDDING_DIMENSION,
      metric: 'cosine',
      spec: { serverless: { cloud: 'aws', region: 'us-east-1' } },
      waitUntilReady: true,
    });
  }
}

export async function upsertRecords(records, namespace = 'default') {
  if (records.length === 0) return;
  const index = await getIndex();
  const BATCH_SIZE = 100;
  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    await index.namespace(namespace).upsert(batch);
  }
}

/** Deletes specific vector ids outright - used by incremental ingestion to drop removed/renamed projects. */
export async function deleteRecords(ids, namespace = 'default') {
  if (!ids || ids.length === 0) return;
  const index = await getIndex();
  await index.namespace(namespace).deleteMany(ids);
}

/**
 * Deletes vectors belonging to `repo` whose metadata.runId doesn't match the current run,
 * i.e. anything that no longer exists / wasn't re-embedded in this ingestion pass. Only valid
 * after a *full* pass over the repo (every project re-embedded) - never call this after an
 * incremental/partial run, since it would delete every project that simply wasn't touched.
 * The `_ingestion-state` tracking record (see rag-ingestion/ingestionState.js) is excluded, since
 * it's a bookkeeping vector, not ingested content.
 */
export async function pruneStale(repo, currentRunId, namespace = 'default') {
  const index = await getIndex();
  // Pinecone rejects an all-zero query vector ("must contain at least one non-zero value") - the
  // actual value doesn't affect which vectors match the `filter` below, only their ranking.
  const placeholderVector = new Array(EMBEDDING_DIMENSION).fill(0);
  placeholderVector[0] = 1;
  const result = await index.namespace(namespace).query({
    vector: placeholderVector,
    topK: 1000,
    filter: { repo: { $eq: repo }, type: { $ne: 'ingestion_state' } },
    includeMetadata: true,
  });

  const staleIds = (result.matches || [])
    .filter((match) => match.metadata?.runId !== currentRunId)
    .map((match) => match.id);

  if (staleIds.length > 0) {
    await index.namespace(namespace).deleteMany(staleIds);
  }
  return staleIds.length;
}

export async function queryByVector(vector, { topK = 5, filter } = {}, namespace = 'default') {
  const index = await getIndex();
  return index.namespace(namespace).query({ vector, topK, filter, includeMetadata: true });
}
