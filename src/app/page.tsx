'use client';

import { useChat } from '@ai-sdk/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { JarvisUIMessage } from '@/lib/agent/jarvis-agent';
import { ReactorHUD } from '@/components/ReactorHUD';
import { InfoPanel } from '@/components/InfoPanel';
import { SettingsPanel } from '@/components/SettingsPanel';
import { HAPTICS, setHapticsEnabled, vibrate } from '@/lib/haptics';

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

// Whisper invents words out of near-silence — "thank you", "I don't know" and
// similar turn up constantly when it is fed room tone. In a loop that reopens
// the mic automatically, one hallucination becomes a reply, which reopens the
// mic, which hallucinates again. So a recording only counts as speech if it
// carried real energy for long enough; anything quieter is thrown away without
// ever reaching transcription.
// Measured against a real room: median level sits near 10, but background
// bursts reach the low 40s — the same loudness as speech. Volume alone cannot
// separate "talking to Jarvis" from "television in the corner", so the gate
// also demands the energy be *sustained*: passing chatter is bursty, a
// deliberate follow-up is not.
// Used to tell "they've started talking" from "the room is quiet", which
// drives when the recording stops. Deliberately generous: being slow to
// notice speech costs the user a real answer.
const SPEECH_THRESHOLD = 16;
const MIN_VOICED_MS = 240;

// A far stricter bar, applied ONLY to the unattended follow-up window. That
// is the one path where a false trigger becomes a runaway loop, so it has to
// clear both a sustained duration and a genuine peak. A recording the user
// deliberately started is never judged this way — they meant to speak.
const FOLLOW_UP_MIN_VOICED_MS = 600;
const FOLLOW_UP_MIN_PEAK = 30;
// A hard stop on unattended turns. The gate reduces false triggers, it cannot
// eliminate them, so a noisy room still must not be able to hold a
// conversation with itself indefinitely.
const MAX_CONSECUTIVE_FOLLOW_UPS = 3;

// After a reply the mic reopens on its own so a conversation can continue
// without re-triggering. If nothing is said in this window, Jarvis stands down.
const FOLLOW_UP_WINDOW_MS = 6000;
// A beat before reopening, so the tail of Jarvis's own speech doesn't bleed
// from the speakers back into the microphone.
const FOLLOW_UP_DELAY_MS = 350;

