import { tool } from 'ai';
import { z } from 'zod';
import { getDb, setProfileName } from '../db';

export const setUserNameTool = tool({
  description:
    "Save what the user wants to be called. Call this as soon as you learn their name, whether they volunteer it or you ask for it directly.",
  inputSchema: z.object({
    name: z.string().describe('The name or nickname the user wants to be addressed by'),
  }),
  execute: async ({ name }) => {
    if (!process.env.DATABASE_URL) {
      return { error: 'Memory is not configured yet (missing DATABASE_URL).' };
    }
    await setProfileName(name);
    return { saved: true };
  },
});

export const rememberFactTool = tool({
  description:
    "Save a fact worth remembering about the user for future conversations (preferences, names, ongoing projects, recurring context). Don't call this for one-off details irrelevant later.",
  inputSchema: z.object({
    fact: z.string().describe('A short, self-contained statement of the fact to remember'),
  }),
  execute: async ({ fact }) => {
    if (!process.env.DATABASE_URL) {
      return { error: 'Memory is not configured yet (missing DATABASE_URL).' };
    }
    const sql = await getDb();
    await sql`INSERT INTO jarvis_memory (fact) VALUES (${fact})`;
    return { saved: true };
  },
});

export const recallMemoryTool = tool({
  description:
    'Recall previously saved facts about the user. Call this at the start of a conversation or whenever past context would help.',
  inputSchema: z.object({
    query: z
      .string()
      .describe('Keyword to filter facts, or an empty string to get the most recent facts'),
  }),
  execute: async ({ query }) => {
    if (!process.env.DATABASE_URL) {
      return { error: 'Memory is not configured yet (missing DATABASE_URL).', facts: [] };
    }
    const sql = await getDb();
    const rows = query
      ? await sql`SELECT fact, created_at FROM jarvis_memory WHERE fact ILIKE ${'%' + query + '%'} ORDER BY created_at DESC LIMIT 20`
      : await sql`SELECT fact, created_at FROM jarvis_memory ORDER BY created_at DESC LIMIT 20`;
    return { facts: rows };
  },
});
