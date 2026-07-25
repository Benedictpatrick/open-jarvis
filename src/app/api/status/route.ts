import { getDb, getProfile } from '@/lib/db';
import { readUserId } from '@/lib/identity';

const NEON_FREE_STORAGE_BYTES = 0.5 * 1024 * 1024 * 1024;
const NEON_FREE_COMPUTE_HOURS_PER_MONTH = 100;

interface GroqLimits {
  requestsLimit: number | null;
  requestsRemaining: number | null;
  tokensLimit: number | null;
  tokensRemaining: number | null;
}

async function getGroqLimits(): Promise<GroqLimits | { error: string }> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return { error: 'Not configured' };
  try {
    // Rate-limit headers are only attached to endpoints that actually
    // consume quota (e.g. chat completions) — a lightweight /models list
    // doesn't carry them. A 1-token completion is the cheapest real probe.
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
    });
    const num = (v: string | null) => (v !== null && v !== '' ? Number(v) : null);
    return {
      requestsLimit: num(res.headers.get('x-ratelimit-limit-requests')),
      requestsRemaining: num(res.headers.get('x-ratelimit-remaining-requests')),
      tokensLimit: num(res.headers.get('x-ratelimit-limit-tokens')),
      tokensRemaining: num(res.headers.get('x-ratelimit-remaining-tokens')),
    };
  } catch {
    return { error: 'Could not reach Groq' };
  }
}

async function getNeonStorage(): Promise<{ usedBytes: number; capBytes: number; capComputeHours: number } | { error: string }> {
  if (!process.env.DATABASE_URL) return { error: 'Not configured' };
  try {
    const sql = await getDb();
    const rows = (await sql`SELECT pg_database_size(current_database()) AS size`) as Array<{ size: string }>;
    const usedBytes = Number(rows[0]?.size ?? 0);
    return { usedBytes, capBytes: NEON_FREE_STORAGE_BYTES, capComputeHours: NEON_FREE_COMPUTE_HOURS_PER_MONTH };
  } catch {
    return { error: 'Could not reach Neon' };
  }
}

export async function GET(request: Request) {
  const userId = readUserId(request);
  const [groq, neon, profile] = await Promise.all([
    getGroqLimits(),
    getNeonStorage(),
    userId ? getProfile(userId) : Promise.resolve(null),
  ]);
  const founderName = profile?.name ?? null;

  const phoneControlConfigured = Boolean(process.env.JOIN_API_KEY && process.env.JOIN_DEVICE_ID);

  return Response.json({
    founderName,
    groq,
    neon,
    exa: {
      configured: Boolean(process.env.EXA_API_KEY),
      note: 'Live usage requires a separate Exa admin key (not configured) — check the Exa dashboard directly.',
    },
    vercelSandbox: {
      note: 'Usage is tracked in the Vercel dashboard, not exposed via a simple API call.',
    },
    phoneControl: {
      configured: phoneControlConfigured,
    },
  });
}
