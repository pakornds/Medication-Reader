// Runs inside the synthetic two-label intake scenario against the actual React Review route.
export async function checkScanCatalogue({ frame, manualOrder, scannedOrder, expect, assert, type }) {
  const originalFetch = frame.fetch
  const release = 'Demo TMT release'
  const product = (tpu, strength) => ({
    tpu, label: `DEMO ORDER (Demo Manufacturer) (demo ingredient ${strength}) tablet`,
    source_generic: 'demo ingredient', strength, dose_form: 'tablet', active_tmt: true,
  })
  const five = product('0005', '5 mg')
  const ten = product('0010', '10 mg')
  const queries = []
  let resolveOld
  let oldSignal
  frame.fetch = async (url, options) => {
    if (!String(url).includes('/checks/local/products')) return originalFetch(url, options)
    const q = new URL(url, frame.location.href).searchParams.get('q')
    queries.push(q)
    if (q === 'slow') {
      oldSignal = options.signal
      await new Promise(resolve => { resolveOld = resolve })
      return Response.json({ tmt_release: 'obsolete', products: [ten] })
    }
    const matches = { 'Demo order': [five, ten], 'Demo order 5 mg': [five], 'Demo order 10 mg': [ten], '0005': [five] }
    return Response.json({ tmt_release: release, products: matches[q] ?? [] })
  }

  async function panel(order) {
    const summary = [...order.querySelectorAll('summary')].find(s => s.textContent === 'Compare label with catalogue')
    assert(summary, 'named label has a catalogue comparison')
    summary.click()
    const details = summary.closest('details')
    await expect(() => details.querySelector('input'), 'comparison search opens')
    return details
  }
  const search = root => root.querySelector('button[type=submit]').click()
  const candidates = root => [...root.querySelectorAll('.scan-comparison .suggestion')]
  const confirmed = order => order.querySelector('.selected-trade-product')?.textContent
  try {
    const linked = await panel(manualOrder)
    const source = linked.querySelector('.citation-image [data-region]')
    assert(source && linked.textContent.includes('Demo North Facility'), 'linked 5 mg label keeps its own crop')
    search(linked)
    await expect(() => candidates(linked).length === 2, 'qualified and neighboring products displayed')
    assert(queries.includes('Demo order 5 mg') && queries.includes('Demo order'), 'name and label strength queried')
    const [matching, conflict] = candidates(linked)
    assert(matching.textContent.includes('Demo Manufacturer') && matching.textContent.includes('demo ingredient'),
      'full source product description and ingredients preserved')
    assert(conflict.textContent.includes('Wording differs from the label') && conflict.textContent.includes('10 mg'),
      'neighboring strength differs from the original 5 mg wording')
    assert(!confirmed(manualOrder), 'lookup leaves selection empty')
    const query = linked.querySelector('input')
    type(query, 'missing'); search(linked)
    await expect(() => linked.textContent.includes('No matching trade products') && linked.textContent.includes(release), 'empty result carries its release')
    assert(!confirmed(manualOrder), 'empty lookup leaves the original row selectable and unconfirmed')
    type(query, 'slow'); search(linked)
    await expect(() => resolveOld, 'old lookup in flight')
    type(query, '0005'); search(linked)
    await expect(() => candidates(linked).length === 1, 'documented code can be looked up directly')
    resolveOld()
    await new Promise(resolve => setTimeout(resolve, 30))
    assert(!linked.textContent.includes('obsolete') && candidates(linked).length === 1, 'late response ignored')
    candidates(linked)[0].querySelector('button').click()
    await expect(() => confirmed(manualOrder)?.includes('TPU 0005') && confirmed(manualOrder).includes(release),
      'explicit confirmation attaches the string TPU and release')
    assert(manualOrder.textContent.includes('Synthetic manual 5 mg order') && manualOrder.textContent.includes('Awaiting clinical review'),
      'manual source and clinical review status stay visible')
    const separate = await panel(scannedOrder)
    search(separate)
    await expect(() => candidates(separate).length === 2, 'second physical label has independent results')
    assert(queries.includes('Demo order 10 mg') && !queries.includes('Demo order 12 mg'), 'lookup uses the scan, not the staff correction')
    assert(!confirmed(scannedOrder) && scannedOrder.textContent.includes('12 mg'), 'other row and staff correction preserved')
    linked.open = false
    resolveOld = undefined
    type(separate.querySelector('input'), 'slow'); search(separate)
    await expect(() => resolveOld, 'lookup active on the old scan')
    return async () => {
      await expect(() => oldSignal.aborted && !separate.isConnected, 'leaving the scan for reanalysis cancels its lookup')
      resolveOld()
    }
  } finally {
    frame.fetch = originalFetch
  }
}

