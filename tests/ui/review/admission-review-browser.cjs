/* Optional browser acceptance through a running synthetic app. Set NODE_PATH to Playwright. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { chromium } = require("playwright");


const base = process.env.ADMISSION_DEMO_URL || "http://127.0.0.1:18764";
const token = process.env.ADMISSION_TEST_NURSE;
const headers = { "X-Demo-Reviewer-Token": token };
const fixture = path.resolve(__dirname, "../../../fixtures/package-capture/two-photos.json");
const intake = path.resolve(__dirname, "../intake");

async function post(route, data, form = false) {
  const response = await fetch(base + route, {
    method: "POST",
    headers: form ? headers : { ...headers, "Content-Type": "application/json" },
    body: form ? data : JSON.stringify(data),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}

async function expectCount(locator, count) {
  if (count) await locator.nth(count - 1).waitFor({ state: "attached" });
  await locator.nth(count).waitFor({ state: "detached" });
  assert.equal(await locator.count(), count);
}

async function run() {
  assert.ok(token, "Set ADMISSION_TEST_NURSE to the synthetic app's assigned nurse token.");
  const alias = "Synthetic package review " + randomUUID().slice(0, 7);
  let encounter = await post("/admissions", { patient_alias: alias });
  const admissionPath = "/admissions/" + encounter.id;
  const save = async (action, fields) => {
    encounter = await post(admissionPath + "/actions", {
      revision: encounter.revision, request_id: randomUUID(), command: { action, ...fields },
    });
  };
  const entry = (id, kind, wording, rest = {}, source = {}) => ({
    source: { id, kind, ...source }, wording, ...rest,
  });
  await save("add", { entry: entry("clinic-script", "prescription", "Demo A: take 1 tablet twice daily", {
    name: "Demo A", directions: "take 1 tablet twice daily",
  }, { organization: "Demo Clinic A" }) });

  const manifest = JSON.parse((await fs.readFile(fixture, "utf8")).replaceAll("demo-two-photos", encounter.id));
  manifest.reverse.regions[1].visibility = "opaque";
  manifest.reverse.regions.push({
    id: "reverse-b", bounds: { x: 0.38, y: 0.08, width: 0.23, height: 0.34 },
  });
  const matchB = manifest.reverse_matches.find(match => match.package_id === "package-b");
  matchB.status = "confirmed";
  matchB.region.region_id = "reverse-b";
  const capture = new FormData();
  capture.set("command", JSON.stringify({
    manifest, revision: encounter.revision, request_id: randomUUID(), existing_rows: { "order-a": "item-1" },
  }));
  capture.set("front", new Blob([await fs.readFile(path.join(intake, "table-front-orientation-6.jpg"))], { type: "image/jpeg" }), "front.jpg");
  capture.set("reverse", new Blob([await fs.readFile(path.join(intake, "table-reverse.png"))], { type: "image/png" }), "reverse.png");
  encounter = await post(admissionPath + "/capture", capture, true);

  const report = entry("patient-use", "patient_report", "I take one tablet in the morning only.", {}, {
    reporter: "Synthetic patient",
  });
  await save("link", { row_id: "item-1", confirmed: true, entry: report });
  await save("interview", { row_id: "item-1", source_id: "patient-use", ownership: "patient", current_use: "uncertain" });

  for (const [id, name, directions] of [
    ["split", "Demo split", "1 tablet each morning and 2 tablets each evening"],
    ["taper", "Demo taper", "1 tablet each morning then taper"],
  ]) {
    await save("add", { entry: entry(id, "prescription", name + ": " + directions, { name, directions }, { organization: "Synthetic hospital" }) });
  }

  const browser = await chromium.launch({
    executablePath: process.env.ADMISSION_CHROME, headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
    const errors = [];
    const crops = new Set();
    page.on("pageerror", error => errors.push(error.message));
    page.on("request", request => {
      if (request.url().endsWith("/capture/region")) crops.add(request.postDataJSON().region_id);
    });
    await page.goto(base + "/admission/");
    await page.getByLabel("Demo reviewer token").fill(token);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.getByRole("button", { name: new RegExp(alias) }).click();
    await page.getByRole("button", { name: "Record unavailable source" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Organization").fill("Synthetic transfer hospital");
    await dialog.getByLabel("Department or ward").fill("Demo ward");
    await dialog.getByLabel("Reason unavailable").fill("Records desk closed");
    await dialog.getByLabel("Follow-up").fill("Request the ward list when the desk reopens.");
    await dialog.getByRole("button", { name: "Save", exact: true }).click();
    const missing = page.getByRole("region", { name: "Unavailable sources", exact: true });
    await missing.getByText(/Synthetic transfer hospital · Demo ward/).waitFor();
    await page.getByRole("button", { name: "Reload review" }).click();
    await missing.getByText("Reason · Records desk closed", { exact: true }).waitFor();
    await missing.getByText(/Request the ward list when the desk reopens/).waitFor();
    await missing.getByText(/Recorded by .+nurse/).waitFor();
    const reloaded = await fetch(base + admissionPath, { headers });
    assert.equal(reloaded.status, 200);
    encounter = await reloaded.json();
    const [outstanding] = Object.values(encounter.unavailable_sources);
    assert.equal(outstanding.source.availability, "unavailable");
    assert.ok(Object.values(encounter.rows).every(medication =>
      medication.entries.every(entry => entry.source.id !== outstanding.source.id)
    ));

    const row = name => page.locator("#rows > article").filter({ has: page.getByRole("heading", { name, exact: true }) });
    const a = row("Demo A");
    await a.getByText("Verification pending", { exact: true }).waitFor();
    await expectCount(a.getByText(/Records desk closed/), 0);
    await a.getByText(/I take one tablet in the morning only/).first().waitFor();
    await a.getByText("Open sourced regimen fields").click();
    await expectCount(a.locator(".regimen-evidence"), 2);
    await a.getByText(/Open package regions/).click();
    await expectCount(a.getByRole("img"), 2);
    await a.getByText(/Demo Clinic A/).first().waitFor();

    for (const shape of ["round", "oval"]) {
      const pendingId = encounter.capture_rows["pending-b-" + shape];
      const pending = row("Unknown medication " + pendingId);
      await pending.getByText("Open package regions · package-b").click();
      await pending.getByRole("img", { name: "Front item region · front-b-" + shape }).waitFor();
      await pending.getByRole("img", { name: "Confirmed reverse package region · reverse-b" }).waitFor();
      await pending.getByText(/Unresolved identity/).waitFor();
      await expectCount(pending.getByText(/Demo Clinic A|Demo Clinic C/), 0);
    }
    const c = page.locator("#rows > article").filter({ has: page.getByText("Open package regions · package-c") });
    await c.getByText(/Open package regions/).click();
    await c.getByText("Confirmed reverse package region · reverse-c · opaque").waitFor();
    await c.getByText(/Demo Clinic C/).waitFor();
    await c.getByRole("img", { name: "Front item region · front-c" }).waitFor();
    assert.deepEqual(crops, new Set(["front-a", "reverse-a", "front-b-round", "front-b-oval", "reverse-b", "front-c"]));

    const split = row("Demo split");
    await split.getByText("Open sourced regimen fields").click();
    await expectCount(split.locator(".regimen-evidence"), 2);
    for (const [index, timing] of ["morning", "evening"].entries()) {
      const evidence = split.locator(".regimen-evidence").nth(index);
      await evidence.getByText("Fields and sources").click();
      await evidence.getByText(timing, { exact: true }).waitFor();
      await evidence.getByText("Synthetic hospital", { exact: true }).first().waitFor();
    }
    const taper = row("Demo taper");
    await taper.getByText("Open sourced regimen fields").click();
    await taper.getByText("Unrepresented wording").waitFor();
    assert.equal(await taper.locator(".regimen-evidence blockquote").textContent(), "1 tablet each morning then taper");

    await save("interview", { row_id: "item-1", source_id: "patient-use", ownership: "patient", current_use: "current",
      dose: "one tablet", route: "oral", schedule: "each morning" });
    await save("verify", { row_id: "item-1", source_id: "patient-use" });
    await page.getByRole("button", { name: "Reload review" }).click();
    await a.getByText(/Verified regimen · one tablet · oral · each morning/).waitFor();
    await a.getByText(/Last documented prescription · take 1 tablet twice daily/).waitFor();
    assert.deepEqual(errors, []);
    if (process.env.ADMISSION_EVIDENCE_DIR) {
      await page.screenshot({ path: path.join(process.env.ADMISSION_EVIDENCE_DIR, "admission-review.png"), fullPage: true });
    }
    console.log("Passed: unavailable ward record and follow-up, sourced prescription, separate report and verification, independently cited mixed-bag crops, opaque reverse, split doses and retained taper wording.");
  } finally {
    await browser.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
