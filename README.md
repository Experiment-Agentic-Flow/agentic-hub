# agent-hub

Central repository powering an autonomous AI developer system: nightly RAG ingestion of your
organization's codebases, plus LLM coding agents that turn Jira tickets into pull requests.

No agent logic lives inside your production codebases — everything is centralized here.

## Architecture

```
Jira (webhook) --> n8n (router) --> GitHub repository_dispatch --> agent-hub (this repo)
                                                                      |
                                                    +-----------------+-----------------+
                                                    |                                   |
                                       .github/workflows/unified-agent-runner.yml   .github/workflows/rag-ingestion-cron.yml
                                        (bugfix-agent.js / tech-debt-agent.js)          (nightly, rebuilds the vector DB)
```

- **Router** — Jira + n8n. Jira fires a webhook to n8n on ticket creation. n8n forwards just the ticket key and type via a
  `repository_dispatch` to this repo - agent-hub itself fetches the ticket description from Jira, resolves the target
  repo(s) (via the parent ticket for bugfix, or a vector-DB search for tech-debt), and decides what to change.
- **Memory** — Pinecone (serverless vector DB), populated nightly with auto-healed summaries
  of every registered repo.
- **Brain & Hands** — this repo: ingestion scripts, agent logic, and the GitHub Actions
  workflows that run them against target repositories using an org-level PAT.

## Repository layout

| Path | Purpose |
|---|---|
| [rag-registry.json](rag-registry.json) | Allowlist of repos to ingest, split into `api_services` and `monorepos`. |
| [.github/workflows/rag-ingestion-cron.yml](.github/workflows/rag-ingestion-cron.yml) | Nightly cron that rebuilds the vector DB. |
| [.github/workflows/unified-agent-runner.yml](.github/workflows/unified-agent-runner.yml) | Entry point triggered by n8n via `repository_dispatch`. |
| [rag-ingestion/](rag-ingestion/index.js) | Scripts that auto-heal API READMEs and parse Nx monorepo graphs into embeddings. |
| [agent-logic/](agent-logic/copilotAgent.js) | The LLM code-editing agents: [bugfix-agent.js](agent-logic/bugfix-agent.js) and [tech-debt-agent.js](agent-logic/tech-debt-agent.js). |
| [shared/](shared/config.js) | Shared Pinecone / Copilot CLI clients and config used by both layers. |

## The nightly RAG ingestion flow

1. **Read registry** — [rag-ingestion/index.js](rag-ingestion/index.js) reads [rag-registry.json](rag-registry.json).
2. **Process Nx monorepos** — [rag-ingestion/monorepoIngestor.js](rag-ingestion/monorepoIngestor.js) does a shallow/sparse
   clone, runs `npx nx graph` (falling back to scanning `project.json` files if that fails), and embeds each project separately.
3. **Process API services** — API services are all .NET Core, so [rag-ingestion/apiServiceIngestor.js](rag-ingestion/apiServiceIngestor.js)
   fetches `README.md`, auto-detects the `.sln`/`.csproj` manifest (overridable via `manifest` in the registry), and scans the
   whole repo tree (excluding `bin`/`obj`/`packages`), then
   [rag-ingestion/summarizer.js](rag-ingestion/summarizer.js) asks the GitHub Copilot CLI to produce a factual, ground-truth JSON summary.
4. **Sync vector DB** — [shared/pinecone.js](shared/pinecone.js) embeds text via Pinecone's hosted inference API, upserts
   with `{ repo, type, runId, updatedAt, ... }` metadata, and prunes any vectors for that repo not refreshed in the current run.

## The agentic ticket lifecycle

1. **Ticket ingestion** — Jira webhook → n8n.
2. **Trigger GitHub Hub** — n8n forwards only the ticket key and type: it sends a `repository_dispatch` with event type
   `bugfix-ticket` or `tech-debt-ticket` and a `client_payload` of `{ ticket_key }`. Everything else - description, target
   repo(s), branch, path - is resolved by agent-hub itself, not by n8n.

   (An optional `target_repos: [{ repo, branch, path }, ...]` array, or legacy single `target_repo`/`target_branch`/`target_path`
   fields, are still accepted for the rare case where n8n already knows the repo(s) to target.)
