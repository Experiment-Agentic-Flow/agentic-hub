export const EMBEDDING_MODEL = process.env.PINECONE_EMBEDDING_MODEL || 'llama-text-embed-v2';
// llama-text-embed-v2 (Pinecone hosted inference) defaults to 1024-dim vectors.
export const EMBEDDING_DIMENSION = 1024;
export const PINECONE_INDEX = process.env.PINECONE_INDEX || 'agentic-hub-knowledge';
