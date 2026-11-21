// Run against a dedicated synthetic backend. The two staff tokens must belong to that server.
// TEST_UI_URL=... TEST_API_URL=... MEDICATION_READER_DEMO_NURSE_TOKEN=... MEDICATION_READER_DEMO_REVIEWER_TOKEN=... node frontend/tests/workflow/connected.cjs
// Requires Playwright and Chromium. Set CHROME_PATH to use a local browser executable.
const assert = require('node:assert/strict')
const path = require('node:path')
const { chromium } = require('playwright')

const ui = process.env.TEST_UI_URL
const api = process.env.TEST_API_URL
const demo = process.env.TEST_DEMO_URL
const nurse = process.env.MEDICATION_READER_DEMO_NURSE_TOKEN
const pharmacy = process.env.MEDICATION_READER_DEMO_REVIEWER_TOKEN
assert.ok(demo || (ui && api && nurse && pharmacy), 'Set TEST_DEMO_URL for the local presenter, or configure the UI, API and staff tokens.')

const clinicalToken = token => ({ 'X-Demo-Reviewer-Token': token })
const assignedEncounter = async id => {
  const response = await fetch(api + '/admissions/' + encodeURIComponent(id), { headers: clinicalToken(pharmacy) })
  assert.equal(response.status, 200)
  return response.json()
}
const button = (page, name) => page.getByRole('button', { name, exact: true })
const label = (page, name) => page.getByLabel(name, { exact: true })
const routeLink = (page, pathname) => page.locator('a[href="' + pathname + '"]').filter({ visible: true }).first()
const signIn = async (page, token) => {
  await label(page, 'Staff token').fill(token)
  await button(page, 'Sign in').click()
  await button(page, 'Sign out').waitFor()
}
const stage = (page, name) => routeLink(page, '/new-patient/' + name).click()
const fitsWidth = page => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)

async function addDocumentedProduct(page, { separateSchedules = false } = {}) {
  await button(page, 'Enter medicine manually').click()
  const field = page.getByRole('combobox', { name: 'Product name or code' })
  await field.fill('117365')
  await page.getByRole('option').filter({ hasText: '117365' }).first().waitFor()
  await field.press('ArrowDown')
  await field.press('Enter')
  assert.match(await field.inputValue(), /ZOCOR/i)
  await label(page, 'Source wording or reference').fill('Synthetic transfer note lists ZOCOR; 21 tablets supplied.')
  const manual = page.locator('form').filter({ has: button(page, 'Add to draft') })
  await manual.locator('summary').filter({ hasText: 'Organization (if known)' }).click()
  await label(manual, 'Organization (if known)').fill('Synthetic transfer clinic')
  await manual.getByText('Facility contact details', { exact: true }).click()
  await manual.getByRole('combobox', { name: /^Facility type/ }).selectOption('clinic')
  await label(manual, 'Facility address').fill('100 Fictional Test Road')
  await label(manual, 'Facility phone').fill('02-000-0000')
  await label(page, 'Quantity prescribed (as written)').fill('21 tablets')
  await label(page, 'Directions as written or reported').fill('1 tablet each morning')
  await button(page, 'Fill fields from wording').click()
  await page.waitForFunction(() => document.querySelector('.directions-card input[type=number]')?.value === '1')
  assert.equal(await label(page, 'Dose unit').inputValue(), 'tablet')
  assert.equal(await label(page, 'Period unit').inputValue(), 'day')
  assert.equal(await button(page, 'Morning').getAttribute('aria-pressed'), 'true')
  await button(page, 'Add another set of directions').click()
  const second = page.locator('.directions-card').nth(1)
  await second.getByLabel('Directions source', { exact: true }).selectOption('patient_report')
  await second.getByLabel('Directions as written or reported', { exact: true }).fill(
    'I take 1 tablet by mouth each evening' + (separateSchedules ? ' and 2 tablets by mouth each morning' : ''))
  await second.getByRole('button', { name: 'Fill fields from wording' }).click()
  await page.waitForFunction(() => document.querySelectorAll('.directions-card')[1]?.querySelector('[aria-pressed=true]')?.textContent === 'Evening')
  await button(page, 'Add to draft').click()
  await page.locator('.draft-line').filter({ hasText: /ZOCOR/i }).waitFor()
}

