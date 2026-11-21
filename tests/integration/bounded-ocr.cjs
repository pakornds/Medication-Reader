/* Invoked by RUN_BOUNDED_OCR_BROWSER=1 pytest backend/tests/api/test_bounded_ocr.py */
const { chromium } = require("playwright");
const assert = require("node:assert/strict");

async function exercise(page) {
  const [, , port, photo] = process.argv;
  await page.goto(`http://127.0.0.1:${port}/admission/`);
  await page.getByLabel("Demo reviewer token").fill("fixture-nurse");
  const click = name => page.getByRole("button", { name, exact: true }).click();
  await click("Sign in");
  await page.getByLabel("Synthetic patient name").fill("Synthetic bounded OCR");
  await click("Create encounter");
  await click("Add medication or unknown item");
  const dialog = page.getByRole("dialog");
  const label = name => dialog.getByLabel(name, { exact: true });
  const medicineName = label("Documented medicine name");
  const observedName = label("Name observed in this region");
  const wording = label("Original wording or observation");
  await label("Evidence type").selectOption("label_photo");
  await label("Item photo").setInputFiles(photo);
  await label("Bag or package reference").fill("Fictional packaging");
  await label("width (%)").fill("25");
  const scan = () => click("Read selected label region");
  await scan();
  assert.match(await page.locator("#formerror").innerText(), /Match the label region/);
  await label("This front label region belongs to the selected bag.").check();
  await scan();
  await page.waitForFunction(() => document.querySelector("[name=strength]").value === "5 mg");
  assert.equal(await label("Printed directions").inputValue(), "Once each morning");
  assert.equal(await medicineName.inputValue(), "");
  assert.deepEqual(await observedName.locator("option").allTextContents(), [
    "Choose a name or leave it unresolved", "Fictional A", "Alternate name A",
  ]);
  await observedName.selectOption("Alternate name A");
  assert.equal(await medicineName.inputValue(), "Alternate name A");
  await label("width (%)").fill("50");
  assert.equal(await observedName.count(), 0);
  assert.equal(await medicineName.inputValue(), "");
  await label("width (%)").fill("25");
  await label("This front label region belongs to the selected bag.").check();
  await scan();
  await observedName.selectOption("Fictional A");
  assert.equal(await wording.inputValue(), "Fictional A\nAlternate name A\n5 mg\nOnce each morning");
  if (process.env.OCR_SCREENSHOT) await page.screenshot({ path: process.env.OCR_SCREENSHOT });
  await label("Source, reporter or department").fill("Synthetic OCR clinic");
  const [savedResponse] = await Promise.all([
    page.waitForResponse((response) => response.url().endsWith("/actions"), { timeout: 8000 }),
    click("Save"),
  ]);
  const saved = await savedResponse.json();
  assert.ok(savedResponse.ok(), JSON.stringify(saved));
  const [entry] = Object.values(saved.rows)[0].entries;
  assert.equal(entry.name, "Fictional A");
  assert.equal(entry.wording, "Fictional A\nAlternate name A\n5 mg\nOnce each morning");
  assert.deepEqual(entry.photo.region, [0, 0, 0.25, 1]);
  const article = page.getByRole("article");
  await article.getByRole("heading", { name: "Fictional A 5 mg" }).waitFor();
  assert.match(await article.locator(".source").innerText(), /Fictional A\nAlternate name A/);
  assert.equal(await article.locator("canvas.crop").count(), 1);

  await click("Add medication or unknown item");
  await label("Evidence type").selectOption("reverse_photo");
  await label("Item photo").setInputFiles(photo);
  await label("Bag or package reference").fill("Fictional packaging");
  await label("width (%)").fill("25");
  await label("x (%)").fill("25");
  await scan();
  assert.equal(await label("Documented strength").inputValue(), "");
  await label("Pairing").selectOption("matched");
  await label("Distinct tablet appearance, if a crop").fill("white tablet");
  await scan();
  assert.equal(await label("Documented medicine name").inputValue(), "");
  await label("Distinct tablet appearance, if a crop").fill("");
  await scan();
  await page.waitForFunction(() => document.querySelector("[name=strength]").value === "10 mg");
  assert.equal(await label("Printed directions").inputValue(), "Twice daily");
  assert.equal(await medicineName.inputValue(), "Fictional B / Fictional C");
  assert.equal(await observedName.count(), 0);
  await label("x (%)").fill("50");
  await label("Pairing").selectOption("matched");
  await scan();
  await page.waitForFunction(() => document.querySelector("[name=directions_status]").value === "unreadable");
  assert.equal(await label("Documented strength").inputValue(), "");
  assert.equal(await label("Documented medicine name").inputValue(), "");
}

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.ADMISSION_CHROME || undefined });
  try { await exercise(await browser.newPage()); }
  finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
