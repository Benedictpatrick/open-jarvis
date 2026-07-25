import { tool } from 'ai';
import { z } from 'zod';

const FETCH_TIMEOUT_MS = 6000;
const MAX_BYTES = 60_000;

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'");
}

async function fetchPageMeta(url: string): Promise<{ title: string; description: string }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JarvisBot/1.0)' },
    });
    const reader = res.body?.getReader();
    if (!reader) return { title: url, description: '' };

    const decoder = new TextDecoder();
    let html = '';
    let received = 0;
    while (received < MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});

    const titleMatch = html.match(/<title[^>]*>([^<]*)<\/title>/i);
    const descMatch =
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ??
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i);

    return {
      title: decodeEntities(titleMatch?.[1]?.trim() ?? '') || url,
      description: decodeEntities(descMatch?.[1]?.trim() ?? '').slice(0, 220),
    };
  } catch {
    return { title: url, description: '' };
  } finally {
    clearTimeout(timeout);
  }
}

export const openTabTool = tool({
  description:
    "Pull up a webpage as an info card for the user to see, like pulling up a display — after finding something worth showing via webSearch, or when the user asks you to open a specific site or link. Only pass real URLs, not app names.",
  inputSchema: z.object({
    url: z.string().describe('The full URL to pull up, including https://'),
  }),
  execute: async ({ url }) => {
    const meta = await fetchPageMeta(url);
    return { url, title: meta.title, description: meta.description };
  },
});
