'use client';

import { useCallback, useEffect, useState } from 'react';

/** Chromium fires this instead of showing its own install banner once the site
 * meets the install criteria. Capturing it lets the app offer installation at
 * a sensible moment rather than leaving it buried in a browser menu. */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

export type InstallState =
  /** Already running as an installed app. */
  | 'installed'
  /** Chromium has offered a prompt we can trigger on demand. */
  | 'available'
  /** iOS has no install API at all — the user must do it by hand. */
  | 'ios-manual'
  /** Not installable here (unsupported browser, or criteria unmet). */
  | 'unavailable';

export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);
  const [installed, setInstalled] = useState(false);
  const [isIos, setIsIos] = useState(false);

  useEffect(() => {
    const standalone =
      window.matchMedia('(display-mode: standalone)').matches ||
      // iOS Safari predates display-mode and reports this instead.
      (navigator as Navigator & { standalone?: boolean }).standalone === true;

    // Every browser on iOS is WebKit underneath, so the platform decides this,
    // not the browser brand.
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent);

    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (standalone) setInstalled(true);
    if (ios) setIsIos(true);

    const onPrompt = (event: Event) => {
      // Suppress the browser's own banner so the app can place the offer.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    const onInstalled = () => {
      setInstalled(true);
      setDeferred(null);
    };

    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const state: InstallState = installed
    ? 'installed'
    : deferred
      ? 'available'
      : isIos
        ? 'ios-manual'
        : 'unavailable';

  /** Returns the user's choice, or null when there was no prompt to show.
   * The captured event is single-use — Chromium will fire a fresh one if the
   * user declines and remains eligible. */
  const install = useCallback(async (): Promise<'accepted' | 'dismissed' | null> => {
    if (!deferred) return null;
    await deferred.prompt();
    const { outcome } = await deferred.userChoice;
    if (outcome === 'accepted') setInstalled(true);
    setDeferred(null);
    return outcome;
  }, [deferred]);

  return { state, install };
}
