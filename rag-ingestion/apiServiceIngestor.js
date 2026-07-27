import { getFileContent, getFileTree } from './githubContent.js';
import { summarizeApiService } from './summarizer.js';
import { embedTexts } from '../shared/embeddings.js';

// .NET Core repos don't need their build output/restored packages scanned for context.
const IGNORED_DIR_PATTERN = /(^|\/)(bin|obj|packages|node_modules|\.git)\//;

/** Fetches README/manifest/source tree, summarizes via LLM, embeds, and returns Pinecone-ready records. */
export async function ingestApiService(service, runId) {
  const { repo, branch = 'main', manifest, tech_stack: techStackHint } = service;

  const fullTree = await getFileTree(repo, branch);
  const relevantTree = fullTree.filter((entryPath) => !IGNORED_DIR_PATTERN.test(entryPath));

  // .NET Core services have no fixed manifest filename like package.json - auto-detect the
  // solution/project file from the tree unless the registry explicitly overrides it.
  const manifestPath =
    manifest || relevantTree.find((p) => p.endsWith('.sln')) || relevantTree.find((p) => p.endsWith('.csproj'));

  const [readme, manifestContent] = await Promise.all([
    getFileContent(repo, 'README.md', branch),
    manifestPath ? getFileContent(repo, manifestPath, branch) : Promise.resolve(null),
  ]);

  const summary = await summarizeApiService({ repo, readme, manifest: manifestContent, fileTree: relevantTree });
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
        runId,
        updatedAt: new Date().toISOString(),
      },
    },
  ];
}
