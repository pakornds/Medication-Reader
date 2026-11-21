import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { mountImportPreview } from "../../../src/components/approval/import-preview.mjs";

function file(name) {
  return JSON.parse(readFileSync(new URL(`../../../backend/tests/fixtures/contracts/${name}.json`, import.meta.url), "utf8"));
}

const service = file("service_responses");
const receipt = service.import_success;
const doctor = { id: "demo-doctor", name: "Demo doctor", role: "doctor" };

function draftFixture() {
  const transfer = file("transfer_case");
  const [reviewed, pending] = transfer.response.rows.slice(1);
  reviewed.revision = pending.revision = 1;
  const identity = reviewed.observed_names[0];
  reviewed.verification = {
    reviewer: doctor, status: "no_longer_current", verified_at: receipt.imported_at,
    identity, evidence: [identity.evidence],
  };
  return { evidence: transfer.request.evidence, rows: [reviewed, pending], selectedRowIds: [reviewed.id, pending.id],
    reviewer: service.reviewer };
}

function documentFixture() {
  const document = {
    createElement(tag) {
      const listeners = new Map();
      return {
        tag, ownerDocument: document, textContent: "", children: [],
        append(...items) { this.children.push(...items); },
        replaceChildren(...items) { this.children = items; },
        setAttribute() {}, addEventListener(type, handler) { listeners.set(type, handler); },
        click() { return listeners.get("click")?.(); }, remove() {},
      };
    },
  };
  return document.createElement("main");
}

function all(element) {
  return [element, ...element.children.flatMap(all)];
}

function scenario(behavior = () => {}) {
  const draft = draftFixture();
  const target = documentFixture();
  const calls = [];
  const imported = [];
  let tries = 0;
  const control = mountImportPreview(target, {
    getDraft: () => draft,
    newRetryToken: () => `run-${++tries}`,
    onImported: value => imported.push(value),
    async api(path, input) {
      calls.push({ path, input });
      await behavior(path, input, calls);
      if (path === "/imports/approvals") {
        return { pharmacist_id: "demo-pharmacist", approved_at: receipt.imported_at, row_revision: input.row.revision };
      }
      return receipt;
    },
  });
  return { target, draft, calls, imported, control, button: all(target).find(item => item.tag === "button") };
}

test("only an explicit pharmacist click imports the verified row, with the pending row excluded", async t => {
  const { target, draft, calls, imported, button } = scenario();
  const text = all(target).map(node => node.textContent).join("\n");
  assert.match(text, /Demo B/);
  assert.match(text, /Sources: ศักดาเวชการ/);
  assert.match(text, /Verified by Demo doctor/);
  assert.match(text, /Unknown medication A · Clinician verification is pending/);
  assert.deepEqual(calls, []);

  const before = structuredClone(draft);
  await button.click();
  assert.deepEqual(calls.map(call => call.path), ["/imports/approvals", "/imports"]);
  assert.deepEqual(calls[1].input.selected_row_ids, ["row-b"]);
  assert.deepEqual(calls[1].input.rows.map(row => row.id), ["row-b"]);
  assert.deepEqual(imported, [receipt]);
  assert.deepEqual(draft, before);
  assert.equal(button.disabled, true);
  t.diagnostic(JSON.stringify({ excluded: "row-c", imported: receipt.imported_row_ids }));
});

test("a failed import preserves the draft and reuses the identical approved payload on retry", async () => {
  const { target, draft, calls, imported, control, button } = scenario((path, _payload, calls) => {
    if (path === "/imports" && calls.length === 2) throw new Error("Simulated response loss");
  });
  const before = structuredClone(draft);
  await button.click();
  assert.deepEqual(draft, before);
  assert.deepEqual(imported, []);
  assert.ok(all(target).some(item => item.textContent.includes("draft is available to retry")));

  draft.rows[1].unknown_label = "Unidentified item";
  control.refresh();
  await button.click();
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[1], calls[2]);
  assert.deepEqual(imported, [receipt]);
});

test("an edit while approval is pending prevents import until a fresh confirmation", async () => {
  const pending = Promise.withResolvers();
  const { target, draft, calls, control, button } = scenario((path, input) => {
    if (path === "/imports/approvals" && input.row.revision === 1) return pending.promise;
  });
  const first = button.click();
  draft.rows[0].revision = 2;
  control.refresh();
  pending.resolve();
  await first;
  assert.equal(calls.length, 1);
  assert.ok(all(target).some(item => item.textContent.includes("confirm again")));
  await button.click();
  assert.equal(calls[1].input.row.revision, 2);
  assert.equal(calls[2].input.rows[0].approval.row_revision, 2);
  assert.equal(calls[2].input.retry_token, "run-2");
});

test("a stale preview and a non-pharmacist cannot start the approval request", async () => {
  const { draft, calls, control, button } = scenario();
  draft.rows[0].revision = 2;
  await button.click();
  assert.deepEqual(calls, []);
  draft.reviewer = doctor;
  control.refresh();
  assert.equal(button.disabled, true);
  await button.click();
  assert.deepEqual(calls, []);
});

test("a server-rejected approval can be confirmed again with the existing retry identity", async () => {
  const { target, draft, calls, imported, button } = scenario((path, _request, calls) => {
    if (path === "/imports" && calls.length === 2) {
      throw { detail: { code: "approval_required", recoverable: true, message: "Approve the current reviewed row." } };
    }
  });
  const before = structuredClone(draft);
  await button.click();
  assert.deepEqual(draft, before);
  assert.deepEqual(imported, []);
  assert.ok(all(target).some(item => item.textContent.includes("requires fresh approval")));
  await button.click();
  assert.deepEqual(calls.map(call => call.path), ["/imports/approvals", "/imports", "/imports/approvals", "/imports"]);
  assert.equal(calls[1].input.retry_token, calls[3].input.retry_token);
  assert.deepEqual(imported, [receipt]);
});

test("a late receipt reaches history without showing success for another selection", async () => {
  const pending = Promise.withResolvers();
  const started = Promise.withResolvers();
  const { target, draft, imported, control, button } = scenario(path => {
    if (path === "/imports") {
      started.resolve();
      return pending.promise;
    }
  });
  const first = button.click();
  await started.promise;
  draft.selectedRowIds = ["row-c"];
  control.refresh();
  pending.resolve();
  await first;
  assert.ok(all(target).some(item => item.textContent.startsWith("Unknown medication A")));
  assert.ok(!all(target).some(item => item.textContent.startsWith("Imported at")));
  assert.deepEqual(imported, [receipt]);
});

test("a retry conflict stops this attempt without creating a replacement import token", async () => {
  const { target, calls, imported, button } = scenario((path, _request, calls) => {
    if (path === "/imports" && calls.length === 2) throw new Error("Simulated response loss");
    if (path === "/imports") throw { code: "retry_conflict", recoverable: true };
  });
  await button.click();
  await button.click();
  assert.deepEqual(calls[1], calls[2]);
  assert.equal(button.disabled, true);
  assert.ok(all(target).some(item => item.textContent.includes("already recorded this retry")));
  await button.click();
  assert.equal(calls.length, 3);
  assert.deepEqual(imported, []);
});
