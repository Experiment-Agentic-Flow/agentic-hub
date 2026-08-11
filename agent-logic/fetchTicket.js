import 'dotenv/config';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fetchTicketDetails, classifyTicketType, isImageAttachment } from './jira.js';

/** Renders fetched comments as a "Comments:" section, or '' if there are none. */
function formatComments(comments) {
  if (!comments?.length) return '';
  const body = comments.map((c) => `- ${c.author} (${c.created}): ${c.body}`).join('\n');
  return `\n\nComments:\n${body}`;
}

/**
 * Renders fetched attachments as an "Attachments:" section (inlining small text-like attachments'
 * content). Image attachments are flagged "(image)" here since they're just a link at this point -
 * the actual image bytes only get downloaded later, inside the chosen candidate repo's working
 * directory, by agent-logic/ticketAttachments.js (see bugfix-agent.js/general-agent.js). Returns
 * '' if there are no attachments at all.
 */
function formatAttachments(attachments) {
  if (!attachments?.length) return '';
  const body = attachments
    .map((a) => {
      const imageNote = isImageAttachment(a) ? ' (image - will be downloaded for the coding agent to view)' : '';
      const header = `- ${a.filename} (${a.mimeType}, ${a.size} bytes)${imageNote}: ${a.url}`;
      if (!a.textContent) return header;
      const indented = a.textContent
        .split('\n')
        .map((line) => `    ${line}`)
        .join('\n');
      return `${header}\n  Content:\n${indented}`;
    })
    .join('\n');
  return `\n\nAttachments:\n${body}`;
}

/**
 * n8n only forwards the ticket key via repository_dispatch - not the description or ticket type -
 * so this step fetches the ticket's summary/description/issue type/comments/attachments directly
 * from Jira, classifies it (bugfix-ticket / general-ticket / not automated), and exposes the
 * results as $GITHUB_OUTPUT for later workflow steps. Only tickets Jira couldn't return an issue
 * type for at all get an empty `ticket_type` output, which causes both agent steps' `if:`
 * conditions to skip - a clean no-op rather than a failure.
 */
async function main() {
  const { TICKET_KEY, GITHUB_OUTPUT } = process.env;
  if (!TICKET_KEY) {
    throw new Error('TICKET_KEY is required to fetch ticket details from Jira');
  }

  const { summary, description, issueType, comments, attachments } = await fetchTicketDetails(TICKET_KEY);
  const ticketType = classifyTicketType(issueType);

  if (!ticketType) {
    console.log(`Ignoring ${TICKET_KEY}: could not resolve an issue type from Jira.`);
  }

  const combined =
    (summary && description && description !== summary ? `${summary}\n\n${description}` : description || summary) +
    formatComments(comments) +
    formatAttachments(attachments);

  if (GITHUB_OUTPUT) {
    const delimiter = `EOF_${crypto.randomBytes(8).toString('hex')}`;
    fs.appendFileSync(GITHUB_OUTPUT, `summary=${summary}\n`);
    fs.appendFileSync(GITHUB_OUTPUT, `ticket_type=${ticketType || ''}\n`);
    fs.appendFileSync(GITHUB_OUTPUT, `description<<${delimiter}\n${combined}\n${delimiter}\n`);
    // Raw attachment metadata (JSON.stringify never emits newlines), so bugfix-agent.js/
    // general-agent.js can later download image attachments to disk - formatAttachments() above
    // only ever renders a link for images at this stage, not the actual bytes.
    fs.appendFileSync(GITHUB_OUTPUT, `attachments=${JSON.stringify(attachments || [])}\n`);
  } else {
    console.log(JSON.stringify({ summary, description: combined, issueType, ticketType, attachments }));
  }
}

main().catch((err) => {
  console.error('Failed to fetch ticket details:', err);
  process.exit(1);
});
