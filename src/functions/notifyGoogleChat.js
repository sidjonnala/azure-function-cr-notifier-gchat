/**
 * src/functions/notifyGoogleChat.js
 *
 * Azure Functions v4 HTTP trigger for the ADO → Google Chat notifier.
 * Handles Azure-specific concerns (request parsing, response formatting, env vars)
 * and contains all business logic for processing ADO webhooks.
 */

import { app } from '@azure/functions';

app.http('notifyGoogleChat', {
  methods: ['POST'],
  authLevel: 'function',
  handler: async (request, context) => {
    const googleChatWebhookUrl = process.env.GOOGLE_CHAT_WEBHOOK_URL;
    const targetAreaPath       = process.env.TARGET_AREA_PATH;

    if (!googleChatWebhookUrl || !targetAreaPath) {
      context.log.error('❌ Missing required app settings: GOOGLE_CHAT_WEBHOOK_URL and/or TARGET_AREA_PATH');
      return { status: 500, jsonBody: { error: 'Function misconfiguration: missing app settings.' } };
    }

    let body;
    try {
      body = await request.json();
    } catch {
      context.log.error('❌ Failed to parse request body as JSON.');
      return { status: 400, jsonBody: { error: 'Invalid JSON body.' } };
    }

    try {
      const result = await processAdoWebhook({
        body,
        googleChatWebhookUrl,
        targetAreaPath,
        log: context.log,
      });
      return { status: result.status, jsonBody: { message: result.message } };
    } catch (err) {
      context.log.error('❌ Failed to post to Google Chat:', err.message);
      return { status: 500, jsonBody: { error: 'Failed to notify Google Chat.', details: err.message } };
    }
  },
});

// ── Business Logic ────────────────────────────────────────────────────────────

/**
 * Pure business logic for the ADO → Google Chat notifier.
 *
 * @param {object} opts
 * @param {object} opts.body              - Parsed ADO service hook payload
 * @param {string} opts.googleChatWebhookUrl
 * @param {string} opts.targetAreaPath
 * @param {Function} opts.log             - Logging function (e.g. context.log or console.log)
 * @returns {Promise<{ status: number, message: string }>}
 */
async function processAdoWebhook({ body, googleChatWebhookUrl, targetAreaPath, log }) {
  log('📥 ADO WEBHOOK RECEIVED — Google Chat Notifier');

  // 1. Only handle work item creation events
  const eventType = body?.eventType ?? '';
  if (eventType !== 'workitem.created') {
    log(`ℹ️  Ignored event type: ${eventType}`);
    return { status: 200, message: 'Event ignored.' };
  }

  // 2. Extract work item fields from the ADO payload
  const resource = body?.resource ?? {};
  const fields   = resource?.fields ?? {};

  const workItemType = getField(fields, 'System.WorkItemType');
  const areaPath     = getField(fields, 'System.AreaPath');
  const title        = getField(fields, 'System.Title');
  const assignedTo   = getFieldNested(fields, 'System.AssignedTo', 'displayName');
  const state        = getField(fields, 'System.State');
  const priority     = getField(fields, 'Microsoft.VSTS.Common.Priority');
  const description  = getField(fields, 'System.Description');
  const workItemId   = resource?.id;
  const project      = getField(fields, 'System.TeamProject');

  const orgUrl      = body?.resourceContainers?.account?.baseUrl ?? '';
  const workItemUrl = orgUrl
    ? `${orgUrl.replace(/\/$/, '')}/${project}/_workitems/edit/${workItemId}`
    : '(link unavailable)';

  // 3. Filter: User Stories only
  if (workItemType.toLowerCase() !== 'user story') {
    log(`ℹ️  Ignored work item type: ${workItemType}`);
    return { status: 200, message: 'Not a User Story.' };
  }

  // 4. Filter: area path must start with targetAreaPath.
  // Normalize backslashes so values like "Proj\\Team" match ADO's "Proj\Team".
  const normalize = (s) => s.replace(/\\\\/g, '\\');
  if (!normalize(areaPath).toLowerCase().startsWith(normalize(targetAreaPath).toLowerCase())) {
    log(`ℹ️  Ignored area path: ${areaPath}`);
    return { status: 200, message: 'Area path does not match.' };
  }

  log(`✅ Matched User Story #${workItemId} in ${areaPath}`);

  // 5. Build the Google Chat card payload
  let cleanDescription = description
    ? description.replace(/<[^>]*>/g, '').trim()
    : '_No description provided._';
  if (cleanDescription.length > 300) {
    cleanDescription = cleanDescription.slice(0, 300) + '…';
  }

  const chatPayload = {
    cardsV2: [
      {
        cardId: `ado-userstory-${workItemId}`,
        card: {
          header: {
            title: `New User Story #${workItemId} created`,
            subtitle: areaPath,
            imageUrl: 'https://cdn.vsassets.io/content/icons/favicon.ico',
            imageType: 'CIRCLE',
          },
          sections: [
            {
              widgets: [
                { decoratedText: { topLabel: 'Title',       text: title } },
                { decoratedText: { topLabel: 'Assigned To', text: assignedTo || 'Unassigned' } },
                { decoratedText: { topLabel: 'State',       text: state } },
                { decoratedText: { topLabel: 'Priority',    text: priority ? `P${priority}` : '—' } },
                { decoratedText: { topLabel: 'Description', text: cleanDescription, wrapText: true } },
              ],
            },
            {
              widgets: [
                {
                  buttonList: {
                    buttons: [
                      {
                        text: 'Open in Azure DevOps',
                        onClick: { openLink: { url: workItemUrl } },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      },
    ],
  };

  // 6. POST the card to Google Chat
  const response = await fetch(googleChatWebhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(chatPayload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Google Chat responded ${response.status}: ${text}`);
  }

  log('✅ Notification sent to Google Chat.');
  return { status: 200, message: 'Notification sent.' };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Returns the string value of a flat ADO field, or '' if absent. */
function getField(fields, fieldName) {
  const val = fields[fieldName];
  if (val === undefined || val === null) return '';
  return typeof val === 'object' ? JSON.stringify(val) : String(val);
}

/**
 * Returns a nested string property of an ADO object field (e.g. AssignedTo.displayName).
 * Also handles the case where ADO sends the field as a plain string "Display Name <email>",
 * in which case the display name portion (before the angle bracket) is returned.
 */
function getFieldNested(fields, fieldName, nested) {
  const val = fields[fieldName];
  if (val === undefined || val === null) return '';
  if (typeof val === 'string') return val.replace(/<[^>]*>/, '').trim();
  if (typeof val === 'object' && nested in val) return String(val[nested] ?? '');
  return '';
}
