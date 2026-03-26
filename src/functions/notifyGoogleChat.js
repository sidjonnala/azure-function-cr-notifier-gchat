/**
 * src/functions/notifyGoogleChat.js
 *
 * Azure Functions v4 HTTP trigger — thin wrapper around core/notifier.js.
 * All business logic lives in core/notifier.js; this file only handles
 * Azure-specific concerns (request parsing, response formatting, env vars).
 */

import { app } from '@azure/functions';
import { processAdoWebhook } from '../../core/notifier.js';

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
