import fs from 'node:fs';
import { summarizeApiService } from './summarizer.js';
import { cloneForAnalysis } from './repoClone.js';
import { embedTexts } from '../shared/embeddings.js';

/** Clones the repo, has the agent explore the real codebase, summarizes, embeds, and returns Pinecone-ready records. */
export async function ingestApiService(service, runId) {
  const { repo, branch = 'main', tech_stack: techStackHint } = service;

  const repoDir = await cloneForAnalysis(repo, branch);
  try {
    const summary = await summarizeApiService({ repo, cwd: repoDir });
    const techStack = summary.techStack?.length ? summary.techStack : [techStackHint || 'dotnet'];

    const summaryText = [
      `Repository: ${repo}`,
      `Purpose: ${summary.purpose}`,
      `Tech stack: ${techStack.join(', ')}`,
      `Key modules: ${(summary.keyModules || []).join(', ')}`,
      `Dependencies: ${(summary.dependencies || []).join(', ')}`,
      `Notable patterns: ${(summary.notablePatterns || []).join(', ')}`,
    ].join('\n');

    const [vector] = await embedTexts([summaryText], 'passage');

    return [
      {
        id: `${repo}::service-summary`,
        values: vector,
        metadata: {
          repo,
          type: 'api_service',
          techStack,
          purpose: summary.purpose || 'unknown',
          keyModules: summary.keyModules || [],
          dependencies: summary.dependencies || [],
          notablePatterns: summary.notablePatterns || [],
          runId,
          updatedAt: new Date().toISOString(),
        },
      },
    ];
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
}
