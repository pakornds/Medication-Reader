import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { readImportHistory, recordImportReceipt } from "../../../src/lib/history/import-history.ts";
import { renderImportHistory } from "../../../src/components/history/import-history.ts";

const fixture = JSON.parse(readFileSync(new URL(
  "../../../backend/tests/fixtures/contracts/service_responses.json", import.meta.url,
), "utf8"));
const receipt = fixture.import_success;

function storageWith(entries = []) {
  const values = new Map(entries);
  return {
    get length() { return values.size; },
    key: index => [...values.keys()][index] ?? null,
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    entries: () => [...values],
  };
}

function renderTarget() {
  const document = {
    createElement(tag) {
      return { tag, children: [], append(child) { this.children.push(child); } };
    },
  };
  return { ownerDocument: document, replaceChildren(child) { this.child = child; } };
}

test("a restored page renders the fixture receipt and storage holds only its UTC timestamp", t => {
  const storage = storageWith();
  assert.equal(recordImportReceipt(storage, {
    ...receipt,
    photos: ["photo.png"],
    analysis: { note: "sensitive draft" },
  }), "saved");

  const restoredStorage = storageWith(storage.entries());
  const target = renderTarget();
  renderImportHistory(target, restoredStorage);
  const time = target.child.children[0].children[0];
  assert.equal(time.tag, "time");
  assert.equal(time.textContent, receipt.imported_at);
  assert.deepEqual(restoredStorage.entries(), [[
    `medication-reader:imported-at:${time.dateTime}`, time.dateTime,
  ]]);
  t.diagnostic(JSON.stringify({ restored: time.textContent, stored: restoredStorage.entries() }));
});

test("equivalent retries deduplicate and independent receipts retain microseconds and order", () => {
  const storage = storageWith();
  const prefix = receipt.imported_at.slice(0, -1);
  recordImportReceipt(storage, receipt);
  recordImportReceipt(storage, { ...receipt, imported_at: `${prefix}.000+00:00` });
  recordImportReceipt(storage, { ...receipt, imported_at: `${prefix}.000001Z` });
  assert.deepEqual(readImportHistory(storage), [`${prefix}.000001Z`, `${prefix}.000000Z`]);
});

test("failed responses, non-UTC times and invalid calendar dates do not persist", () => {
  const storage = storageWith([["another-app", "unchanged"]]);
  const failures = [fixture.retry_conflict, { imported_at: receipt.imported_at },
    { ...receipt, imported_at: "2026-02-30T04:00:00Z" }, { ...receipt, imported_at: "2026-11-21T04:00:00+07:00" }];
  for (const failure of failures) assert.equal(recordImportReceipt(storage, failure), "ignored");
  assert.deepEqual(readImportHistory(storage), []);
  assert.deepEqual(storage.entries(), [["another-app", "unchanged"]]);
});

test("storage denial is recoverable and renders an unavailable message", () => {
  const unavailable = {
    get length() { throw new Error("Denied"); },
    setItem() { throw new Error("Denied"); },
  };
  assert.equal(recordImportReceipt(unavailable, receipt), "unavailable");
  const target = renderTarget();
  renderImportHistory(target, unavailable);
  assert.equal(target.child.textContent, "Import history is unavailable.");
});
