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

Respond with ONLY valid JSON in this exact shape, no prose before or after:
{
  "purpose": string,
  "keyModules": string[],
  "notablePatterns": string[]
}
