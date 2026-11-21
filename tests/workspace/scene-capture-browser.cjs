// Run with TEST_UI_URL, TEST_API_URL, MEDICATION_READER_DEMO_NURSE_TOKEN and optional CHROME_PATH.
// Use a synthetic FastAPI server without a provider key to exercise the real recoverable detector/scan failures.
const assert = require('node:assert/strict')
const path = require('node:path')
const { readFileSync } = require('node:fs')
const { randomUUID } = require('node:crypto')
const { chromium } = require('playwright')
const ui = process.env.TEST_UI_URL, api = process.env.TEST_API_URL, token = process.env.MEDICATION_READER_DEMO_NURSE_TOKEN
const oraclePhoto = process.env.SCENE_CAPTURE_ORACLE_PHOTO
assert.ok(ui && api && token, 'Set the synthetic frontend URL, backend URL and nurse token.')
async function request(route, data) {
  const response = await fetch(api + route, { method: data ? 'POST' : 'GET',
    headers: { 'X-Demo-Reviewer-Token': token, 'Content-Type': 'application/json' }, body: data && JSON.stringify(data) })
  if (!response.ok) throw new Error(await response.text())
  return response.json()
}
async function run() {
  const alias = 'Synthetic capture ' + randomUUID().slice(0, 8)
  let record = await request('/admissions', { patient_alias: alias })
  const route = '/admissions/' + record.id
  for (const [id, name] of [['clinic', 'Demo Slate'], ['ward', 'Demo Amber']]) {
    record = await request(route + '/actions', { revision: record.revision, request_id: randomUUID(), command: {
      action: 'add', entry: { source: { id, kind: 'prescription' }, name, wording: name },
    } })
  }
  const [rowId, siblingId] = Object.keys(record.rows)
  const sibling = structuredClone(record.rows[siblingId])
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH, headless: true })
  const page = await browser.newPage({ viewport: { width: 1280, height: 920 } })
  const errors = []
  try {
    page.setDefaultTimeout(12000)
    page.on('pageerror', e => errors.push(e.message))
    await page.goto(ui)
    await page.getByLabel('Staff token').fill(token)
    await page.getByRole('button', { name: 'Sign in', exact: true }).click()
    await page.locator('li').filter({ hasText: alias }).getByRole('button', { name: 'Open review' }).click()
    const panel = page.getByRole('region', { name: 'Whole-table photos' })
    async function openPanel() {
      if (!(await panel.isVisible())) await page.getByText('Review package photos and retakes', { exact: true }).click()
      await panel.waitFor()
    }
    await openPanel()
    const front = oraclePhoto || path.resolve(__dirname, '../ui/intake/table-front-orientation-6.jpg')
    const back = path.resolve(__dirname, '../ui/intake/table-reverse.png')
    const replacement = path.resolve(__dirname, '../../backend/tests/fixtures/package_regions/empty.png')
    async function verifyReplacementPreview(expectedFile) {
      const preview = panel.getByRole('img', { name: /Replacement item photo for/ })
      await preview.waitFor()
      const bytes = await preview.evaluate(async img =>
        Array.from(new Uint8Array(await (await fetch(img.src)).arrayBuffer())))
      assert.deepEqual(Buffer.from(bytes), readFileSync(expectedFile))
    }
    const button = name => panel.getByRole('button', { name, exact: true })
    async function saveClick(name) {
      const response = page.waitForResponse(r => r.url().endsWith(route + '/capture') && r.request().method() === 'POST')
      await button(name).click()
      const result = await response
      assert.equal(result.status(), 200, await result.text())
      return result.json()
    }
    async function upload(label, file) {
      const response = page.waitForResponse(r => r.url().endsWith(route + '/capture') && r.request().method() === 'POST')
      await panel.getByLabel(label, { exact: true }).setInputFiles(file)
      const result = await response
      assert.equal(result.status(), 200, await result.text())
      return result.json()
    }
    async function draw(side, from = [.12, .16], to = [.42, .49]) {
      const stage = panel.locator('[data-side="' + side + '"] .pl-stage')
      await stage.scrollIntoViewIfNeeded()
      const box = await stage.boundingBox()
      await page.mouse.move(box.x + from[0] * box.width, box.y + from[1] * box.height)
      await page.mouse.down()
      await page.mouse.move(box.x + to[0] * box.width, box.y + to[1] * box.height, { steps: 6 })
      await page.mouse.up()
    }
    record = await upload('Label-side original', front)
    assert.equal(record.capture.reverse, null)
    if (!oraclePhoto) {
      const detector = page.waitForResponse(r => r.url().endsWith('/capture/propose-regions'))
      await button('Suggest front regions').click()
      assert.equal((await detector).status(), 503)
      await panel.getByText(/Draw or adjust package regions manually/).waitFor()
    }
    await draw('front')
    // The oracle compares every cropped pixel to the first synthetic label (200 by 100).
    const side = panel.locator('[data-side="front"]')
    await side.getByText('Edit region coordinates').click()
    for (const [field, value] of Object.entries({ x: '0', y: '0', width: '0.25', height: '1' }))
      await side.getByLabel(field, { exact: true }).fill(value)
    await side.getByRole('button', { name: 'Resize region' }).click()
    record = await saveClick('Save regions and matches')
    const frontLink = record.capture.packages[0].front_regions[0]
    await button('Review front region ' + frontLink.region_id).click()
    await panel.getByLabel('Admission row', { exact: true }).selectOption(rowId)
    await panel.getByLabel('Documented name', { exact: true }).fill('Demo Slate')
    const scan = page.waitForResponse(r => r.url().endsWith('/medication-analysis'))
    await button('Scan selected label region').click()
    assert.equal((await scan).status(), oraclePhoto ? 200 : 503)
    assert.equal(await panel.getByLabel('Documented name').inputValue(), 'Demo Slate')
    if (oraclePhoto) {
      await panel.getByLabel('Name observed in this region').selectOption('Fictional A')
      assert.equal(await panel.getByLabel('Documented strength').inputValue(), '5 mg')
      assert.equal(await panel.getByLabel('Documented directions').inputValue(), 'Once each morning')
    } else await panel.getByLabel('Original wording or appearance').fill('Demo Slate synthetic label.')
    record = await saveClick('Link selected region to row')
    const itemId = record.rows[rowId].capture_item_id
    assert.equal(record.capture_rows[itemId], rowId)
    const firstSource = record.rows[rowId].entries.at(-1).source.id
    assert.equal(record.rows[rowId].entries.at(-1).photo.front_attributed, true)
    if (oraclePhoto) assert.deepEqual(record.rows[rowId].entries.at(-1).scan_fields.strength,
      { status: 'readable', value: '5 mg', evidence: { source_id: firstSource, item_id: 'selected' } })
    record = await upload('Reverse original (optional)', back)
    await draw('reverse')
    await button('Match package').click()
    record = await saveClick('Save regions and matches')
    assert.equal(record.capture.reverse_matches[0].status, 'confirmed')
    const reverseId = record.capture.reverse.attachment_id
    await page.getByRole('button', { name: 'Review package photos and retakes', exact: true }).click()
    await openPanel()
    await panel.getByText(/Paired with Back 1/).waitFor()
    await button('Review front region ' + frontLink.region_id).click()
    await panel.getByLabel('Targeted retake (same item and side)').setInputFiles(replacement)
    await verifyReplacementPreview(replacement)
    await panel.getByLabel('Documented name').fill('Demo Slate')
    await panel.getByLabel('Original wording or appearance').fill('Demo Slate replacement label.')
    await button('Save item retake').click()
    await panel.getByText('Item retake saved on ' + rowId + '.').waitFor()
    record = await request(route)
    assert.ok(record.rows[rowId].superseded.includes(firstSource))
    assert.equal(record.rows[rowId].capture_item_id, itemId)
    assert.deepEqual(record.rows[siblingId], sibling)
    await draw('front', [.55, .1], [.9, .6])
    record = await saveClick('Save regions and matches')
    const secondLink = record.capture.packages[1].front_regions[0]
    const reviewSecond = () => button('Review front region ' + secondLink.region_id).click()
    await reviewSecond()
    await panel.getByLabel('Region contains', { exact: true }).selectOption('appearance')
    record = await saveClick('Link selected region to row')
    const pending = Object.values(record.rows).find(r => r.package_id === record.capture.packages[1].id)
    assert.ok(pending.unknown && !pending.entries.length)
    assert.ok(!record.capture.reverse_matches.some(match => match.package_id === pending.package_id && match.status === 'confirmed'))
    const oldAppearance = record.capture.packages[1].items[0].evidence[0].source_id
    await reviewSecond()
    const appearanceRetake = path.resolve(__dirname, '../../backend/tests/fixtures/package_regions/clear.png')
    await panel.getByLabel('Targeted retake (same item and side)').setInputFiles(appearanceRetake)
    await verifyReplacementPreview(appearanceRetake)
    await panel.getByLabel('Original wording or appearance').fill('Synthetic round tablet')
    await button('Save item retake').click()
    await panel.getByText('Item retake saved on ' + pending.id + '.').waitFor()
    record = await request(route)
    assert.equal(record.rows[pending.id].capture_item_id, pending.capture_item_id)
    assert.ok(record.rows[pending.id].superseded.includes(oldAppearance))
    assert.equal(record.rows[pending.id].entries[0].photo.appearance, 'Synthetic round tablet')
    assert.equal(record.events.at(-1).replaces, oldAppearance)
    const selectRow = id => page.getByRole('navigation', { name: 'Medicines to review' })
      .getByRole('button').nth(Object.keys(record.rows).indexOf(id)).click()
    const compare = page.getByText('Compare pill appearance', { exact: true })
    await selectRow(pending.id)
    await compare.click()
    const observed = page.getByRole('img', { name: 'Matched crop of the observed item' })
    const matchesReplacement = await observed.evaluate(async (img, encoded) => {
      await img.decode()
      const expected = new Image()
      expected.src = 'data:image/png;base64,' + encoded
      await expected.decode()
      const scale = Math.min(1, 640 / Math.max(expected.naturalWidth, expected.naturalHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.round(expected.naturalWidth * scale)
      canvas.height = Math.round(expected.naturalHeight * scale)
      if (canvas.width !== img.naturalWidth || canvas.height !== img.naturalHeight) return false
      const context = canvas.getContext('2d')
      const pixels = image => {
        context.clearRect(0, 0, canvas.width, canvas.height)
        context.drawImage(image, 0, 0, canvas.width, canvas.height)
        return canvas.toDataURL()
      }
      return pixels(img) === pixels(expected)
    }, readFileSync(appearanceRetake).toString('base64'))
    assert.ok(matchesReplacement, 'Candidate comparison shows the selected replacement pixels')
    await page.getByLabel('Shape', { exact: true }).fill('round')
    const lookup = page.waitForResponse(r => r.url().endsWith('/pill-candidates') && r.request().method() === 'POST')
    await page.getByRole('button', { name: 'Refresh candidates' }).click()
    const response = await lookup
    assert.equal(response.status(), 200, await response.text())
    const replacementId = record.rows[pending.id].entries[0].source.id
    const payload = response.request().postDataJSON()
    assert.equal(payload.observation.row_id, pending.id)
    assert.deepEqual(payload.observation.crop, { source_id: replacementId, item_id: pending.id })
    assert.deepEqual(payload.observation.shape.evidence, payload.observation.crop)
    assert.deepEqual(payload.evidence.sources.map(source => source.id), [replacementId])
    assert.equal((await response.json()).status, 'unresolved')
    await selectRow(siblingId)
    await compare.waitFor({ state: 'detached' })
    // Add a separately sourced label on this bag, then move its region onto the neighboring label.
    await reviewSecond()
    await panel.getByLabel('Admission row', { exact: true }).selectOption('')
    await panel.getByLabel('Region contains', { exact: true }).selectOption('label')
    await panel.getByLabel('Documented name').fill('Synthetic Third')
    await panel.getByLabel('Original wording or appearance').fill('Synthetic Third label')
    record = await saveClick('Link selected region to row')
    const third = Object.values(record.rows).find(r => r.entries.some(e => e.name === 'Synthetic Third'))
    const stable = structuredClone(record.rows[rowId])
    await side.getByLabel('Region', { exact: true }).selectOption(secondLink.region_id)
    await side.getByText('Edit region coordinates').click()
    for (const [field, value] of Object.entries({ x: '0', y: '0', width: '0.25', height: '1' }))
      await side.getByLabel(field, { exact: true }).fill(value)
    await side.getByRole('button', { name: 'Resize region' }).click()
    record = await saveClick('Save regions and matches')
    assert.ok(record.rows[third.id].superseded.includes(third.entries[0].source.id))
    assert.deepEqual(record.rows[rowId], stable)
    // The same pixels on an opaque reverse cannot serve as pill evidence.
    const reverseLink = record.capture.reverse_matches[0].region
    await button('Review reverse region ' + reverseLink.region_id).click()
    await panel.getByLabel('Admission row', { exact: true }).selectOption('')
    await panel.getByLabel('Region contains', { exact: true }).selectOption('appearance')
    record = await saveClick('Link selected region to row')
    const reverseItem = record.capture.packages.flatMap(pkg => pkg.items).find(item =>
      item.evidence.some(e => e.kind === 'appearance' && e.region.region_id === reverseLink.region_id))
    const reverseRow = record.capture_rows[reverseItem.row_id]
    await selectRow(reverseRow)
    await compare.waitFor()
    const reverseSide = panel.locator('[data-side="reverse"]')
    await reverseSide.getByLabel('Region', { exact: true }).selectOption(reverseLink.region_id)
    await reverseSide.getByRole('button', { name: 'Mark opaque' }).click()
    record = await saveClick('Save regions and matches')
    await compare.waitFor({ state: 'detached' })
    record = await upload('Label-side original', replacement)
    assert.equal(record.capture.reverse.attachment_id, reverseId)
    assert.equal(record.capture.reverse_matches.length, 0)
    assert.deepEqual(record.rows[siblingId], sibling)
    assert.ok(record.rows[rowId].entries.some(e => e.source.id === 'clinic'))
    assert.equal(record.rows[rowId].verified, null)
    assert.deepEqual(errors, [])
    console.log(JSON.stringify({ encounter: record.id, rowId, siblingId, frontOnly: true,
      scan: oraclePhoto ? { fixtureName: 'Fictional A', strength: '5 mg', directions: 'Once each morning' }
        : { detector: 503, failurePreservedName: true }, confirmedReverse: true, itemRetakeSuperseded: true,
      replacementPreviewBytesMatched: true, manifestOnlyAppearanceRetake: pending.id, movedRegionSourceWithdrawn: true,
      candidateReplacementPixelsMatched: true, candidateCropSource: replacementId, opaqueComparisonWithdrawn: true,
      wholeRetakeClearedMatch: true, siblingUnchanged: true }))
  } catch (error) {
    console.error({ errors, capture: (await page.locator('[aria-label="Whole-table photos"]').allTextContents()).join('').slice(-1400) })
    throw error
  } finally { await browser.close() }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