// This path records an unreadable original through the staff UI. It works without a live OCR provider.
async function addUnreadablePhoto(page) {
  await button(page, 'Read photos or notes').click()
  const slot = page.getByRole('region', { name: 'Label side', exact: true })
  await slot.locator('input[type=file]').first().setInputFiles(path.resolve(__dirname, '../../../backend/tests/fixtures/package_regions/empty.png'))
  await slot.locator('.photo-marking summary').click()
  await button(slot, 'One package fills this entire photo').click()
  await page.getByText('Record what I can read', { exact: true }).click()
  await page.getByLabel('Keep identity unresolved').check()
  await button(page, 'Use this label in draft').click()
  await page.locator('.draft-line').filter({ hasText: 'Unidentified medicine' }).waitFor()
}

async function verifyProduct(page, rowId, { verifyFreeText = false, separateSchedules = false } = {}) {
  // Select the documented row even when the backend returns the unreadable row first.
  const identity = page.getByRole('button', { name: /ZOCOR/i }).filter({ visible: true })
  if (await identity.count()) await identity.first().click()
  const interview = page.locator('form').filter({ has: button(page, 'Save interview') })
  const source = interview.getByLabel('Interview source')
  const account = await source.locator('option').filter({ hasText: /I take 1 tablet by mouth each evening/ }).getAttribute('value')
  assert.ok(account, 'Intake retained the reported evening statement as a separate interview source.')
  await source.selectOption(account)
  await interview.getByLabel('Whose medicine?').selectOption('patient')
  await interview.getByLabel('Current use').selectOption('current')
  await interview.getByLabel('Actual dose').fill(separateSchedules ? '1 tablet evening, 2 tablets morning' : '1 tablet')
  await interview.getByLabel('Actual route').fill('oral')
  const actualSchedule = separateSchedules ? 'each evening and each morning' : 'each evening'
  await interview.getByLabel('Actual schedule').fill(actualSchedule)
  await interview.getByLabel('Reported reason for use').fill('Synthetic admission review')
  const interviewSaved = page.waitForResponse(r => r.url().endsWith('/actions') && r.request().postDataJSON()?.command.action === 'interview')
  await button(page, 'Save interview').click()
  const recorded = await interviewSaved
  assert.equal(recorded.status(), 200, await recorded.text())
  const verify = page.locator('form').filter({ has: button(page, 'Verify this medicine') })
  await verify.waitFor()
  const readback = verify.getByRole('region', { name: 'Verification readback' })
  const submit = async () => {
    const response = page.waitForResponse(r => r.url().endsWith('/actions') && r.request().postDataJSON()?.command.action === 'verify')
    await button(page, 'Verify this medicine').click()
    const saved = await response
    assert.equal(saved.status(), 200, await saved.text())
    return (await saved.json()).rows[rowId].verified
  }
  await verify.getByRole('heading', { name: 'Intake schedule suggestion' }).waitFor()
  await verify.getByRole('heading', { name: 'Intake product suggestion' }).waitFor()
  await readback.getByText('Catalogue product will remain unverified.').waitFor()
  await readback.getByText(/Directions recorded as free text only.*1 tablet.*oral.*each evening/).waitFor()
  assert.equal(await readback.locator('.regimen-readback').count(), 0)
  const identitySource = await label(verify, 'Supported medicine identity').inputValue()
  assert.match(await readback.innerText(), /Identity source.*ZOCOR[\s\S]*Current-use source.*Patient report/)
  if (verifyFreeText) {
    const ordinary = await submit()
    assert.equal(ordinary.regimens, undefined)
    assert.equal(ordinary.identity.normalized_medication_id, undefined)
    assert.equal(ordinary.answer.schedule, actualSchedule)
    assert.equal(ordinary.source_id, account)
    assert.equal(ordinary.identity.source_id, identitySource)
    await page.getByText('Directions recorded as free text only', { exact: true }).waitFor()
    await page.locator('summary').filter({ hasText: 'Verify actual use' }).click()
  }
  await button(verify, 'Use the schedule recorded from this interview').click()
  const first = verify.locator('.clinical-schedule').first()
  assert.equal(await button(first, 'Evening').getAttribute('aria-pressed'), 'true')
  await first.getByLabel('All directions are represented in these fields').check()
  if (separateSchedules) {
    const extra = verify.locator('.clinical-schedule').nth(1)
    assert.equal(await label(extra, 'Dose per use').inputValue(), '2')
    assert.equal(await button(extra, 'Morning').getAttribute('aria-pressed'), 'true')
    await label(extra, 'Dose unit').fill('tablets')
    assert.equal(await button(verify, 'Verify this medicine').isDisabled(), true)
    await label(extra, 'All directions are represented in these fields').check()
  }
  await verify.getByRole('button', { name: /Use the intake selection/ }).click()
  await readback.getByText(/TPU 117365/).waitFor()
  const previews = readback.locator('.regimen-readback')
  assert.equal(await previews.count(), separateSchedules ? 2 : 1)
  assert.match(await previews.first().innerText(), /Evening/)
  if (separateSchedules) assert.match(await previews.nth(1).innerText(), /2 tablets[\s\S]*Morning/)
  assert.ok(await fitsWidth(page))
  const verified = await submit()
  assert.equal(verified.answer.current_use, 'current')
  assert.equal(verified.regimens.length, separateSchedules ? 2 : 1)
  const [confirmed] = verified.regimens
  assert.equal(confirmed.basis, 'verified')
  assert.equal(confirmed.evidence.directions_text.source_id, account)
  assert.deepEqual(confirmed.time_of_day, ['evening'])
  assert.equal(verified.identity.normalized_medication_id, '117365')
  assert.equal(verified.identity.source_id, identitySource)
  if (separateSchedules) {
    assert.deepEqual(verified.regimens[1].time_of_day, ['morning'])
    assert.equal(verified.regimens[1].dose_amount, 2)
    assert.equal(verified.regimens[1].evidence.directions_text.source_id, account)
  }
  await verify.waitFor({ state: 'hidden' })
}

