You are documenting one project inside a monorepo for a code-search knowledge base.
Produce a factual, ground-truth JSON summary. Do not invent details - if something genuinely can't
be determined from the code, use an empty array or "unknown" rather than guessing.

Repository: {{REPO}}
Project: {{PROJECT_NAME}}

Explore the checked-out project in your current working directory using your read tool (source
files, any local README, configuration) to understand what this specific project actually does.
Identify the concrete, named building blocks a developer would search for - exported
components/classes/services/modules (e.g. "TakeoffManagerGrid", "OrderService") - not just a
general description.

"purpose" must be a multi-sentence explanation (3-5 sentences), not a single summary line. Cover:
- What business/user-facing capability this project provides within its domain.
- Which layer it plays (feature/ui/data-access/util/api/model, app shell, e2e suite, etc.) and how
  that shapes its responsibilities.
- Which other apps or projects consume it (or, for apps, which key libs/features it composes),
  based on actual imports you see - not name-guessing.
- Any noteworthy integration points (external APIs, desktop/webview bridges, NgRx state, etc.) if
  present.

"dependencies" must list the real other projects/libraries this project imports from (e.g.
"@hcworkspace/shared/platform/projects/data-access") and any significant external/third-party
packages it relies on beyond framework basics - derived from actual import statements, not from
project.json's implicitDependencies (that's already tracked separately).

Respond with ONLY valid JSON in this exact shape, no prose before or after:
{
  "purpose": string,
  "keyModules": string[],
  "dependencies": string[],
  "notablePatterns": string[]
}
