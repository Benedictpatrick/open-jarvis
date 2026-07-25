import { createAgentUIStreamResponse } from 'ai';
import { createJarvisAgent } from '@/lib/agent/jarvis-agent';
import { resolveUser } from '@/lib/identity';

export async function POST(request: Request) {
  const { messages } = await request.json();

  // A chat POST can beat the session fetch on a cold visit, so mint the id
  // here too and hand it back — both paths then settle on the same id rather
  // than generating two profiles for one person.
  const { userId, setCookie } = resolveUser(request);

  return createAgentUIStreamResponse({
    agent: createJarvisAgent(userId),
    uiMessages: messages,
    ...(setCookie ? { headers: { 'Set-Cookie': setCookie } } : {}),
  });
}
