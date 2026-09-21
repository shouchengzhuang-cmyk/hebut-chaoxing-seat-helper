const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;

export function getTomorrowInShanghai(now: Date | number = new Date()): string {
  const timestamp = now instanceof Date ? now.getTime() : now;
  const shifted = new Date(timestamp + SHANGHAI_OFFSET_MS + 24 * 60 * 60 * 1000);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, "0")}-${String(shifted.getUTCDate()).padStart(2, "0")}`;
}
