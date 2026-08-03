You are matching a ticket description against candidate projects from a code-search knowledge base.

Ticket description:
{{DESCRIPTION}}

Candidate projects:
{{CANDIDATE_LIST}}

Return ONLY the candidates that are genuinely relevant to implementing what this ticket describes - a candidate
being topically adjacent (e.g. a sibling lib in the same feature area) is not enough on its own; its own purpose,
key modules, or notable patterns must actually relate to the ticket. A ticket can genuinely apply to more than one
candidate, so include every one that qualifies, not just the single best match.

Respond with ONLY a JSON array of the candidate numbers that are relevant, e.g. [1, 3]. If none are relevant,
respond with [].
