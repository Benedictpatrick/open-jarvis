'use client';

import type { InstallState } from '@/lib/use-install-prompt';

/** A dismissible offer to install. Deliberately not hidden in Settings —
 * someone opening the link for the first time should be able to see that it
 * can live on their home screen. */
export function InstallPrompt({
  state,
  onInstall,
  onDismiss,
}: {
  state: InstallState;
  onInstall: () => void;
  onDismiss: () => void;
}) {
  if (state !== 'available' && state !== 'ios-manual') return null;

  return (
    <div className="install-prompt" role="status">
      <span className="install-prompt-text">
        {state === 'available' ? (
          <>Install Jarvis for full-screen voice control.</>
        ) : (
          <>
            To install: tap <strong>Share</strong>, then <strong>Add to Home Screen</strong>.
          </>
        )}
      </span>
      {state === 'available' && (
        <button type="button" className="install-prompt-cta" onClick={onInstall}>
          Install
        </button>
      )}
      <button type="button" className="install-prompt-close" onClick={onDismiss} aria-label="Dismiss">
        ×
      </button>
    </div>
  );
}