async function verificationReadback(browser) {
  for (const width of [1280, 390]) {
    const page = await browser.newPage({ viewport: { width, height: 844 }, isMobile: width < 500, hasTouch: width < 500 })
    await page.goto(ui + '/new-patient/input')
    await addDocumentedProduct(page, { separateSchedules: true })
    await stage(page, 'review')
    await signIn(page, pharmacy)
    const stored = page.waitForResponse(r => r.url().endsWith('/admissions/intake') && r.request().method() === 'POST')
    await button(page, 'Save draft and open clinical review').click()
    const response = await stored
    assert.equal(response.status(), 200, await response.text())
    const [known] = Object.values((await response.json()).rows)
    await verifyProduct(page, known.id, { verifyFreeText: true, separateSchedules: true })
    if (width === 1280) {
      await page.locator('summary').filter({ hasText: 'Verify actual use' }).click()
      const verify = page.locator('form').filter({ has: button(page, 'Verify this medicine') })
      await verify.getByLabel('Verify a structured dosing schedule').uncheck()
      await verify.getByLabel('Confirm an exact TMT product').uncheck()
      const reverified = page.waitForResponse(r =>
        r.url().endsWith('/actions') && r.request().postDataJSON()?.command.action === 'verify')
      await button(verify, 'Verify this medicine').click()
      const saved = await reverified
      assert.equal(saved.status(), 200, await saved.text())
      assert.equal((await saved.json()).rows[known.id].verified.regimens, undefined)
      await stage(page, 'output')
      await page.getByRole('checkbox', { name: /ZOCOR/i }).check()
      await button(page, 'Approve and import selected medicines').click()
      await page.getByRole('heading', { name: 'Import confirmed' }).waitFor()
      await routeLink(page, '/history').click()
      await button(page, 'View receipt').click()
      await page.getByText('Directions recorded as free text only', { exact: true }).waitFor()
      await page.getByText('each evening and each morning', { exact: true }).waitFor()
      assert.equal(await page.locator('.regimen-readback').count(), 0)
    }
    await page.close()
  }
}

