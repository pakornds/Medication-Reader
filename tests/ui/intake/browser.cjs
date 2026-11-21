// Run against Vite serving the repository root. INTAKE_API_ORIGIN enables real FastAPI round trip.
const { chromium } = require('playwright')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs/promises')

async function run(browser) {
  const base = process.env.INTAKE_URL || 'http://127.0.0.1:5180/tests/ui/intake/preview.html'
  const url = new URL(base)
  url.searchParams.set('retry', '1')
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: [] })
  const token = process.env.INTAKE_TEST_TOKEN || 'fixture-nurse'
  const backend = process.env.INTAKE_API_ORIGIN
  if (backend) {
    const created = await ctx.request.post(backend + '/admissions', {
      headers: {'X-Demo-Reviewer-Token': token}, data: {patient_alias: 'Synthetic rotated-label intake'},
    })
    assert.equal(created.status(), 201)
    const {id} = await created.json()
    await ctx.addInitScript(id => { window.fixtureCase = id }, id)
  }
  const page = await ctx.newPage()
  page.setDefaultTimeout(6500)
  const errors = []
  page.on('pageerror', e => errors.push(e.message))
  await page.goto(url.href)
  const field = name => page.getByLabel(name, { exact: true })
  const click = name => page.getByRole('button', { name, exact: true }).click()
  const open = name => page.getByText(name, { exact: true }).first().click()
  const submit = () => click('Review intake')
  const state = () => page.evaluate(() => window.intake.snapshot())
  await field('Medicine name or catalogue code').fill('Fictional')
  await click('Fictional A 5 mg tablet')
  let row = (await state()).manual_rows[0]
  assert.deepEqual([row.name, row.strength, row.form, row.selected_product.tpu, row.selected_product.release],
    ['Fictional A', '5 mg', 'tablet', 'TMT-demo', 'synthetic'])
  await page.locator('.intake-row > summary').click()
  await field('Documented directions').fill('Original written directions')
  await field('Medicine name or catalogue code').fill('Unlisted label')
  await click('Add as written')
  assert.equal((await state()).manual_rows[1].catalogue_id, null)

  const front = path.join(__dirname, 'table-front-orientation-6.jpg')
  const reverse = path.join(__dirname, 'table-reverse.png')
  const photo = (label, file) => field(label + ' · Choose file').setInputFiles(file)
  await photo('Photo 1 · Labels up', front)
  await page.waitForFunction(() => window.intake.snapshot().photos.length === 1)
  const frontOnly = await state()
  assert.equal(frontOnly.photos[0].exif_orientation, 6)
  assert.equal(await page.evaluate(() => window.intake.snapshot().photos[0].file.size), (await fs.stat(front)).size)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  if (process.env.INTAKE_SCREENSHOT) await page.screenshot({ path: process.env.INTAKE_SCREENSHOT, fullPage: true })
  const origSource = frontOnly.photos[0].source_id
  await submit()
  assert.match(await page.getByRole('alert').innerText(), /retry/)
  await submit()
  assert.equal(await page.evaluate(() => window.submissions[0].photos[0].source_id), origSource)

  await photo('Photo 2 · Reverse (optional)', reverse)
  await page.waitForFunction(() => window.intake.snapshot().photos.length === 2)
  await open('Patient or caregiver interview')
  await field('Patient-reported use').fill('ผู้ป่วยแจ้งว่ากินเฉพาะตอนเช้าและนำยามาเพียงบางส่วน')
  await field('Patient cannot recall the schedule').check()
  await open('Other source notes and facility details')
  await click('Add source')
  await field('Prior record unavailable').check()
  await field('Reason unavailable').fill('Synthetic clinic did not have the prior record')
  await click('Add source')
  const records = page.locator('.med-intake fieldset').filter({has:page.locator('legend')})
  const last = records.filter({has:page.getByText('Source 2', {exact:true})}).last()
  await last.getByLabel('Source attachment').selectOption(frontOnly.photos[0].attachment_id)
  await last.getByLabel('Facility, if known').fill('Synthetic clinic')
  await last.getByText('Facility contact details').click()
  await last.getByLabel('Institution address').fill('Synthetic street')
  await last.getByLabel('Institution phone').fill('02-xxx-0190')
  await open('Questions for the agent')
  await field('Question for review').fill('Which label is unreadable?')
  await submit()
  let v = await state()
  assert.equal(v.photos.length, 2)
  assert.equal(new Set(v.photos.map(p => p.source_id)).size, 2)
  assert.equal(v.patient_report[0].evidence.source_id, v.schedule_unknown_source_id)
  assert(!v.photos.some(p => p.source_id === v.schedule_unknown_source_id))
  assert(v.evidence.sources.some(s => s.availability === 'unavailable' && s.unavailable_reason))
  assert.equal(v.evidence.sources.find(s => s.organization_phone).organization_address, 'Synthetic street')
  assert.equal(v.other_source_notes.length, 0)
  assert.equal(v.question, 'Which label is unreadable?')

  {
    const link = await page.evaluate(async () => {
      const scene = window.editor.snapshot()
      const front = window.intake.snapshot().photos[0]
      if (scene.front.exif_orientation !== 6) throw new Error('Lost JPEG orientation')
      const image = new Image(); image.src = URL.createObjectURL(front.file)
      await image.decode(); URL.revokeObjectURL(image.src)
      if (image.naturalWidth !== 450 || image.naturalHeight !== 160) throw new Error('Incorrect display orientation')
      const bounds = [0.01, 0.34, 0.67].map(x => ({x, y: .05, width: .30, height: .85}))
      window.editor.addProposals('front', {...scene.front, bounds})
      const pkg = window.editor.snapshot().packages[0]
      return {...pkg.front_regions[0], package_id:pkg.id, source_id:front.source_id}
    })
    if (backend) {
      const pixels = await page.evaluate(async token => {
        const snapshot = window.intake.snapshot()
        const manifest = window.editor.snapshot()
        manifest.sources = snapshot.evidence.sources.filter(s => s.attachment_id)
        const path = '/fixture-api/admissions/' + snapshot.case_id + '/capture'
        const headers = {'X-Demo-Reviewer-Token': token}
        const data = new FormData()
        data.append('command', JSON.stringify({ revision: 1, request_id: 'fixture-save', manifest }))
        for (const photo of snapshot.photos) data.append(photo.kind === 'label_photo' ? 'front' : 'reverse', photo.file)
        const saved = await fetch(path, {method:'POST', headers, body:data})
        if (!saved.ok) throw new Error(await saved.text())
        const scene = (await saved.json()).capture
        const result = await fetch(path + '/region', {method:'POST', headers:{...headers,'Content-Type':'application/json'},
          body:JSON.stringify(scene.packages[0].front_regions[0])})
        if (!result.ok) throw new Error(await result.text())
        const crop = await createImageBitmap(await result.blob())
        const canvas = document.createElement('canvas')
        canvas.width = crop.width; canvas.height = crop.height
        const drawing = canvas.getContext('2d')
        drawing.drawImage(crop,0,0)
        return {width:crop.width, height:crop.height, color:[...drawing.getImageData(20,20,1,1).data]}
      }, token)
      assert(Math.abs(pixels.width - 135) <= 1 && Math.abs(pixels.height - 136) <= 1)
      assert(pixels.color[0] > 235 && pixels.color[2] < 240, 'First package color must survive EXIF orientation')
      console.log('PASS two unmodified originals saved through FastAPI; extracted EXIF-oriented first package', pixels)
    }
    await page.evaluate(link => window.intake.offerScan(link), link)
    await field('Existing medicine').selectOption(row.id)
    await click('Confirm link')
    v = await state()
    assert.equal(v.manual_rows.length, 2)
    assert.equal(v.manual_rows[0].scans[0].region_id, link.region_id)
    assert.equal(v.manual_rows[0].directions, 'Original written directions')
    await open('Additional photo or targeted retake')
    await page.locator('.med-intake').getByLabel('Package', {exact:true}).selectOption(link.package_id)
    await field('Retake view').selectOption('reverse')
    await photo('Item photo', reverse)
    await page.waitForFunction(() => window.intake.snapshot().photos.length === 3)
    assert.deepEqual((await state()).photos[2].target, {package_id:link.package_id, side:'reverse'})
    await photo('Photo 1 · Labels up', front)
    await page.waitForFunction(() => window.intake.snapshot().manual_rows[0].scans.length === 0)
    v = await state()
    assert.equal(v.manual_rows[0].directions, 'Original written directions')
    assert.notEqual(v.photos[0].source_id, origSource)
    assert.equal(v.manual_rows[0].superseded_scans[0].source_id, origSource)
    assert.equal(v.superseded_evidence[0].photo.source_id, origSource)
    assert.equal(v.superseded_evidence[0].sources.find(s => s.organization_phone)?.organization, 'Synthetic clinic')
    await assert.rejects(page.evaluate(({id, link}) => window.intake.confirmScan(id, link), {id: row.id, link}), /stale_link/)
    assert.equal(v.patient_report.length, 1)
  }

  await page.goto(base + '?lang=th')
  await field('ภาพ 1 · หงายฉลาก · เลือกไฟล์').setInputFiles(front)
  await page.waitForFunction(() => window.intake.snapshot().photos.length === 1)
  await click('ทบทวนข้อมูล')
  assert.equal(await page.evaluate(() => window.submissions[0].manual_rows.length), 0)
  assert.deepEqual(errors, [])
  await ctx.close()
  console.log('PASS manual, mixed-package photos, front only, sourced Thai interview, unavailable source, retry and Thai photo-only intake.')
}
;(async () => {
  const browser = await chromium.launch({executablePath:process.env.ADMISSION_CHROME || undefined})
  try { await run(browser) } finally { await browser.close() }
})().catch(e => {console.error(e); process.exitCode=1})