// Ending a conversation out loud, rather than waiting out the silence timer.
const SIGN_OFF_PATTERNS = [
  /^(that|thats|that's) (will be |would be )?all\b/,
  /^(thank you|thanks)( jarvis)?[.! ]*$/,
  /^(goodbye|good bye|bye)( jarvis)?[.! ]*$/,
  /^(nothing else|no more|stand down|dismissed)\b/,
  /^jarvis,? (thats all|that's all|stand down|dismissed)\b/,
];
const SIGN_OFF_REPLIES = ['Very good, sir.', 'Standing by.', 'As you wish.'];

function isSignOff(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized || normalized.split(' ').length > 5) return false;
  return SIGN_OFF_PATTERNS.some((pattern) => pattern.test(normalized));
}

const WAKE_WORD_STORAGE_KEY = 'jarvis:wake-word';
const CONTINUOUS_STORAGE_KEY = 'jarvis:continuous';
const HAPTICS_STORAGE_KEY = 'jarvis:haptics';

// Boot sequence — the reactor coming online before it settles into idle.
const BOOT_LINES = [
  'ARC REACTOR — INITIALISING',
  'DIAGNOSTICS — ALL SYSTEMS NOMINAL',
  'VOICE INTERFACE — ONLINE',
];
const BOOT_LINE_MS = 620;

interface SessionInfo {
  name: string | null;
  honorific: string;
  lastSeenAt: string | null;
  isNew: boolean;
  legacyFacts: number;
}

function timeOfDayGreeting(): string {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/** JARVIS greets by the clock and acknowledges how long you've been gone —
 * composed on the client so the hour is the user's local one, not the
 * server's. */
function composeGreeting(session: SessionInfo): string {
  const address = session.name ?? session.honorific;
  const opening = `${timeOfDayGreeting()}, ${address}.`;

  if (session.isNew || !session.name) {
    return `${opening} I don't believe we've been introduced.`;
  }

  if (!session.lastSeenAt) return `${opening} At your service.`;

  const elapsedMs = Date.now() - new Date(session.lastSeenAt).getTime();
  const hours = elapsedMs / 3_600_000;
  const days = Math.floor(hours / 24);

  if (hours < 1) return `${opening} Welcome back.`;
  if (days < 1) return `${opening} It's been a few hours.`;
  if (days === 1) return `${opening} It's been a day since we last spoke.`;
  if (days < 14) return `${opening} It's been ${days} days since our last session.`;
  return `${opening} It's been some time.`;
}
const GROQ_VOICE_STORAGE_KEY = 'jarvis:groq-voice';

// JARVIS is British in the films, and the browser's own speech synthesis is
// free, unlimited and needs no key — Edge in particular exposes Microsoft's
// neural voices through it. Ordered best-first; the first one present wins.
const PREFERRED_VOICES = [
  // Edge / Windows neural voices
  'Microsoft Ryan Online (Natural)',
  'Microsoft Thomas Online (Natural)',
  'Microsoft Oliver Online (Natural)',
  'Microsoft Brian Multilingual Online (Natural)',
  'Microsoft Andrew Multilingual Online (Natural)',
  // Android — the names Chrome exposes there
  'Google UK English Male',
  'Google US English Male',
  // iOS / macOS
  'Daniel',
  'Arthur',
  'Oliver',
];

const VOICE_STORAGE_KEY = 'jarvis:voice';

/** Chosen in Settings. Device voice sets vary far too much to guess from a
 * name list alone, so an explicit pick always wins. */
let preferredVoiceName: string | null = null;

function setPreferredVoice(name: string | null): void {
  preferredVoiceName = name;
}

function isFemaleNamed(voice: SpeechSynthesisVoice): boolean {
  return /female|woman/i.test(voice.name);
}

function isMaleNamed(voice: SpeechSynthesisVoice): boolean {
  return /\bmale\b|\bman\b/i.test(voice.name) && !isFemaleNamed(voice);
}

export function englishVoices(): SpeechSynthesisVoice[] {
  if (!hasSpeechSynthesis()) return [];
  return window.speechSynthesis.getVoices().filter((voice) => voice.lang.startsWith('en'));
}

// Chromium silently truncates a single utterance after roughly 15 seconds.
// Splitting on sentence boundaries keeps every chunk well under that, and
// reads with more natural phrasing anyway.
const SPEECH_CHUNK_CHARS = 180;

/** Whether speech recognition and an open MediaRecorder can share the mic.
 * Desktop copes; Android does not, because recognition there is a separate
 * system service competing for the same device. */
function supportsConcurrentMic(): boolean {
  if (typeof navigator === 'undefined') return false;
  return navigator.maxTouchPoints === 0;
}

function hasSpeechSynthesis(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

/** Voices load asynchronously in most browsers — the first getVoices() call
 * routinely returns an empty list. */
function whenVoicesReady(): Promise<void> {
  return new Promise((resolve) => {
    if (!hasSpeechSynthesis()) return resolve();
    if (window.speechSynthesis.getVoices().length > 0) return resolve();

    // Android fires 'voiceschanged' late, and sometimes not at all, so poll as
    // well as listen. The old version simply resolved after a fixed wait — on a
    // phone the list was usually still empty by then, no voice got assigned,
    // and Android fell back to its default, which is why Jarvis sounded female.
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(cap);
      resolve();
    };
    const poll = setInterval(() => {
      if (window.speechSynthesis.getVoices().length > 0) finish();
    }, 120);
    const cap = setTimeout(finish, 4000);
    window.speechSynthesis.addEventListener('voiceschanged', finish, { once: true });
  });
}

function pickJarvisVoice(): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;

  if (preferredVoiceName) {
    const chosen = voices.find((voice) => voice.name === preferredVoiceName);
    if (chosen) return chosen;
  }

  for (const name of PREFERRED_VOICES) {
    const match = voices.find((voice) => voice.name.startsWith(name));
    if (match) return match;
  }

  // Nothing recognised by name. Fall back by character rather than taking
  // whatever happens to be first, which is how a female voice slipped through.
  const en = voices.filter((voice) => voice.lang.startsWith('en'));
  const gb = en.filter((voice) => voice.lang === 'en-GB');
  return (
    gb.find(isMaleNamed) ??
    en.find(isMaleNamed) ??
    gb.find((voice) => !isFemaleNamed(voice)) ??
    en.find((voice) => !isFemaleNamed(voice)) ??
    gb[0] ??
    en[0] ??
    voices[0] ??
    null
  );
}

function chunkForSpeech(text: string): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    if (current && current.length + sentence.length > SPEECH_CHUNK_CHARS) {
      chunks.push(current.trim());
      current = sentence;
    } else {
      current += sentence;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.filter(Boolean);
}

function speakWithBrowser(text: string, onDone: () => void): void {
  const synth = window.speechSynthesis;
  synth.cancel();
  const voice = pickJarvisVoice();
  const chunks = chunkForSpeech(text);
  if (!chunks.length) return onDone();

  chunks.forEach((chunk, i) => {
    const utterance = new SpeechSynthesisUtterance(chunk);
    if (voice) {
      utterance.voice = voice;
      utterance.lang = voice.lang;
    }
    utterance.rate = 1.02;
    utterance.pitch = 0.95;
    // Only the final chunk reports completion; an error anywhere ends the turn
    // rather than leaving the UI stuck in the speaking phase.
    if (i === chunks.length - 1) utterance.onend = onDone;
    utterance.onerror = onDone;
    synth.speak(utterance);
  });
}

const IDLE_HINT_TAP = 'Tap the core or press space to talk.';
const IDLE_HINT_WAKE = 'Listening for “Jarvis” — or tap the core to talk.';

// Errors that mean the mic will never arrive on its own: retrying just burns
// CPU. 'audio-capture' in particular is what an OS-level microphone privacy
// block looks like — the browser grants the permission, the system refuses
// the device — so it has to reach the user as text or the wake word just
// appears to be on while hearing nothing.
const FATAL_RECOGNITION_ERRORS = new Set(['not-allowed', 'service-not-allowed', 'audio-capture']);
// Recognition ends on its own constantly (every pause in speech), so a plain
// end is not a failure and restarts promptly. Anything else backs off.
const BENIGN_RECOGNITION_ERRORS = new Set(['no-speech', 'aborted']);
// Fallback if the recogniser's 'end' never arrives — the handoff must not
// stall forever waiting for an event some platform declines to fire.
const MIC_HANDOFF_TIMEOUT_MS = 700;
const RECOGNITION_RESTART_MS = 250;
const RECOGNITION_BACKOFF_BASE_MS = 400;
const RECOGNITION_BACKOFF_MAX_MS = 10000;
const MAX_RECOGNITION_FAILURES = 6;

const RECOGNITION_ERROR_MESSAGES: Record<string, string> = {
  'not-allowed': 'Microphone access denied for wake word.',
  'service-not-allowed': 'Speech recognition is blocked in this browser.',
  'audio-capture':
    "Can't reach the microphone. Check your system's mic privacy settings and that no other app is using it.",
};

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

// Roughly the RMS of confident speech at arm's length. Used only to map raw
// amplitude onto a 0–1 range for the visuals; the silence logic still works
// off the raw value.
const MIC_LEVEL_CEILING = 40;

// Analysis cadence. Fast enough for responsive silence detection and a lively
// core; the CSS transition on the core smooths the gaps between samples.
const MIC_TICK_MS = 80;

/** Monitors a mic stream's volume. Calls onSilence after speech is followed by
 * a sustained quiet period (or a hard duration cap), so a wake-word-triggered
 * recording can stop itself without a button release. Pass onSilence as null to
 * meter the stream without auto-stopping it. onLevel receives a normalised 0–1
 * amplitude every frame, which drives the reactor's core while recording. */
function watchForSilence(
  stream: MediaStream,
  /** Reports how much real speech the recording actually carried, so the
   * caller can decide whether to transcribe it. */
  onSilence: ((info: { hasSpoken: boolean; voicedMs: number; peak: number }) => void) | null,
  onLevel?: (level: number) => void,
  /** If set, give up this long after opening when nobody has said anything —
   * used to close an unanswered follow-up window instead of recording, and
   * then transcribing, several seconds of room tone. */
  noSpeechMs?: number,
): () => void {
  const AudioContextCtor =
    window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const audioCtx = new AudioContextCtor();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);

  let voicedMs = 0;
  let peak = 0;
  let silenceStart: number | null = null;
  const startTime = Date.now();
  let stopped = false;

  // Driven by a timer rather than requestAnimationFrame: rAF is suspended
  // entirely in a background tab, which would leave a recording running
  // forever if the user switched tabs or their screen locked mid-sentence.
  // Timers keep firing there (throttled to about 1s), so the silence stop and
  // the hard cap still happen.
  let intervalId = 0 as unknown as ReturnType<typeof setInterval>;

  const cleanup = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(intervalId);
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

    onLevel?.(Math.min(1, rms / MIC_LEVEL_CEILING));

    if (rms > peak) peak = rms;
    if (rms > SPEECH_THRESHOLD) voicedMs += MIC_TICK_MS;
    const hasSpoken = voicedMs >= MIN_VOICED_MS;

    if (onSilence) {
      const report = () => {
        cleanup();
        onSilence({ hasSpoken, voicedMs, peak });
      };

      if (rms > SILENCE_THRESHOLD) {
        silenceStart = null;
      } else if (hasSpoken) {
        if (silenceStart === null) silenceStart = Date.now();
        else if (Date.now() - silenceStart > SILENCE_HOLD_MS) return report();
      }

      if (!hasSpoken && noSpeechMs !== undefined && Date.now() - startTime > noSpeechMs) return report();
      if (Date.now() - startTime > MAX_AUTO_RECORDING_MS) return report();
    }
  };

  intervalId = setInterval(tick, MIC_TICK_MS);
  return cleanup;
}

