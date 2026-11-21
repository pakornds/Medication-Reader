import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { captureCheckSnapshot } from "../../../src/components/checks/coverage-panel.mjs";
import { renderMedicationHandoff } from "../../../src/components/print/medication-handoff.mjs";

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`../../../backend/tests/fixtures/contracts/${name}.json`, import.meta.url), "utf8"));
}

const datedAt = "2026-11-21T04:00:00Z";

function snapshot() {
  const { request, response } = fixture("transfer_case");
  return { evidence: request.evidence, rows: response.rows, datedAt };
}

function render(options) {
  const doc = {
    createElement(tag) {
      const listeners = new Map();
      return {
        tag, ownerDocument: doc, textContent: "", childNodes: [],
        append(...items) { this.childNodes.push(...items); },
        replaceChildren(...items) { this.childNodes = items; },
        setAttribute() {},
        addEventListener(type, callback) { listeners.set(type, callback); },
        dispatch(type) { listeners.get(type)?.(); },
      };
    },
  };
  const container = { ownerDocument: doc, replaceChildren(result) { this.result = result; } };
  renderMedicationHandoff(container, options);
  return container.result;
}

function all(element) {
  return [element, ...element.childNodes.flatMap(all)];
}

function text(element) {
  return all(element).filter(item => !item.hidden).map(item => item.textContent).filter(Boolean).join("\n");
}

test("two-row worksheet retains the clinic contact and the unresolved item's own source", t => {
  const data = snapshot();
  data.rows = [data.rows[0], data.rows[2]];
  const sheet = render({ ...data, mode: "worksheet" });
  const [named, unknown] = all(sheet).filter(item => item.tag === "article");
  assert.match(text(sheet), /Medication interview worksheet/);
  assert.equal(all(sheet).find(item => item.tag === "time").dateTime, datedAt);
  assert.match(text(named), /เช้า–เย็น\nLabel photo · ศักดาเวชการ \[label-photo\] · label-a/);
  assert.match(text(named), /Phone 075-356XXXX ext\. 12/);
  assert.match(text(named), /รับประทานเฉพาะตอนเช้า\nPatient report · Demo patient \[patient-account\]/);
  assert.match(text(named), /Unresolved/);
  assert.match(text(unknown), /Unknown medication A[\s\S]*Identity unresolved/);
  assert.match(text(unknown), /Reverse-side photo \[reverse-photo\]/);
  assert.match(text(unknown), /Evidence items: pill-c/);
  assert.match(text(unknown), /No usable reverse-side crop available/);
  assert.match(text(unknown), /Documented directions\nMissing/);
  assert.match(text(unknown), /Check the documented directions with the source/);
  assert.match(text(unknown), /Does the patient have the original labeled package/);
  assert.doesNotMatch(text(unknown), /075-356XXXX/);
  assert.equal(all(sheet).filter(item => item.className === "handoff-notes").length, 2);
  t.diagnostic(JSON.stringify({ rows: 2, facility: "ศักดาเวชการ", phone: "075-356XXXX", unknown: "Identity unresolved", crop: "unavailable" }));
});

test("only a matched crop from this row is shown and broken imagery leaves a visible note", () => {
  const data = snapshot();
  const matched = render({ ...data, cropUrl: () => "/fixtures/crop.png" });
  const [image] = all(matched).filter(item => item.tag === "img");
  assert.equal(image.alt, "Matched reverse-side crop for Unknown medication A");
  assert.match(text(matched), /Reverse-side photo \[reverse-photo\] · pill-c/);
  image.dispatch("error");
  assert.equal(image.hidden, true);
  assert.match(text(matched), /No usable reverse-side crop available/);

  data.rows[2].reverse_crop = { source_id: "label-photo", item_id: "label-a" };
  const mismatched = render({ ...data, cropUrl: () => { throw new Error("Wrong crop requested"); } });
  assert.ok(!all(mismatched).some(item => item.tag === "img"));
});

test("reviewed handoff preserves partial original wording and puts stopped medicine in dated history", () => {
  const data = snapshot();
  const [named, stopped, pending] = data.rows;
  const ref = named.label_fields.directions.evidence;
  const literal = "เช้า–เย็น เมื่อจำเป็น";
  named.regimens = [{ component_id: "label-1", basis: "documented", directions_text: literal, parse_status: "partial",
    unparsed_text: "เมื่อจำเป็น", time_of_day: ["morning", "evening"], evidence: { directions_text: ref, time_of_day: ref } }];
  stopped.verification = { status: "no_longer_current", identity: stopped.observed_names[0],
    reviewer: { name: "Demo nurse", role: "nurse" }, verified_at: datedAt, evidence: stopped.sources };
  const reviewed = render({ ...data,
    decisions: [{ row_id: named.id, outcome: "clarified", finding: "Compare the distinct orders.", source_id: "ward-record" }],
    referrals: [{ row_ids: [pending.id], reason: "Confirm the item in the original package.", checked: "Photo 2" }],
  });
  const [active, history] = reviewed.childNodes.filter(item => item.tag === "section");
  assert.match(text(active), /Original wording\nเช้า–เย็น เมื่อจำเป็น\nLabel photo/);
  assert.match(text(active), /Parse status\nPartial/);
  assert.match(text(active), /Wording to clarify\nเมื่อจำเป็น/);
  assert.match(text(active), /Decision: clarified · Compare the distinct orders/);
  assert.match(text(active), /Pending pharmacist referral · Confirm the item in the original package/);
  assert.doesNotMatch(text(active), /Demo B/);
  assert.match(text(history), /Medication history[\s\S]*Demo B[\s\S]*No longer current[\s\S]*Demo nurse/);
});

