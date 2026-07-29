import { Pinecone } from '@pinecone-database/pinecone';
import { EMBEDDING_MODEL } from './config.js';

let pineconeClient;

export function getPineconeClient() {
  if (!pineconeClient) {
    if (!process.env.PINECONE_API_KEY) {
      throw new Error('PINECONE_API_KEY is not set');
    }
    pineconeClient = new Pinecone({ apiKey: process.env.PINECONE_API_KEY });
  }
  return pineconeClient;
}

const JINA_EMBEDDINGS_URL = 'https://api.jina.ai/v1/embeddings';

/**
 * Embeds a batch of texts via Jina AI's embeddings API. jina-embeddings-v2-base-code isn't a
 * Pinecone-hosted model, so unlike the previous Pinecone-hosted models, we call Jina directly and
 * upsert the resulting vectors into Pinecone as "bring your own vectors" (see shared/pinecone.js).
 * It's trained specifically on source code + docstring/QA pairs across 30+ languages with an 8k
 * token context window, which suits this repo's code-heavy RAG content better than a
 * general-purpose text model.
 * @param {string[]} texts
 * @param {'passage'|'query'} inputType - kept for call-site compatibility; jina-embeddings-v2
 *   models are symmetric and don't need asymmetric query/passage prefixing like v3+ does.
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts, inputType = 'passage') {
  if (!process.env.JINA_API_KEY) {
    throw new Error('JINA_API_KEY is not set');
  }

  const response = await fetch(JINA_EMBEDDINGS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.JINA_API_KEY}`,
    },
    body: JSON.stringify({
      model: EMBEDDING_MODEL,
      normalized: true,
      input: texts,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Jina embeddings request failed (${response.status}): ${body}`);
  }

  const { data } = await response.json();
  return data.sort((a, b) => a.index - b.index).map((entry) => entry.embedding);
}