function messageText(message: JarvisUIMessage): string {
  // A multi-step tool-calling turn can produce several separate 'text'
  // parts (one per step, e.g. narrating before a tool call and again
  // after). Only the last one is the model's actual final reply — joining
  // them all reads as the model repeating itself.
  //
  // The last part can also be empty: a turn that ends on a tool step emits a
  // trailing blank text part, and taking it verbatim renders a silent reply
  // and speaks nothing. Fall back to the last part that actually has words.
  const textParts = message.parts.filter((part): part is Extract<typeof part, { type: 'text' }> => part.type === 'text');
  return (
    textParts
      .map((part) => part.text.trim())
      .filter(Boolean)
      .at(-1) ?? ''
  );
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
  // Empty means "nothing to report" — the idle hint is derived at render time
  // from whether the wake word is actually armed, so the UI never claims to be
  // passively listening when it isn't.
  const [statusText, setStatusText] = useState('');
  const [textInput, setTextInput] = useState('');
  const [clock, setClock] = useState('');
  const [wakeWordEnabled, setWakeWordEnabled] = useState(false);
  const [wakeWordSupported, setWakeWordSupported] = useState(true);
  const [useGroqVoice, setUseGroqVoice] = useState(false);
  const [continuous, setContinuous] = useState(true);
  const [haptics, setHaptics] = useState(true);
  const [voiceName, setVoiceName] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [liveCaption, setLiveCaption] = useState('');
  const [wakeWordHeard, setWakeWordHeard] = useState('');
  const [bootStep, setBootStep] = useState(0);
  const [booting, setBooting] = useState(true);
  const [session, setSession] = useState<SessionInfo | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const spokenMessageIds = useRef(new Set<string>());
  const transcriptRef = useRef<HTMLElement | null>(null);
  const reactorTiltRef = useRef<HTMLDivElement | null>(null);
  const silenceCleanupRef = useRef<(() => void) | null>(null);
  const discardRecordingRef = useRef(false);
  // Set when a reply is about to be spoken, so the mic reopens for a follow-up
  // once it finishes — this is what makes the conversation continuous.
  const followUpPendingRef = useRef(false);
  const wasSpeakingRef = useRef(false);
  const followUpCountRef = useRef(0);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const recognitionRef = useRef<MinimalSpeechRecognition | null>(null);
  const captionRecognitionRef = useRef<MinimalSpeechRecognition | null>(null);
  const currentAudioUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!getSpeechRecognitionCtor()) setWakeWordSupported(false);
  }, []);

  // Restore the wake-word preference. Read after mount rather than in a lazy
  // initializer so the server-rendered markup and the first client render
  // agree.
  useEffect(() => {
    try {
      // Reading a persisted preference out of localStorage is exactly the
      // "sync from an external system" case the rule is aimed past; it can't
      // be a lazy initializer without making the client's first render
      // disagree with the server's.
      // On by default — calling its name is the primary way in, so it has to
      // work without first being discovered in Settings. Only an explicit
      // 'off' disables it.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      if (localStorage.getItem(WAKE_WORD_STORAGE_KEY) !== 'off') setWakeWordEnabled(true);
      if (localStorage.getItem(GROQ_VOICE_STORAGE_KEY) === 'on') setUseGroqVoice(true);
      if (localStorage.getItem(CONTINUOUS_STORAGE_KEY) === 'off') setContinuous(false);
      const storedVoice = localStorage.getItem(VOICE_STORAGE_KEY);
      if (storedVoice) {
        setVoiceName(storedVoice);
        setPreferredVoice(storedVoice);
      }
      if (localStorage.getItem(HAPTICS_STORAGE_KEY) === 'off') {
        setHaptics(false);
        setHapticsEnabled(false);
      }
    } catch {
      // private mode / storage disabled — just leave it off
    }
  }, []);

  const chooseVoice = useCallback((name: string | null) => {
    setVoiceName(name);
    setPreferredVoice(name);
    try {
      if (name) localStorage.setItem(VOICE_STORAGE_KEY, name);
      else localStorage.removeItem(VOICE_STORAGE_KEY);
    } catch {
      // ignore — the choice still applies for this session
    }
    // Say something immediately so the choice can be judged by ear.
    if (hasSpeechSynthesis()) {
      window.speechSynthesis.cancel();
      speakWithBrowser('Voice set, sir.', () => {});
    }
  }, []);

  const toggleHaptics = useCallback(() => {
    const next = !haptics;
    setHaptics(next);
    setHapticsEnabled(next);
    // Fire one immediately so turning it on demonstrates what it feels like.
    if (next) vibrate(HAPTICS.listenStart);
    try {
      localStorage.setItem(HAPTICS_STORAGE_KEY, next ? 'on' : 'off');
    } catch {
      // ignore — the toggle still works for this session
    }
  }, [haptics]);

  const toggleContinuous = useCallback(() => {
    const next = !continuous;
    setContinuous(next);
    if (!next) followUpPendingRef.current = false;
    try {
      localStorage.setItem(CONTINUOUS_STORAGE_KEY, next ? 'on' : 'off');
    } catch {
      // ignore — the toggle still works for this session
    }
  }, [continuous]);

  const toggleGroqVoice = useCallback(() => {
    const next = !useGroqVoice;
    setUseGroqVoice(next);
    setStatusText('');
    try {
      localStorage.setItem(GROQ_VOICE_STORAGE_KEY, next ? 'on' : 'off');
    } catch {
      // ignore — the toggle still works for this session
    }
  }, [useGroqVoice]);

  // Only an explicit toggle is persisted. A fatal error disables the wake word
  // for the session but leaves the stored preference alone, so fixing the mic
  // and reloading brings it back without digging through settings again.
  const toggleWakeWord = useCallback(() => {
    const next = !wakeWordEnabled;
    setWakeWordEnabled(next);
    setStatusText('');
    try {
      localStorage.setItem(WAKE_WORD_STORAGE_KEY, next ? 'on' : 'off');
    } catch {
      // ignore — the toggle still works for this session
    }
  }, [wakeWordEnabled]);

  useEffect(() => {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  // Boot sequence. It also covers the session fetch, so the greeting is ready
  // by the time the reactor settles.
  useEffect(() => {
    let cancelled = false;

    void fetch('/api/session')
      .then((res) => res.json())
      .then((data: SessionInfo) => {
        if (!cancelled) setSession(data);
      })
      .catch(() => {
        if (!cancelled) {
          setSession({ name: null, honorific: 'sir', lastSeenAt: null, isNew: true, legacyFacts: 0 });
        }
      });

    const timers = BOOT_LINES.map((_, i) =>
      setTimeout(() => !cancelled && setBootStep(i + 1), BOOT_LINE_MS * (i + 1)),
    );
    const finish = setTimeout(
      () => !cancelled && setBooting(false),
      BOOT_LINE_MS * (BOOT_LINES.length + 1),
    );

    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
      clearTimeout(finish);
    };
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

  /** Silences whatever is currently talking, whichever engine produced it. */
  const stopSpeaking = useCallback(() => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    if (currentAudioUrlRef.current) {
      URL.revokeObjectURL(currentAudioUrlRef.current);
      currentAudioUrlRef.current = null;
    }
    if (hasSpeechSynthesis()) window.speechSynthesis.cancel();
    setIsSpeaking(false);
  }, []);

  const speak = useCallback(
    async (text: string) => {
      if (!text) return;
      stopSpeaking();
      setIsSpeaking(true);
      vibrate(HAPTICS.replyStart);

      let finished = false;
      const done = () => {
        if (finished) return;
        finished = true;
        setIsSpeaking(false);
      };

      // Groq's TTS sounds better but is capped at a few thousand tokens a day,
      // so it's opt-in. Any failure (quota, network) drops straight to the
      // browser voice instead of leaving the reply silent.
      if (useGroqVoice) {
        try {
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
            URL.revokeObjectURL(url);
            currentAudioUrlRef.current = null;
            done();
          };
          audio.onerror = done;
          await audio.play();
          return;
        } catch (err) {
          console.error(err);
          setStatusText('Premium voice unavailable — using the browser voice.');
        }
      }

      if (!hasSpeechSynthesis()) {
        setStatusText('This browser has no speech support, so replies stay text-only.');
        done();
        return;
      }

      await whenVoicesReady();
      speakWithBrowser(text, done);
    },
    [useGroqVoice, stopSpeaking],
  );

  // Greeting fires once the reactor has settled and the session is known.
  const greetedRef = useRef(false);
  useEffect(() => {
    if (booting || !session || greetedRef.current) return;
    greetedRef.current = true;

    const greeting = composeGreeting(session);
    setStatusText(greeting);
    void speak(greeting);

    // Autoplay policy blocks sound on a first visit with no prior interaction,
    // so the greeting can be dropped silently. The text is already on screen;
    // if nothing actually started, say it on the first gesture instead.
    const retry = () => void speak(greeting);
    const check = setTimeout(() => {
      const started =
        (hasSpeechSynthesis() && (window.speechSynthesis.speaking || window.speechSynthesis.pending)) ||
        audioRef.current !== null;
      if (started) return;
      window.addEventListener('pointerdown', retry, { once: true });
      window.addEventListener('keydown', retry, { once: true });
    }, 1200);

    return () => {
      clearTimeout(check);
      window.removeEventListener('pointerdown', retry);
      window.removeEventListener('keydown', retry);
    };
  }, [booting, session, speak]);

  const { messages, sendMessage, status, setMessages } = useChat<JarvisUIMessage>({
    onFinish: ({ message }) => {
      if (spokenMessageIds.current.has(message.id)) return;
      spokenMessageIds.current.add(message.id);
      // Arm the follow-up before speaking: when the speech ends, the mic
      // reopens so the user can simply keep talking.
      followUpPendingRef.current = continuous;
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

  const stopRecording = useCallback((discard = false) => {
    // A discarded stop means nothing was said — skip transcription entirely
    // rather than sending several seconds of room tone to Whisper.
    discardRecordingRef.current = discard;
    if (discard) followUpPendingRef.current = false;
    silenceCleanupRef.current?.();
    silenceCleanupRef.current = null;
    stageRef.current?.style.setProperty('--mic-level', '0');
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
      // Only when a recording was genuinely running — this function is also
      // called defensively during teardown.
      vibrate(HAPTICS.listenStop);
    }
    setIsRecording(false);
  }, []);

  const startRecording = useCallback(
    async (auto = false, isFollowUp = false) => {
      if (isRecording || status !== 'ready') return;
      // A deliberate activation — tap, space bar, wake word — means a person is
      // driving, so the unattended-turn budget starts over.
      if (!isFollowUp) followUpCountRef.current = 0;
      // Barge-in: talking (however triggered) always cuts off whatever
      // Jarvis is currently saying, the way Tony talks over JARVIS.
      stopSpeaking();
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const recorder = new MediaRecorder(stream);
        chunksRef.current = [];
        recorder.ondataavailable = (e) => {
          if (e.data.size > 0) chunksRef.current.push(e.data);
        };
        recorder.onstop = async () => {
          stream.getTracks().forEach((track) => track.stop());
          if (discardRecordingRef.current) {
            discardRecordingRef.current = false;
            setStatusText('');
            return;
          }
          const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
          if (blob.size < 500) {
            // On a follow-up this is just a quiet room, not a failed attempt.
            setStatusText(isFollowUp ? '' : "Didn't catch that. Try again, a little closer to the mic.");
            return;
          }
          setStatusText('Transcribing…');
          try {
            const formData = new FormData();
            formData.append('audio', blob, 'speech.webm');
            const res = await fetch('/api/transcribe', { method: 'POST', body: formData });
            if (!res.ok) throw new Error(await res.text());
            const { text } = await res.json();
            const spoken = text?.trim();
            if (!spoken) {
              setStatusText(isFollowUp ? '' : "Didn't catch that. Try again.");
              return;
            }
            // Ending the conversation out loud never reaches the model — it
            // just closes the loop with an acknowledgement.
            if (isSignOff(spoken)) {
              followUpPendingRef.current = false;
              setStatusText('');
              void speak(SIGN_OFF_REPLIES[Math.floor(Math.random() * SIGN_OFF_REPLIES.length)]);
              return;
            }
            setStatusText('');
            sendMessage({ text: spoken });
          } catch (err) {
            console.error(err);
            setStatusText('Transcription failed. Check your setup.');
          }
        };
        mediaRecorderRef.current = recorder;
        recorder.start();
        setIsRecording(true);
        // Your turn — felt rather than seen, so it works with the phone in a
        // pocket or across the room.
        vibrate(HAPTICS.listenStart);
        setStatusText('Listening…');
        setLiveCaption('');

        // Meter the stream whether or not it auto-stops, so the core can track
        // the user's voice. The level is written straight to a CSS custom
        // property rather than React state — this fires every animation frame.
        silenceCleanupRef.current = watchForSilence(
          stream,
          auto
            ? (info) => {
                // A recording the user started themselves is always sent for
                // transcription — they meant to speak, and silently binning it
                // is why Jarvis would listen and then never answer. Only the
                // automatic follow-up window has to prove it heard real speech,
                // because that is the path a false trigger can run away on.
                const discard =
                  isFollowUp &&
                  (info.voicedMs < FOLLOW_UP_MIN_VOICED_MS || info.peak < FOLLOW_UP_MIN_PEAK);
                stopRecording(discard);
              }
            : null,
          (level) => stageRef.current?.style.setProperty('--mic-level', level.toFixed(3)),
          // A follow-up window closes itself if the room stays quiet; a
          // deliberate activation waits for you.
          isFollowUp ? FOLLOW_UP_WINDOW_MS : undefined,
        );

        // Live captions: a second, purely visual speech-recognition stream
        // running alongside the actual recording, so you see what it's
        // hearing in real time instead of a silent "recording" state. The
        // real transcript (with translation) still comes from Groq Whisper
        // on the recorded audio once you stop — this is just for feedback.
        //
        // Skipped on phones. Android routes SpeechRecognition through Google's
        // speech service, which demands the microphone exclusively — running it
        // while MediaRecorder holds the mic makes Android pop up "Speech
        // recognition and synthesis from Google cannot record now as Chrome is
        // recording" and can cost us the recording itself. A cosmetic caption is
        // never worth losing the actual command.
        const CaptionCtor = supportsConcurrentMic() ? getSpeechRecognitionCtor() : null;
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
    [isRecording, status, sendMessage, stopRecording, stopSpeaking, speak],
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

    // `done` covers every intentional stop (teardown, wake-word handoff, giving
    // up after repeated failures) so the end handler can tell those apart from
    // the routine end-of-utterance that should restart.
    let done = false;
    let consecutiveFailures = 0;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;

    recognition.onresult = (event) => {
      // Audio is genuinely flowing, so forget any earlier backoff.
      consecutiveFailures = 0;
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const transcript = event.results[i][0]?.transcript ?? '';
        setWakeWordHeard(transcript);
        if (containsWakePhrase(transcript)) {
          // Prevent the auto-restart from racing the handoff to the command
          // recorder below — this stop is intentional, not a drop.
          done = true;
          setWakeWordHeard('');
          // Confirm it heard you before anything else happens.
          vibrate(HAPTICS.wakeWord);
          setStatusText('Wake word detected…');

          // Hand the microphone over properly rather than grabbing it. On
          // Android, recognition runs in Google's speech service, which holds
          // the mic until it has actually finished — calling getUserMedia
          // straight away races that release and produces "cannot record now
          // as Chrome is recording", losing the command. Waiting for 'end'
          // costs nothing on desktop, where it fires immediately.
          let handedOff = false;
          const handOff = () => {
            if (handedOff) return;
            handedOff = true;
            void startRecording(true);
          };
          recognition.addEventListener('end', handOff, { once: true });
          setTimeout(handOff, MIC_HANDOFF_TIMEOUT_MS);
          recognition.stop();
          return;
        }
      }
    };

    recognition.onerror = (event) => {
      if (BENIGN_RECOGNITION_ERRORS.has(event.error)) return;
      consecutiveFailures++;
      if (FATAL_RECOGNITION_ERRORS.has(event.error)) {
        done = true;
        setWakeWordEnabled(false);
        setStatusText(RECOGNITION_ERROR_MESSAGES[event.error] ?? `Wake word stopped: ${event.error}.`);
      }
    };

    // Every restart goes through a timer. Restarting synchronously here is what
    // turns a persistent failure into a hot loop: the error fires, end fires,
    // start throws or immediately errors again, thousands of times a second.
    recognition.onend = () => {
      setWakeWordHeard('');
      if (done) return;
      if (consecutiveFailures >= MAX_RECOGNITION_FAILURES) {
        setWakeWordEnabled(false);
        setStatusText('Wake word keeps failing to start. Turn it back on in settings to retry.');
        return;
      }
      const delay =
        consecutiveFailures === 0
          ? RECOGNITION_RESTART_MS
          : Math.min(RECOGNITION_BACKOFF_BASE_MS * 2 ** (consecutiveFailures - 1), RECOGNITION_BACKOFF_MAX_MS);
      restartTimer = setTimeout(() => {
        if (done) return;
        try {
          recognition.start();
        } catch {
          // already running or being torn down — ignore
        }
      }, delay);
    };

    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      // ignore duplicate-start errors
    }

    return () => {
      done = true;
      clearTimeout(restartTimer);
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      recognition.stop();
      setWakeWordHeard('');
    };
  }, [wakeWordEnabled, phase, startRecording]);

  // Continuous conversation: the moment a spoken reply finishes, reopen the
  // mic for a follow-up. One wake word starts a whole exchange instead of
  // every single turn needing its own trigger.
  useEffect(() => {
    const wasSpeaking = wasSpeakingRef.current;
    wasSpeakingRef.current = isSpeaking;
    if (!wasSpeaking || isSpeaking) return;
    if (!followUpPendingRef.current) return;
    followUpPendingRef.current = false;

    if (followUpCountRef.current >= MAX_CONSECUTIVE_FOLLOW_UPS) {
      followUpCountRef.current = 0;
      setStatusText('Standing by.');
      return;
    }
    followUpCountRef.current += 1;

    const timer = setTimeout(() => void startRecording(true, true), FOLLOW_UP_DELAY_MS);
    return () => clearTimeout(timer);
  }, [isSpeaking, startRecording]);

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
    stopSpeaking();
    spokenMessageIds.current.clear();
    setMessages([]);
    setTextInput('');
    setStatusText('');
  }, [isRecording, stopRecording, stopSpeaking, setMessages]);

  const idleHint = wakeWordEnabled ? IDLE_HINT_WAKE : IDLE_HINT_TAP;

  return (
    <div
      ref={stageRef}
      className={`app-shell phase-${phase} ${messages.length > 0 ? 'has-sheet' : ''} ${booting ? 'is-booting' : ''}`}
    >
      {/* One mesh layer per phase, crossfaded by opacity. Four real layers
          rather than one mutating gradient, so the transition is a true
          blend instead of a snap. */}
      <div className="mesh mesh-idle" />
      <div className="mesh mesh-listening" />
      <div className="mesh mesh-thinking" />
      <div className="mesh mesh-speaking" />

      {infoPanel && (
        <InfoPanel
          title={infoPanel.title}
          description={infoPanel.description}
          url={infoPanel.url}
          onDismiss={() => setInfoPanel(null)}
        />
      )}

      {settingsOpen && (
        <SettingsPanel
          wakeWordEnabled={wakeWordEnabled}
          wakeWordSupported={wakeWordSupported}
          onToggleWakeWord={toggleWakeWord}
          useGroqVoice={useGroqVoice}
          onToggleGroqVoice={toggleGroqVoice}
          continuous={continuous}
          onToggleContinuous={toggleContinuous}
          haptics={haptics}
          onToggleHaptics={toggleHaptics}
          voiceName={voiceName}
          onChooseVoice={chooseVoice}
          listVoices={englishVoices}
          legacyFacts={session?.legacyFacts ?? 0}
          onImportLegacy={async () => {
            const res = await fetch('/api/session', { method: 'POST' });
            if (!res.ok) return;
            const result = (await res.json()) as { facts: number; name: string | null };
            setSession((current) => (current ? { ...current, legacyFacts: 0, name: result.name ?? current.name } : current));
            setStatusText(`Imported ${result.facts} remembered fact${result.facts === 1 ? '' : 's'}.`);
          }}
          hasMessages={messages.length > 0}
          onNewSession={() => {
            startNewSession();
            setSettingsOpen(false);
          }}
          onClose={() => setSettingsOpen(false)}
        />
      )}

      <header className="chrome-top">
        <span className="nav-brand">Jarvis</span>
        <div className="flex items-center gap-3">
          <span className="chrome-clock hidden sm:inline">{clock}</span>
          <button type="button" onClick={() => setSettingsOpen(true)} className="nav-btn nav-btn-ghost">
            Settings
          </button>
        </div>
      </header>

      <>
        {/* Status sits above the reactor rather than below it, so the sheet can
            rise over the lower half without ever colliding with this text. */}
        <div className="stage-status">
          {booting ? (
            <div className="boot-lines" role="status">
              {BOOT_LINES.slice(0, bootStep).map((line) => (
                <div key={line} className="boot-line">
                  {line}
                </div>
              ))}
            </div>
          ) : (
            <>
              <div className="phase-row flex items-center gap-2">
                <span className="band-dot" />
                <span className="phase-label">{phaseLabel[phase]}</span>
              </div>

              <p className={`band-status max-w-md text-center ${isRecording && liveCaption ? 'is-caption' : ''}`}>
                {isRecording && liveCaption
                  ? liveCaption
                  : !isRecording && wakeWordEnabled && wakeWordHeard
                    ? `heard: "${wakeWordHeard}"`
                    : statusText || idleHint}
              </p>
            </>
          )}
        </div>

        <div className="stage-core">
          {/* Remounted on every phase change by its key, so the burst replays
              each time the state actually flips. */}
          <span key={phase} className="shockwave" aria-hidden />
          <div ref={reactorTiltRef} className="reactor-tilt">
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
        </div>

        <div className="stage-readout band-readout">
          <span>{linkLabel[phase]}</span>
          <span aria-hidden>·</span>
          <span>GPT-OSS-120B</span>
        </div>

        {/* Frosted sheet: the conversation rises over the stage rather than
            displacing it, so the reactor keeps its full scale and stays
            visible glowing behind the text. */}
        {messages.length > 0 && (
          <section ref={transcriptRef} className="transcript-sheet">
            {messages.map((message) => {
              const isUser = message.role === 'user';
              return (
                <div key={message.id} className="message-enter">
                  <div className="sheet-eyebrow mb-1.5">{isUser ? 'You' : 'Jarvis'}</div>
                  <p className={`whitespace-pre-wrap ${isUser ? 'msg-user' : 'msg-assistant'}`}>
                    {messageText(message)}
                  </p>
                  {toolPartsOf(message).length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {toolPartsOf(message).map((part, i) => (
                        <span key={i} className="tool-tag">
                          {part.type.replace('tool-', '')}
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </section>
        )}
      </>

      <form onSubmit={handleTextSubmit} className="composer-float">
        <div className="composer">
          <span className="composer-caret">{'>'}</span>
          <input
            value={textInput}
            onChange={(e) => setTextInput(e.target.value)}
            placeholder="Type to Jarvis…"
            className="composer-input"
          />
        </div>
      </form>
    </div>
  );
}
