import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { confirmReverseCrop, flagPhotoMatch, replacePhoto } from "../../src/lib/evidence-pairing/index.mjs";

const fixture = JSON.parse(readFileSync(new URL(
  "../../backend/tests/fixtures/contracts/transfer_case.json", import.meta.url,
), "utf8"));
const ref = (source_id, item_id) => ({ source_id, item_id });
const reverse = { id: "reverse-retake", kind: "reverse_photo", attachment_id: "photo-2-retake" };
const priorCrop = ref("reverse-photo", "pill-c");
const firstCrop = ref("reverse-photo", "candidate-left");
const replacementCrop = ref(reverse.id, "candidate-left");

function makeDraft() {
  const sample = structuredClone(fixture);
  return {
    evidence: sample.request.evidence,
    rows: sample.response.rows.map(row => ({ ...row, revision: 1 })),
    reverseCropCandidates: [firstCrop, ref("reverse-photo", "candidate-right")],
  };
}

function getRow(draft, id) {
  return draft.rows.find(row => row.id === id);
}

function flag(draft, rowId, reason) {
  return flagPhotoMatch(draft, { rowId, revision: getRow(draft, rowId).revision, reason });
}

function confirm(draft, rowId, crop) {
  return confirmReverseCrop(draft, { rowId, revision: getRow(draft, rowId).revision, crop });
}

test("swapped bags stay unmatched until staff confirm a current crop after a retake", t => {
  const original = makeDraft();
  const swapped = flag(flag(original, "row-a", "ambiguous"), "row-b", "ambiguous");
  for (const id of ["row-a", "row-b"]) {
    const row = getRow(swapped, id);
    assert.equal(row.reverse_crop, null);
    assert.match(row.follow_ups.find(item => item.field === "photo_match").question, /match.*or retake/i);
  }
  assert.deepEqual(getRow(swapped, "row-c").reverse_crop, priorCrop);

  const retaken = replacePhoto(swapped, { sourceId: "reverse-photo", replacement: reverse });
  assert.equal(getRow(retaken, "row-c").reverse_crop, null);
  assert.deepEqual(retaken.reverseCropCandidates, []);
  assert.throws(() => confirm(retaken, "row-a", firstCrop), /current reverse-side/);
  assert.throws(() => confirm(retaken, "row-a", replacementCrop), /not located/);

  const reviewed = confirm({ ...retaken, reverseCropCandidates: [replacementCrop] }, "row-a", replacementCrop);
  assert.deepEqual(getRow(reviewed, "row-a").reverse_crop, replacementCrop);
  assert.ok(getRow(reviewed, "row-a").sources.some(source => source.item_id === replacementCrop.item_id));
  assert.ok(!getRow(reviewed, "row-a").follow_ups.some(item => item.field === "photo_match"));
  assert.equal(getRow(reviewed, "row-b").reverse_crop, null);
  assert.deepEqual(reviewed.evidence.items.filter(item => item.kind === "pill_crop"), [
    { source_id: reverse.id, id: replacementCrop.item_id, row_id: "row-a", kind: "pill_crop" },
  ]);
  const crops = draft => ["row-a", "row-b"].map(id => getRow(draft, id).reverse_crop);
  t.diagnostic(JSON.stringify({ afterSwap: crops(swapped), afterRetakeAndConfirmation: crops(reviewed) }));
});

test("a hidden item stays pending and a crop already assigned to another row cannot be reused", () => {
  const original = makeDraft();
  assert.throws(() => confirm(original, "row-a", priorCrop), /already assigned/);
  const hidden = flag(original, "row-c", "hidden");
  assert.equal(getRow(hidden, "row-c").reverse_crop, null);
  assert.match(getRow(hidden, "row-c").follow_ups.at(-1).question, /retake.*visible/i);
  assert.ok(!hidden.evidence.items.some(item => item.id === "pill-c"));
  assert.deepEqual(getRow(original, "row-c").reverse_crop, priorCrop);
});