test("an optional superseded screening report does not leak earlier findings into the print view", () => {
  const data = snapshot();
  const fixtureReport = fixture("service_responses").ddi_partial;
  const request = { kind: "DDI", enabled: true, evidence: data.evidence, rows: data.rows };
  const report = { snapshot: captureCheckSnapshot(request), summary: fixtureReport };
  const checks = [{ kind: "DDI", enabled: true, report }];
  assert.match(text(render({ ...data, checks })), /Evaluated 1 of 2 medication pairs/);
  data.rows[0].revision = 2;
  const stale = text(render({ ...data, checks }));
  assert.match(stale, /Stale. Rerun this check/);
  assert.doesNotMatch(stale, /Evaluated 1 of 2 medication pairs/);
});

test("an unresolved stopped item retains both statuses in the history", () => {
  const data = snapshot();
  const pending = data.rows[2];
  pending.verification = { status: "no_longer_current", reviewer: { name: "Demo nurse", role: "nurse" },
    verified_at: datedAt, evidence: pending.sources };
  const handoff = render(data);
  const [active, history] = handoff.childNodes.filter(item => item.tag === "section");
  assert.doesNotMatch(text(active), /Unknown medication A/);
  assert.match(text(history), /Unknown medication A[\s\S]*Identity unresolved[\s\S]*No longer current/);
});

test("appearance and unqualified reviewers cannot establish a printed identity", () => {
  const data = snapshot();
  const pending = data.rows[2];
  data.rows = [pending];
  const appearance = { value: "Appearance-only identity", evidence: pending.reverse_crop };
  pending.verification = { status: "current", identity: appearance, reviewer: { name: "Demo pharmacist", role: "pharmacist" },
    verified_at: datedAt, evidence: pending.sources };
  const unresolved = text(render(data));
  assert.match(unresolved, /Unknown medication A[\s\S]*Identity unresolved/);
  assert.doesNotMatch(unresolved, /Appearance-only identity|Verified current/);

  data.evidence.items.push({ id: "matched-label", source_id: "reverse-photo", row_id: pending.id, kind: "matched_reverse_label" });
  const label = { source_id: "reverse-photo", item_id: "matched-label" };
  pending.verification.identity = { value: "Independently named item", evidence: label };
  pending.verification.reviewer = { name: "Intake staff", role: "staff" };
  assert.doesNotMatch(text(render(data)), /Independently named item|Verified current|Intake staff/);
  pending.verification.reviewer = { name: "Demo pharmacist", role: "pharmacist" };
  assert.doesNotMatch(text(render(data)), /Independently named item|Verified current/);
  data.evidence.sources.push({ id: "corroborating-photo", kind: "reverse_photo", attachment_id: "separate-package" });
  data.evidence.items.push({ id: "corroborating-label", source_id: "corroborating-photo", row_id: pending.id,
    kind: "matched_reverse_label" });
  pending.verification.identity.evidence = { source_id: "corroborating-photo", item_id: "corroborating-label" };
  assert.match(text(render(data)), /Independently named item[\s\S]*Verified current/);
});

test("a report keeps the reporter when the source also lists an organization", () => {
  const data = snapshot();
  data.evidence.sources.find(source => source.id === "patient-account").organization = "Demo Clinic";
  const sheet = text(render(data));
  assert.match(sheet, /Patient report · Demo Clinic · Reported by Demo patient \[patient-account\]/);
});

test("a reported account can support current use while the physical identity stays unresolved", () => {
  const data = snapshot();
  const pending = data.rows[2];
  const interview = { source_id: "patient-account" };
  data.rows = [pending];
  pending.verification = { status: "current", reviewer: { name: "Demo nurse", role: "nurse" },
    verified_at: datedAt, evidence: [interview] };
  const current = text(render(data));
  assert.match(current, /Identity unresolved\nCurrent use verified for this unidentified item/);
  pending.verification.reviewer = { name: "Demo pharmacist", role: "pharmacist" };
  pending.verification.identity = { value: "Reported name only", evidence: interview };
  const unresolved = text(render(data));
  assert.match(unresolved, /Unknown medication A[\s\S]*Identity unresolved/);
  assert.doesNotMatch(unresolved, /Reported name only|Verified identity/);

  const confirmed = { source_id: "ward-record", item_id: "confirmation-c" };
  data.evidence.items.push({ id: confirmed.item_id, source_id: confirmed.source_id, row_id: pending.id, kind: "record_excerpt" });
  pending.verification.identity = { value: "Separately identified item", evidence: confirmed };
  assert.match(text(render(data)), /Separately identified item[\s\S]*Verified current/);
});
