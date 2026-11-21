/* Optional browser acceptance run. Use a fresh local fixture server and Playwright on NODE_PATH. */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs/promises");

const base = process.env.ADMISSION_DEMO_URL || "http://127.0.0.1:18761";
const output = process.env.ADMISSION_EVIDENCE_DIR;
const photoPath = path.resolve(
  __dirname,
  "../../backend/tests/fixtures/ai/label-side.png",
);
const patient = "Synthetic admission " + Date.now();
const errors = [];

async function signIn(page, role) {
  page.setDefaultTimeout(8000);
  page.on("pageerror", (e) => { errors.push(e.message); console.error(e.message); });
  await page.goto(base + "/admission/");
  await page
    .getByLabel("Demo reviewer token")
    .fill(process.env["ADMISSION_TEST_" + role.toUpperCase()]);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Assigned encounters" }).waitFor();
}
async function click(scope, name) {
  await scope.getByRole("button", { name, exact: true }).click();
}
async function save(page) {
  const dialog = page.getByRole("dialog");
  await click(dialog, "Save");
  await dialog.waitFor({ state: "hidden", timeout: 4000 }).catch(async (e) => {
    throw new Error(
      (await page.locator("#formerror").textContent()) || e.message,
    );
  });
}
async function add(page, name, kind = "transfer_record", bag) {
  await click(page, "Add medication or unknown item");
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Evidence type").selectOption(kind);
  await dialog
    .getByLabel("Source, reporter or department")
    .fill("Synthetic ward");
  if (bag) {
    await dialog.getByLabel("Item photo").setInputFiles(photoPath);
    await dialog.getByLabel("Bag or package reference").fill(bag);
    await dialog
      .getByLabel("Distinct tablet appearance, if a crop")
      .fill("round tablet");
  }
  await dialog
    .getByLabel("Original wording or observation")
    .fill(name || "Unlabeled bag. Location uncertain.");
  if (name)
    await dialog
      .getByLabel("Documented medicine name, strength and form")
      .fill(name);
  await save(page);
  return page.locator("#rows article").last();
}
async function interview(page, article, first = false) {
  await click(
    first ? page : article,
    first ? "Start patient interview" : "Interview",
  );
  const d = page.getByRole("dialog");
  await d.getByLabel("Reporter", { exact: true }).fill("Synthetic caregiver");
  await d
    .getByLabel("Original account")
    .fill("Patient reports the fixture amount by mouth each morning.");
  await d.getByLabel("Ownership", { exact: true }).selectOption("patient");
  await d.getByLabel("Current use", { exact: true }).selectOption("current");
  await d.getByLabel("Actual dose").fill("fixture amount");
  await d.getByLabel("Actual route").fill("by mouth");
  await d.getByLabel("Actual schedule or as-needed use").fill("each morning");
  await save(page);
}
async function paper(page, filename) {
  await page.emulateMedia({ media: "print" });
  assert.equal(
    await page
      .getByRole("heading", {
        name:
          filename === "worksheet"
            ? "Admission interview worksheet"
            : "Reviewed medication handoff",
      })
      .isVisible(),
    true,
  );
  assert.equal(await page.locator("#controls").isVisible(), false);
  if (output)
    await page.pdf({
      path: path.join(output, filename + ".pdf"),
      format: "A4",
      printBackground: true,
    });
  await page.emulateMedia({ media: "screen" });
}
async function run(browser) {
  if (output) await fs.mkdir(output, { recursive: true });
  const nurse = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await nurse.newPage();
  await signIn(page, "nurse");
  await page.getByLabel("Synthetic patient name").fill(patient);
  await click(page, "Create encounter");
  const first = await add(page, "Amlodipine 5 mg box");
  assert.equal(
    await page
      .getByRole("button", { name: "Start patient interview" })
      .isVisible(),
    true,
  );
  assert.equal(
    await page.getByRole("button", { name: "Print worksheet" }).isVisible(),
    true,
  );
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  if (output)
    await page.screenshot({
      path: path.join(output, "phone-worksheet.png"),
      fullPage: true,
    });
  await paper(page, "worksheet");
  await interview(page, first, true);
  await click(first, "Verify current use");
  await save(page);
  const unknown = await add(page, null, "reverse_photo", "Bag A");
  await interview(page, unknown);
  await click(unknown, "Propose identity");
  await page
    .getByLabel("Hospital record or catalogue candidate")
    .selectOption({ index: 1 });
  await save(page);
  assert.equal(
    await page
      .getByRole("button", { name: "Finish reconciliation" })
      .isDisabled(),
    true,
  );
  await click(page, "Request pharmacist review");
  await page.getByRole("dialog").getByRole("checkbox").check();
  await page
    .getByLabel("What has been checked")
    .fill("Bags moved. Retake requested.");
  await page
    .getByLabel("Reason for referral")
    .fill("Current tablet needs independent identification.");
  await save(page);
  await nurse.close();

  const pharmacy = await browser.newContext({
    viewport: { width: 820, height: 1180 },
  });
  const later = await pharmacy.newPage();
  await signIn(later, "pharmacist");
  await click(later, patient + " · Awaiting pharmacist review");
  const item = later.locator("#rows article").last();
  await click(item, "Link source or photo");
  const d = later.getByRole("dialog");
  await d.getByLabel("Evidence type").selectOption("reviewer_record");
  await d
    .getByLabel("Source, reporter or department")
    .fill("Synthetic dispensing pharmacist");
  await d
    .getByLabel("Original wording or observation")
    .fill(
      "The dispensing pharmacist matched the physical item in bag A to Demo blue.",
    );
  await d
    .getByLabel("Documented medicine name, strength and form")
    .fill("Demo blue");
  await d
    .getByLabel("Independent identity evidence")
    .selectOption("dispensing_confirmation");
  await d.getByRole("checkbox").check();
  await save(later);
  await click(item, "Review identity");
  await d.getByLabel("Decision", { exact: true }).selectOption("correct");
  const options = d.getByLabel("Item-specific evidence").locator("option");
  await d
    .getByLabel("Item-specific evidence")
    .selectOption(await options.last().getAttribute("value"));
  await d.getByLabel("Documented identity", { exact: true }).fill("Demo blue");
  await d
    .getByLabel("Evidence checked and finding")
    .fill("Dispensing staff confirmed the physical item.");
  await save(later);
  await click(item, "Verify current use");
  await save(later);
  await click(later, "Finish reconciliation");
  await save(later);
  assert.equal(
    await later.getByText("Finished", { exact: true }).isVisible(),
    true,
  );
  assert.equal(await later.evaluate(() => localStorage.length), 0);
  assert.equal(
    await later.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  if (output)
    await later.screenshot({
      path: path.join(output, "tablet-reviewed.png"),
      fullPage: true,
    });
  await paper(later, "reviewed");
  await click(later, "Approve and import selected rows");
  await d.getByRole("checkbox").first().check();
  await save(later);
  assert.match(
    await later.evaluate(() => localStorage.key(0)),
    /^medication-reader:imported-at:/,
  );
  await later.reload();
  await signIn(later, "pharmacist");
  await click(later, patient + " · Finished");
  await later.getByRole("heading", { name: "Demo blue" }).waitFor();
  assert.deepEqual(errors, []);
  console.log(
    "PASS 390px worksheet, interview, proposal and referral; 820px independent pharmacy continuation, correction, finish, selected import, reload and dated print views.",
  );
}
(async () => {
  const browser = await chromium.launch({
    executablePath: process.env.ADMISSION_CHROME || undefined,
    headless: true,
  });
  try {
    await run(browser);
  } finally {
    await browser.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
