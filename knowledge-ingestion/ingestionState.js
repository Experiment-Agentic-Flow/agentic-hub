import { getIndex } from '../shared/pinecone.js';
import { EMBEDDING_DIMENSION } from '../shared/config.js';

// Pinecone rejects an all-zero dense vector ("must contain at least one non-zero value"), so this
// bookkeeping record (never used for similarity search - see the `type: "ingestion_state"`
// exclusion filters) uses a single placeholder 1 instead of a true zero vector.
const PLACEHOLDER_VECTOR = new Array(EMBEDDING_DIMENSION).fill(0);
PLACEHOLDER_VECTOR[0] = 1;

/** Deterministic id for the single bookkeeping vector that tracks `repo`'s last-ingested commit. */
function stateId(repo) {
  return `${repo}::_ingestion-state`;
}

/**
 * Reads back the commit SHA `repo` was last ingested up to, so a push-triggered run knows this is
 * genuinely a fresh commit, and a manual `workflow_dispatch` (which has no "before" of its own)
 * knows what to diff against to only re-analyze what changed since the last successful run.
 * Returns `null` if `repo` has never been ingested before.
 */
export async function getIngestionState(repo, namespace = 'default') {
  const index = await getIndex();
  const result = await index.namespace(namespace).fetch([stateId(repo)]);
  const record = result.records?.[stateId(repo)];
  return record ? { lastSha: record.metadata?.lastSha } : null;
}

/** Persists the commit SHA this run ingested up to. Not real content - excluded from search/pruning by `type`. */
export async function setIngestionState(repo, sha, namespace = 'default') {
  const index = await getIndex();
  await index.namespace(namespace).upsert([
    {
      id: stateId(repo),
      values: PLACEHOLDER_VECTOR,
      metadata: { repo, type: 'ingestion_state', lastSha: sha, updatedAt: new Date().toISOString() },
    },
  ]);
}