async function assertReceiptHistory(page, expected, canRead) {
  await page.getByRole('button', { name: 'View receipt', exact: true }).click()
  if (canRead) {
    await page.getByText(expected, { exact: true }).last().waitFor()
    assert.match(await page.locator('.regimen-readback').innerText(), /Verified[\s\S]*Evening/)
    await page.getByText(/TPU 117365/).waitFor()
    await page.getByText('Synthetic transfer clinic', { exact: true }).click()
    await page.getByText('100 Fictional Test Road', { exact: true }).waitFor()
    await page.getByText('02-000-0000', { exact: true }).waitFor()
    assert.equal(await page.getByText('Unidentified medicine', { exact: true }).count(), 0)
  } else {
    await page.getByText('Sign in as the assigned pharmacist to open the hospital receipt.').waitFor()
    assert.equal(await page.getByText(expected, { exact: true }).count(), 0)
  }
}

async function workflow(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } })
  const page = await context.newPage()
  page.setDefaultTimeout(12000)
  const pageErrors = []
  const optionalChecks = []
  page.on('pageerror', error => pageErrors.push(error.message))
  page.on('request', req => {
    if (req.method() === 'POST' && /(\/checks(?:\/local)?$|\/review-reports\/)/.test(new URL(req.url()).pathname)) optionalChecks.push(req.url())
  })
  page.on('dialog', dialog => dialog.accept())
  await page.goto(ui + '/')
  await routeLink(page, '/new-patient').click()
  await addDocumentedProduct(page)
  await addUnreadablePhoto(page)
  await stage(page, 'review')
  const documented = page.locator('article').filter({ hasText: /ZOCOR/i })
  await documented.locator('.medicine-source > summary').click()
  const schedules = documented.locator('.regimen-readback')
  await schedules.nth(1).waitFor()
  assert.match(await schedules.nth(0).innerText(), /Documented[\s\S]*Morning/)
  assert.match(await schedules.nth(1).innerText(), /Reported[\s\S]*Evening/)
  assert.match(await documented.innerText(), /21 tablets/)
  await signIn(page, nurse)
  const stored = page.waitForResponse(r => r.url().endsWith('/admissions/intake') && r.request().method() === 'POST')
  await button(page, 'Save draft and open clinical review').click()
  const saved = await stored
  assert.equal(saved.status(), 200, await saved.text())
  const initial = await saved.json()
  const rows = Object.values(initial.rows)
  assert.equal(rows.length, 2)
  const known = rows.find(r => !r.unknown), unknown = rows.find(r => r.unknown)
  assert.ok(known && unknown)
  assert.equal(known.intake.regimens.length, 2)
  assert.equal(known.intake_catalogue.product.tpu, '117365')
  assert.ok(unknown.entries.some(e => e.photo && e.source.kind === 'label_photo'))
  assert.equal(initial.intake_attachments.length, 1)
  await verifyProduct(page, known.id)
  await button(page, 'Dated handoff / print').click()
  const preview = page.getByRole('dialog', { name: 'Dated medication handoff' })
  await preview.getByText('Identity unresolved', { exact: true }).waitFor()
  assert.equal(await preview.getByRole('button', { name: 'Print handoff' }).isEnabled(), true)
  assert.match(await preview.innerText(), /ZOCOR/i)
  await preview.getByRole('button', { name: 'Close' }).click()
  await stage(page, 'output')
  assert.equal(await button(page, 'Approve and import selected medicines').isDisabled(), true)
  await button(page, 'Sign out').click()
  await routeLink(page, '/').click()
  await signIn(page.locator('.staff-desk'), pharmacy)
  await page.locator('.staff-queue li').filter({ hasText: initial.patient_alias }).getByRole('button').click()
  await stage(page, 'output')
  const ready = page.getByRole('checkbox', { name: /ZOCOR/i })
  await ready.check()
  assert.match(await page.locator('.regimen-readback').innerText(), /Verified[\s\S]*Evening/)
  await page.setViewportSize({ width: 390, height: 844 })
  assert.ok(await fitsWidth(page), 'The populated import page fits a phone viewport.')
  await page.setViewportSize({ width: 1280, height: 900 })
  assert.equal(await page.getByRole('checkbox').count(), 1)
  const requests = []
  // Deliver the first write to the real hospital, then lose the response before it reaches React.
  await page.route('**/admissions/*/actions', async route => {
    const payload = route.request().postDataJSON()
    assert.equal(payload.command.action, 'import')
    requests.push(payload)
    if (requests.length === 1) {
      assert.equal((await route.fetch()).status(), 200)
      await route.abort('failed')
    } else await route.continue()
  })
  await button(page, 'Approve and import selected medicines').click()
  await page.getByText('Import could not be confirmed. Retry the same selection.').waitFor()
  await button(page, 'Approve and import selected medicines').click()
  await page.getByRole('heading', { name: 'Import confirmed' }).waitFor()
  assert.deepEqual(requests[0], requests[1])
  await page.unroute('**/admissions/*/actions')
  const final = await assignedEncounter(initial.id)
  assert.equal(final.receipts.length, 1)
  assert.deepEqual(final.receipts[0].imported_row_ids, [known.id])
  assert.equal(final.rows[unknown.id].verified, null)
  assert.equal(final.rows[unknown.id].imported_at, undefined)
  const storage = await page.evaluate(() => Object.entries(localStorage))
  assert.equal(storage.length, 1, 'Only the successful timestamp was saved in browser storage.')
  const [key, stamp] = storage[0]
  assert.match(stamp, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/)
  assert.equal(key, 'medication-reader:imported-at:' + stamp)
  await routeLink(page, '/history').click()
  await assertReceiptHistory(page, final.rows[known.id].verified.identity.name, true)
  await page.reload()
  await assertReceiptHistory(page, final.rows[known.id].verified.identity.name, false)
  await signIn(page, pharmacy)
  await page.getByText(final.rows[known.id].verified.identity.name, { exact: true }).last().waitFor()
  assert.deepEqual(pageErrors, [])
  assert.deepEqual(optionalChecks, [], 'Optional screening must not gate clinical review or import.')
  await context.close()
}

