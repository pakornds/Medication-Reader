import assert from "node:assert/strict";
import test from "node:test";
import { admissionReview } from "../../../src/components/review/admission-review.mjs";
import { regimenEvidenceChoices, regimenStatements, verifiedRegimenSummary } from "../../../src/components/review/admission-regimens.mjs";

test("parse requests preserve each current statement, row and photo attribution", () => {
  const label = { source: { id: "label", kind: "label_photo" }, photo: {}, directions: "1 tablet each morning and 2 tablets each evening" };
  const report = { source: { id: "patient", kind: "patient_report" }, wording: "2 tablets each morning" };
  const previous = { ...label, source: { id: "old", kind: "prescription" } };
  const row = { id: "row-2", entries: [label, report, previous], superseded: ["old"] };
  const [documented, reported] = regimenStatements(admissionReview({ id: "encounter" }, row));
  assert.deepEqual(documented.source, { source_id: "label", item_id: "row-2" });
  assert.equal(documented.evidence.items[0].row_id, "row-2");
  assert.equal(documented.directions_text, label.directions);
  assert.equal(reported.directions_text, report.wording);
  assert.equal(reported.basis, "reported");
  assert.equal(reported.source.source_id, "patient");
  assert.equal(regimenStatements(admissionReview({}, row)).length, 2);
});

test("verified fields can cite available clinician records and independently attributed label regions", () => {
  const entry = (id, photo = null, availability = "available") => ({ source: { id, availability }, photo });
  const entries = [
    entry("clinician"), entry("attributed", { front_attributed: true }), entry("reverse", { pairing: "matched" }),
    entry("unmatched", { pairing: "uncertain" }), entry("pill", { pairing: "matched", appearance: "oval" }),
    entry("absent", null, "unavailable"),
  ];
  assert.deepEqual(regimenEvidenceChoices(entries).map(e => e.source.id), ["clinician", "attributed", "reverse"]);
});

test("an existing interview-only verification remains readable", () => {
  const verified = { answer: { dose: "one tablet", route: "oral", schedule: "each morning" } };
  assert.equal(verifiedRegimenSummary(verified, [], value => value), "<br>Verified regimen · one tablet · oral · each morning");
});
