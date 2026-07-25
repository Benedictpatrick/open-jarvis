export async function POST(request: Request) {
  const formData = await request.formData();
  const audio = formData.get('audio');

  if (!(audio instanceof Blob)) {
    return Response.json({ error: 'Missing audio file' }, { status: 400 });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return Response.json({ error: 'GROQ_API_KEY is not configured' }, { status: 500 });
  }

  // Always translate to English (whisper-large-v3), so speech in Tamil or any
  // other supported language comes through as English text automatically.
  const groqForm = new FormData();
  groqForm.append('file', audio, 'speech.webm');
  groqForm.append('model', 'whisper-large-v3');
  groqForm.append('response_format', 'json');

  const response = await fetch('https://api.groq.com/openai/v1/audio/translations', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: groqForm,
  });

  if (!response.ok) {
    const body = await response.text();
    return Response.json({ error: `Transcription failed: ${body}` }, { status: 502 });
  }

  const result = await response.json();
  return Response.json({ text: result.text as string });
}
