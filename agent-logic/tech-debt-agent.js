import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { runAgentLoop } from './copilotAgent.js';
import { createBranch, commitAndPush } from './git.js';
import { openPullRequest, findExistingPullRequest } from './githubPr.js';
import { addJiraComment } from './jira.js';
import { retrieveRelatedContext } from './contextRetrieval.js';
import { gatherCandidates } from './repoCandidates.js';
import { cloneCandidate, sanitizeRepoDirName } from './repoWorkspace.js';

async function main() {
  const {
    TICKET_KEY,
    TICKET_DESCRIPTION,
    TARGET_REPO,
    TARGET_PATH,
    TARGET_BRANCH,
    WORKSPACE_DIR = path.resolve('workspace'),
  } = process.env;

  if (!TICKET_KEY || !TICKET_DESCRIPTION) {
    throw new Error('TICKET_KEY and TICKET_DESCRIPTION are required env vars');
  }

  const branchName = `task/${TICKET_KEY.toLowerCase()}`;

  // Tech-debt tickets have no parent ticket to fall back on - candidates always come from either
  // an explicit target repo or a vector-DB search.
  let candidates = await gatherCandidates({
    ticketKey: TICKET_KEY,
    ticketType: 'tech-debt-ticket',
    description: TICKET_DESCRIPTION,
    targetRepo: TARGET_REPO,
    targetBranch: TARGET_BRANCH,
    targetPath: TARGET_PATH,
  });

  if (candidates.length === 0) {
    throw new Error(`Could not identify any candidate repo for ${TICKET_KEY} from the vector DB`);
  }

  const openCandidates = [];
  for (const candidate of candidates) {
    const existingPr = await findExistingPullRequest({ repo: candidate.repo, head: branchName, base: candidate.branch });
    if (existingPr) {
      console.log(`An open PR already exists for ${TICKET_KEY} on ${candidate.repo}, skipping candidate: ${existingPr.html_url}`);
      continue;
    }
    openCandidates.push(candidate);
  }

  if (openCandidates.length === 0) {
    console.log('Every candidate repo already has an open PR for this ticket; nothing to do.');
    return;
  }
  candidates = openCandidates;

  console.log(
    `Candidate repo(s) for ${TICKET_KEY}: ${candidates.map((c) => `${c.repo} (${c.path}, ${c.source})`).join(', ')}`
  );

  fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
  const candidateDirs = {};
  for (const candidate of candidates) {
    console.log(`Cloning ${candidate.repo}...`);
    candidateDirs[candidate.repo] = await cloneCandidate(WORKSPACE_DIR, candidate);
    await createBranch(candidateDirs[candidate.repo], branchName);
  }

  let chosenRepo = candidates[0].repo;
  let result;

  if (candidates.length === 1) {
    const candidate = candidates[0];
    console.log(`Running tech-debt agent for ${TICKET_KEY} on ${chosenRepo} (${candidate.path})`);

    let relatedContext = [];
    try {
      relatedContext = await retrieveRelatedContext(TICKET_DESCRIPTION, chosenRepo);
    } catch (err) {
      console.warn(`Vector context retrieval failed, continuing without it: ${err.message}`);
    }

    const scopedRoot = path.resolve(candidateDirs[chosenRepo], candidate.path);
    const contextBlock = relatedContext.length
      ? `\n\nRelated architectural context from the knowledge base:\n${relatedContext
          .map((c) => `- ${c.id} (score ${c.score.toFixed(2)}): ${JSON.stringify(c.metadata)}`)
          .join('\n')}`
      : '';

    result = await runAgentLoop({
      rootDir: scopedRoot,
      systemPrompt: `You are an autonomous senior software engineer paying down tech debt in ${chosenRepo}, scoped strictly to path "${candidate.path}".
Use the provided tools to explore only this scope and apply a focused refactor. Do not touch files outside this scope.`,
      task: `Tech debt ticket ${TICKET_KEY}:\n\n${TICKET_DESCRIPTION}${contextBlock}`,
    });
  } else {
    console.log(`Multiple candidate repos for ${TICKET_KEY}; letting the agent inspect and choose one.`);
    const candidateList = candidates
      .map(
        (c) =>
          `- ${sanitizeRepoDirName(c.repo)}/  (repo: ${c.repo}, likely path: ${c.path}, matched via: ${c.source})`
      )
      .join('\n');

    result = await runAgentLoop({
      rootDir: WORKSPACE_DIR,
      systemPrompt: `You are an autonomous senior software engineer. It isn't yet certain which repository this tech-debt
ticket belongs to, so several candidates have been checked out as subfolders of the current working directory:
${candidateList}

Inspect each candidate's code to determine which ONE repository (and, if it's a monorepo, which project path within it)
this ticket actually targets, then apply a focused refactor ONLY inside that repository's subfolder. Do not modify
files in any other candidate.`,
      task: `Tech debt ticket ${TICKET_KEY}:\n\n${TICKET_DESCRIPTION}`,
      extraResponseFields: {
        chosenRepo: `<exact repo identifier of the ONE repo you modified, one of: ${candidates.map((c) => c.repo).join(', ')}>`,
      },
    });

    if (result.chosenRepo && candidateDirs[result.chosenRepo]) {
      chosenRepo = result.chosenRepo;
    } else {
      console.warn(`Agent did not report a valid chosenRepo; defaulting to ${chosenRepo}`);
    }
  }

  const chosenBranch = candidates.find((c) => c.repo === chosenRepo)?.branch || TARGET_BRANCH || 'main';
  const chosenPath = candidates.find((c) => c.repo === chosenRepo)?.path || TARGET_PATH || '.';
  const pushed = await commitAndPush(candidateDirs[chosenRepo], branchName, `${result.commitMessage}\n\nAddresses ${TICKET_KEY}`);
  if (!pushed) {
    console.log(`No changes were made by the agent in ${chosenRepo}; skipping PR creation.`);
    return;
  }

  const prUrl = await openPullRequest({
    repo: chosenRepo,
    base: chosenBranch,
    head: branchName,
    title: `[${TICKET_KEY}] ${result.commitMessage}`,
    body: `${result.prSummary}\n\nAutomated tech-debt cleanup generated by agent-hub for ${TICKET_KEY}, scoped to \`${chosenPath}\`.`,
  });

  console.log(`Opened PR: ${prUrl}`);
  await addJiraComment(TICKET_KEY, `agent-hub opened a tech-debt cleanup PR in ${chosenRepo} (${chosenPath}) for this ticket: ${prUrl}`);
}

main().catch((err) => {
  console.error('Tech-debt agent failed:', err);
  process.exit(1);
});
