/** Per-device identity. No login: a random id is minted on first contact and
 * kept in a cookie, and every profile row and remembered fact is scoped to it.
 * That keeps one person's memories out of another person's session without
 * putting a sign-in wall in front of the reactor. */
export const USER_COOKIE = 'jarvis_uid';

const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365 * 2;

export function readUserId(request: Request): string | null {
  const header = request.headers.get('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === USER_COOKIE) {
      const value = decodeURIComponent(rest.join('='));
      return value || null;
    }
  }
  return null;
}

export function newUserId(): string {
  return crypto.randomUUID();
}

/** Not `Secure` on purpose — dev runs on plain-HTTP localhost and a Secure
 * cookie would be dropped there without warning. Not `httpOnly`, because the
 * value is a random opaque id and nothing is authorised by it. */
export function userCookie(userId: string): string {
  return `${USER_COOKIE}=${encodeURIComponent(userId)}; Path=/; Max-Age=${COOKIE_MAX_AGE_SECONDS}; SameSite=Lax`;
}

/** Resolves the caller's id, minting one if this is their first request. The
 * caller must attach `setCookie` to the response when it is present, so a
 * chat POST that races the session fetch still settles on a single id. */
export function resolveUser(request: Request): { userId: string; setCookie?: string } {
  const existing = readUserId(request);
  if (existing) return { userId: existing };
  const userId = newUserId();
  return { userId, setCookie: userCookie(userId) };
}
