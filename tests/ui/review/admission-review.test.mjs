import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { admissionReview, canAttestCurrentUse, requiresPharmacyIdentity } from "../../../src/components/review/admission-review.mjs";

const manifest = JSON.parse(readFileSync(new URL("../../../fixtures/package-capture/two-photos.json", import.meta.url), "utf8"));

function packageRow(packageId, itemId, other = {}) {
  return { package_id: packageId, capture_item_id: itemId, entries: [], superseded: [], ...other };
}

test("mixed pending appearances keep distinct regions and the same package", () => {
  const encounter = { capture: manifest };
  const round = admissionReview(encounter, packageRow("package-b", "pending-b-round"));
  const oval = admissionReview(encounter, packageRow("package-b", "pending-b-oval"));
  assert.equal(round.package.id, oval.package.id);
  assert.notEqual(round.package.item, oval.package.item);
  assert.deepEqual(round.package.views.map(({ link }) => link.region_id), ["front-b-round"]);
  assert.deepEqual(oval.package.views.map(({ link }) => link.region_id), ["front-b-oval"]);
  assert.equal(round.package.sources[0].source.organization, undefined);
  assert.equal(oval.package.sources[0].source.organization, undefined);
  assert.equal(round.verified, undefined);
  assert.equal(oval.verified, undefined);
});

test("confirmed package views and explicitly cited organizations stay with their own rows", () => {
  const encounter = { capture: manifest };
  const a = admissionReview(encounter, packageRow("package-a", "order-a"));
  const c = admissionReview(encounter, packageRow("package-c", "order-c"));
  assert.deepEqual(a.package.views.map(({ link }) => link.region_id), ["front-a", "reverse-a"]);
  assert.deepEqual(c.package.views.map(({ link }) => link.region_id), ["front-c", "reverse-c"]);
  assert.deepEqual([...new Set(a.package.sources.map(({ source }) => source.organization))], ["Demo Clinic A"]);
  assert.deepEqual([...new Set(c.package.sources.map(({ source }) => source.organization))], ["Demo Clinic C"]);
  assert.equal(admissionReview(encounter, packageRow("package-a", "pending-b-round")).package, null);
});

test("an opaque confirmed reverse is flagged and a stale view cannot be opened", () => {
  const capture = structuredClone(manifest);
  const row = packageRow("package-a", "order-a");
  capture.reverse.regions[0].visibility = "opaque";
  let review = admissionReview({ capture }, row);
  assert.deepEqual(review.package.views.map(({ opaque }) => opaque), [false, true]);
  capture.reverse.revision += 1;
  review = admissionReview({ capture }, row);
  assert.deepEqual(review.package.views.map(({ link }) => link.side), ["front"]);
});

test("a prescription, reported timing, and a verified decision remain separately sourced", () => {
  const label = {
    source: { id: "clinic", kind: "label_photo", organization: "Demo Clinic" },
    name: "Demo A",
    directions: "Twice daily",
  };
  const account = {
    source: { id: "statement", kind: "patient_report", reporter: "Synthetic patient" },
    name: "Demo A",
    wording: "Mornings only",
  };
  const missingWardRecord = {
    source: { id: "ward", kind: "transfer_record", availability: "unavailable" },
    wording: "Ward record unavailable",
  };
  const interview = { source_id: account.source.id, current_use: "uncertain" };
  const row = { entries: [label, account, missingWardRecord], superseded: [], interview };
  const draft = admissionReview({}, row);
  assert.equal(draft.documented, label);
  assert.deepEqual(draft.accounts, [account]);
  assert.equal(draft.interview, interview);
  assert.equal(draft.verified, undefined);
  const verification = {
    source_id: account.source.id,
    identity: { source_id: label.source.id },
    answer: { current_use: "current", schedule: "morning" },
    actor: { role: "nurse", name: "Demo Nurse" },
    at: "2026-11-21T01:00:00Z",
  };
  const verified = admissionReview({}, { ...row, verified: verification });
  assert.equal(verified.documented, label);
  assert.equal(verified.accounts[0], account);
  assert.equal(verified.interview.current_use, "uncertain");
  assert.equal(verified.verified, verification);
  assert.equal(admissionReview({}, { ...row, superseded: ["clinic"] }).documented, undefined);
});

test("only a doctor or pharmacist can attest sourced current use with an incomplete regimen", () => {
  const report = { source: { id: "interview", kind: "patient_report" }, wording: "Synthetic answer" };
  const row = {
    id: "item-1", entries: [report], superseded: [], unknown: false,
    interview: { source_id: "interview", ownership: "patient", current_use: "current", dose: null, route: "oral", schedule: "each morning" },
  };
  assert.deepEqual(admissionReview({}, row).missingRegimen, ["dose"]);
  assert.equal(canAttestCurrentUse(row, { role: "nurse" }), false);
  assert.equal(canAttestCurrentUse(row, { role: "doctor" }), true);
  assert.equal(canAttestCurrentUse({ ...row, unknown: true }, { role: "pharmacist" }), false);
  assert.equal(canAttestCurrentUse({ ...row, superseded: ["interview"] }, { role: "doctor" }), false);
  const attestation = {
    identity: { name: "Demo A", source_id: "order" }, source_id: "interview",
    answer: { ...row.interview }, active_sources: ["interview"],
  };
  const attested = { ...row, screening_attestation: attestation };
  assert.equal(admissionReview({}, attested).screeningAttestation, attestation);
  assert.equal(canAttestCurrentUse(attested, { role: "doctor" }), false);
  const addedSource = { ...attested, entries: [...row.entries, { source: { id: "order" } }] };
  assert.equal(admissionReview({}, addedSource).screeningAttestation, null);
  assert.equal(canAttestCurrentUse(addedSource, { role: "doctor" }), true);
});

test("a report naming an unresolved loose item can require pharmacy identity review", () => {
  const unknown = { unknown: true, interview: { current_use: "current" }, proposal: { name: "Demo A" } };
  assert.equal(requiresPharmacyIdentity(unknown), true);
  assert.equal(requiresPharmacyIdentity({ ...unknown, confirmed: { name: "Demo A" } }), false);
  assert.equal(requiresPharmacyIdentity({ ...unknown, unknown: false }), false);
  assert.equal(requiresPharmacyIdentity({ unknown: true, interview: { current_use: "reported_stopped" } }), false);
});
