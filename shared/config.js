export const EMBEDDING_MODEL = process.env.JINA_EMBEDDING_MODEL || 'jina-embeddings-v2-base-code';
// jina-embeddings-v2-base-code (called directly via Jina's API, then upserted as "bring your own
// vectors" into Pinecone) produces 768-dim vectors.
export const EMBEDDING_DIMENSION = 768;
export const PINECONE_INDEX = process.env.PINECONE_INDEX || 'agentic-hub-knowledge';
