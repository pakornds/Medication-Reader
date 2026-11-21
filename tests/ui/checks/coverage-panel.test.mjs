import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { captureCheckSnapshot, renderCheckCoverage } from "../../../src/components/checks/coverage-panel.mjs";

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../../../backend/tests/fixtures/contracts/${name}.json`, import.meta.url), "utf8"));
}

const service = fixture("service_responses");
const transfer = fixture("transfer_case");
const request = {
  kind: "DDI", enabled: true, evidence: transfer.request.evidence,
  rows: transfer.response.rows.map(row => ({ ...row, revision: 1 })), context: { fixture_context: "present" },
};
const rowNames = new Map([["row-a", "Demo A"], ["row-b", "Demo B"], ["row-c", "Unknown medication A"]]);

function render(request, report, version = null) {
  const document = {
    createElement() {
      return { textContent: "", children: [], setAttribute() {}, append(...items) { this.children.push(...items); } };
    },
  };
  const element = { ownerDocument: document, replaceChildren(panel) { this.panel = panel; } };
  renderCheckCoverage(element, { current: captureCheckSnapshot(request, version), report, rowNames });
  function text(node) {
    return [node.textContent, ...node.children.map(text)].filter(Boolean).join("\n");
  }
  return text(element.panel);
}

test("skipped DDI and DRP checks leave the reviewed rows untouched", () => {
  const before = structuredClone(request.rows);
  for (const kind of ["DDI", "DRP"]) {
    const disabled = { ...request, kind, enabled: false };
    assert.match(render(disabled), /Not run/);
  }
  assert.deepEqual(request.rows, before);
});

test("partial coverage names evaluated and excluded pairs and hides stale findings after a row edit", t => {
  const report = { snapshot: captureCheckSnapshot(request), summary: service.ddi_partial };
  const current = render(request, report);
  assert.match(current, /Partial coverage/);
  assert.match(current, /Simulated review/);
  assert.match(current, /Synthetic references · Version demo-v1/);
  assert.match(current, /2026-11-21T04:05:00Z/);
  assert.match(current, /Evaluated 1 of 2 medication pairs/);
  assert.match(current, /Demo A \+ Demo B/);
  assert.match(current, /Demo A \+ Unknown medication A · Unresolved identity/);
  assert.match(current, /No findings within checked scope/);

  const edited = { ...request, rows: request.rows.map(row => ({ ...row, revision: 2 })) };
  const stale = render(edited, report);
  assert.match(stale, /Stale/);
  assert.doesNotMatch(stale, /Demo A|No findings|Unresolved identity/);
  t.diagnostic(JSON.stringify({ current: "Evaluated 1 of 2 medication pairs", afterEdit: "Stale" }));
});

test("a response also becomes stale after evidence, context, reference or case changes", () => {
  const report = { snapshot: captureCheckSnapshot(request, "release-a"), summary: service.ddi_partial };
  const edits = [
    [{ ...request, context: { fixture_context: "flagged" } }, "release-a"],
    [{ ...request, evidence: { ...request.evidence, sources: [] } }, "release-a"],
    [{ ...request, evidence: { ...request.evidence, case_id: "other-case" } }, "release-a"],
    [request, "release-b"],
  ];
  for (const [edited, version] of edits) assert.match(render(edited, report, version), /Stale/);
});

test("unavailable rules and complete coverage expose reasons and the right denominator", () => {
  const drp = { ...request, kind: "DRP" };
  const unavailable = render(drp, { snapshot: captureCheckSnapshot(drp), summary: service.drp_unavailable });
  assert.match(unavailable, /Unavailable/);
  assert.match(unavailable, /Evaluated 0 of 1 rule scopes/);
  assert.match(unavailable, /demo-rule \(Demo B\) · Required context is missing/);
  assert.doesNotMatch(unavailable, /No findings within checked scope/);

  const complete = { ...service.ddi_partial, status: "complete", excluded: [] };
  assert.match(render(request, { snapshot: captureCheckSnapshot(request), summary: complete }), /Completed/);

  const single = { ...service.ddi_partial, status: "unavailable", evaluated: [], excluded: [
    { scope: { row_ids: ["row-a"] }, reason: "A second verified medication is required." },
  ] };
  assert.match(render(request, { snapshot: captureCheckSnapshot(request), summary: single }), /No pair to assess/);
});
