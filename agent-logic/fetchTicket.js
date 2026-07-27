import 'dotenv/config';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fetchTicketDetails } from './jira.js';

/**
 * n8n only forwards the ticket key and type via repository_dispatch - not the description - so
 * this step fetches the ticket's summary/description directly from Jira and exposes it as
 * $GITHUB_OUTPUT for the resolve-repo step and the agent scripts to consume.
 */
async function main() {
  const { TICKET_KEY, GITHUB_OUTPUT } = process.env;
  if (!TICKET_KEY) {
    throw new Error('TICKET_KEY is required to fetch ticket details from Jira');
  }

  const { summary, description } = await fetchTicketDetails(TICKET_KEY);
  const combined = summary && description && description !== summary ? `${summary}\n\n${description}` : description || summary;

  if (GITHUB_OUTPUT) {
    const delimiter = `EOF_${crypto.randomBytes(8).toString('hex')}`;
    fs.appendFileSync(GITHUB_OUTPUT, `summary=${summary}\n`);
    fs.appendFileSync(GITHUB_OUTPUT, `description<<${delimiter}\n${combined}\n${delimiter}\n`);
  } else {
    console.log(combined);
  }
}

main().catch((err) => {
  console.error('Failed to fetch ticket details:', err);
  process.exit(1);
});
