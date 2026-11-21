/* Run against a local admission demo with the same token variables as admission-browser.cjs. */
const assert = require("node:assert/strict");
const { randomUUID } = require("node:crypto");
const { chromium } = require("playwright");

async function run(browser) {
  const base = process.env.ADMISSION_DEMO_URL || "http://127.0.0.1:18761";
  const token = role => process.env["ADMISSION_TEST_" + role.toUpperCase()];
  const alias = "Demo shared transfer " + randomUUID();
  const medicines = ["Demo Amber", "Demo Slate"];
  const lines = medicines.map((name, i) => `${i + 1}. ${name}, documented ward interview.`);
  const source = { id: "W1", kind: "transfer_record", organization: "Demo Ward" };
  const page = await browser.newPage();
  async function request(method, path, role, data) {
    const response = await page.request.fetch(base + path, {
      method, headers: { "X-Demo-Reviewer-Token": token(role) }, data,
    });
    assert.ok(response.ok(), await response.text());
    return response.json();
  }
  let state = await request("POST", "/admissions", "nurse", { patient_alias: alias });
  const path = "/admissions/" + state.id;
  async function send(command, role = "nurse") {
    state = await request("POST", path + "/actions", role,
      { revision: state.revision, request_id: randomUUID(), command });
  }
  await send({ action: "register_document", source, wording: lines.join("\n") });
  for (const [i, name] of medicines.entries()) {
    const row_id = "item-" + (i + 1);
    await send({ action: "add", entry: { case_id: state.id, source_id: "W1", name, wording: lines[i],
      record_basis: "documented_interview" } });
    await send({ action: "interview", row_id, source_id: "W1", ownership: "patient", current_use: "current",
      dose: "fixture amount", route: "oral", schedule: "fixture schedule" });
    await send({ action: "verify", row_id, source_id: "W1" });
  }
  await send({ action: "add", entry: { source: { id: "unidentified", kind: "other_record", reporter: "Demo nurse" },
    wording: "An unidentified item awaits follow-up." } });
  state = await request("GET", path, "pharmacist");
  await send({ action: "import", row_ids: ["item-1", "item-2"] }, "pharmacist");
  const receipt = state.receipts[0];
  const [record] = await request("GET", "/imports?" + new URLSearchParams({ imported_at: receipt.imported_at }),
    "pharmacist");
  assert.deepEqual(record.snapshot.evidence.sources.map(s => s.id), ["W1"]);
  assert.deepEqual(record.snapshot.evidence.items.map(i => [i.row_id, i.excerpt]),
    [["item-1", lines[0]], ["item-2", lines[1]]]);
  console.log("Imported", receipt.imported_row_ids, "with one source W1 and both row-specific excerpts.");

  await page.goto(base + "/admission/");
  await page.getByLabel("Demo reviewer token").fill(token("pharmacist"));
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: alias + " · In progress", exact: true }).click();
  await page.getByRole("button", { name: "Propose identity", exact: true }).click();
  const dialog = page.getByRole("dialog");
  for (const name of medicines) {
    await dialog.getByLabel("Hospital record or catalogue candidate")
      .selectOption({ label: "Encounter record · " + name + " · W1" });
    assert.equal(await dialog.getByLabel("Proposed identity", { exact: true }).inputValue(), name);
    assert.equal(await dialog.getByLabel("Source or lookup reference").inputValue(), "W1");
    console.log("Selected", name, "with source W1.");
  }
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.ADMISSION_CHROME || undefined, headless: true });
  try { await run(browser); } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
