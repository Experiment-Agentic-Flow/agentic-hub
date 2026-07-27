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

/**
 * Embeds a batch of texts using Pinecone's hosted inference API.
 * @param {string[]} texts
 * @param {'passage'|'query'} inputType - 'passage' for documents being indexed, 'query' for search queries.
 * @returns {Promise<number[][]>}
 */
export async function embedTexts(texts, inputType = 'passage') {
  const client = getPineconeClient();
  const response = await client.inference.embed(EMBEDDING_MODEL, texts, {
    inputType,
    truncate: 'END',
  });
  return response.data.map((entry) => entry.values);
}
