import { tool } from 'ai';
import { z } from 'zod';
import { getDb, isDbConfigured, setHonorific, setProfileName } from '../db';

/** Built per request rather than at module scope, so every read and write is
 * bound to the caller's device id. A shared module-level tool would let one
 * person's facts leak into another person's conversation. */
export function createMemoryTools(userId: string) {
  const setUserNameTool = tool({
    description:
      "Save what the user wants to be called, and optionally how they'd like to be addressed. Call this as soon as you learn either one.",
    inputSchema: z.object({
      name: z.string().describe('The name or nickname the user wants to be addressed by'),
      honorific: z
        .string()
        .optional()
        .describe(
          "How they'd like to be addressed formally, e.g. 'sir', 'ma'am', 'boss'. Omit if they haven't said.",
        ),
    }),
    execute: async ({ name, honorific }) => {
      if (!isDbConfigured()) {
        return { error: 'Memory is not configured yet (missing DATABASE_URL).' };
      }
      await setProfileName(userId, name);
      if (honorific) await setHonorific(userId, honorific);
      return { saved: true };
    },
  });

  const setHonorificTool = tool({
    description:
      "Save how the user wants to be addressed ('sir', 'ma'am', 'boss', or their name). Call this when they state a preference.",
    inputSchema: z.object({
      honorific: z.string().describe("The form of address, e.g. 'sir', 'ma'am', 'boss'"),
    }),
    execute: async ({ honorific }) => {
      if (!isDbConfigured()) {
        return { error: 'Memory is not configured yet (missing DATABASE_URL).' };
      }
      await setHonorific(userId, honorific);
      return { saved: true };
    },
  });

  const rememberFactTool = tool({
    description:
      "Save a fact worth remembering about the user for future conversations (preferences, names, ongoing projects, recurring context). Don't call this for one-off details irrelevant later.",
    inputSchema: z.object({
      fact: z.string().describe('A short, self-contained statement of the fact to remember'),
    }),
    execute: async ({ fact }) => {
      if (!isDbConfigured()) {
        return { error: 'Memory is not configured yet (missing DATABASE_URL).' };
      }
      const sql = await getDb();
      await sql`INSERT INTO jarvis_fact (user_id, fact) VALUES (${userId}, ${fact})`;
      return { saved: true };
    },
  });

  const recallMemoryTool = tool({
    description:
      'Recall previously saved facts about the user. Call this at the start of a conversation or whenever past context would help.',
    inputSchema: z.object({
      query: z
        .string()
        .describe('Keyword to filter facts, or an empty string to get the most recent facts'),
    }),
    execute: async ({ query }) => {
      if (!isDbConfigured()) {
        return { error: 'Memory is not configured yet (missing DATABASE_URL).', facts: [] };
      }
      const sql = await getDb();
      const rows = query
        ? await sql`
            SELECT fact, created_at FROM jarvis_fact
            WHERE user_id = ${userId} AND fact ILIKE ${'%' + query + '%'}
            ORDER BY created_at DESC LIMIT 20
          `
        : await sql`
            SELECT fact, created_at FROM jarvis_fact
            WHERE user_id = ${userId}
            ORDER BY created_at DESC LIMIT 20
          `;
      return { facts: rows };
    },
  });

  return { setUserNameTool, setHonorificTool, rememberFactTool, recallMemoryTool };
}
