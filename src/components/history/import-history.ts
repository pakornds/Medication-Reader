import { readImportHistory } from "../../lib/history/import-history.ts";
import type { HistoryStorage } from "../../lib/history/import-history.ts";

/** Render the receipt history from browser storage into the workspace's history section. */
export function renderImportHistory(container: HTMLElement, storage: HistoryStorage): void {
  const timestamps = readImportHistory(storage);
  const document = container.ownerDocument;
  if (!timestamps?.length) {
    const message = document.createElement("p");
    message.textContent = timestamps ? "No successful imports yet." : "Import history is unavailable.";
    container.replaceChildren(message);
    return;
  }

  const list = document.createElement("ul");
  for (const timestamp of timestamps) {
    const entry = document.createElement("li");
    const time = document.createElement("time");
    time.dateTime = timestamp;
    time.textContent = timestamp.replace(/\.0+Z$/, "Z");
    entry.append(time);
    list.append(entry);
  }
  container.replaceChildren(list);
}
