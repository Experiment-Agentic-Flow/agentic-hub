You are matching a ticket description against candidate repositories in an organization.

Ticket description:
{{DESCRIPTION}}

Candidate repositories:
{{REPO_LIST}}

Return ONLY the repositories that are genuinely likely to be where this ticket's work belongs, based on each
repository's stated purpose. A ticket can genuinely apply to more than one repository (e.g. a cross-cutting
change), so include every one that qualifies, not just the single best match.

Respond with ONLY a JSON array of the repository numbers that are relevant, e.g. [1, 3]. If none are relevant,
respond with [].