3. **Agent execution** — [.github/workflows/unified-agent-runner.yml](.github/workflows/unified-agent-runner.yml):
   - **Fetch ticket details** — [agent-logic/fetchTicket.js](agent-logic/fetchTicket.js) fetches the ticket's
     summary/description straight from Jira using the ticket key.
   - **Gather candidate repos** — [agent-logic/repoCandidates.js](agent-logic/repoCandidates.js) gathers candidate repo(s)
     for [agent-logic/bugfix-agent.js](agent-logic/bugfix-agent.js) / [agent-logic/tech-debt-agent.js](agent-logic/tech-debt-agent.js)
     to consider, in priority order: an explicit `target_repo` always wins; otherwise bugfix tickets look up **every** repo
     referenced by the Jira parent ticket's linked PRs *and* branches ([agent-logic/jira.js](agent-logic/jira.js)) - a
     parent story/epic can span several repos, so all of them become candidates; otherwise (tech-debt always, since it
     has no parent ticket) an adaptive set of "appropriate" candidates comes from a vector-DB search
     ([agent-logic/contextRetrieval.js](agent-logic/contextRetrieval.js)) - one match if there's a clear winner, several if
     more than one repo is a genuinely competitive match. Every vector-search-derived candidate uses its registered
     branch from [rag-registry.json](rag-registry.json) rather than guessing a default.
   - **Clone and decide** — each surviving candidate (skipping any that already has an open PR for this ticket) is shallow
     -cloned into its own subfolder of the workspace ([agent-logic/repoWorkspace.js](agent-logic/repoWorkspace.js)). If
     there's only one candidate, the coding agent works on it directly. If there are several, one Copilot CLI session is
     given all the checked-out candidates side by side and decides which single repo to modify based on the real code,
     not just vector-search metadata - then edits only inside that repo's subfolder.
4. **Commit and notify** — for the chosen repo, the agent runs a GitHub Copilot CLI coding session
   ([agent-logic/copilotAgent.js](agent-logic/copilotAgent.js)) to read/write files, commits and pushes a branch, opens a PR
   ([agent-logic/githubPr.js](agent-logic/githubPr.js)), and comments that repo's PR link back onto the Jira ticket
   ([agent-logic/jira.js](agent-logic/jira.js)) — so a multi-repo ticket ends up with one comment per repo/PR.

## Setup

1. `npm install`
2. Install the GitHub Copilot CLI globally: `npm install -g @github/copilot` (requires an active Copilot subscription).
3. Copy [.env.example](.env.example) to `.env` and fill in credentials for local runs.
4. Add the same values as GitHub Actions **secrets** (`COPILOT_GITHUB_TOKEN`, `PINECONE_API_KEY`, `ORG_GITHUB_PAT`,
   `JIRA_EMAIL`, `JIRA_API_TOKEN`) and **variables** (`COPILOT_MODEL`, `PINECONE_INDEX`, `PINECONE_EMBEDDING_MODEL`, `JIRA_BASE_URL`) on this repo.
   `COPILOT_GITHUB_TOKEN` should be a PAT (fine-grained or classic) with the "Copilot Requests" permission enabled.
5. Populate [rag-registry.json](rag-registry.json) with your real `api_services` and `monorepos`.
6. `ORG_GITHUB_PAT` must be an organization-level PAT (or GitHub App installation token) with `repo` and `pull_request` scope
   across every target repository.
7. Point your n8n workflow's HTTP node at
   `POST https://api.github.com/repos/<org>/agent-hub/dispatches` with `event_type: bugfix-ticket` or `tech-debt-ticket`.

## Local commands

```bash
npm run ingest           # run RAG ingestion once, locally
npm run agent:bugfix     # run the bugfix agent (requires TICKET_KEY, TICKET_DESCRIPTION; TARGET_REPO/WORKSPACE_DIR optional)
npm run agent:tech-debt  # run the tech-debt agent (also accepts an optional TARGET_PATH)
```
