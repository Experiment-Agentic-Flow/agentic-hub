{{SYSTEM_PROMPT}}

{{TASK}}

Make all necessary file changes directly in the current working directory using your file tools.
Do this work yourself - do not delegate to a sub-agent, task tool, or child session, and do not run
shell commands to write files (e.g. via bash/python heredocs). Only your own direct file-write tool
is available for creating/editing files here; anything delegated will have no write or shell access
and will silently fail. If a task spans many files, write them one at a time yourself rather than
batching the work off to another agent.
When you are completely done, respond with ONLY a single JSON object (no other text, no markdown fences) in this exact shape:
{{RESPONSE_SHAPE}}
