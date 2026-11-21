/* Run against a local synthetic app with Playwright on NODE_PATH. */
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { readFile } = require("node:fs/promises");
const path = require("node:path");
const { chromium } = require("playwright");

const base = process.env.ADMISSION_DEMO_URL || "http://127.0.0.1:18764";
const tokens = {
  nurse: process.env.ADMISSION_TEST_NURSE,
  doctor: process.env.ADMISSION_TEST_DOCTOR,
  pharmacist: process.env.ADMISSION_TEST_PHARMACIST,
};
const button = (root, name) => root.getByRole("button", { name, exact: true });
const rowFor = (page, id) => page.locator("#rows > article").filter({
  has: page.locator('[data-review-item="' + id + '"]'),
});

async function responseError(action, response) {
  const { detail } = await response.json();
  const message = Array.isArray(detail)
    ? detail.map(error => error.loc.join(".") + ": " + error.msg).join(", ")
    : detail;
  return new Error(action + ": " + message);
}

async function request(role, route, body) {
  const response = await fetch(base + route, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "X-Demo-Reviewer-Token": tokens[role] },
    body: body && JSON.stringify(body),
  });
  if (!response.ok) throw await responseError(route, response);
  return response.json();
}

async function makeCase(role, label) {
  const alias = "Synthetic " + label + " " + randomUUID().slice(0, 7);
  let state = await request(role, "/admissions", { patient_alias: alias });
  const route = "/admissions/" + state.id;
  return {
    alias, route,
    async seed(action, fields) {
      state = await request(role, route + "/actions", {
        revision: state.revision, request_id: randomUUID(), command: { action, ...fields },
      });
      return state;
    },
  };
}

function entry(id, kind, wording, fields = {}) {
  return { source: { id, kind, reporter: "Synthetic intake" }, wording, ...fields };
}

function photo(kind, image, fields) {
  return entry("physical-item", kind, fields.name || "Unmarked tablet in synthetic Bag A", {
    ...fields, photo: {
      data: image, media_type: "image/png", bag: "A", pairing: "matched", region: [0, 0, 0.5, 0.5],
      appearance: kind === "reverse_photo" ? "unmarked tablet" : null,
    },
  });
}

const interview = (dose = "one tablet") => ({
  row_id: "item-1", source_id: "account", ownership: "patient", current_use: "current",
  dose, route: "oral", schedule: "reported morning use",
});

async function openCase(browser, role, encounter) {
  const page = await browser.newPage();
  await page.goto(base + "/admission/");
  await page.getByLabel("Demo reviewer token").fill(tokens[role]);
  await button(page, "Sign in").click();
  await page.getByRole("button", { name: new RegExp(encounter.alias) }).click();
  await rowFor(page, "item-1").waitFor();
  return page;
}

async function submit(page, encounter, action) {
  const dialog = page.getByRole("dialog");
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url() === base + encounter.route + "/actions" &&
      r.request().method() === "POST" && r.request().postDataJSON().command.action === action),
    dialog.locator('button[type="submit"]').click(),
  ]);
  if (!response.ok()) throw await responseError(action, response);
  await dialog.waitFor({ state: "hidden" });
  return response.json();
}

async function namedDispute(browser, image) {
  const encounter = await makeCase("nurse", "named dispute");
  await encounter.seed("add", { entry: photo("label_photo", image, { name: "Demo Amber" }) });
  const link = entry => encounter.seed("link", { row_id: "item-1", confirmed: true, entry });
  await link(entry("transfer", "transfer_record", "Bag A listed as Demo Slate.", { name: "Demo Slate" }));
  await link(entry("account", "patient_report", "I use the tablet from Bag A."));
  await encounter.seed("interview", interview());
  const nurse = await openCase(browser, "nurse", encounter);
  const row = rowFor(nurse, "item-1");
  await row.getByText("Disputed documented identity", { exact: true }).waitFor();
  await button(row, "Link source or photo").click();
  const editor = nurse.getByRole("dialog");
  await editor.getByLabel("Evidence type").selectOption("reviewer_record");
  await editor.getByLabel("Source, reporter or department").fill("Synthetic dispensing pharmacy");
  await editor.getByLabel("Original wording or observation").fill("Synthetic dispensing number A-001 matches Bag A to Demo Slate.");
  await editor.getByLabel("Documented medicine name").fill("Demo Slate");
  await editor.getByLabel("Independent identity evidence, if documented").selectOption("dispensing_confirmation");
  await editor.getByRole("checkbox", { name: /I confirm this evidence/ }).check();
  const linked = await submit(nurse, encounter, "link");
  const proof = linked.rows["item-1"].entries.find(e => e.identity_basis === "dispensing_confirmation").source.id;
  await button(row, "Verify current use").click();
  await editor.getByLabel("Identity evidence", { exact: true }).selectOption(proof);
  await editor.getByLabel(/Resolution of conflicting sources/).fill("Reviewed the independent dispensing record for synthetic Bag A.");
  const verified = await submit(nurse, encounter, "verify");
  assert.equal(verified.rows["item-1"].verified.identity.source_id, proof);
  const [incident] = Object.values(verified.identity_incidents);
  assert.equal(incident.reviewer.role, "nurse");
  assert.deepEqual(incident.conflicting_sources.map(s => s.source_id).sort(), ["physical-item", "transfer"]);
  await row.getByRole("heading", { name: "Original identity decision" }).waitFor();
  assert.equal(await button(row, "Pharmacy assessment").count(), 0);
  await button(nurse, "Finish reconciliation").click();
  const finished = await submit(nurse, encounter, "finish");
  assert.equal(finished.status, "Finished");
  await nurse.close();

  const pharmacy = await openCase(browser, "pharmacist", encounter);
  const reviewed = rowFor(pharmacy, "item-1");
  await button(reviewed, "Pharmacy assessment").click();
  const finding = "Pharmacy checked synthetic dispensing number A-001.";
  await pharmacy.getByLabel("Assessment outcome").selectOption("confirmed_medication_error");
  await pharmacy.getByLabel("Pharmacy finding").fill(finding);
  await submit(pharmacy, encounter, "assess_identity_incident");
  await button(pharmacy, "Reload review").click();
  await reviewed.getByText(/Pharmacy assessment · confirmed medication error/).waitFor();
  await reviewed.getByText(finding, { exact: false }).waitFor();
  const saved = await request("pharmacist", encounter.route);
  const { pharmacy_assessments, ...decision } = saved.identity_incidents[incident.id];
  const { pharmacy_assessments: before, ...original } = incident;
  assert.equal(before.length, 0);
  assert.deepEqual(original, decision);
  assert.equal(saved.status, "Finished");
  assert.deepEqual(saved.rows, finished.rows);
  assert.equal(pharmacy_assessments.length, 1);
  assert.equal(pharmacy_assessments[0].assessment, finding);
  assert.equal(pharmacy_assessments[0].recorder.role, "pharmacist");
  if (process.env.ADMISSION_EVIDENCE_DIR) {
    await reviewed.getByRole("heading", { name: "Original identity decision" }).locator("..")
      .screenshot({ path: path.join(process.env.ADMISSION_EVIDENCE_DIR, "admission-pharmacy-assessment.png") });
  }
  await pharmacy.close();
}

