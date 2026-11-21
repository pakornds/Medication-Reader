export type HistoryStorage = Pick<Storage, "length" | "key" | "getItem" | "setItem">;

const keyPrefix = "medication-reader:imported-at:";
const utcPattern = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(?:Z|\+00:00)$/;

function utcTimestamp(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const given = utcPattern.exec(value);
  if (!given) return null;

  const [, seconds, fraction = ""] = given;
  const date = new Date(`${seconds}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 19) !== seconds) return null;
  return `${seconds}.${fraction.padEnd(6, "0")}Z`;
}

function importTimestamp(receipt: unknown): string | null {
  if (!receipt || typeof receipt !== "object" || !("imported_row_ids" in receipt) ||
      !("imported_at" in receipt)) return null;

  const ids = receipt.imported_row_ids;
  if (!Array.isArray(ids) || ids.length === 0 || ids.some(id => typeof id !== "string" || !id.trim())) {
    return null;
  }
  return utcTimestamp(receipt.imported_at);
}

/** Record the successful import response in the browser. No row IDs are written. */
export function recordImportReceipt(storage: HistoryStorage, receipt: unknown): "saved" | "ignored" | "unavailable" {
  const timestamp = importTimestamp(receipt);
  if (!timestamp) return "ignored";

  try {
    // Each timestamp has its own key so concurrent tabs cannot overwrite other receipts.
    storage.setItem(`${keyPrefix}${timestamp}`, timestamp);
    return "saved";
  } catch {
    return "unavailable";
  }
}

/** Read UTC timestamps newest first, or return null if the browser cannot read storage. */
export function readImportHistory(storage: HistoryStorage): string[] | null {
  try {
    const timestamps: string[] = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (!key?.startsWith(keyPrefix)) continue;
      const timestamp = key.slice(keyPrefix.length);
      if (utcTimestamp(timestamp) === timestamp && storage.getItem(key) === timestamp) timestamps.push(timestamp);
    }
    return [...new Set(timestamps)].sort().reverse();
  } catch {
    return null;
  }
}
