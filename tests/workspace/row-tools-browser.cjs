// Run against the local React and FastAPI servers using a synthetic doctor account.
const assert = require('node:assert/strict')
const { randomUUID } = require('node:crypto')
const { readFile } = require('node:fs/promises')
const path = require('node:path')
const { chromium } = require('playwright')

async function run() {
  const { TEST_UI_URL: ui, TEST_API_URL: api, MEDICATION_READER_DEMO_DOCTOR_TOKEN: token } = process.env
  assert.ok(ui && api && token)
  const headers = { 'X-Demo-Reviewer-Token': token, 'Content-Type': 'application/json' }
  const post = async (route, data) => {
    const result = await fetch(api + route, { method: 'POST', headers, body: JSON.stringify(data) })
    assert.ok(result.ok, route + ' HTTP ' + result.status)
    return result.json()
  }
  const alias = 'Synthetic row tools ' + randomUUID().slice(0, 8)
  const initial = await post('/admissions', { patient_alias: alias })
  const route = '/admissions/' + initial.id
  const image = await readFile(path.join(__dirname, '../../backend/tests/fixtures/ai/reverse-crop.png'))
  const seeded = await post(route + '/actions', { revision: initial.revision, request_id: randomUUID(), command: {
    action: 'add', entry: {
      source: { id: 'appearance', kind: 'reverse_photo', attachment_id: 'synthetic-reverse' },
      wording: 'Round loose item in Bag A', photo: { data: image.toString('base64'), media_type: 'image/png',
        bag: 'A', appearance: 'round', pairing: 'matched', region: [0, 0, 1, 1] },
    },
  } })
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH })
  try {
    const page = await browser.newPage()
    await page.goto(ui)
    await page.getByLabel('Staff token').fill(token)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.getByRole('listitem').filter({ hasText: alias }).getByRole('button', { name: 'Open review' }).click()
    await page.getByText('Compare pill appearance', { exact: true }).click()
    await page.getByRole('img', { name: 'Matched crop of the observed item' }).waitFor()
    await page.getByLabel('Shape', { exact: true }).fill('round')
    const comparison = page.waitForResponse(r => r.url().endsWith('/pill-candidates') && r.request().method() === 'POST')
    await page.getByRole('button', { name: 'Refresh candidates' }).click()
    const candidates = await (await comparison).json()
    assert.equal(candidates.status, 'unresolved')
    assert.equal(candidates.row_id, Object.keys(seeded.rows)[0])
    await page.getByText('Record an unavailable source', { exact: true }).click()
    const form = page.locator('form').filter({ has: page.getByRole('button', { name: 'Save source follow-up' }) })
    await form.getByLabel('Department or ward').fill('Synthetic Ward A')
    await form.getByLabel('Reason unavailable').fill('Records desk closed')
    await form.getByLabel('Follow-up', { exact: true }).fill('Request ward list tomorrow')
    await form.getByRole('button').click()
    await page.getByText(/Outstanding source records/).click()
    await page.getByText(/Request ward list tomorrow/).waitFor()
    await page.getByText('Optional medication checks', { exact: true }).click()
    await page.getByText('Simulated DDI / DRP coverage', { exact: true }).click()
    for (const kind of ['DDI', 'DRP']) {
      await page.getByRole('button', { name: 'Run simulated ' + kind, exact: true }).click()
      await page.getByRole('heading', { name: new RegExp('^' + kind + ' ·') }).waitFor()
    }
    assert.equal(await page.getByRole('heading', { name: /^DDI ·/ }).count(), 1)
    const current = await (await fetch(api + route, { headers })).json()
    assert.equal(Object.values(current.rows)[0].verified, null)
    assert.equal(Object.values(current.unavailable_sources)[0].follow_up, 'Request ward list tomorrow')
    console.log(JSON.stringify({ candidateStatus: candidates.status, reports: ['DDI', 'DRP'],
      wardFollowUp: 'Request ward list tomorrow', verified: false }))
  } finally { await browser.close() }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
