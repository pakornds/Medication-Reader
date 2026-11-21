// Serve the repository root over HTTP. Use Playwright and an installed Chromium browser.
const assert = require("node:assert/strict");
const { chromium } = require("playwright");

async function run() {
  const browser = await chromium.launch({
    executablePath: process.env.REVIEW_ITEMS_CHROME,
    channel: process.env.REVIEW_ITEMS_CHROME ? undefined : "chrome",
    headless: true,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 880 } });
    page.setDefaultTimeout(8000);
    const pageErrors = [];
    page.on("pageerror", error => pageErrors.push(error.message));
    await page.goto(process.env.REVIEW_ITEMS_URL ??
      "http://127.0.0.1:8079/tests/ui/checks/review-items/preview.html");

    const review = page.locator("#review");
    const fixture = page.getByLabel("Fixture");
    const openFinding = async () => {
      const card = review.locator("details").filter({
        has: page.locator("summary").getByText(/Shared active ingredient.*Demo Amber.*Demo Slate/),
      });
      await card.locator("summary").click();
      return card;
    };

    await review.getByText("Evaluated 1 of 3 rule scopes (33%).", { exact: true }).waitFor();
    const before = await page.evaluate(() => window.fixtureData);
    const draft = page.getByRole("group", { name: "Draft" });
    const importSelection = draft.getByRole("checkbox", { name: "Select Demo Amber for mock import" });
    const draftContent = await draft.innerText();
    let finding = await openFinding();
    for (const text of [
      /demo-duplicate-ingredient-v1 · Version 1/,
      /Demo Amber · Scheduled/,
      /E1 · Synthetic labeled pack/,
      /Demo Slate · As needed \(PRN\)/,
      /E2 · Synthetic labeled pack and interview/,
      /Ingredients assessed · X/,
      /Overlapping use is unconfirmed for the as-needed medicine/,
      /Is the shared ingredient across Demo Amber and Demo Slate intended/,
    ]) {
      await finding.getByText(text).waitFor({ state: "visible" });
    }
    const link = finding.getByRole("link", { name: "Proposed DRP rule for overlapping active ingredients" });
    assert.equal(await link.getAttribute("href"), before.release.rules[2].reference.source_url);
    await finding.getByLabel("Disposition").selectOption("additional_evidence");
    await finding.getByRole("button", { name: "Save disposition" }).click();
    assert.equal(await finding.getByRole("status").innerText(), "Additional evidence needed");
    assert.equal(await importSelection.isChecked(), true);
    assert.equal(await draft.innerText(), draftContent);
    assert.deepEqual(await page.evaluate(() => window.fixtureData), before);
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    if (process.env.REVIEW_ITEMS_SCREENSHOT) {
      await page.screenshot({ path: process.env.REVIEW_ITEMS_SCREENSHOT, fullPage: true });
    }

    await fixture.selectOption("ddi");
    await review.getByText("Evaluated 0 of 3 medication pairs (0%).", { exact: true }).waitFor();
    const pair = review.locator("summary", { hasText: "Not evaluated · Demo Amber + Demo Slate" }).first();
    await pair.click();
    await review.getByText("No finding in this comparison · Demo Amber + Demo Slate", { exact: true }).waitFor();
    assert.equal(await review.getByRole("status").allTextContents().then(list => list.length), 1);

    await fixture.selectOption("baseline");
    finding = await openFinding();
    assert.equal(await finding.getByRole("status").innerText(), "Additional evidence needed");
    await finding.getByLabel("Disposition").selectOption("documented");
    await finding.getByLabel("Assessment").fill("Source clarification requested.");
    await finding.getByRole("button", { name: "Save disposition" }).click();
    assert.equal(await finding.getByRole("status").innerText(), "Documented disposition · Source clarification requested.");

    await fixture.selectOption("stale");
    assert.match(await review.innerText(), /Screening is stale/);
    assert.doesNotMatch(await review.innerText(), /Demo Amber|Source clarification requested/);
    await fixture.selectOption("updated");
    finding = await openFinding();
    assert.equal(await finding.getByRole("status").innerText(), "");
    assert.equal(await finding.getByLabel("Disposition").inputValue(), "");
    assert.equal(await finding.getByText("Known gaps", { exact: true }).count(), 0);

    await fixture.selectOption("single");
    await review.getByText("No pair to assess.", { exact: true }).waitFor();
    assert.doesNotMatch(await review.innerText(), /%/);
    assert.match(await review.innerText(), /Not evaluated/);

    await fixture.selectOption("doctor");
    finding = await openFinding();
    assert.equal(await finding.getByRole("button", { name: "Save disposition" }).count(), 0);
    assert.deepEqual(pageErrors, []);
    console.log("PASS: shared X, separate cited sources, PRN gap, snapshot reset, one product, and read-only doctor view");
    console.log("PASS: saved disposition preserved the fixture regimen and mock import selection; no browser storage written");
  } finally {
    await browser.close();
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
