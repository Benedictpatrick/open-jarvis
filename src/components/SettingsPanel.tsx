'use client';

import { useEffect, useState } from 'react';
import { canVibrate } from '@/lib/haptics';
import type { InstallState } from '@/lib/use-install-prompt';

const INSTALL_NOTE: Record<InstallState, string> = {
  installed: 'Running as an installed app',
  available: 'Add Jarvis to your home screen',
  'ios-manual': 'Tap Share, then Add to Home Screen',
  unavailable: 'Not available in this browser',
};

interface StatusResponse {
  founderName: string | null;
  groq:
    | { requestsLimit: number | null; requestsRemaining: number | null; tokensLimit: number | null; tokensRemaining: number | null }
    | { error: string };
  neon: { usedBytes: number; capBytes: number; capComputeHours: number } | { error: string };
  exa: { configured: boolean; note: string };
  vercelSandbox: { note: string };
  phoneControl: { configured: boolean };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function UsageBar({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  return (
    <div className="usage-bar">
      <div className="usage-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

export function SettingsPanel({
  wakeWordEnabled,
  wakeWordSupported,
  onToggleWakeWord,
  useGroqVoice,
  onToggleGroqVoice,
  continuous,
  onToggleContinuous,
  haptics,
  onToggleHaptics,
  voiceName,
  onChooseVoice,
  listVoices,
  installState,
  onInstall,
  legacyFacts,
  onImportLegacy,
  hasMessages,
  onNewSession,
  onClose,
}: {
  wakeWordEnabled: boolean;
  wakeWordSupported: boolean;
  onToggleWakeWord: () => void;
  useGroqVoice: boolean;
  onToggleGroqVoice: () => void;
  continuous: boolean;
  onToggleContinuous: () => void;
  haptics: boolean;
  onToggleHaptics: (() => void);
  voiceName: string | null;
  onChooseVoice: (name: string | null) => void;
  listVoices: () => SpeechSynthesisVoice[];
  installState: InstallState;
  onInstall: () => void;
  legacyFacts: number;
  onImportLegacy: () => void | Promise<void>;
  hasMessages: boolean;
  onNewSession: () => void;
  onClose: () => void;
}) {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [importing, setImporting] = useState(false);
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);

  // Voices arrive asynchronously and, on Android, often after first paint —
  // so listen as well as read.
  useEffect(() => {
    const load = () => setVoices(listVoices());
    load();
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
    window.speechSynthesis.addEventListener('voiceschanged', load);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', load);
  }, [listVoices]);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/status')
      .then((res) => {
        if (!res.ok) throw new Error('bad response');
        return res.json();
      })
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch(() => {
        if (!cancelled) setLoadError(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="settings-overlay" onClick={onClose}>
      <div className="settings-panel" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Settings">
        <div className="info-panel-corner tl" />
        <div className="info-panel-corner tr" />
        <div className="info-panel-corner bl" />
        <div className="info-panel-corner br" />
        <button type="button" onClick={onClose} aria-label="Close settings" className="info-panel-close">
          ×
        </button>

        <div className="settings-title">Settings</div>

        <div className="settings-section">
          <div className="hud-panel-title">Operator</div>
          <p className="hud-panel-note">
            Founder: {status?.founderName ?? '—'}
          </p>
        </div>

        <div className="settings-section">
          <div className="hud-panel-title">Controls</div>
          <div className="settings-row">
            <span>Wake word</span>
            {wakeWordSupported ? (
              <button
                type="button"
                onClick={onToggleWakeWord}
                className="settings-toggle"
                data-state={wakeWordEnabled ? 'on' : 'off'}
                aria-pressed={wakeWordEnabled}
              >
                {wakeWordEnabled ? 'On' : 'Off'}
              </button>
            ) : (
              <span className="settings-toggle-disabled">unsupported</span>
            )}
          </div>
          <div className="settings-row">
            <span>
              Conversation
              <span className="settings-row-note">
                {continuous
                  ? 'Mic reopens after each reply'
                  : 'One turn at a time — tap or call its name'}
              </span>
            </span>
            <button
              type="button"
              onClick={onToggleContinuous}
              className="settings-toggle"
              data-state={continuous ? 'on' : 'off'}
              aria-pressed={continuous}
            >
              {continuous ? 'On' : 'Off'}
            </button>
          </div>
          {voices.length > 0 && (
            <div className="settings-row">
              <span>
                Voice
                <span className="settings-row-note">
                  {voiceName ?? 'Chosen automatically'}
                </span>
              </span>
              <select
                className="settings-select"
                value={voiceName ?? ''}
                onChange={(e) => onChooseVoice(e.target.value || null)}
                aria-label="Speech voice"
              >
                <option value="">Auto</option>
                {voices.map((voice) => (
                  <option key={voice.name} value={voice.name}>
                    {voice.name.replace(/ - English.*$/, '')} ({voice.lang})
                  </option>
                ))}
              </select>
            </div>
          )}
          <div className="settings-row">
            <span>
              Haptics
              <span className="settings-row-note">
                {canVibrate() ? 'Vibration on wake word, mic and replies' : 'No vibration hardware on this device'}
              </span>
            </span>
            {canVibrate() ? (
              <button
                type="button"
                onClick={onToggleHaptics}
                className="settings-toggle"
                data-state={haptics ? 'on' : 'off'}
                aria-pressed={haptics}
              >
                {haptics ? 'On' : 'Off'}
              </button>
            ) : (
              <span className="settings-toggle-disabled">unsupported</span>
            )}
          </div>
          <div className="settings-row">
            <span>
              Premium voice
              <span className="settings-row-note">
                {useGroqVoice
                  ? 'Groq Orpheus — better quality, ~3.6k tokens/day'
                  : 'Browser voice — free and unlimited'}
              </span>
            </span>
            <button
              type="button"
              onClick={onToggleGroqVoice}
              className="settings-toggle"
              data-state={useGroqVoice ? 'on' : 'off'}
              aria-pressed={useGroqVoice}
            >
              {useGroqVoice ? 'On' : 'Off'}
            </button>
          </div>
          {legacyFacts > 0 && (
            <div className="settings-row">
              <span>
                Previous memory
                <span className="settings-row-note">
                  {legacyFacts} fact{legacyFacts === 1 ? '' : 's'} from before profiles existed
                </span>
              </span>
              <button
                type="button"
                className="settings-toggle"
                disabled={importing}
                onClick={async () => {
                  setImporting(true);
                  try {
                    await onImportLegacy();
                  } finally {
                    setImporting(false);
                  }
                }}
              >
                {importing ? '…' : 'Import'}
              </button>
            </div>
          )}
          <div className="settings-row">
            <span>
              Install app
              <span className="settings-row-note">{INSTALL_NOTE[installState]}</span>
            </span>
            {installState === 'available' ? (
              <button type="button" onClick={onInstall} className="settings-toggle" data-state="on">
                Install
              </button>
            ) : (
              <span className="settings-toggle-disabled">
                {installState === 'installed' ? 'installed' : '—'}
              </span>
            )}
          </div>
          <div className="settings-row">
            <span>Session</span>
            <button
              type="button"
              onClick={onNewSession}
              disabled={!hasMessages}
              className="settings-toggle"
              style={{ opacity: hasMessages ? 1 : 0.4, cursor: hasMessages ? 'pointer' : 'default' }}
            >
              Clear
            </button>
          </div>
        </div>

        <div className="settings-section">
          <div className="hud-panel-title">System Limits</div>

          {!status && !loadError && <p className="hud-panel-note">Reading telemetry…</p>}
          {loadError && <p className="hud-panel-note">Could not reach status endpoint.</p>}

          {status && (
            <div className="settings-limits">
              <div className="settings-limit-row">
                <span>Groq — requests/day</span>
                {'error' in status.groq ? (
                  <span className="settings-limit-error">{status.groq.error}</span>
                ) : (
                  <>
                    <span>
                      {status.groq.requestsRemaining ?? '—'} / {status.groq.requestsLimit ?? '—'}
                    </span>
                    {status.groq.requestsRemaining !== null && status.groq.requestsLimit !== null && (
                      <UsageBar
                        used={status.groq.requestsLimit - status.groq.requestsRemaining}
                        total={status.groq.requestsLimit}
                      />
                    )}
                  </>
                )}
              </div>

              <div className="settings-limit-row">
                <span>Groq — tokens/min</span>
                {'error' in status.groq ? (
                  <span className="settings-limit-error">{status.groq.error}</span>
                ) : (
                  <>
                    <span>
                      {status.groq.tokensRemaining ?? '—'} / {status.groq.tokensLimit ?? '—'}
                    </span>
                    {status.groq.tokensRemaining !== null && status.groq.tokensLimit !== null && (
                      <UsageBar
                        used={status.groq.tokensLimit - status.groq.tokensRemaining}
                        total={status.groq.tokensLimit}
                      />
                    )}
                  </>
                )}
              </div>

              <div className="settings-limit-row">
                <span>Neon — storage</span>
                {'error' in status.neon ? (
                  <span className="settings-limit-error">{status.neon.error}</span>
                ) : (
                  <>
                    <span>
                      {formatBytes(status.neon.usedBytes)} / {formatBytes(status.neon.capBytes)}
                    </span>
                    <UsageBar used={status.neon.usedBytes} total={status.neon.capBytes} />
                  </>
                )}
              </div>

              {!('error' in status.neon) && (
                <div className="settings-limit-row">
                  <span>Neon — compute cap</span>
                  <span>{status.neon.capComputeHours} hrs/mo (usage not queryable live)</span>
                </div>
              )}

              <div className="settings-limit-row">
                <span>Exa — web search</span>
                <span className="settings-limit-note">{status.exa.configured ? status.exa.note : 'Not configured'}</span>
              </div>

              <div className="settings-limit-row">
                <span>Vercel Sandbox</span>
                <span className="settings-limit-note">{status.vercelSandbox.note}</span>
              </div>

              <div className="settings-limit-row">
                <span>Phone control</span>
                <span>{status.phoneControl.configured ? 'connected' : 'not connected'}</span>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
