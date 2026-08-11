import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';

// Jira Cloud uses REST API v3 (supports ADF rich-text fields); Jira Server/Data Center only ever
// shipped v2 (plain-string/wiki-markup fields) - v3 doesn't exist there and 404s. Default to v2
// since that's the more common self-hosted case; override with JIRA_API_VERSION=3 for Cloud.
function getJiraAuth() {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_API_VERSION } = process.env;
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return null;
  }
  return {
    baseUrl: JIRA_BASE_URL,
    apiVersion: JIRA_API_VERSION || '2',
    headers: { Authorization: `Basic ${Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64')}` },
  };
}

/** Posts a comment (e.g. the PR link) back onto the originating Jira ticket. */
export async function addJiraComment(ticketKey, commentText) {
  const auth = getJiraAuth();
  if (!auth) {
    console.warn('Jira credentials not set, skipping comment.');
    return;
  }

  // v3 (Cloud) requires an ADF document body; v2 (Server/Data Center) just wants a plain string.
  const body =
    auth.apiVersion === '3'
      ? { body: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: commentText }] }] } }
      : { body: commentText };

  await axios.post(`${auth.baseUrl}/rest/api/${auth.apiVersion}/issue/${ticketKey}/comment`, body, {
    headers: { ...auth.headers, 'Content-Type': 'application/json' },
  });
}

async function getIssue(auth, ticketKey, fields) {
  const { data } = await axios.get(`${auth.baseUrl}/rest/api/${auth.apiVersion}/issue/${ticketKey}`, {
    headers: auth.headers,
    params: { fields },
  });
  return data;
}

/** Flattens a Jira Atlassian Document Format (ADF) node tree into plain text (v2's description is already a plain string, so this just passes it through). */
function adfToPlainText(node) {
  if (!node) return '';
  if (typeof node === 'string') return node;
  if (node.type === 'text') return node.text || '';
  if (Array.isArray(node.content)) {
    const text = node.content.map(adfToPlainText).join('');
    return node.type === 'paragraph' || node.type === 'heading' || node.type === 'listItem' ? `${text}\n` : text;
  }
  return '';
}

/** Fetches every comment on a ticket (paginated - a busy ticket can have far more than one page's worth). */
async function fetchAllComments(auth, ticketKey) {
  const comments = [];
  let startAt = 0;
  const maxResults = 100;

  for (;;) {
    const { data } = await axios.get(`${auth.baseUrl}/rest/api/${auth.apiVersion}/issue/${ticketKey}/comment`, {
      headers: auth.headers,
      params: { startAt, maxResults, orderBy: 'created' },
    });
    comments.push(...(data.comments || []));
    if (!data.comments?.length || comments.length >= (data.total || comments.length)) break;
    startAt += data.comments.length;
  }

  return comments.map((comment) => ({
    author: comment.author?.displayName || comment.author?.name || 'unknown',
    created: comment.created,
    body: (auth.apiVersion === '3' ? adfToPlainText(comment.body) : comment.body || '').trim(),
  }));
}

// Attachments in these formats are small enough and plain-text enough to be worth inlining
// directly into the ticket context (e.g. a log file or stack trace attached to a bug). Images are
// handled separately (see isImageAttachment/downloadImageAttachments below) since a coding agent
// can visually inspect them but can't usefully read raw image bytes as text; everything else
// (videos, archives, office docs, ...) is left as a filename + link only.
const INLINABLE_ATTACHMENT_EXTENSIONS = ['.txt', '.log', '.md', '.json', '.csv', '.yml', '.yaml', '.xml'];
const MAX_INLINE_ATTACHMENT_BYTES = 50 * 1024;

/** Whether an attachment (as returned by fetchTicketDetails) is an image worth downloading for the coding agent to visually inspect. */
export function isImageAttachment(attachment) {
  return /^image\//.test(attachment.mimeType || '');
}

/** Strips path separators and other unsafe characters so a Jira-supplied filename can't escape destDir or break on any OS. */
function sanitizeFilename(filename) {
  return path.basename(filename || 'attachment').replace(/[^A-Za-z0-9._-]/g, '_');
}