async function mobile(browser) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true })
  const page = await ctx.newPage()
  await page.goto(ui + '/new-patient/input')
  await button(page, 'Switch to Thai').click()
  await button(page, 'ใช้ธีมมืด').click()
  await button(page, 'กรอกยาเอง').click()
  const product = page.getByRole('combobox', { name: 'ชื่อผลิตภัณฑ์หรือรหัสยา' })
  await product.fill('117365')
  await page.getByRole('option').filter({ hasText: '117365' }).first().tap()
  assert.match(await product.inputValue(), /ZOCOR/i)
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), 'dark')
  for (const [stagePath, heading] of [['/new-patient/review','ทบทวน'], ['/new-patient/output','ผลลัพธ์'], ['/history','ประวัติ']]) {
    await routeLink(page, stagePath).tap()
    await page.getByRole('heading', { name: heading, exact: true }).waitFor()
    assert.ok(await fitsWidth(page), stagePath)
  }
  await ctx.close()
}

async function namedPhoto(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1050, height: 800 } })
  const page = await ctx.newPage()
  page.setDefaultTimeout(10000)
  await page.goto(ui + '/new-patient/input')
  const result = await fetch(api + '/checks/local/products?q=117365')
  assert.equal(result.status, 200)
  const product = (await result.json()).products.find(p => p.tpu === '117365')
  const photo = await page.evaluate(name => {
    const canvas = document.createElement('canvas')
    canvas.width = 1200; canvas.height = 180
    const surface = canvas.getContext('2d')
    surface.fillStyle = '#fff'; surface.fillRect(0, 0, canvas.width, canvas.height)
    surface.fillStyle = '#111'; surface.font = '22px sans-serif'
    surface.fillText('Synthetic catalogue comparison fixture', 20, 55)
    surface.fillText(name, 20, 110)
    return canvas.toDataURL('image/png').split(',')[1]
  }, product.label)
  const front = page.getByRole('region', { name: 'Label side', exact: true })
  await front.locator('input[type=file]').first().setInputFiles({
    name: 'synthetic-label.png', mimeType: 'image/png', buffer: Buffer.from(photo, 'base64'),
  })
  await front.locator('.photo-marking summary').click()
  await button(front, 'One package fills this entire photo').click()
  await page.getByText('Record what I can read', { exact: true }).click()
  await label(page, 'Name as written').fill(product.label)
  await button(page, 'Use this label in draft').click()
  await stage(page, 'review')
  const compare = page.locator('.scan-catalogue')
  await compare.locator('summary').click()
  const picker = label(compare, 'Observed name or TPU code')
  assert.equal(await picker.inputValue(), product.label)
  const compareWith = async code => {
    await picker.fill(code)
    await compare.getByText('TPU ' + code, { exact: true }).waitFor()
  }
  await compareWith('1044462')
  const nameWarning = compare.getByText(/The observed name does not appear/)
  await nameWarning.waitFor()
  assert.equal(await page.getByRole('heading', { name: product.label }).count(), 1)
  await compareWith('117365')
  assert.equal(await nameWarning.count(), 0, 'An exact observed and catalogue name should agree.')
  await button(compare, 'Confirm this catalogue product').click()
  await button(page, 'Remove catalogue selection').click()
  assert.equal(await page.getByRole('heading', { name: product.label }).count(), 1)
  await signIn(page, nurse)
  async function save() {
    const saved = page.waitForResponse(r => r.url().endsWith('/admissions/intake') && r.request().method() === 'POST')
    await page.getByRole('button', { name: /^(Save draft and open clinical review|Save revised draft)$/ }).click()
    const response = await saved
    assert.equal(response.status(), 200, await response.text())
    return response.json()
  }
  async function editSavedDraft() {
    await page.getByText('Intake draft and source evidence', { exact: true }).click()
    await compare.locator('summary').click()
  }
  const cleared = await save()
  assert.equal(Object.values((await assignedEncounter(cleared.id)).rows)[0].intake_catalogue, null)
  await editSavedDraft()
  await compareWith('1044462')
  await button(compare, 'Confirm this catalogue product').click()
  await save()
  assert.equal(Object.values((await assignedEncounter(cleared.id)).rows)[0].intake_catalogue.product.tpu, '1044462')
  await editSavedDraft()
  await compareWith('117365')
  await button(compare, 'Replace confirmed TPU 1044462').click()
  const encounter = await save(), [row] = Object.values((await assignedEncounter(cleared.id)).rows)
  assert.equal(row.intake_catalogue.product.tpu, '117365')
  assert.equal(row.intake.observed_names[0].value, product.label)
  assert.ok(row.entries.some(e => e.photo && e.source.kind === 'label_photo' && e.name === product.label))
  assert.equal(row.verified, null)
  await label(page, 'Original interview wording').fill('This medicine is mine. I stopped taking it.')
  await label(page, 'Whose medicine?').selectOption('patient')
  await label(page, 'Current use').selectOption('reported_stopped')
  await button(page, 'Save interview').click()
  const verify = page.locator('form').filter({ has: button(page, 'Verify this medicine') })
  await verify.getByLabel('Confirm an exact TMT product').check()
  await verify.getByRole('combobox', { name: 'Product name or code' }).fill('1044462')
  await verify.getByRole('option').filter({ hasText: 'TPU 1044462' }).click()
  const nextVerify = () => page.waitForResponse(r =>
    r.url().endsWith('/actions') && r.request().postDataJSON()?.command.action === 'verify')
  const rejection = nextVerify()
  await button(verify, 'Verify this medicine').click()
  const rejected = await rejection
  assert.equal(rejected.status(), 422)
  assert.equal((await assignedEncounter(encounter.id)).rows[row.id].verified, null)
  await verify.getByRole('button', { name: /Use the intake selection/ }).click()
  const acceptance = nextVerify()
  await button(verify, 'Verify this medicine').click()
  const accepted = await acceptance
  assert.equal(accepted.status(), 200, await accepted.text())
  assert.equal((await accepted.json()).rows[row.id].verified.identity.normalized_medication_id, '117365')
  await ctx.close()
}

