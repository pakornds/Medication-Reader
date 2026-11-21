// Run against Vite's staff workspace and a dedicated synthetic FastAPI backend.
// TEST_UI_URL=... TEST_API_URL=... MEDICATION_READER_DEMO_REVIEWER_TOKEN=... node frontend/tests/workflow/output-receipt.cjs
// Requires Playwright and Chromium. Set CHROME_PATH to select a local Chrome executable.
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { chromium } = require('playwright')

const { TEST_UI_URL: ui, TEST_API_URL: api, MEDICATION_READER_DEMO_REVIEWER_TOKEN: token } = process.env
assert.ok(ui && api && token, 'Configure the staff workspace, synthetic API and pharmacist token.')

async function json(path, body) {
  const response = await fetch(api + path, {
    headers: { 'X-Demo-Reviewer-Token': token, 'Content-Type': 'application/json' },
    method: body ? 'POST' : 'GET',
    body: body && JSON.stringify(body),
  })
  assert.ok(response.ok, await response.clone().text())
  return response.json()
}

async function seedEncounter() {
  let encounter = await json('/admissions', { patient_alias: 'Synthetic receipt ' + randomUUID().slice(0, 8) })
  const actions = [
    { action: 'add', entry: { source: { id: 'unresolved', kind: 'reviewer_record' }, wording: 'Unreadable name' } },
    { action: 'add', entry: { source: { id: 'prescription', kind: 'prescription' }, wording: 'Demo Amber', name: 'Demo Amber' } },
    { action: 'link', row_id: 'item-2', confirmed: true, entry: { source: { id: 'patient', kind: 'patient_report' }, wording: 'I stopped taking it.' } },
    { action: 'interview', row_id: 'item-2', source_id: 'patient', ownership: 'patient', current_use: 'reported_stopped' },
    { action: 'verify', row_id: 'item-2', source_id: 'patient' },
  ]
  for (const command of actions) {
    encounter = await json('/admissions/' + encounter.id + '/actions', {
      revision: encounter.revision, request_id: randomUUID(), command,
    })
  }
  return encounter
}

const exact = (page, role, name) => page.getByRole(role, { name, exact: true })
const link = (page, path) => page.locator('a[href="' + path + '"]').filter({ visible: true }).first()

async function assertOutcome(page, timestamp) {
  const status = page.getByRole('status').filter({ has: exact(page, 'heading', 'Import confirmed') })
  await status.getByText('Medicines on receipt · 1', { exact: false }).waitFor()
  assert.equal(await status.locator('time').getAttribute('datetime'), timestamp)
  const imported = exact(page, 'heading', 'Imported medicines · 1').locator('..')
  const pending = exact(page, 'heading', 'Pending medicines · 1').locator('..')
  await imported.getByText('Demo Amber', { exact: true }).waitFor()
  await pending.getByText(/Medicine identity unresolved/).waitFor()
  assert.equal(await pending.getByText('Demo Amber', { exact: true }).count(), 0)
  assert.equal(await exact(page, 'button', 'Approve and import selected medicines').count(), 0)
  assert.equal(await page.getByText('Selected medicines', { exact: true }).count(), 0)
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth))
}

async function exercise(browser, phone) {
  const page = await browser.newPage({
    viewport: phone ? { width: 390, height: 844 } : { width: 1280, height: 900 },
    isMobile: phone,
    hasTouch: phone,
  })
  try {
    const encounter = await seedEncounter()
    const encounterPath = '/admissions/' + encounter.id
    await page.goto(ui + '/')
    const staffToken = page.getByLabel('Staff token')
    if (await staffToken.isVisible()) {
      await staffToken.fill(token)
      await exact(page, 'button', 'Sign in').click()
    }
    await page.getByRole('listitem').filter({ hasText: encounter.patient_alias })
      .getByRole('button', { name: 'Open review' }).click()
    await link(page, '/new-patient/output').click()
    const selected = page.getByRole('checkbox', { name: /Demo Amber/ })
    await selected.check()
    assert.equal(await page.getByRole('checkbox').count(), 1)

    const requests = []
    if (phone) await page.route('**' + encounterPath + '/actions', async route => {
      requests.push(route.request().postDataJSON())
      const response = await route.fetch()
      assert.equal(response.status(), 200)
      // Commit the first write at the real hospital before dropping the response.
      if (requests.length === 1) await route.abort('failed')
      else await route.fulfill({ response })
    })
    const approve = exact(page, 'button', 'Approve and import selected medicines')
    await approve.click()
    if (phone) {
      await page.getByRole('alert').filter({ hasText: /Retry the same selection/ }).waitFor()
      assert.ok(await selected.isChecked())
      assert.equal(await page.evaluate(() => localStorage.length), 0)
      await approve.click()
    }
    await exact(page, 'heading', 'Import confirmed').waitFor()
    if (phone) {
      assert.equal(requests.length, 2)
      assert.deepEqual(requests[0], requests[1])
    }
    const recorded = await json(encounterPath)
    assert.equal(recorded.receipts.length, 1)
    const [receipt] = recorded.receipts
    assert.deepEqual(receipt.imported_row_ids, ['item-2'])
    assert.equal(recorded.rows['item-2'].imported_at, receipt.imported_at)
    assert.deepEqual(recorded.rows['item-1'], encounter.rows['item-1'])
    await assertOutcome(page, receipt.imported_at)

    const storage = await page.evaluate(() => Object.entries(localStorage))
    assert.equal(storage.length, 1)
    const [[key, stamp]] = storage
    assert.equal(key, 'medication-reader:imported-at:' + stamp)
    assert.equal(Date.parse(stamp), Date.parse(receipt.imported_at))

    await exact(page, 'link', 'Open import history').click()
    await exact(page, 'button', 'View receipt').click()
    await exact(page, 'heading', 'Imported medicines · 1').waitFor()
    await page.getByText('Demo Amber', { exact: true }).waitFor()
    await link(page, '/').click()
    await page.getByRole('listitem').filter({ hasText: encounter.patient_alias })
      .getByRole('button', { name: 'Open review' }).click()
    await link(page, '/new-patient/output').click()
    await assertOutcome(page, receipt.imported_at)
  } finally {
    await page.close()
  }
}

;(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH })
  try {
    await exercise(browser, false)
    await exercise(browser, true)
    console.log('PASS Output receipts: desktop approval and phone retry, one imported and one pending after reopening.')
  } finally {
    await browser.close()
  }
})().catch(error => { console.error(error); process.exitCode = 1 })
