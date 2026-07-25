'use client';

import { useChat } from '@ai-sdk/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JarvisUIMessage } from '@/lib/agent/jarvis-agent';
import { ReactorHUD } from '@/components/ReactorHUD';
import { InfoPanel } from '@/components/InfoPanel';
import { SettingsPanel } from '@/components/SettingsPanel';

const INFO_PANEL_AUTO_DISMISS_MS = 15000;

const AUTO_SCROLL_THRESHOLD_PX = 80;
// Common ways speech recognition mishears "Jarvis" — checked as exact
// alternatives before falling back to fuzzy matching, since a recognizer
// confidently transcribing "travis" is a very different signal than a
// near-miss spelling.
const JARVIS_MISHEARINGS = ['jarvis', 'jarviss', 'jervis', 'travis', 'garvis', 'charvis', 'jarbis', 'jarvest'];
const DADDYS_HOME_PHRASES = ['daddys home', 'daddy home', 'daddys back'];
const SILENCE_THRESHOLD = 12;
const SILENCE_HOLD_MS = 1300;
const MAX_AUTO_RECORDING_MS = 15000;

type Phase = 'idle' | 'listening' | 'thinking' | 'speaking';

interface MinimalSpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  onresult: ((event: SpeechRecognitionResultEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

interface SpeechRecognitionResultEvent {
  resultIndex: number;
  results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
}

interface SpeechRecognitionErrorEvent {
  error: string;
}

function getSpeechRecognitionCtor(): (new () => MinimalSpeechRecognition) | null {
  const w = window as unknown as {
    SpeechRecognition?: new () => MinimalSpeechRecognition;
    webkitSpeechRecognition?: new () => MinimalSpeechRecognition;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

function levenshtein(a: string, b: string): number {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) dp[i][0] = i;
  for (let j = 0; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[a.length][b.length];
}

// Deliberately loose: just hearing something close to "Jarvis" anywhere is
// enough to trigger, without requiring "hey"/"hello" first. Speech
// recognition often garbles multi-word phrases worse than single names, and
// for a personal wake word, missing a real activation is worse than an
// occasional false one.
function containsWakePhrase(transcript: string): boolean {
  const normalized = transcript.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  if (DADDYS_HOME_PHRASES.some((phrase) => normalized.includes(phrase))) return true;

  const words = normalized.split(' ');
  return words.some((word) => {
    if (word.length < 4) return false;
    if (JARVIS_MISHEARINGS.includes(word)) return true;
    return levenshtein(word, 'jarvis') <= 2;
  });
}

/** Monitors a mic stream's volume and calls onSilence after speech is
 * followed by a sustained quiet period (or a hard duration cap), so a
 * wake-word-triggered recording can stop itself without a button release. */
function watchForSilence(stream: MediaStream, onSilence: () => void): () => void {
  const AudioContextCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioContextCtor();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  let hasSpoken = false;
  let silenceStart: number | null = null;
  const startTime = Date.now();
  let rafId = 0;
  let stopped = false;

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(rafId);
    source.disconnect();
    void audioCtx.close();
  };

  const tick = () => {
    analyser.getByteTimeDomainData(data);
    let sumSquares = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i] - 128;
      sumSquares += v * v;
    }
    const rms = Math.sqrt(sumSquares / data.length);

    if (rms > SILENCE_THRESHOLD) {
      hasSpoken = true;
      silenceStart = null;
    } else if (hasSpoken) {
      if (silenceStart === null) silenceStart = Date.now();
      else if (Date.now() - silenceStart > SILENCE_HOLD_MS) {
        cleanup();
        onSilence();
        return;
      }
    }

    if (Date.now() - startTime > MAX_AUTO_RECORDING_MS) {
      cleanup();
      onSilence();
      return;
    }

    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);
  return cleanup;
}

function messageText(message: JarvisUIMessage): string {
  // A multi-step tool-calling turn can produce several separate 'text'
  // parts (one per step, e.g. narrating before a tool call and again
  // after). Only the last one is the model's actual final reply — joining
  // them all reads as the model repeating itself.
  const textParts = message.parts.filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text');
  return (textParts.at(-1)?.text ?? '').trim();
}

function toolPartsOf(message: JarvisUIMessage) {
  return message.parts.filter((part) => part.type.startsWith('tool-'));
}

interface OpenTabOutput {
  url: string;
  title: string;
  description: string;
}

function isOpenTabPart(
  part: JarvisUIMessage['parts'][number],
): part is Extract<JarvisUIMessage['parts'][number], { type: 'tool-openTab' }> {
  return part.type === 'tool-openTab';
}

export default function Home() {
  const [isRecording, setIsRecording] = useState(false);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [statusText, setStatusText] = useState(
    'Say something in any language, or tap the core to talk.',
  );
  const [textInput, setTextInput] = useState('');
  const [clock, setClock] = useState('');
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const [wakeWordSupported, setWakeWordSupported] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [liveCaption, setLiveCaption] = useState('');
  const [wakeWordHeard, setWakeWordHeard] = useState('');

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const spokenMessageIds = useRef(new Set<string>());
  const transcriptRef = useRef<HTMLElement | null>(null);
  const reactorTiltRef = useRef<HTMLDivElement | null>(null);
  const silenceCleanupRef = useRef<(() => void) | null>(null);
  const recognitionRef = useRef<MinimalSpeechRecognition | null>(null);
  const captionRecognitionRef = useRef<MinimalSpeechRecognition | null>(null);
  const currentAudioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!getSpeechRecognitionCtor()) setWakeWordSupported(false);
  }, []);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  useEffect(() => {
    const el = reactorTiltRef.current;
    if (!el || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;

    const maxTiltDeg = 9;
    const handleMove = (e: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      const px = (e.clientX - rect.left) / rect.width - 0.5;
      const py = (e.clientY - rect.top) / rect.height - 0.5;
      el.style.transform = `perspective(800px) rotateX(${(-py * maxTiltDeg).toFixed(2)}deg) rotateY(${(px * maxTiltDeg).toFixed(2)}deg)`;
    };
    const handleLeave = () => {
      el.style.transform = 'perspective(800px) rotateX(0deg) rotateY(0deg)';
    };
    el.addEventListener('pointermove', handleMove);
    el.addEventListener('pointerleave', handleLeave);
    return () => {
      el.removeEventListener('pointermove', handleMove);
      el.removeEventListener('pointerleave', handleLeave);
    };
  }, []);

  const speak = useCallback(async (text: string) => {
    if (!text) return;
    try {
      setIsSpeaking(true);
      const res = await fetch('/api/speak', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) throw new Error(await res.text());
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      currentAudioUrlRef.current = url;
      audio.onended = () => {
        setIsSpeaking(false);
        URL.revokeObjectURL(url);
        currentAudioUrlRef.current = null;
      };
      await audio.play();
    } catch (err) {
      console.error(err);
      setIsSpeaking(false);
    }
  }, []);

  const { messages, sendMessage, status, setMessages } = useChat<JarvisUIMessage>({
    onFinish: ({ message }) => {
      if (spokenMessageIds.current.has(message.id)) return;
      spokenMessageIds.current.add(message.id);
      void speak(messageText(message));
    },
    onError: (error) => {
      setStatusText(`Something went wrong: ${error.message}`);
    },
  });

  const shownPanelIds = useRef(new Set<string>());
  const [infoPanel, setInfoPanel] = useState<{ id: string; url: string; title: string; description: string } | null>(
    null,
  );

  // Show new openTab results as a floating HUD panel instead of trying to
  // open a real browser tab — popup blockers kill those before they ever
  // appear, since the trigger is an async agent response, not a click.
  useEffect(() => {
    for (const message of messages) {
      for (const part of message.parts) {
        if (!isOpenTabPart(part) || part.state !== 'output-available') continue;
        const output = part.output as OpenTabOutput | undefined;
        const toolCallId = part.toolCallId;
        if (!output?.url || shownPanelIds.current.has(toolCallId)) continue;
        shownPanelIds.current.add(toolCallId);
        setInfoPanel({ id: toolCallId, url: output.url, title: output.title, description: output.description });
      }
    }
  }, [messages]);

  useEffect(() => {
    if (!infoPanel) return;
    const id = setTimeout(() => {
      setInfoPanel((current) => (current?.id === infoPanel.id ? null : current));
    }, INFO_PANEL_AUTO_DISMISS_MS);
    return () => clearTimeout(id);
  }, [infoPanel]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distanceFromBottom < AUTO_SCROLL_THRESHOLD_PX) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  const phase: Phase = isRecording
    ? 'listening'
    : isSpeaking
      ? 'speaking'
      : status === 'submitted' || status === 'streaming'
        ? 'thinking'
        : 'idle';

  const phaseLabel: Record<Phase, string> = {
    idle: 'Standing by',
    listening: 'Listening…',
    thinking: 'Thinking…',
    speaking: 'Speaking…',
  };

  const linkLabel: Record<Phase, string> = {
    idle: 'READY',
    listening: 'REC',
    thinking: 'BUSY',
    speaking: 'TX',
  };

  useEffect(() => {
    const update = () =>
      setClock(
        new Date().toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      );
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, []);

  const stopRecording = useCallback(() => {
    silenceCleanupRef.current?.();
    silenceCleanupRef.current = null;
    if (captionRecognitionRef.current) {
      captionRecognitionRef.current.onresult = null;
      captionRecognitionRef.current.onerror = null;
      captionRecognitionRef.current.onend = null;
      captionRecognitionRef.current.stop();
      captionRecognitionRef.current = null;
    }
    setLiveCaption('');
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  const startRecording = useCallback(
    async (auto = false) => {
      if (isRecording || status !== 'ready') return;
      // Barge-in: talking (however triggered) always cuts off whatever
      // Jarvis is currently saying, the way Tony talks over JARVIS.
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current = null;
      }
      if (currentAudioUrlRef.current) {
        URL.revokeObjectURL(currentAudioUrlRef.current);
        currentAudioUrlRef.current = null;
      }
      setIsSpeaking(false);
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = async () => {
          stream.getTracks().forEach((track) => track.stop());
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
          if (blob.size < 500) {
            setStatusText("Didn't catch that. Try again, a little closer to the mic.");
            return;
          }
          setStatusText('Transcribing…');
          try {
            const formData = new FormData();
            formData.append('audio', blob, 'speech.webm');
            const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
            if (!res.ok) throw new Error(await res.text());
            const { text } = await res.json();
            if (text?.trim()) {
              setStatusText('');
              sendMessage({ text: text.trim() });
            } else {
              setStatusText("Didn't catch that. Try again.");
            }
          } catch (err) {
            console.error(err);
            setStatusText('Transcription failed. Check your setup.');
          }
        };
        mediaRecorderRef.current = recorder;
        recorder.start();
        setIsRecording(true);
        setStatusText('Listening…');
        setLiveCaption('');

        if (auto) {
          silenceCleanupRef.current = watchForSilence(stream, () => stopRecording());
        }

        // Live captions: a second, purely visual speech-recognition stream
        // running alongside the actual recording, so you see what it's
        // hearing in real time instead of a silent "recording" state. The
        // real transcript (with translation) still comes from Groq Whisper
        // on the recorded audio once you stop — this is just for feedback.
        const CaptionCtor = getSpeechRecognitionCtor();
        if (CaptionCtor) {
          const captionRecognition = new CaptionCtor();
          captionRecognition.continuous = true;
          captionRecognition.interimResults = true;
          captionRecognition.lang = 'en-US';
          captionRecognition.onresult = (event) => {
            let text = '';
            for (let i = 0; i < event.results.length; i++) {
              text += event.results[i][0]?.transcript ?? '';
            }
            setLiveCaption(text.trim());
          };
          captionRecognition.onerror = () => {};
          captionRecognitionRef.current = captionRecognition;
          try {
            captionRecognition.start();
          } catch {
            // ignore — live captions are a nice-to-have, not required
          }
        }
      } catch (err) {
        console.error(err);
        setStatusText('Microphone access denied.');
      }
    },
    [isRecording, status, sendMessage, stopRecording],
  );

  // Wake-word listening: active while idle, and also while Jarvis is
  // speaking so you can barge in and interrupt it by voice — but paused
  // while a command is actually being recorded or the agent is thinking,
  // since there's no useful "interrupt" to make in those states.
  useEffect(() => {
    if (!wakeWordEnabled || (phase !== 'idle' && phase !== 'speaking')) {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      return;
    }

    const Ctor = getSpeechRecognitionCtor();
    if (!Ctor) {
      setWakeWordSupported(false);
      setWakeWordEnabled(false);
      return;
    }

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = 'en-US';

    recognition.onresult = (event) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0]?.transcript ?? '';
        setWakeWordHeard(transcript);
        if (containsWakePhrase(transcript)) {
          // Prevent the onend auto-restart from racing the handoff to the
          // command recorder below — this stop is intentional, not a drop.
          recognition.onend = null;
          recognition.stop();
          setWakeWordHeard('');
          setStatusText('Wake word detected…');
          void startRecording(true);
          return;
        }
      }
    };
    recognition.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        setWakeWordEnabled(false);
        setStatusText('Microphone access denied for wake word.');
      }
    };
    recognition.onend = () => {
      setWakeWordHeard('');
      try {
        recognition.start();
      } catch {
        // already running or being torn down — ignore
      }
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      // ignore duplicate-start errors
    }

    return () => {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.stop();
      setWakeWordHeard('');
    };
  }, [wakeWordEnabled, phase, startRecording]);

  useEffect(() => {
    const isTypingTarget = (el: EventTarget | null) =>
      el instanceof HTMLElement && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA');

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.code === 'Space' && !isTypingTarget(e.target) && !e.repeat) {
        e.preventDefault();
        if (isRecording) {
          stopRecording();
        } else {
          void startRecording(true);
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [isRecording, startRecording, stopRecording]);

  const handleTextSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!textInput.trim()) return;
    sendMessage({ text: textInput.trim() });
    setTextInput('');
  };

  const startNewSession = useCallback(() => {
    if (isRecording) stopRecording();
    audioRef.current?.pause();
    setIsSpeaking(false);
    spokenMessageIds.current.clear();
    setMessages([]);
    setTextInput('');
    setStatusText('Say something in any language, or tap the core to talk.');
  }, [isRecording, stopRecording, setMessages]);

  return (
    <div className={`phase-${phase} relative flex h-dvh flex-col items-center overflow-hidden px-4 sm:px-6`}>
      <div className="hud-bracket tl" />
      <div className="hud-bracket tr" />
      <div className="hud-bracket bl" />
      <div className="hud-bracket br" />

      {infoPanel && (
        <InfoPanel
          title={infoPanel.title}
          description={infoPanel.description}
          url={infoPanel.url}
          onDismiss={() => setInfoPanel(null)}
        />
      )}

      <div className="hud-readout fixed left-6 top-5 hidden sm:block">
        {clock}
        <br />
        LOCAL TIME
      </div>
      <div className="hud-readout fixed right-6 top-5 hidden text-right sm:block">
        <span className="hud-dot mr-1.5 align-middle" />
        {linkLabel[phase]}
        <br />
        GPT-OSS-120B
      </div>

      {settingsOpen && (
        <SettingsPanel
          wakeWordEnabled={wakeWordEnabled}
          wakeWordSupported={wakeWordSupported}
          onToggleWakeWord={() => setWakeWordEnabled((v) => !v)}
          hasMessages={messages.length > 0}
          onNewSession={() => {
            startNewSession();
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <header className="shrink-0 pt-[max(1rem,env(safe-area-inset-top))] text-center">
        <h1 className="text-xs sm:text-sm font-mono tracking-[0.4em] sm:tracking-[0.5em] text-amber-200/70 uppercase">
          Jarvis
        </h1>
      </header>

      <button
        type="button"
        onClick={() => setSettingsOpen(true)}
        className="mt-2 shrink-0 font-mono text-[10px] uppercase tracking-widest text-amber-500/40 transition-colors hover:text-amber-300/80"
      >
        [ settings ]
      </button>

      <div ref={reactorTiltRef} className="reactor-tilt mt-2 shrink-0 sm:mt-4">
        <button
          type="button"
          aria-label={isRecording ? 'Stop talking' : 'Tap to talk'}
          className="reactor mic-button cursor-pointer border-0 bg-transparent p-0"
          onClick={() => {
            if (isRecording) {
              stopRecording();
            } else {
              void startRecording(true);
            }
          }}
        >
          <ReactorHUD phase={phase} />
        </button>
      </div>

      <div className="mt-2 shrink-0 text-center font-mono text-xs uppercase tracking-widest text-amber-200/60 sm:mt-3">
        {phaseLabel[phase]}
      </div>
      <div
        className="shrink-0 px-2 text-center text-xs sm:text-sm min-h-[1.25rem]"
        style={{
          color: isRecording && liveCaption ? 'var(--jarvis-amber)' : 'rgba(217, 167, 92, 0.5)',
        }}
      >
        {isRecording && liveCaption
          ? liveCaption
          : !isRecording && wakeWordEnabled && wakeWordHeard
            ? `heard: "${wakeWordHeard}"`
            : statusText}
      </div>

      {messages.length > 0 && (
        <section
          ref={transcriptRef}
          className="terminal-feed mt-3 flex min-h-0 w-full max-w-xl flex-1 flex-col gap-4 overflow-y-auto px-1 py-6 font-mono sm:mt-4"
        >
          {messages.map((message) => {
            const isUser = message.role === 'user';
            return (
              <div key={message.id} className="message-enter">
                <p
                  className="whitespace-pre-wrap text-[13px] leading-relaxed sm:text-sm"
                  style={{
                    color: isUser ? 'rgba(217, 167, 92, 0.8)' : 'rgba(250, 238, 214, 0.95)',
                  }}
                >
                  {isUser ? `> ${messageText(message)}` : messageText(message)}
                </p>
                {toolPartsOf(message).map((part, i) => (
                  <span key={i} className="mt-1 block text-[10px] tracking-wide text-amber-500/35">
                    # {part.type.replace('tool-', '')}
                  </span>
                ))}
              </div>
            );
          })}
        </section>
      )}

      <form
        onSubmit={handleTextSubmit}
        className="w-full max-w-xl shrink-0 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]"
      >
        <div className="flex items-center gap-2 border-b border-amber-800/40 px-1 py-2 transition-colors focus-within:border-amber-400/80">
          <span className="hud-caret font-mono text-amber-400">{'>'}</span>
          <input
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="Type to Jarvis…"
            className="w-full bg-transparent font-mono text-base text-amber-50 placeholder:text-amber-100/25 focus:outline-none"
          />
        </div>
      </form>
    </div>
  );
}
