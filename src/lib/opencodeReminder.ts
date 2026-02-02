const STORAGE_KEY = "falck.opencode.reminderUntil";
const REMIND_AFTER_MS = 24 * 60 * 60 * 1000;

export function dismissOpenCodeReminder() {
  try {
    const remindAt = Date.now() + REMIND_AFTER_MS;
    window.localStorage.setItem(STORAGE_KEY, String(remindAt));
  } catch {
    // Ignore storage failures so the dialog can still be dismissed.
  }
}

export function shouldShowOpenCodeReminder(): boolean {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return true;
    }
    const remindAt = Number(raw);
    if (Number.isNaN(remindAt)) {
      return true;
    }
    return Date.now() >= remindAt;
  } catch {
    return true;
  }
}

export function clearOpenCodeReminder() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore storage failures.
  }
}