// Run independently with TEST_DEMO_URL pointing to the loopback presenter proxy.
async function presenter(browser) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 820 } })
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('request', request => {
    if (new URL(request.url()).pathname.startsWith('/admissions')) {
      assert.equal(request.headers()['x-demo-reviewer-token'], undefined, 'The browser must not receive the demo credential.')
    }
  })
  async function noLogin() {
    assert.equal(await label(page, 'Staff token').count(), 0)
    assert.equal(await button(page, 'Sign in').count(), 0)
  }
  await page.goto(demo)
  await page.getByRole('heading', { name: 'Assigned encounters' }).waitFor()
  await noLogin()
  await routeLink(page, '/new-patient').click()
  await noLogin()
  await addDocumentedProduct(page)
  await button(page, 'Read photos or notes').click()
  const front = page.getByRole('region', { name: 'Label side', exact: true })
  await front.locator('input[type=file]').first().setInputFiles(path.resolve(__dirname, '../../../backend/tests/fixtures/package_regions/empty.png'))
  // Keep model nondeterminism and real images out of this staff navigation regression.
  await page.route('**/medication-analysis', async route => {
    const form = await new Response(route.request().postDataBuffer(), {
      headers: { 'content-type': route.request().headers()['content-type'] },
    }).formData()
    const metadata = JSON.parse(form.get('form'))
    const item = 'fixture-location', ref = { source_id: item, item_id: item }
    await route.fulfill({ json: { case_id: metadata.evidence.case_id,
      located_regions: [{ attachment_id: metadata.scene_photo_ids[0], ...ref, row_id: item, bounds: { x: 0, y: 0, width: 1, height: 1 } }],
      rows: [{ id: item, identity_status: 'unreadable', unknown_label: 'Unreadable fixture label', observed_names: [], sources: [ref] }],
    } })
  })
  await button(page, 'Analyze evidence').click()
  await page.getByRole('heading', { name: 'Unreadable fixture label' }).waitFor()
  await stage(page, 'review')
  await noLogin()
  await page.getByRole('checkbox', { name: 'Unreadable fixture label' }).check()
  await button(page, 'Add selected to draft').click()
  const stored = page.waitForResponse(r => r.url().endsWith('/admissions/intake') && r.request().method() === 'POST')
  await button(page, 'Save draft and open clinical review').click()
  const response = await stored
  assert.equal(response.status(), 200, await response.text())
  const encounter = await response.json()
  const [unknown, known] = [true, false].map(value => Object.values(encounter.rows).find(row => row.unknown === value))
  assert.ok(unknown && known)
  assert.equal(unknown.verified, null)
  assert.equal(known.verified, null)
  await verifyProduct(page, known.id)
  await stage(page, 'output')
  await noLogin()
  const ready = page.getByRole('checkbox', { name: /ZOCOR/i })
  await ready.check()
  assert.equal(await page.getByRole('checkbox').count(), 1, 'The unresolved item stays outside the selection.')
  await button(page, 'Approve and import selected medicines').click()
  await page.getByRole('heading', { name: 'Import confirmed' }).waitFor()
  await routeLink(page, '/history').click()
  await noLogin()
  await button(page, 'View receipt').click()
  await page.getByText(/TPU 117365/).waitFor()
  assert.deepEqual(errors, [])
  await page.close()
}

;(async () => {
  const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {})
  try {
    if (demo) {
      await presenter(browser)
      console.log('PASS loopback presenter: pending scan in Review, pharmacist verification, final import, and receipt with no staff token in the browser.')
      return
    }
    if (process.argv.includes('--scan-catalogue')) {
      await namedPhoto(browser)
      console.log('PASS scan catalogue confirmation, removal, replacement and independent clinical readback.')
      return
    }
    if (process.argv.includes('--verification')) {
      await verificationReadback(browser)
      await namedPhoto(browser)
      console.log('PASS desktop and phone verification readback, separate schedules, and conflicting catalogue rejection.')
      return
    }
    await workflow(browser)
    await mobile(browser)
    await namedPhoto(browser)
    console.log('PASS normal React staff routes: real TMT and regimen parser, located unreadable photo, admission handoff, nurse verification, pharmacist import retry, server receipt, signed-out reload, Thai mobile and dark theme.')
  } finally { await browser.close() }
})().catch(error => { console.error(error); process.exitCode = 1 })
