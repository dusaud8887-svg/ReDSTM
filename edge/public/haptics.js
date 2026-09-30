import { capabilities, featureEnabled } from "./capabilities.js";

const DURATIONS = { page: 8, next: 8, save: 12, mark: 12, pull: 15 };

export function haptic(action, enabled = true) {
  const duration = Object.hasOwn(DURATIONS, action) ? DURATIONS[action] : 0;
  if (!duration || !enabled || !featureEnabled("haptics", Boolean(capabilities.vibration.minVerified)) ||
      !capabilities.vibration.detect() || !navigator.userActivation?.isActive ||
      matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
  return navigator.vibrate(duration);
}