async function reportedIdentity(browser, image, reportFirst) {
  const encounter = await makeCase("nurse", reportFirst ? "report first" : "loose first");
  const wording = "I think this tablet is Demo A.";
  const report = entry("account", "patient_report", wording, { name: "Demo A" });
  const loose = photo("reverse_photo", image, {});
  await encounter.seed("add", { entry: reportFirst ? report : loose });
  if (reportFirst) {
    await encounter.seed("interview", interview());
    await encounter.seed("verify", { row_id: "item-1", source_id: "account" });
  }
  await encounter.seed("link", { row_id: "item-1", confirmed: true, entry: reportFirst ? loose : report });
  if (!reportFirst) await encounter.seed("interview", interview());
  const page = await openCase(browser, "nurse", encounter);
  const row = rowFor(page, "item-1");
  await row.getByRole("heading", { name: "Unknown medication item-1" }).waitFor();
  await row.getByText(/Proposed identity.*pharmacist review required.*Demo A/i).waitFor();
  await row.getByText(wording, { exact: false }).first().waitFor();
  assert.equal(await button(row, "Verify current use").count(), 0);
  assert.ok(await button(page, "Finish reconciliation").isDisabled());
  const saved = await request("nurse", encounter.route);
  assert.equal(saved.rows["item-1"].verified, null);
  assert.equal(saved.rows["item-1"].proposal.reference, "account");
  await page.close();
}

async function incompleteRegimen(browser) {
  const encounter = await makeCase("doctor", "screening attestation");
  await encounter.seed("add", { entry: entry("script", "prescription", "Demo Amber", { name: "Demo Amber" }) });
  await encounter.seed("link", {
    row_id: "item-1", confirmed: true,
    entry: entry("account", "patient_report", "I currently take Demo Amber. Dose uncertain."),
  });
  await encounter.seed("interview", interview(null));
  const page = await openCase(browser, "doctor", encounter);
  const row = rowFor(page, "item-1");
  await button(row, "Attest current use for screening").click();
  await submit(page, encounter, "attest_current_use");
  await row.getByText("Current use attested for screening", { exact: true }).waitFor();
  await row.getByText(/Regimen still requires dose before verification and import/).waitFor();
  assert.ok(await button(page, "Finish reconciliation").isDisabled());
  const saved = await request("doctor", encounter.route);
  const attestation = saved.rows["item-1"].screening_attestation;
  assert.equal(attestation.actor.role, "doctor");
  assert.equal(attestation.source_id, "account");
  assert.equal(attestation.answer.dose, null);
  assert.equal(saved.rows["item-1"].verified, null);
  assert.equal(saved.receipts.length, 0);
  if (process.env.ADMISSION_EVIDENCE_DIR) {
    await row.screenshot({ path: path.join(process.env.ADMISSION_EVIDENCE_DIR, "admission-screening-attestation.png") });
  }
  await page.close();
}

async function run() {
  for (const [role, token] of Object.entries(tokens)) {
    assert.ok(token, "Set ADMISSION_TEST_" + role.toUpperCase() + " for the local synthetic app.");
  }
  const image = await readFile(path.join(__dirname, "../../../backend/tests/fixtures/ai/label-side.png"), "base64");
  const browser = await chromium.launch({ executablePath: process.env.ADMISSION_CHROME, headless: true });
  try {
    await reportedIdentity(browser, image, true);
    await reportedIdentity(browser, image, false);
    await incompleteRegimen(browser);
    await namedDispute(browser, image);
    console.log("Passed: report-first and loose-first remain proposals; doctor screening attestation retains missing dose; nurse independently resolves a named dispute; post-finish pharmacy assessment preserves the original decision and rows.");
  } finally {
    await browser.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
