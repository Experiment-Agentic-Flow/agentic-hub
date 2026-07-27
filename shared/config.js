export const EMBEDDING_MODEL = process.env.PINECONE_EMBEDDING_MODEL || 'multilingual-e5-large';
// multilingual-e5-large (Pinecone hosted inference) produces 1024-dim vectors.
export const EMBEDDING_DIMENSION = 1024;
export const PINECONE_INDEX = process.env.PINECONE_INDEX || 'agentic-hub-knowledge';