test("staff can reassign an existing crop after withdrawing its uncertain match", () => {
  const original = makeDraft();
  const pending = flag(original, "row-c", "ambiguous");
  const confirmed = confirm(pending, "row-b", priorCrop);
  assert.equal(getRow(confirmed, "row-c").reverse_crop, null);
  assert.deepEqual(getRow(confirmed, "row-b").reverse_crop, priorCrop);
  assert.equal(confirmed.evidence.items.find(item => item.id === "pill-c").row_id, "row-b");
});

test("reverse retakes invalidate case approvals and preserve unrelated evidence and verification", () => {
  const original = confirm(makeDraft(), "row-a", firstCrop);
  const rowA = getRow(original, "row-a");
  const rowB = getRow(original, "row-b");
  const verifiedWardRecord = { evidence: [ref("ward-record", "part-a")] };
  rowA.verification = verifiedWardRecord;
  rowA.approval = { pharmacist_id: "demo", row_revision: rowA.revision };
  rowB.approval = { pharmacist_id: "demo", row_revision: rowB.revision };

  const retaken = replacePhoto(original, { sourceId: "reverse-photo", replacement: reverse });
  const updated = getRow(retaken, "row-a");
  assert.equal(updated.reverse_crop, null);
  assert.equal(updated.approval, null);
  assert.equal(updated.revision, rowA.revision + 1);
  assert.equal(updated.verification, verifiedWardRecord);
  assert.deepEqual(updated.label_fields, rowA.label_fields);
  assert.deepEqual(getRow(retaken, "row-b"), { ...rowB, approval: null });
  assert.equal(confirmReverseCrop(original, { rowId: "row-a", revision: rowA.revision, crop: firstCrop }), original);
});

test("retakes preserve remaining conflicts and remove dangling follow-up source IDs", () => {
  const original = makeDraft();
  const rowA = getRow(original, "row-a");
  const rowC = getRow(original, "row-c");
  const oldLabel = { value: "5 mg", evidence: ref("label-photo", "label-a") };
  const ward = { value: "10 mg", evidence: ref("ward-record", "part-a") };
  const other = { value: "20 mg", evidence: { source_id: "prior-script" } };
  original.evidence.sources.push({ id: "prior-script", kind: "prescription" });
  rowA.sources.push(other.evidence);
  rowA.discrepancies = [{ id: "strength", field: "strength", observed_values: [oldLabel, ward, other] }];
  rowC.follow_ups = [{ field: "source", question: "Can staff get another photo?", potential_source_id: "label-photo" }];
  const updated = replacePhoto(original, {
    sourceId: "label-photo", replacement: { id: "label-retake", kind: "label_photo" },
  });
  assert.deepEqual(getRow(updated, "row-a").discrepancies[0].observed_values, [ward, other]);
  assert.deepEqual(getRow(updated, "row-c").follow_ups, [{ ...rowC.follow_ups[0], potential_source_id: null }]);
  assert.deepEqual(getRow(updated, "row-c").reverse_crop, priorCrop);
});

test("a label retake invalidates old row revisions and crops across the same upload", () => {
  const original = confirm(makeDraft(), "row-a", firstCrop);
  const old = getRow(original, "row-a");
  old.verification = { evidence: [ref("label-photo", "label-a")] };
  old.approval = { pharmacist_id: "demo", row_revision: old.revision };
  original.evidence.sources.push({ id: "second-label", kind: "label_photo", attachment_id: "demo-photo-1" });
  const replacement = { id: "label-retake", kind: "label_photo", attachment_id: "photo-1-retake" };

  const retaken = replacePhoto(original, { sourceId: "label-photo", replacement });
  const updated = getRow(retaken, "row-a");
  assert.equal(updated.id, old.id);
  assert.equal(updated.reverse_crop, null);
  assert.equal(updated.approval, null);
  assert.equal(updated.verification, null);
  assert.deepEqual(updated.reported_use, old.reported_use);
  assert.ok(!retaken.evidence.sources.some(source => ["label-photo", "second-label"].includes(source.id)));
  assert.deepEqual(getRow(retaken, "row-c").reverse_crop, priorCrop);
  assert.throws(() => confirmReverseCrop(retaken, {
    rowId: "row-a", revision: old.revision, crop: firstCrop,
  }), /stale/);
  assert.throws(() => replacePhoto(retaken, {
    sourceId: replacement.id, replacement: { ...replacement, id: "label-photo" },
  }), /fresh source/);
});