// Add ?liveCatalogue to /tests/intake.html to exercise the installed local catalogue.
// Only extraction is simulated in that mode, to keep the original label deliberately incomplete.
export async function checkUnspecifiedPresentation({ frame, doc, win, photo, packageLabelPhoto, click, expect, assert, type, live }) {
  const loaded = new Promise(resolve => frame.addEventListener('load', resolve, { once: true }))
  frame.src = '/new-patient/input'
  await loaded
  await expect(() => doc().querySelector('section[aria-label="Label side"]'), 'fresh photo intake')
  const originalFetch = win().fetch.bind(win())
  const regionId = crypto.randomUUID()
  win().fetch = async (url, init) => {
    if (String(url).endsWith('/medication-analysis')) {
      const form = JSON.parse(init.body.get('form'))
      const ref = { source_id: regionId, item_id: regionId }
      const located_regions = form.scene_photo_ids.length ? [{
        attachment_id: form.scene_photo_ids[0], ...ref, row_id: regionId,
        bounds: { x: 0, y: 0, width: 0.5, height: 1 },
      }] : []
      return Response.json({ case_id: form.evidence.case_id, located_regions, unassigned_reports: [], rows: [{
        id: regionId, identity_status: 'named', observed_names: [{ value: 'AMLOC', evidence: ref }],
        label_fields: { strength: { status: 'unreadable', evidence: ref }, form: { status: 'missing' } },
        sources: [ref], reported_use: [], discrepancies: [], follow_ups: [],
      }] })
    }
    if (!live && String(url).includes('/checks/local/products')) {
      return Response.json({ tmt_release: 'fixture-release', products: ['5 mg', '10 mg'].map((strength, i) => ({
        tpu: ['108455', '108591'][i], label: 'AMLOC (Demo Manufacturer) (amlodipine ' + strength + ') tablet',
        source_generic: 'amlodipine', strength, dose_form: 'tablet', active_tmt: true,
      })) })
    }
    return originalFetch(url, init)
  }
  photo('Label side', 'synthetic-AMLOC.png', packageLabelPhoto('AMLOC'))
  await click('Analyze evidence')
  await expect(() => doc().querySelector('.pick-row input'), 'analysis returns named scan')
  doc().querySelector('.pick-row input').click()
  await click('Add selected to draft')
  doc().querySelector('a[href="/new-patient/review"]').click()
  await expect(() => doc().querySelector('article .med-corrections'), 'accepted row in Review')
  const row = doc().querySelector('article')
  const editor = row.querySelector('.med-corrections')
  const empty = () => !editor.querySelector('[name=strength]').value && !editor.querySelector('[name=form]').value
  assert(empty(), 'unreadable strength and missing form initially blank in clinical draft')
  const comparison = [...row.querySelectorAll('details')].find(d => d.querySelector('summary')?.textContent === 'Compare label with catalogue')
  comparison.open = true
  await click('Search catalogue')
  const candidate = code => [...comparison.querySelectorAll('.suggestion')].find(c => c.textContent.includes('TPU ' + code))
  await expect(() => candidate('108455') && candidate('108591'), 'both source strengths available')
  if (live) {
    assert(candidate('108455').textContent.includes('PFIZER, AUSTRALIA'), 'documented manufacturer preserved in FSN')
    assert(comparison.textContent.includes('TMTRF20200217'), 'actual installed release displayed')
  }
  assert(!row.querySelector('.selected-trade-product'), 'multiple matches leave row without a confirmed TPU')
  candidate('108455').querySelector('button').click()
  await expect(() => row.querySelector('.selected-trade-product')?.textContent.includes('108455'), 'explicit 5 mg choice')
  assert(empty(), 'catalogue selection leaves missing clinical fields blank')
  assert(row.textContent.includes('Awaiting clinical review'), 'selection preserves pending status')
  assert(row.querySelector('.row-evidence').textContent.includes('Unreadable'), 'original uncertain observation retained')
  // Staff can attach the same package to a separately documented manual order.
  doc().querySelector('a[href="/new-patient/input"]').click()
  await click('Enter medicine manually')
  type(doc().querySelector('.medicine-picker input'), '108591')
  const ten = () => [...doc().querySelectorAll('[role=option]')].find(o => o.textContent.includes('TPU 108591'))
  await expect(ten, 'existing product found in the manual picker')
  ten().click()
  type([...doc().querySelectorAll('label')].find(l => l.textContent.trim() === 'Source wording or reference').control, 'Synthetic original manual order')
  await click('Add to draft')
  await click('Read photos or notes')
  await click('Analyze evidence')
  const target = () => doc().querySelector('.suggestion select')
  await expect(target, 'choose a separate existing order for the already accepted scan')
  const option = [...target().options].find(o => o.textContent.includes('10 mg'))
  assert(option, 'documented manual 10 mg order available')
  target().value = option.value
  target().dispatchEvent(new Event('change', {bubbles:true}))
  doc().querySelector('.pick-row input').click()
  await click('Add selected to draft')
  doc().querySelector('a[href="/new-patient/review"]').click()
  const manual = () => [...doc().querySelectorAll('article')].find(a => a.textContent.includes('Synthetic original manual order'))
  await expect(() => manual()?.querySelector('.scan-catalogue'), 'compare label on a separately catalogued manual order')
  const details = manual().querySelector('.scan-catalogue')
  details.open = true
  const replacement = () => [...details.querySelectorAll('.suggestion')].find(c => c.textContent.includes('TPU 108455'))?.querySelector('button')
  await expect(replacement, 'alternative for explicitly linked manual order')
  assert(manual().querySelector('.selected-trade-product').textContent.includes('TPU 108591'), 'search retains previously chosen product')
  assert(replacement().textContent.includes('Replace confirmed TPU 108591'), 'replacement names prior confirmed product')
  replacement().click()
  await expect(() => manual().querySelector('.selected-trade-product').textContent.includes('TPU 108455'), 'replaced only after confirmation')
  assert(manual().textContent.includes('Original manual selection') && manual().textContent.includes('TPU 108591'), 'original manual choice remains attributable')
  assert(manual().querySelector('.med-corrections [name=strength]').value === '10 mg', 'clinical presentation from manual order remains unchanged')

}
