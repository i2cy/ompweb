import { isToolPreset, type ToolPreset } from "./tool-presets";

const STORAGE_KEY = "omp-web:tool-preset";

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function browserStorage(): StorageLike | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

export function getPreferredToolPreset(storage: StorageLike | null = browserStorage()): ToolPreset {
  if (!storage) return "full";
  try {
    const value = storage.getItem(STORAGE_KEY);
    return isToolPreset(value) ? value : "full";
  } catch {
    return "full";
  }
}

export function setPreferredToolPreset(preset: ToolPreset, storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, preset);
  } catch {
    // Preferences remain optional when storage is unavailable.
  }
}

const SESSION_STORAGE_KEY_PREFIX = "omp-web:tool-preset:";

/** The preset a session was spawned with, recorded at spawn time (#356).
 * Null when unknown: a session from before this was recorded, or from
 * another browser or process. The server exposes no per-session toolset,
 * so only sessions this browser spawned can be known. */
export function getSessionToolPreset(sessionId: string | null, storage: StorageLike | null = browserStorage()): ToolPreset | null {
  if (!storage || !sessionId) return null;
  try {
    const value = storage.getItem(`${SESSION_STORAGE_KEY_PREFIX}${sessionId}`);
    return isToolPreset(value) ? value : null;
  } catch {
    return null;
  }
}

export function setSessionToolPreset(sessionId: string, preset: ToolPreset, storage: StorageLike | null = browserStorage()): void {
  if (!storage || !sessionId) return;
  try {
    storage.setItem(`${SESSION_STORAGE_KEY_PREFIX}${sessionId}`, preset);
  } catch {
    // The record is optional when storage is unavailable.
  }
}
