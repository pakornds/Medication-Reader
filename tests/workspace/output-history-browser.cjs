/* Run with Vite and FastAPI serving the React app and its proxied routes.
   Set WORKSPACE_URL, ADMISSION_TEST_PHARMACIST, and optionally ADMISSION_CHROME. */
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { readFile } = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')

async function run() {
  const url = process.env.WORKSPACE_URL || 'http://127.0.0.1:5173'
  const token = process.env.ADMISSION_TEST_PHARMACIST
  assert.ok(token, 'Set ADMISSION_TEST_PHARMACIST for the local synthetic app.')
  const headers = { 'X-Demo-Reviewer-Token': token, 'Content-Type': 'application/json' }
  const json = async (route, body) => {
    const response = await fetch(url + route, { headers, method: body ? 'POST' : 'GET',
      body: body && JSON.stringify(body) })
    assert.ok(response.ok, route + ' returned ' + response.status)
    return response.json()
  }
  const alias = 'Synthetic Output ' + randomUUID().slice(0, 8)
  let encounter = await json('/admissions', { patient_alias: alias })
  const route = '/admissions/' + encounter.id
  const seed = async command => {
    encounter = await json(route + '/actions', { revision: encounter.revision, request_id: randomUUID(), command })
  }
  await seed({ action: 'add', entry: { source: { id: 'unresolved', kind: 'reviewer_record', reporter: 'Synthetic staff' },
    wording: 'A second item has an unreadable name.' } })
  await seed({ action: 'add', entry: { source: { id: 'script', kind: 'prescription', organization: 'Synthetic clinic' },
    wording: 'Demo Amber', name: 'Demo Amber' } })
  await seed({ action: 'link', row_id: 'item-2', confirmed: true, entry: { source: { id: 'patient', kind: 'patient_report' },
    wording: 'I take one tablet in the morning.' } })
  await seed({ action: 'interview', row_id: 'item-2', source_id: 'patient', ownership: 'patient',
    current_use: 'current', dose: 'one tablet', route: 'oral', schedule: 'morning' })
  await seed({ action: 'verify', row_id: 'item-2', source_id: 'patient' })
  await seed({ action: 'record_unavailable_source', source: { id: 'missing', kind: 'transfer_record',
    availability: 'unavailable', organization: 'Synthetic ward', contact: 'Synthetic liaison',
    unavailable_reason: 'Ward record has not arrived.' }, follow_up: 'Check the synthetic ward handoff.' })
  const fixtures = path.resolve(__dirname, '../../fixtures/package-capture')
  const imageDir = path.resolve(__dirname, '../ui/intake')
  const manifest = JSON.parse((await readFile(path.join(fixtures, 'two-photos.json'), 'utf8')).replaceAll('demo-two-photos', encounter.id))
  manifest.reverse.regions.push({ id: 'reverse-b', bounds: { x: .38, y: .08, width: .23, height: .34 } })
  const match = manifest.reverse_matches.find(m => m.package_id === 'package-b')
  match.status = 'confirmed'
  match.region.region_id = 'reverse-b'
  const form = new FormData()
  form.set('command', JSON.stringify({ manifest, revision: encounter.revision, request_id: randomUUID() }))
  form.set('front', new Blob([await readFile(path.join(imageDir, 'table-front-orientation-6.jpg'))], { type: 'image/jpeg' }), 'front.jpg')
  form.set('reverse', new Blob([await readFile(path.join(imageDir, 'table-reverse.png'))], { type: 'image/png' }), 'reverse.png')
  const capture = await fetch(url + route + '/capture', { method: 'POST', headers: { 'X-Demo-Reviewer-Token': token }, body: form })
  assert.equal(capture.status, 200)
  encounter = await capture.json()

  const browser = await chromium.launch({ headless: true, executablePath: process.env.ADMISSION_CHROME })
  try {
    const page = await browser.newPage()
    await page.goto(url + '/')
    await page.getByLabel('Staff token').fill(token)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByRole('listitem').filter({ hasText: alias }).getByRole('button', { name: 'Open review' }).click()
    await page.getByRole('link', { name: 'Go to import preview' }).click()
    const approved = page.getByRole('checkbox', { name: /Demo Amber/ })
    await approved.waitFor()
    assert.equal(await page.getByRole('checkbox').count(), 1)
    await page.getByRole('button', { name: 'Dated handoff / print', exact: true }).click()
    const handoff = page.getByRole('dialog', { name: 'Dated medication handoff' })
    await handoff.getByRole('heading', { name: 'Demo Amber', exact: true }).waitFor()
    await handoff.getByText('Identity unresolved', { exact: true }).first().waitFor()
    await handoff.getByText(/Synthetic clinic/).first().waitFor()
    const packagePhoto = handoff.getByRole('img', { name: 'Confirmed reverse package region · package-b · reverse-b' })
    await packagePhoto.waitFor()
    assert.ok(await packagePhoto.evaluate(image => image.complete && image.naturalWidth > 0))
    assert.equal(await handoff.locator('article').getByRole('img', { name: /Confirmed reverse package region/ }).count(), 0)
    await handoff.getByText(/Synthetic liaison.*Check the synthetic ward handoff/).waitFor()
    if (process.env.ADMISSION_EVIDENCE_DIR) {
      await packagePhoto.locator('..').screenshot({ path: path.join(process.env.ADMISSION_EVIDENCE_DIR, 'workspace-package-handoff.png') })
    }
    await handoff.getByRole('button', { name: 'Close', exact: true }).click()
    assert.equal((await json(route)).receipts.length, 0)

    // Let the real hospital commit, then drop the first response to exercise an uncertain result.
    const requests = []
    await page.route('**' + route + '/actions', async intercepted => {
      const input = intercepted.request().postDataJSON()
      if (input.command.action !== 'import') return intercepted.continue()
      requests.push(input)
      const response = await intercepted.fetch()
      assert.ok(response.ok())
      if (requests.length === 1) return intercepted.abort('failed')
      return intercepted.fulfill({ response })
    })
    await approved.check()
    const submit = page.getByRole('button', { name: 'Approve and import selected medicines', exact: true })
    await submit.click()
    await page.getByRole('alert').filter({ hasText: /Retry the same selection/i }).waitFor()
    assert.ok(await approved.isChecked())
    const historyKeys = () => page.evaluate(() =>
      Object.keys(localStorage).filter(key => key.startsWith('medication-reader:imported-at:')))
    assert.equal((await historyKeys()).length, 0)
    await submit.click()
    await page.getByRole('status').filter({ hasText: 'Import confirmed' }).waitFor()
    assert.equal(requests.length, 2)
    assert.deepEqual(requests[0], requests[1])
    const after = await json(route)
    assert.equal(after.receipts.length, 1)
    assert.deepEqual(after.receipts[0].imported_row_ids, ['item-2'])
    assert.deepEqual(after.rows['item-1'], encounter.rows['item-1'])
    const [key] = await historyKeys()
    const stamp = await page.evaluate(key => localStorage.getItem(key), key)
    assert.equal(key, 'medication-reader:imported-at:' + stamp)
    assert.equal(Date.parse(stamp), Date.parse(after.receipts[0].imported_at))
    await page.locator('header a[href="/history"]').click()
    await page.getByRole('button', { name: 'View receipt' }).click()
    await page.getByRole('heading', { name: 'Imported medicines · 1' }).waitFor()
    if (process.env.ADMISSION_EVIDENCE_DIR) {
      await page.screenshot({ path: path.join(process.env.ADMISSION_EVIDENCE_DIR, 'workspace-import-receipt.png') })
    }
    await page.getByRole('button', { name: 'Go to Review · Demo Amber', exact: true }).click()
    await page.waitForURL('**/new-patient/review*')
    await page.getByRole('navigation', { name: 'Medicines to review' }).locator('button[aria-current="true"]').filter({ hasText: '2. Demo Amber' }).waitFor()
    console.log('PASS · Real partial admission import, same-operation retry, pending row intact, printable handoff, UTC history and authorized receipt lookup. Imported item-2 at ' + stamp)
  } finally { await browser.close() }
}

run().catch(error => { console.error(error); process.exitCode = 1 })
