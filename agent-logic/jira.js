import axios from 'axios';

function getJiraAuth() {
  const { JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  if (!JIRA_BASE_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    return null;
  }
  return {
    baseUrl: JIRA_BASE_URL,
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

  await axios.post(
    `${auth.baseUrl}/rest/api/3/issue/${ticketKey}/comment`,
    {
      body: {
        type: 'doc',
        version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: commentText }] }],
      },
    },
    { headers: { ...auth.headers, 'Content-Type': 'application/json' } }
  );
}

async function getIssue(auth, ticketKey, fields) {
  const { data } = await axios.get(`${auth.baseUrl}/rest/api/3/issue/${ticketKey}`, {
    headers: auth.headers,
    params: { fields },
  });
  return data;
}

/** Flattens a Jira Atlassian Document Format (ADF) node tree into plain text. */
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

/**
 * Fetches a ticket's summary + description directly from Jira. n8n only forwards the ticket key
 * (not the description or ticket type), so agent-hub fetches the full ticket content itself -
 * this is also what's used as the task text given to the Copilot coding agent.
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
  return { summary, description: description || summary, issueType };
}

/**
 * Maps a Jira issue type name to the automation it should trigger, or null if this ticket isn't
 * automated at all. Deliberately narrow: "User Story Bug" (a subtask type) is the only bugfix
 * trigger, "Technical Debt" is the only tech-debt trigger. Everything else - including "Task"
 * (inconsistently reused for tech-debt work in practice, making it too ambiguous to classify
 * safely) and "Story"/"User Story" parent containers - is intentionally ignored.
 */
export function classifyTicketType(issueType) {
  if (issueType === 'User Story Bug') return 'bugfix-ticket';
  if (issueType === 'Technical Debt') return 'tech-debt-ticket';
  return null;
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
