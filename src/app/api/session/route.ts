import { claimLegacy, countLegacyFacts, touchUser } from '@/lib/db';
import { resolveUser } from '@/lib/identity';

/** Session start. Returns the profile as it stood *before* this visit so the
 * client can work out how long the user has been away, then stamps the visit. */
export async function GET(request: Request) {
  const { userId, setCookie } = resolveUser(request);

  try {
    const [profile, legacyFacts] = await Promise.all([touchUser(userId), countLegacyFacts()]);
    return Response.json(
      {
        name: profile.name,
        honorific: profile.honorific,
        lastSeenAt: profile.lastSeenAt,
        isNew: profile.isNew,
        legacyFacts,
      },
      { headers: setCookie ? { 'Set-Cookie': setCookie } : undefined },
    );
  } catch (err) {
    console.error(err);
    // A database hiccup must not block the app from starting — degrade to an
    // unrecognised visitor rather than failing the boot.
    return Response.json(
      { name: null, honorific: 'sir', lastSeenAt: null, isNew: true, legacyFacts: 0 },
      { headers: setCookie ? { 'Set-Cookie': setCookie } : undefined },
    );
  }
}

/** Deliberate import of the pre-multi-user memory onto this device. */
export async function POST(request: Request) {
  const { userId, setCookie } = resolveUser(request);
  try {
    const result = await claimLegacy(userId);
    return Response.json(result, { headers: setCookie ? { 'Set-Cookie': setCookie } : undefined });
  } catch (err) {
    console.error(err);
    return Response.json({ error: 'Could not import previous memory.' }, { status: 500 });
  }
}
