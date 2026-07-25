export async function POST(request: Request) {
  const { text } = await request.json();

  if (!text || typeof text !== 'string') {
    return Response.json({ error: 'Missing text' }, { status: 400 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'GROQ_API_KEY is not configured' }, { status: 500 });
  }

  const response = await fetch('https://api.groq.com/openai/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'canopylabs/orpheus-v1-english',
      input: text,
      voice: 'austin',
      response_format: 'wav',
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    return Response.json({ error: `Speech generation failed: ${body}` }, { status: 502 });
  }

  const audioBuffer = Buffer.from(await response.arrayBuffer());

  return new Response(audioBuffer, {
    headers: { 'Content-Type': 'audio/wav' },
  });
}
