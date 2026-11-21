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
  await label("Evidence type").selectOption("label_photo");
  await label("Item photo").setInputFiles(photo);
  await label("Bag or package reference").fill("Fictional packaging");
  await label("width (%)").fill("33.3333333333");
  const scan = () => click("Read selected label region");
  await scan();
  assert.match(await page.locator("#formerror").innerText(), /Match the label region/);
  await label("This front label region belongs to the selected bag.").check();
  await scan();
  await page.waitForFunction(() => document.querySelector("[name=strength]").value === "5 mg");
  assert.equal(await label("Printed directions").inputValue(), "Once each morning");
  if (process.env.OCR_SCREENSHOT) await page.screenshot({ path: process.env.OCR_SCREENSHOT });
  await label("Evidence type").selectOption("reverse_photo");
  await label("x (%)").fill("33.3333333333");
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
  await label("x (%)").fill("66.6666666666");
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
