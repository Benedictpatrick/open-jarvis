import { neon } from '@neondatabase/serverless';

let _sql: ReturnType<typeof neon> | null = null;
let _ready: Promise<void> | null = null;

function getSql() {
  if (!_sql) _sql = neon(process.env.DATABASE_URL!);
  return _sql;
}

function ensureSchema(): Promise<void> {
  if (!_ready) {
    const sql = getSql();
    _ready = Promise.all([
      sql`
        CREATE TABLE IF NOT EXISTS jarvis_memory (
          id SERIAL PRIMARY KEY,
          fact TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `,
      sql`
        CREATE TABLE IF NOT EXISTS jarvis_profile (
          id INTEGER PRIMARY KEY DEFAULT 1,
          name TEXT,
          CONSTRAINT jarvis_profile_singleton CHECK (id = 1)
        )
      `,
    ]).then(() => undefined);
  }
  return _ready;
}

export async function getDb() {
  await ensureSchema();
  return getSql();
}

export async function getProfileName(): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;
  const sql = await getDb();
  const rows = (await sql`SELECT name FROM jarvis_profile WHERE id = 1`) as Array<{
    name: string | null;
  }>;
  return rows[0]?.name ?? null;
}

export async function setProfileName(name: string): Promise<void> {
  const sql = await getDb();
  await sql`
    INSERT INTO jarvis_profile (id, name) VALUES (1, ${name})
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name
  `;
}
