import { createAgentUIStreamResponse } from 'ai';
import { jarvisAgent } from '@/lib/agent/jarvis-agent';

export async function POST(request: Request) {
  const { messages } = await request.json();

  return createAgentUIStreamResponse({
    agent: jarvisAgent,
    uiMessages: messages,
  });
}
