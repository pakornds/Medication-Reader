/* Serve Vite with its FastAPI proxy; supply TEST_UI_URL and MEDICATION_READER_DEMO_NURSE_TOKEN. */
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

async function main() {
  const url = process.env.TEST_UI_URL
  const token = process.env.MEDICATION_READER_DEMO_NURSE_TOKEN
  assert.ok(token && url)
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH })
  try {
    const page = await browser.newPage()
    await page.goto(url + '/tests/workflow/shared-document.html')
    await page.waitForFunction(() => typeof window.openSyntheticDraft === 'function')
    await page.evaluate(token => window.openSyntheticDraft(token), token)
    const save = page.getByRole('button', { name: 'Save draft and open clinical review' })
    await save.waitFor()
    assert.equal(await save.isEnabled(), false)
    const first = page.getByLabel('Copy the exact source passage for Demo Amber')
    const second = page.getByLabel('Copy the exact source passage for Demo Slate')
    const a = 'Demo Amber 5 mg each morning', b = 'Demo Slate 5 mg each evening'
    await first.fill(a)
    await second.fill(a + '\n' + b)
    await save.click()
    await page.getByRole('alert').getByText(/excerpt for this medication separately/).waitFor()
    assert.equal(await first.inputValue(), a)
    await second.fill(b)
    await save.click()
    await page.waitForFunction(() => window.savedEncounterId)
    const id = await page.evaluate(() => window.savedEncounterId)
    const result = await fetch(url + '/admissions/' + id, { headers: { 'X-Demo-Reviewer-Token':token } })
    assert.equal(result.status, 200)
    const encounter = await result.json()
    assert.deepEqual(Object.keys(encounter.documents), ['ward-list'])
    assert.equal(encounter.documents['ward-list'].wording, a + '\n' + b)
    assert.deepEqual(Object.values(encounter.rows).map(row => row.entries[0].wording), [a, b])
    console.log('Shared ward document persisted once with both staff-selected excerpts after correcting an ambiguous selection.')
  } finally {
    await browser.close()
  }
}
main().catch(error => { console.error(error); process.exitCode=1 })
