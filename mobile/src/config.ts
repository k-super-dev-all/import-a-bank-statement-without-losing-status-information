// Android emulator: run `adb reverse tcp:8787 tcp:8787` first (see README).
// iOS simulator reaches host loopback directly.
export const BASE_URL = 'http://127.0.0.1:8787';
export const MAX_BYTES = 10 * 1024 * 1024;
export const POLL_INTERVAL_MS = 1000;
