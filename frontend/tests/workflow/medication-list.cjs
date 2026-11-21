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
    const dirs = '1 capsule each morning'
    await page.route('**/medication-analysis', async route => {
      const body = route.request().postData()
      const form = JSON.parse(body.match(/name="form"\r\n\r\n(\{.+\})/)[1])
      const photo = form.photo_source_ids[0]
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
    await page.getByText('Check interactions and duplicate ingredients').click()
    await page.getByRole('button', { name: 'Run check' }).click()
    await page.getByText('Duplicate ingredients · Potential finding').waitFor()
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
    console.log('PASS scan → editable list → bulk selection and local check → copy and JSON handoff without storage or import')
  } finally { await browser.close() }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
