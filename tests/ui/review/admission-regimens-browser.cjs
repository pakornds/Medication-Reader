/* Run against a synthetic FastAPI server with nurse and doctor tokens and Playwright on NODE_PATH. */
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { chromium } = require("playwright");

const base = process.env.ADMISSION_DEMO_URL || "http://127.0.0.1:18764";
const token = process.env.ADMISSION_TEST_NURSE;
async function request(path, data, reviewerToken = token) {
  const headers = { "Content-Type": "application/json", "X-Demo-Reviewer-Token": reviewerToken };
  const response = await fetch(base + path, { method: data ? "POST" : "GET", headers, body: data && JSON.stringify(data) });
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}

async function run() {
  assert.ok(token, "Set ADMISSION_TEST_NURSE for the synthetic app.");
  const alias = "Synthetic regimen review " + randomUUID().slice(0, 8);
  assert.ok(process.env.ADMISSION_TEST_DOCTOR, "Set ADMISSION_TEST_DOCTOR for the synthetic app.");
  let encounter = await request("/admissions", { patient_alias: alias, assigned_roles: ["doctor"] });
  const path = "/admissions/" + encounter.id;
  const save = async command => {
    encounter = await request(path + "/actions", { request_id: randomUUID(), revision: encounter.revision, command });
  };
  const directions = "1 tablet by mouth each morning and 2 tablets by mouth each evening";
  await save({ action: "add", entry: {
    source: { id: "script", kind: "prescription", organization: "Synthetic clinic" },
    name: "Synthetic Split", wording: "Synthetic Split — " + directions, directions,
  } });
  const [rowId] = Object.keys(encounter.rows);
  const report = "3 tablets by mouth each morning";
  const reviewer = "3 tablets by mouth each morning and 2 tablets by mouth each evening";
  for (const [id, kind, reporter, wording] of [
    ["statement", "patient_report", "Synthetic patient", report],
    ["review", "reviewer_record", "Synthetic ward reviewer", reviewer],
  ]) {
    await save({ action: "link", row_id: rowId, confirmed: true, entry: { source: { id, kind, reporter }, wording } });
  }
  await save({ action: "interview", row_id: rowId, source_id: "statement", ownership: "patient", current_use: "current" });
  encounter = await request(path + "/actions", {
    revision: encounter.revision, request_id: randomUUID(),
    command: { action: "attest_current_use", row_id: rowId, source_id: "statement" },
  }, process.env.ADMISSION_TEST_DOCTOR);
  const taper = "1 tablet each morning then taper";
  await save({ action: "add", entry: {
    source: { id: "taper", kind: "prescription" }, name: "Synthetic Taper", wording: "Synthetic Taper — " + taper, directions: taper,
  } });
  const taperId = Object.keys(encounter.rows).at(-1);
  await save({ action: "link", row_id: taperId, confirmed: true, entry: {
    source: { id: "taper-report", kind: "patient_report", reporter: "Synthetic patient" }, wording: taper,
  } });
  await save({ action: "interview", row_id: taperId, source_id: "taper-report", ownership: "patient", current_use: "current" });

  const browser = await chromium.launch({ executablePath: process.env.ADMISSION_CHROME, headless: true });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(base + "/admission/");
    await page.getByLabel("Demo reviewer token").fill(token);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("button", { name: new RegExp(alias) }).click();
    const row = id => page.locator("#rows > article").filter({ has: page.locator('[data-action="verify"][data-row="' + id + '"]') });
    const dialog = page.getByRole("dialog");
    await row(rowId).getByText(/Regimen still requires dose, route, schedule/).waitFor();
    const edit = async (id, source) => {
      await row(id).getByRole("button", { name: "Verify current use" }).click();
      await dialog.getByLabel("Regimen to verify").selectOption("0");
      await dialog.getByLabel("Evidence for verified directions").selectOption(source);
    };
    await edit(taperId, "taper-report");
    await dialog.getByText(/Unrepresented wording:/).waitFor();
    assert.equal(await dialog.getByRole("button", { name: "Verify actual use" }).isDisabled(), true);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await edit(rowId, "review");
    const amounts = dialog.getByLabel("Dose amount", { exact: true });
    assert.equal(await amounts.nth(1).inputValue(), "2");
    await amounts.first().fill("3");
    const evidence = dialog.getByLabel("Evidence source for Dose amount").first();
    await evidence.selectOption({ label: "Synthetic patient" });
    await dialog.getByRole("button", { name: "Verify actual use" }).click();
    await dialog.waitFor({ state: "hidden" });
    await page.getByRole("button", { name: "Reload review" }).click();
    const cards = row(rowId).locator("article.regimen-evidence");
    await cards.nth(1).waitFor();
    assert.equal(await row(rowId).getByText(/Regimen still requires/).count(), 0);
    await cards.first().getByText("Fields and sources").click();
    await cards.first().getByText("Synthetic patient", { exact: true }).waitFor();
    const updated = await request(path);
    const verified = updated.rows[rowId].verified;
    const result = verified.regimens.map(c => ({
      dose: c.dose_amount, time: c.time_of_day, doseSource: c.evidence.dose_amount.source_id,
      verifiedDirectionsSource: c.evidence.directions_text.source_id,
    }));
    assert.deepEqual(result, [
      { dose: 3, time: ["morning"], doseSource: "statement", verifiedDirectionsSource: "review" },
      { dose: 2, time: ["evening"], doseSource: "script", verifiedDirectionsSource: "review" },
    ]);
    assert.equal(verified.actor.role, "nurse");
    assert.equal(updated.rows[taperId].verified, null);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ row: rowId, verifiedBy: verified.actor.role, regimens: result, unresolvedTaper: taper }));
  } finally {
    await browser.close();
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; });