const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * Downloads every image attachment (skipping ones over MAX_IMAGE_ATTACHMENT_BYTES, re-checked
 * against the real downloaded size since Jira's reported size can be stale/wrong) into `destDir`.
 * Coding-agent CLIs (Gemini/Copilot) only ever get filesystem access scoped to the directory
 * they're invoked in and have no tool to fetch a URL themselves - this is the only way for them to
 * actually see an image rather than just being told a link exists. Best-effort per file: one bad
 * download doesn't abort the rest. Returns [] (and creates no directory) if there's nothing to do.
 */
export async function downloadImageAttachments(attachments, destDir) {
  const auth = getJiraAuth();
  const images = (attachments || []).filter((a) => isImageAttachment(a) && a.size <= MAX_IMAGE_ATTACHMENT_BYTES);
  if (!auth || !images.length) return [];

  fs.mkdirSync(destDir, { recursive: true });
  const saved = [];
  for (const attachment of images) {
    try {
      const { data } = await axios.get(attachment.url, { headers: auth.headers, responseType: 'arraybuffer' });
      if (data.byteLength > MAX_IMAGE_ATTACHMENT_BYTES) {
        console.warn(`Skipping image attachment "${attachment.filename}": actual size ${data.byteLength} bytes exceeds the cap.`);
        continue;
      }
      const filename = sanitizeFilename(attachment.filename);
      fs.writeFileSync(path.join(destDir, filename), data);
      saved.push({ filename });
    } catch (err) {
      console.warn(`Failed to download image attachment "${attachment.filename}": ${err.message}`);
    }
  }
  return saved;
}

/** Fetches attachment metadata for a ticket, inlining small plain-text attachments' content directly. */
async function fetchAttachments(auth, ticketKey) {
  const issue = await getIssue(auth, ticketKey, 'attachment');
  const attachments = issue.fields?.attachment || [];

  return Promise.all(
    attachments.map(async (attachment) => {
      const entry = {
        filename: attachment.filename,
        mimeType: attachment.mimeType || 'unknown',
        size: attachment.size || 0,
        url: attachment.content,
        created: attachment.created,
      };

      const isTextLike =
        /^text\//.test(entry.mimeType) || INLINABLE_ATTACHMENT_EXTENSIONS.some((ext) => entry.filename?.toLowerCase().endsWith(ext));
      if (isTextLike && entry.size > 0 && entry.size <= MAX_INLINE_ATTACHMENT_BYTES) {
        try {
          const { data } = await axios.get(entry.url, { headers: auth.headers, responseType: 'text' });
          entry.textContent = typeof data === 'string' ? data : JSON.stringify(data);
        } catch (err) {
          console.warn(`Failed to download attachment "${entry.filename}" for ${ticketKey}: ${err.message}`);
        }
      }

      return entry;
    })
  );
}

/**
 * Fetches a ticket's summary + description + comments + attachments directly from Jira. n8n only
 * forwards the ticket key (not the description or ticket type), so agent-hub fetches the full
 * ticket content itself - this is also what's used as the task text given to the Copilot coding
 * agent. Comments and attachments are fetched best-effort: a failure fetching either one doesn't
 * fail the whole ticket (e.g. an attachment endpoint hiccup shouldn't block automation that only
 * really needs the description).
 */
export async function fetchTicketDetails(ticketKey) {
  const auth = getJiraAuth();
  if (!auth) {
    throw new Error('Jira credentials are not configured; cannot fetch ticket details.');
  }
  const issue = await getIssue(auth, ticketKey, 'summary,description,issuetype');
  const summary = (issue.fields?.summary || '').trim();
  const description = adfToPlainText(issue.fields?.description).trim();
  const issueType = issue.fields?.issuetype?.name || null;

  const [comments, attachments] = await Promise.all([
    fetchAllComments(auth, ticketKey).catch((err) => {
      console.warn(`Failed to fetch comments for ${ticketKey}: ${err.message}`);
      return [];
    }),
    fetchAttachments(auth, ticketKey).catch((err) => {
      console.warn(`Failed to fetch attachments for ${ticketKey}: ${err.message}`);
      return [];
    }),
  ]);

  return { summary, description: description || summary, issueType, comments, attachments };
}

/**
 * Maps a Jira issue type name to the automation it should trigger, or null if this ticket isn't
 * automated at all. "User Story Bug" (a subtask type) is the only bugfix trigger - it has a parent
 * ticket whose linked PRs/branches pin down the exact repo. Every other non-empty issue type
 * (Technical Debt, Story, Task, Epic, ...) routes through the same vector-DB-driven flow: the
 * RAG index summarizes the codebase itself, independent of ticket type, so it's just as capable
 * of identifying the right repo/paths for a new feature story as it is for a tech-debt cleanup.
 */
export function classifyTicketType(issueType) {
  if (!issueType) return null;
  if (issueType === 'User Story Bug') return 'bugfix-ticket';
  return 'general-ticket';
}

/**
 * For a ticket that doesn't specify a target repo directly (e.g. a sub-task), looks up its Jira
 * parent ticket and extracts EVERY repo referenced by the parent's linked GitHub pull requests
 * and branches via Jira's Development panel (dev-status API) - a parent story/epic can span
 * several repos, and work may show up as a branch before a PR exists. Returns [] if there's no
 * parent or nothing linked yet.
 */
export async function resolveTargetReposFromParent(ticketKey) {
  const auth = getJiraAuth();
  if (!auth) {
    console.warn('Jira credentials not set, cannot resolve target repo(s) from parent ticket.');
    return [];
  }

  const issue = await getIssue(auth, ticketKey, 'parent');
  const parentKey = issue.fields?.parent?.key;
  if (!parentKey) {
    return [];
  }

  const parentIssue = await getIssue(auth, parentKey, 'parent');
  const results = [];
  const seenRepos = new Set();

  for (const dataType of ['pullrequest', 'branch']) {
    const { data } = await axios.get(`${auth.baseUrl}/rest/dev-status/1.0/issue/detail`, {
      headers: auth.headers,
      params: { issueId: parentIssue.id, applicationType: 'GitHub', dataType },
    });

    const entries = (data.detail || []).flatMap((entry) =>
      dataType === 'pullrequest' ? entry.pullRequests || [] : entry.branches || []
    );

    for (const entry of entries) {
      const match = entry.url?.match(/github\.com\/([^/]+\/[^/]+)\//);
      if (!match) continue;
      const repo = match[1];
      if (seenRepos.has(repo)) continue;
      seenRepos.add(repo);
      results.push({ repo, parentKey, source: dataType === 'pullrequest' ? 'parent ticket PR' : 'parent ticket branch' });
    }
  }

  return results;
}
