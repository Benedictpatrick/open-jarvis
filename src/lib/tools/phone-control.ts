import { tool } from 'ai';
import { z } from 'zod';

const JOIN_BASE_URL = 'https://joinjoaomgcd.appspot.com/_ah/api/messaging/v1/sendPush';

export const phoneControlTool = tool({
  description:
    "Control the user's Android phone via the Join app: open an app, open a URL, show a notification, make the phone ring to help find it, or speak text aloud on the phone.",
  inputSchema: z.object({
    action: z.enum(['open_app', 'open_url', 'notify', 'find_phone', 'speak']),
    value: z
      .string()
      .optional()
      .describe(
        'For open_app: the app name (e.g. "Spotify"). For open_url: the URL. For notify/speak: the text.',
      ),
    title: z.string().optional().describe('Notification title, only used for notify'),
  }),
  execute: async ({ action, value, title }) => {
    const apiKey = process.env.JOIN_API_KEY;
    const deviceId = process.env.JOIN_DEVICE_ID;
    if (!apiKey || !deviceId) {
      return {
        error:
          'Phone control is not configured yet (missing JOIN_API_KEY / JOIN_DEVICE_ID). Tell the user to finish the Join setup.',
      };
    }

    const params = new URLSearchParams({ apikey: apiKey, deviceId });

    switch (action) {
      case 'open_app':
        if (!value) return { error: 'value (app name) is required for open_app' };
        params.set('app', value);
        break;
      case 'open_url':
        if (!value) return { error: 'value (url) is required for open_url' };
        params.set('url', value);
        break;
      case 'notify':
        if (!value) return { error: 'value (text) is required for notify' };
        params.set('text', value);
        if (title) params.set('title', title);
        break;
      case 'find_phone':
        params.set('find', 'true');
        break;
      case 'speak':
        if (!value) return { error: 'value (text) is required for speak' };
        params.set('say', value);
        break;
    }

    const response = await fetch(`${JOIN_BASE_URL}?${params.toString()}`);
    const data = await response.json().catch(() => null);

    if (!response.ok || data?.success === false) {
      return { error: `Phone action failed: ${JSON.stringify(data) ?? response.statusText}` };
    }

    return { success: true };
  },
});
