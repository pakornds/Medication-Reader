/* Run with TEST_UI_URL, Playwright and Chromium against the default app and a local TMT backend. */
const assert = require('node:assert/strict')
const { readFile } = require('node:fs/promises')
const { chromium } = require('playwright')

async function run() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined })
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['clipboard-read', 'clipboard-write'] })
    const page = await context.newPage()
    const base = process.env.TEST_UI_URL
    const privateRequests = []
    const paths = []
    page.on('request', request => {
      const path = new URL(request.url()).pathname
      paths.push(path)
      if (path.startsWith('/admissions') || path.startsWith('/imports')) privateRequests.push(path)
    })
    const assertFits = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
    const pasted = 'Synthetic transfer record. VIGAMOX eye drops. One drop each morning.'
    const dirs = '1 capsule each morning'
    await page.route('**/medication-analysis', async route => {
      const body = route.request().postData()
      const form = JSON.parse(body.match(/name="form"\r\n\r\n(\{.+\})/)[1])
      const photo = form.photo_source_ids[0]
      if (!photo) {
        const source = form.other_source_notes[0]
        assert.equal(source.value, pasted)
        const ref = source.evidence
        await route.fulfill({ json: {
          case_id: form.evidence.case_id, unassigned_reports: [], rows: [{
            id: 'text-row', identity_status: 'named', sources: [ref],
            observed_names: [{ value: 'VIGAMOX', evidence: ref }],
            label_fields: { directions: { status: 'readable', value: 'One drop each morning', evidence: ref } },
            reported_use: [], discrepancies: [], follow_ups: [],
          }],
        } })
        return
      }
      const boxes = [
        { id: 'front-one', x: 0.02, caption: 'SIADOCIN' },
        { id: 'front-two', x: 0.35, caption: 'SIADOCIN' },
        { id: 'front-three', x: 0.68, caption: null },
      ]
      const rows = boxes.map(({ id, caption }) => ({
        id, identity_status: caption ? 'named' : 'unreadable', unknown_label: caption ? null : 'Unreadable package',
        sources: [{ source_id: id, item_id: id }],
        observed_names: caption ? [{ value: caption, evidence: { source_id: id, item_id: id } }] : [],
        label_fields: caption ? { directions: { status: 'readable', value: dirs, evidence: { source_id: id, item_id: id } } } : {},
        reported_use: [], discrepancies: [], follow_ups: [],
      }))
      await route.fulfill({ json: {
        case_id: form.evidence.case_id, rows, unassigned_reports: [],
        located_regions: boxes.map(({ id, x }) => ({ attachment_id: photo, source_id: id, item_id: id, row_id: id,
          bounds: { x, y: 0.05, width: 0.25, height: 0.6 } })),
        catalogue_identities: Object.fromEntries(boxes.slice(0, 2).map(({ id }, index) => [id, {
          ingredient: 'doxycycline', trade_name: 'SIADOCIN', release: 'TMTRF20200217',
          candidate_tpus: ['441548'], compatible_tpus: index ? ['441548', '441569'] : ['441548'],
          evidence: [{ source_id: id, item_id: id }],
        }])),
      } })
    })
    await page.goto(base + '/new-patient/input')
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6V3sAAAAASUVORK5CYII=', 'base64')
    await page.locator('input[type=file]').first().setInputFiles({ name: 'synthetic-labels.png', mimeType: 'image/png', buffer: image })
    await page.getByRole('button', { name: 'Analyze evidence' }).click()
    const cards = page.locator('.list-medicine')
    await cards.nth(2).waitFor()
    assert.equal(await cards.count(), 3)
    assert.equal(await cards.nth(0).getByText('Suggested match', { exact: true }).count(), 1)
    assert.equal(await cards.nth(1).getByText('Match needed', { exact: true }).count(), 1)
    await cards.nth(1).getByRole('button', { name: 'Choose match' }).click()
    const options = cards.nth(1).locator('.product-option')
    assert.equal(await options.count(), 2)
    await options.filter({ hasText: /capsule/i }).click()
    await cards.nth(0).getByRole('button', { name: 'Edit', exact: true }).click()
    await cards.nth(0).getByLabel('Quantity prescribed (as written)').fill('14 capsules')
    await cards.nth(0).getByRole('button', { name: 'Morning' }).click()
    await cards.nth(0).getByRole('button', { name: 'Done' }).click()
    await page.getByRole('link', { name: 'Continue to Review' }).click()
    assert.equal(await page.getByText('Record interview').count(), 0)
    await page.getByRole('button', { name: 'Select all ready' }).click()
    assert.equal(await page.getByRole('checkbox', { checked: true }).count(), 2)
    assert.ok(await assertFits())
    await page.getByRole('button', { name: 'Check medicines' }).click()
    await page.getByText('1 pair to review').waitFor()
    await page.getByText('Shared ingredient', { exact: true }).waitFor()
    await page.getByText(/pairs with incomplete coverage/).waitFor()
    assert.ok(paths.includes('/checks/local/catalogue'))
    await page.getByRole('button', { name: 'Prepare handoff' }).click()
    await page.getByRole('heading', { name: '2 medicines ready to hand off' }).waitFor()
    assert.equal(await page.getByText('Unreadable package').count(), 0)
    assert.ok(await assertFits())
    await page.getByRole('button', { name: 'Copy medicine list' }).click()
    const clipboard = await page.evaluate(() => navigator.clipboard.readText())
    assert.match(clipboard, /14 capsules/)
    assert.match(clipboard, /441548/)
    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download JSON' }).click()
    const download = await downloadPromise
    const { medicines } = JSON.parse(await readFile(await download.path(), 'utf8'))
    assert.equal(medicines.length, 2)
    assert.equal(medicines[0].schedules[0].times[0], 'morning')
    assert.deepEqual(privateRequests, [])
    const stored = await page.evaluate(() => [JSON.stringify(localStorage), JSON.stringify(sessionStorage)])
    assert.ok(stored.every(value => !/SIADOCIN|441548|14 capsules|synthetic-labels/.test(value)))
    await page.reload()
    await page.getByRole('link', { name: 'Review medicines' }).waitFor()
    await page.evaluate(() => localStorage.setItem(
      'medication-reader:imported-at:2026-11-20T08:00:00.000000Z', '2026-11-20T08:00:00.000000Z',
    ))
    await page.getByRole('link', { name: 'History' }).click()
    await page.getByRole('heading', { name: 'History' }).waitFor()
    assert.equal(await page.locator('#analysis-history ~ ol time').count(), 1)
    assert.equal(await page.locator('#previous-imports ~ ol time').count(), 1)
    await page.getByRole('link', { name: 'Back to Input' }).click()
    await page.getByRole('button', { name: 'Paste text' }).click()
    await page.getByRole('textbox', { name: 'Medication list or record' }).fill(pasted)
    await page.getByRole('button', { name: 'Analyze evidence' }).click()
    await page.getByRole('heading', { name: 'VIGAMOX' }).waitFor()
    await page.getByRole('link', { name: 'History' }).click()
    await page.locator('#analysis-history ~ ol time').nth(1).waitFor()
    assert.equal(await page.locator('#analysis-history ~ ol time').count(), 2)
    assert.equal(await page.getByText('VIGAMOX').count(), 0)
    const analysisKeys = await page.evaluate(() => Object.keys(localStorage)
      .filter(key => key.startsWith('medication-reader:analyzed-at:'))
      .map(key => [key, localStorage.getItem(key)]))
    assert.equal(analysisKeys.length, 2)
    assert.ok(analysisKeys.every(([key, value]) =>
      key === 'medication-reader:analyzed-at:' + value && /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value)))
    const checks = await context.newPage()
    await checks.goto(base + '/new-patient/input')
    await checks.getByRole('button', { name: 'Enter medicine manually' }).click()
    for (const code of ['117365', '263158']) {
      await checks.getByRole('combobox', { name: 'Product name or code' }).fill(code)
      await checks.getByRole('option').filter({ hasText: code }).first().click()
      if (code === '117365') {
        assert.ok(await checks.getByLabel('Strength', { exact: true }).inputValue())
        assert.ok(await checks.getByLabel('Form', { exact: true }).inputValue())
        await checks.getByLabel('Directions as written or reported').fill('1 tablet each morning')
        await checks.getByRole('button', { name: 'Fill fields from wording' }).click()
        await checks.waitForFunction(() => {
          const morning = [...document.querySelectorAll('#manual-input button')].find(b => b.textContent.trim() === 'Morning')
          return morning?.getAttribute('aria-pressed') === 'true'
        })
        assert.equal(await checks.getByLabel('Dose per use').inputValue(), '1')
        await checks.getByRole('button', { name: 'Upload photos' }).click()
        await checks.getByRole('button', { name: 'Enter medicine manually' }).click()
        assert.equal(await checks.getByLabel('Dose per use').inputValue(), '1')
      }
      await checks.getByRole('button', { name: 'Add to draft' }).click()
    }
    await checks.getByRole('combobox', { name: 'Product name or code' }).fill('Synthetic unlisted medicine')
    await checks.getByLabel('Dose per use').fill('2')
    await checks.getByLabel('Dose unit').fill('tablets')
    await checks.getByRole('button', { name: 'Evening' }).click()
    await checks.getByRole('button', { name: 'Add to draft' }).click()
    await checks.getByRole('link', { name: 'Continue to Review' }).click()
    await checks.getByRole('button', { name: 'Check medicines' }).click()
    await checks.getByText('FEST flags this combination to avoid').waitFor()
    const rule = checks.getByText('Source conditions and references')
    await rule.click()
    await checks.locator('.check-finding a').first().waitFor()
    await checks.getByRole('button', { name: 'Select all ready' }).click()
    await checks.getByRole('button', { name: 'Prepare handoff' }).click()
    const manualDownload = checks.waitForEvent('download')
    await checks.getByRole('button', { name: 'Download JSON' }).click()
    const manual = JSON.parse(await readFile(await (await manualDownload).path(), 'utf8')).medicines
    assert.equal(manual.find(medicine => medicine.tpu === '117365').schedules[0].times[0], 'morning')
    const unlisted = manual.find(medicine => medicine.product_name === 'Synthetic unlisted medicine')
    assert.equal(unlisted.tpu, null)
    assert.equal(unlisted.schedules[0].dose_amount, 2)
    assert.deepEqual(unlisted.schedules[0].times, ['evening'])
    console.log('PASS photos, pasted text, structured manual entry, local checks, handoff, and history')
  } finally { await browser.close() }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
