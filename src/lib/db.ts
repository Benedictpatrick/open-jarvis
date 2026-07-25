import { neon } from '@neondatabase/serverless';

/** Where the original single-user profile and facts are parked after the
 * multi-user migration. Nothing claims this automatically — a person has to
 * import it deliberately from Settings, otherwise the first stranger to open
 * the app would inherit the owner's name and every saved fact. */
export const LEGACY_USER_ID = '__legacy__';

export const DEFAULT_HONORIFIC = 'sir';

export interface JarvisProfile {
  name: string | null;
  honorific: string;
  lastSeenAt: string | null;
  isNew: boolean;
}

let _sql: ReturnType<typeof neon> | null = null;
let _ready: Promise<void> | null = null;

function getSql() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL!);
  return _sql;
}

async function ensureSchemaOnce(): Promise<void> {
  const sql = getSql();

  // Note: no template interpolation in DDL — Postgres rejects bind parameters
  // in CREATE TABLE, so the default is written as a literal.
  await sql`
    CREATE TABLE IF NOT EXISTS jarvis_user (
      user_id TEXT PRIMARY KEY,
      name TEXT,
      honorific TEXT NOT NULL DEFAULT 'sir',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS jarvis_fact (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      fact TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS jarvis_fact_user_idx ON jarvis_fact (user_id, created_at DESC)`;

  // One-time move of the pre-multi-user data. Both steps are guarded so this
  // is safe to run on every cold start, and a no-op on a fresh database.
  const legacyProfile = (await sql`SELECT to_regclass('public.jarvis_profile') AS t`) as Array<{
    t: string | null;
  }>;
  if (legacyProfile[0]?.t) {
    await sql`
      INSERT INTO jarvis_user (user_id, name)
      SELECT ${LEGACY_USER_ID}, name FROM jarvis_profile WHERE id = 1 AND name IS NOT NULL
      ON CONFLICT (user_id) DO NOTHING
    `;
  }

  const legacyFacts = (await sql`SELECT to_regclass('public.jarvis_memory') AS t`) as Array<{
    t: string | null;
  }>;
  if (legacyFacts[0]?.t) {
    const already = (await sql`
      SELECT 1 FROM jarvis_fact WHERE user_id = ${LEGACY_USER_ID} LIMIT 1
    `) as unknown[];
    if (already.length === 0) {
      await sql`
        INSERT INTO jarvis_fact (user_id, fact, created_at)
        SELECT ${LEGACY_USER_ID}, fact, created_at FROM jarvis_memory
      `;
    }
  }
}

function ensureSchema(): Promise<void> {
  if (!_ready) {
    // A failed migration must not poison every later request with the same
    // rejected promise — clear it so the next call retries.
    _ready = ensureSchemaOnce().catch((err) => {
      _ready = null;
      throw err;
    });
  }
  return _ready;
}

export async function getDb() {
  await ensureSchema();
  return getSql();
}

export function isDbConfigured(): boolean {
  return Boolean(process.env.DATABASE_URL);
}

/** Reads the profile without side effects — safe to call on every agent turn. */
export async function getProfile(userId: string): Promise<JarvisProfile | null> {
  if (!isDbConfigured() || !userId) return null;
  const sql = await getDb();
  const rows = (await sql`
    SELECT name, honorific, last_seen_at FROM jarvis_user WHERE user_id = ${userId}
  `) as Array<{ name: string | null; honorific: string | null; last_seen_at: string | null }>;
  const row = rows[0];
  if (!row) return null;
  return {
    name: row.name,
    honorific: row.honorific ?? DEFAULT_HONORIFIC,
    lastSeenAt: row.last_seen_at,
    isNew: false,
  };
}

/** Session start: returns the profile as it was *before* this visit, then
 * stamps the visit. Reading first is what makes "it has been four days"
 * possible — updating before reading would always report a zero gap. */
export async function touchUser(userId: string): Promise<JarvisProfile> {
  if (!isDbConfigured() || !userId) {
    return { name: null, honorific: DEFAULT_HONORIFIC, lastSeenAt: null, isNew: true };
  }
  const sql = await getDb();
  const previous = await getProfile(userId);

  if (!previous) {
    await sql`INSERT INTO jarvis_user (user_id) VALUES (${userId}) ON CONFLICT (user_id) DO NOTHING`;
    return { name: null, honorific: DEFAULT_HONORIFIC, lastSeenAt: null, isNew: true };
  }

  await sql`UPDATE jarvis_user SET last_seen_at = now() WHERE user_id = ${userId}`;
  return previous;
}

export async function setProfileName(userId: string, name: string): Promise<void> {
  const sql = await getDb();
  await sql`
    INSERT INTO jarvis_user (user_id, name) VALUES (${userId}, ${name})
    ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name
  `;
}

export async function setHonorific(userId: string, honorific: string): Promise<void> {
  const sql = await getDb();
  await sql`
    INSERT INTO jarvis_user (user_id, honorific) VALUES (${userId}, ${honorific})
    ON CONFLICT (user_id) DO UPDATE SET honorific = EXCLUDED.honorific
  `;
}

export async function countLegacyFacts(): Promise<number> {
  if (!isDbConfigured()) return 0;
  const sql = await getDb();
  const rows = (await sql`
    SELECT count(*)::int AS n FROM jarvis_fact WHERE user_id = ${LEGACY_USER_ID}
  `) as Array<{ n: number }>;
  return rows[0]?.n ?? 0;
}

/** Deliberate, user-initiated transfer of the pre-multi-user data onto this
 * device. One-shot: after the rename there is no legacy row left to claim. */
export async function claimLegacy(userId: string): Promise<{ facts: number; name: string | null }> {
  const sql = await getDb();
  const legacy = (await sql`
    SELECT name FROM jarvis_user WHERE user_id = ${LEGACY_USER_ID}
  `) as Array<{ name: string | null }>;

  const facts = (await sql`
    UPDATE jarvis_fact SET user_id = ${userId} WHERE user_id = ${LEGACY_USER_ID} RETURNING id
  `) as unknown[];

  const name = legacy[0]?.name ?? null;
  if (name) {
    await sql`
      INSERT INTO jarvis_user (user_id, name) VALUES (${userId}, ${name})
      ON CONFLICT (user_id) DO UPDATE SET name = EXCLUDED.name
    `;
  }
  await sql`DELETE FROM jarvis_user WHERE user_id = ${LEGACY_USER_ID}`;

  return { facts: facts.length, name };
}
