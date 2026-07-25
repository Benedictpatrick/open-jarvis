import { tool } from 'ai';
import { z } from 'zod';

export const webSearchTool = tool({
  description:
    'Search the live web for current information (news, facts, prices, docs, anything post-training-cutoff). Returns titles, URLs, and text snippets.',
  inputSchema: z.object({
    query: z.string().describe('The search query'),
    numResults: z.number().int().min(1).max(10).optional().describe('Number of results, default 5'),
  }),
  execute: async ({ query, numResults }) => {
    const apiKey = process.env.EXA_API_KEY;
    if (!apiKey) {
      return {
        error:
          'Web search is not configured yet (missing EXA_API_KEY). Tell the user to finish installing the Exa integration.',
      };
    }

    const response = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        numResults: numResults ?? 5,
        contents: { text: { maxCharacters: 1000 }, highlights: true },
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      return { error: `Exa search failed (${response.status}): ${body}` };
    }

    const data = await response.json();
    return {
      results: (data.results ?? []).map((r: Record<string, unknown>) => ({
        title: r.title,
        url: r.url,
        publishedDate: r.publishedDate,
        text: r.text,
        highlights: r.highlights,
      })),
    };
  },
});
