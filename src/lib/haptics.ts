/** Haptic feedback for the voice loop.
 *
 * Reality of the platform, so nobody has to rediscover it:
 * - Android Chrome/Edge: works.
 * - iOS Safari: no Vibration API at all, ever. Silently does nothing.
 * - Desktop: the function exists but returns false — there is no hardware.
 * - There is no intensity control. The API takes durations in milliseconds,
 *   so "strong" means longer pulses, not a louder motor.
 * - Chrome requires prior user activation on the page; a buzz fired before the
 *   user has interacted is dropped.
 */

/** Long pulses — the strongest a phone can be asked to produce. */
export const HAPTICS = {
  /** Confirms "Jarvis" was recognised, before listening even starts. */
  wakeWord: [60, 40, 120],
  /** The mic has opened and it's your turn. */
  listenStart: 80,
  /** The mic has closed. */
  listenStop: 35,
  /** A reply is starting to speak. */
  replyStart: [45, 40, 45],
} as const;

let enabled = true;

export function setHapticsEnabled(next: boolean): void {
  enabled = next;
}

/** The API existing proves nothing — `navigator.vibrate` is a function on
 * Windows desktop too, where it returns false and does nothing. There is no
 * capability query for a vibration motor, so pair the API check with a touch
 * device, which is the closest honest proxy. Used to decide whether Settings
 * offers a real control or says the device can't do it. */
export function canVibrate(): boolean {
  if (!hasVibrateApi()) return false;
  return navigator.maxTouchPoints > 0;
}

function hasVibrateApi(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function';
}

export function vibrate(pattern: number | readonly number[]): void {
  // Deliberately the loose check: on a device with no motor the call is a
  // harmless no-op, and gating on the strict one would make the behaviour
  // impossible to exercise anywhere but a phone.
  if (!enabled || !hasVibrateApi()) return;
  try {
    navigator.vibrate(pattern as number | number[]);
  } catch {
    // Feedback is never worth breaking a turn over.
  }
}
