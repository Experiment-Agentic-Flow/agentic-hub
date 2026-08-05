import { summarizeApiService } from './summarizer.js';
import { embedTexts } from '../shared/embeddings.js';

/** Summarizes + embeds an API service already checked out at `repoDir` (the calling workflow's own checkout). */
export async function ingestApiServiceFromDir({ repo, repoDir, techStackHint }, runId) {
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
}

