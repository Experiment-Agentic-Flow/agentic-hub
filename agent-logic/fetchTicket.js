import 'dotenv/config';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fetchTicketDetails, classifyTicketType } from './jira.js';

/**
 * n8n only forwards the ticket key via repository_dispatch - not the description or ticket type -
 * so this step fetches the ticket's summary/description/issue type directly from Jira, classifies
 * it (bugfix-ticket / tech-debt-ticket / not automated), and exposes the results as $GITHUB_OUTPUT
 * for later workflow steps. Tickets that don't classify (e.g. "Story", "Task", "Epic") get an
 * empty `ticket_type` output, which causes both agent steps' `if:` conditions to skip - a clean
 * no-op rather than a failure.
 */
async function main() {
  const { TICKET_KEY, GITHUB_OUTPUT } = process.env;
  if (!TICKET_KEY) {
    throw new Error('TICKET_KEY is required to fetch ticket details from Jira');
  }

  const { summary, description, issueType } = await fetchTicketDetails(TICKET_KEY);
  const ticketType = classifyTicketType(issueType);

  if (!ticketType) {
    console.log(
      `Ignoring ${TICKET_KEY}: issue type "${issueType}" is not automated (only "User Story Bug" and "Technical Debt" trigger agent-hub).`
    );
  }

  const combined = summary && description && description !== summary ? `${summary}\n\n${description}` : description || summary;

  if (GITHUB_OUTPUT) {
    const delimiter = `EOF_${crypto.randomBytes(8).toString('hex')}`;
    fs.appendFileSync(GITHUB_OUTPUT, `summary=${summary}\n`);
    fs.appendFileSync(GITHUB_OUTPUT, `ticket_type=${ticketType || ''}\n`);
    fs.appendFileSync(GITHUB_OUTPUT, `description<<${delimiter}\n${combined}\n${delimiter}\n`);
  } else {
    console.log(JSON.stringify({ summary, description: combined, issueType, ticketType }));
  }
}

main().catch((err) => {
  console.error('Failed to fetch ticket details:', err);
  process.exit(1);
});
