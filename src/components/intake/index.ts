import { imageOrientation } from './orientation'
import { IntakeDraft } from './model'
import type { IntakeRecord, LayoutBridge, PhotoTarget, Product, RegionLink, Role, Scene, Side, Source, Submission } from './model'
import './intake.css'

export type { Attachment, LayoutBridge, ManualRow, PhotoTarget, Product, RegionLink, Scene, Submission } from './model'
export interface IntakeOptions {
  caseId: string
  role: Role
  collector?: string
  language?: 'en' | 'th'
  searchProducts: (query: string) => Promise<Product[]>
  onSubmit: (submission: Submission) => Promise<void>
  layout?: LayoutBridge
  packages?: () => readonly { id: string; label: string }[]
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string) {
  const node = document.createElement(tag)
  if (text !== undefined) node.textContent = text
  return node
}

export function mountIntake(root: HTMLElement, options: IntakeOptions) {
  if (!['nurse', 'doctor', 'pharmacist'].includes(options.role)) throw new Error('Clinical staff access required.')
  const draft = new IntakeDraft(options.caseId, options.collector)
  const t = (english: string, thai: string) => options.language === 'th' ? thai : english
  const urls = new Map<Side, string>()
  let layout = options.layout
  let disposed = false
  let searchRevision = 0
  let submitting = false
  let pendingFiles = 0
  const form = el('form')
  form.className = 'med-intake'
  form.lang = options.language ?? 'en'
  const controls = el('fieldset')
  controls.className = 'intake-controls'
  const status = el('p')
  status.setAttribute('role', 'status')
  const alert = el('p')
  alert.setAttribute('role', 'alert')
  const errors: Record<string, string> = {
    unsupported_photo: t('Choose a JPG, PNG or WebP photo.', 'เลือกภาพ JPG, PNG หรือ WebP'),
    oversize_photo: t('Choose a photo under 4 MB.', 'เลือกภาพขนาดไม่เกิน 4 MB'),
    invalid_target: t('Select the package and view for this retake.', 'เลือกซองยาและด้านที่ต้องการถ่ายใหม่'),
    stale_link: t('Select a region from the current photo of this case.', 'เลือกบริเวณจากภาพปัจจุบันของเคสนี้'),
    unavailable_reason: t('Record why the prior source is unavailable.', 'ระบุเหตุผลที่ไม่สามารถขอเอกสารเดิมได้'),
  }
  function problem(error: unknown) {
    const code = error instanceof Error ? error.message : ''
    alert.textContent = errors[code] ?? t('Could not complete the request. Your entries are available to retry.', 'ดำเนินการไม่สำเร็จ ข้อมูลยังอยู่ กรุณาลองอีกครั้ง')
  }
  function button(label: string, action: () => void) {
    const b = el('button', label)
    b.type = 'button'
    b.onclick = action
    return b
  }
  function input(label: string, value: string, change: (v: string) => void, type = 'text') {
    const wrap = el('label', label)
    const control = type === 'textarea' ? el('textarea') : el('input')
    if (control instanceof HTMLInputElement) control.type = type
    control.value = value
    control.oninput = () => change(control.value)
    wrap.append(control)
    return wrap
  }
  function select(label: string, choices: [string, string][], value: string, change: (v: string) => void) {
    const wrap = el('label', label)
    const control = el('select')
    control.setAttribute('aria-label', label)
    for (const [id, name] of choices) control.add(new Option(name, id))
    control.value = value
    control.onchange = () => change(control.value)
    wrap.append(control)
    return wrap
  }
  function checkbox(label: string, value: boolean, change: (v: boolean) => void) {
    const wrap = el('label')
    wrap.className = 'intake-check'
    const control = el('input')
    control.type = 'checkbox'
    control.checked = value
    control.onchange = () => change(control.checked)
    wrap.append(control, label)
    return wrap
  }
  function disclosure(title: string) {
    const details = el('details')
    details.append(el('summary', title))
    return details
  }
  function section(title: string) {
    const node = el('section')
    node.append(el('h3', title))
    return node
  }

  const photos = section(t('Photograph the medicines', 'ถ่ายภาพยาที่นำมา'))
  const pair = el('div')
  pair.className = 'intake-pair'
  function photoControl(
    parent: HTMLElement, label: string, side: Side | 'additional', help: string, target?: () => PhotoTarget | undefined,
  ) {
    const block = el('div')
    block.className = 'intake-photo'
    block.append(el('h4', label), el('p', help))
    const files = el('div')
    files.className = 'intake-files'
    const selected = el('div')
    selected.setAttribute('aria-live', 'polite')
    let pending = 0
    for (const camera of [false, true]) {
      const picker = el('label', camera ? t('Use camera', 'ใช้กล้อง') : t('Choose file', 'เลือกไฟล์'))
      picker.className = 'intake-picker'
      const control = el('input')
      control.type = 'file'
      control.accept = 'image/jpeg,image/png,image/webp'
      control.setAttribute('aria-label', label + ' · ' + picker.textContent)
      if (camera) control.setAttribute('capture', 'environment')
      control.onchange = async () => {
        const file = control.files?.[0]
        control.value = ''
        if (!file) return
        pendingFiles++
        submit.disabled = true
        try {
          const selectedTarget = target?.()
          const sequence = ++pending
          if (file.size > 4_000_000) throw new Error('oversize_photo')
          const orientation = await imageOrientation(file)
          if (disposed || (side !== 'additional' && sequence !== pending)) return
          const attachment = draft.setPhoto(side, file, orientation, selectedTarget)
          if (side !== 'additional') {
            const oldUrl = urls.get(side)
            const url = URL.createObjectURL(file)
            urls.set(side, url)
            layout?.setPhoto(side, { attachment_id: attachment.attachment_id, revision: attachment.revision, exif_orientation: orientation, url })
            if (oldUrl) URL.revokeObjectURL(oldUrl)
            selected.textContent = file.name
          } else {
            selected.replaceChildren(...draft.photos.filter(p => p.kind === 'additional_photo').map(p =>
              el('p', p.target ? p.file.name + ' · ' + p.target.package_id + ' · ' + p.target.side : p.file.name)))
          }
          refreshRecordAttachments()
          alert.textContent = ''
        } catch (e) { problem(e) }
        finally { pendingFiles--; submit.disabled = pendingFiles > 0 }
      }
      picker.append(control)
      files.append(picker)
    }
    block.append(files, selected)
    parent.append(block)
  }
  photoControl(pair, t('Photo 1 · Labels up', 'ภาพ 1 · หงายฉลาก'), 'front',
    t('Lay out all bags, boxes and loose pills together. Keep each package in its own place.', 'วางซองยา กล่อง และยาเม็ดทั้งหมดในภาพเดียว แยกแต่ละรายการให้เห็นชัด'))
  photoControl(pair, t('Photo 2 · Reverse (optional)', 'ภาพ 2 · ด้านกลับ (ไม่จำเป็น)'), 'reverse',
    t('Flip each package in place and photograph the same layout.', 'พลิกแต่ละซองหรือกล่องในตำแหน่งเดิม แล้วถ่ายภาพทั้งหมดอีกครั้ง'))
  photos.append(pair, el('small', t('JPG, PNG or WebP · up to 4 MB each', 'JPG, PNG หรือ WebP · ไม่เกิน 4 MB ต่อภาพ')))
  const extra = disclosure(t('Additional photo or targeted retake', 'ภาพเพิ่มเติมหรือถ่ายซ้ำเฉพาะรายการ'))
  const targets = el('div')
  let targetId = '', targetSide: Side = 'front'
  function targetChoices() {
    const packages = options.packages?.() ?? []
    const target = packages.length
      ? select(t('Package', 'ซองหรือกล่อง'), [['', t('Additional photo', 'ภาพเพิ่มเติม')], ...packages.map(p => [p.id, p.label] as [string, string])],
          targetId, v => { targetId = v })
      : input(t('Package reference for a retake', 'รหัสซองหรือกล่องสำหรับถ่ายซ้ำ'), targetId, v => { targetId = v })
    targets.replaceChildren(target, select(t('Retake view', 'ด้านที่ถ่ายซ้ำ'),
      [['front', t('Front', 'ด้านหน้า')], ['reverse', t('Reverse', 'ด้านกลับ')]], targetSide, v => { targetSide = v as Side }))
  }
  extra.ontoggle = () => { if (extra.open) targetChoices() }
  extra.append(targets)
  photoControl(extra, t('Item photo', 'ภาพรายการยา'), 'additional',
    t('For a retake, select the affected package and view. Both original table photos stay available.', 'หากถ่ายซ้ำ ให้ระบุซองและด้านที่ถ่าย ภาพรวมเดิมทั้งสองด้านยังคงอยู่'),
    () => targetId.trim() ? { package_id: targetId.trim(), side: targetSide } : undefined)
  photos.append(extra)

  const manual = section(t('Add a medicine manually', 'เพิ่มยาโดยกรอกเอง'))
  const results = el('div')
  results.className = 'intake-results'
  results.setAttribute('aria-live', 'polite')
  const rows = el('div')
  const queryLabel = t('Medicine name or catalogue code', 'ชื่อยาหรือรหัสบัญชียา')
  const search = input(queryLabel, '', value => { void findProducts(value) })
  const query = search.querySelector('input')!
  function renderRows() {
    rows.replaceChildren()
    for (const row of draft.rows) {
      const displayName = () => row.catalogue_id && row.selected_product?.label
        ? row.selected_product.label : [row.name, row.strength, row.form].filter(Boolean).join(' ')
      const group = disclosure(displayName())
      group.className = 'intake-row'
      const summary = group.querySelector('summary')!
      function editIdentity(field: 'name' | 'strength' | 'form', value: string) {
        if (row[field] !== value) { row.catalogue_id = null; row.selected_product = null }
        row[field] = value
        summary.textContent = displayName()
      }
      group.append(
        input(t('Documented name', 'ชื่อยาตามหลักฐาน'), row.name, v => editIdentity('name', v)),
        input(t('Strength', 'ความแรง'), row.strength, v => editIdentity('strength', v)),
        input(t('Form', 'รูปแบบยา'), row.form, v => editIdentity('form', v)),
        input(t('Documented directions', 'วิธีใช้ตามหลักฐาน'), row.directions, v => { row.directions = v }))
      const details = disclosure(t('Dose, schedule and source', 'ขนาดยา เวลาใช้ และแหล่งข้อมูล'))
      details.append(input(t('Patient’s dose', 'ขนาดยาที่ผู้ป่วยใช้'), row.dose, v => { row.dose = v }),
        input(t('Patient’s schedule', 'เวลาที่ผู้ป่วยใช้ยา'), row.schedule, v => { row.schedule = v }),
        input(t('Source or reporter', 'แหล่งข้อมูลหรือผู้ให้ข้อมูล'), row.source_wording, v => { row.source_wording = v }))
      group.append(details)
      if (row.superseded_scans.length) group.append(el('small', t('Previously linked regions', 'บริเวณที่เคยเชื่อมโยง') + ' · ' + row.superseded_scans.length))
      if (row.scans.length) group.append(el('small', t('Confirmed photo links', 'ภาพที่ยืนยันแล้ว') + ' · ' + row.scans.length))
      rows.append(group)
    }
  }
  function addProduct(name: string, product: Product | null) {
    if (!name.trim()) { query.focus(); return }
    draft.addMedicine(name, product)
    searchRevision++
    query.value = ''
    results.replaceChildren()
    renderRows()
    rows.lastElementChild?.querySelector('summary')?.focus()
  }
  async function findProducts(value: string) {
    const current = ++searchRevision
    results.replaceChildren()
    if (!value.trim()) return
    try {
      const found = await options.searchProducts(value.trim())
      if (current !== searchRevision || disposed) return
      if (!found.length) results.append(el('small', t('No catalogue match.', 'ไม่พบรายการในบัญชียา')))
      for (const product of found.slice(0, 12)) results.append(button(product.label || product.name, () => addProduct(product.name, product)))
    } catch {
      if (current === searchRevision && !disposed) results.textContent = t('Catalogue unavailable. You can enter the documented name.', 'ไม่สามารถค้นบัญชียาได้ กรอกชื่อยาตามหลักฐานแทนได้')
    }
  }
  const scanReview = el('div')
  manual.append(search, results, button(t('Add as written', 'เพิ่มตามชื่อที่ระบุ'), () => addProduct(query.value, null)), rows, scanReview)

  const interview = disclosure(t('Patient or caregiver interview', 'คำบอกเล่าจากผู้ป่วยหรือผู้ดูแล'))
  interview.append(select(t('Reported by', 'ผู้ให้ข้อมูล'), [['patient_report', t('Patient', 'ผู้ป่วย')], ['caregiver_report', t('Caregiver', 'ผู้ดูแล')]],
    draft.interview.source.kind, v => { draft.interview.source.kind = v as 'patient_report' | 'caregiver_report' }),
    input(t('Patient-reported use', 'การใช้ยาตามคำบอกเล่า'), '', v => { draft.interview.wording = v }, 'textarea'),
    checkbox(t('Patient cannot recall the schedule', 'ผู้ป่วยจำเวลาใช้ยาไม่ได้'), false, v => { draft.scheduleUnknown = v }),
    input(t('Reporter name, if known', 'ชื่อผู้ให้ข้อมูล ถ้าทราบ'), '', v => { draft.interview.source.reporter = v || undefined }),
    input(t('Interview date, if known', 'วันที่สัมภาษณ์ ถ้าทราบ'), '', v => { draft.interview.source.source_date = v || undefined }, 'date'))

  const records = disclosure(t('Other source notes and facility details', 'บันทึกจากแหล่งอื่นและข้อมูลสถานพยาบาล'))
  const recordList = el('div')
  const recordAttachmentSelects = new Map<IntakeRecord, HTMLSelectElement>()
  function refreshRecordAttachments() {
    for (const [record, control] of recordAttachmentSelects) {
      const selectedId = record.source.attachment_id
      control.replaceChildren(new Option(t('Written record', 'เอกสาร'), ''))
      for (const photo of draft.photos) control.add(new Option(photo.file.name, photo.attachment_id))
      if (selectedId && draft.detachedRecords.has(record.source.id)) {
        control.add(new Option(t('Replaced photo · select current source', 'ภาพถูกแทนที่ · เลือกแหล่งข้อมูลปัจจุบัน'), selectedId))
      }
      control.value = selectedId ?? ''
    }
  }
  function addRecord() {
    const record = draft.addRecord()
    const source = record.source
    const group = el('fieldset')
    const fields = el('div')
    const attachLabel = el('label', t('Source attachment', 'เอกสารหรือภาพต้นทาง'))
    const attachment = el('select')
    attachLabel.append(attachment)
    recordAttachmentSelects.set(record, attachment)
    attachment.onchange = () => {
      draft.detachedRecords.delete(source.id)
      source.attachment_id = attachment.value || undefined
      const photo = draft.photos.find(p => p.attachment_id === attachment.value)
      source.kind = photo?.kind ?? 'transfer_record'
      if (photo) { delete source.availability; delete source.unavailable_reason }
      renderRecordFields()
    }
    function optional(key: keyof Pick<Source, 'organization' | 'department_or_ward' | 'organization_address' |
      'organization_phone' | 'organization_phone_extension' | 'organization_email' | 'source_date'>,
      en: string, th: string, type = 'text') {
      return input(t(en, th), source[key] ?? '', v => { source[key] = v || undefined }, type)
    }
    function renderRecordFields() {
      fields.replaceChildren()
      if (!source.attachment_id) {
        fields.append(select(t('Record type', 'ประเภทเอกสาร'),
          [['transfer_record', t('Transfer or ward record', 'เอกสารส่งต่อหรือบันทึกหอผู้ป่วย')], ['prescription', t('Prescription', 'ใบสั่งยา')], ['other_record', t('Other record', 'เอกสารอื่น')]],
          source.kind, v => { source.kind = v as 'transfer_record' | 'prescription' | 'other_record' }),
          checkbox(t('Prior record unavailable', 'ไม่สามารถขอเอกสารเดิมได้'), source.availability === 'unavailable', v => {
            if (v) source.availability = 'unavailable'
            else { delete source.availability; delete source.unavailable_reason }
            renderRecordFields()
          }))
        fields.append(source.availability
          ? input(t('Reason unavailable', 'เหตุผลที่ไม่ได้รับเอกสาร'), source.unavailable_reason ?? '', v => { source.unavailable_reason = v })
          : input(t('Other source notes', 'บันทึกจากแหล่งอื่น'), record.wording, v => { record.wording = v }, 'textarea'))
      }
      fields.append(optional('organization', 'Facility, if known', 'สถานพยาบาล ถ้าทราบ'),
        optional('department_or_ward', 'Department or ward', 'แผนกหรือหอผู้ป่วย'),
        optional('source_date', 'Source date, if known', 'วันที่ของแหล่งข้อมูล ถ้าทราบ', 'date'))
      const contact = disclosure(t('Facility contact details', 'ข้อมูลติดต่อสถานพยาบาล'))
      contact.append(optional('organization_address', 'Institution address', 'ที่อยู่สถานพยาบาล'),
        optional('organization_phone', 'Institution phone', 'โทรศัพท์สถานพยาบาล', 'tel'),
        optional('organization_phone_extension', 'Extension', 'เบอร์ต่อ'),
        optional('organization_email', 'Institution email', 'อีเมลสถานพยาบาล', 'email'))
      fields.append(contact)
    }
    group.append(el('legend', t('Source', 'แหล่งข้อมูล') + ' ' + draft.records.length), attachLabel, fields)
    recordList.append(group)
    refreshRecordAttachments()
    renderRecordFields()
  }
  records.append(recordList, button(t('Add source', 'เพิ่มแหล่งข้อมูล'), addRecord))
  const question = disclosure(t('Questions for the agent', 'คำถามสำหรับผู้ช่วย'))
  question.append(input(t('Question for review', 'คำถามที่ต้องการทบทวน'), '', v => { draft.question = v }, 'textarea'))
  const submit = el('button', t('Review intake', 'ทบทวนข้อมูล'))
  submit.type = 'submit'
  submit.className = 'intake-submit'
  controls.append(photos, manual, interview, records, question, submit)
  form.append(controls, alert, status)
  root.replaceChildren(form)
  form.onsubmit = async event => {
    event.preventDefault()
    if (submitting || pendingFiles) return
    alert.textContent = ''
    status.textContent = ''
    try {
      const snapshot = draft.snapshot()
      if (!snapshot.evidence.sources.length || draft.rows.some(r => !r.name.trim())) {
        alert.textContent = t('Add a photo, documented medicine or sourced account before review.', 'เพิ่มภาพยา รายการยาตามหลักฐาน หรือคำบอกเล่าก่อนทบทวน')
        return
      }
      controls.disabled = submitting = true
      await options.onSubmit(snapshot)
      status.textContent = t('Intake ready for review.', 'ข้อมูลพร้อมสำหรับทบทวน')
    } catch (e) { problem(e) }
    finally { controls.disabled = submitting = false }
  }
  return {
    snapshot: () => draft.snapshot(),
    attachLayout(next: LayoutBridge) {
      layout = next
      for (const [side, url] of urls) {
        const photo = draft.photos.find(p => p.kind === (side === 'front' ? 'label_photo' : 'reverse_photo'))!
        layout.setPhoto(side, { attachment_id: photo.attachment_id, revision: photo.revision, exif_orientation: photo.exif_orientation, url })
      }
    },
    syncLayout(scene: Scene | null) {
      const linkCount = draft.rows.reduce((n, row) => n + row.scans.length, 0)
      draft.syncLayout(scene)
      if (draft.rows.reduce((n, row) => n + row.scans.length, 0) !== linkCount) renderRows()
    },
    offerScan(link: RegionLink) {
      let rowId = ''
      const review = el('fieldset')
      review.append(el('legend', t('Link the selected scan to a medicine', 'เชื่อมภาพที่เลือกกับรายการยา')),
        select(t('Existing medicine', 'รายการยาเดิม'), [['', t('Choose a medicine', 'เลือกรายการยา')],
          ...draft.rows.map(row => [row.id, row.name] as [string, string])], '', id => { rowId = id }),
        button(t('Confirm link', 'ยืนยันการเชื่อมโยง'), () => {
          try { draft.confirmScan(rowId, link); renderRows(); scanReview.replaceChildren(); alert.textContent = '' }
          catch (e) { problem(e) }
        }), button(t('Cancel', 'ยกเลิก'), () => scanReview.replaceChildren()))
      scanReview.replaceChildren(review)
    },
    confirmScan(rowId: string, link: RegionLink) { draft.confirmScan(rowId, link); renderRows() },
    dispose() {
      disposed = true
      searchRevision++
      for (const [side, url] of urls) { layout?.setPhoto(side, null); URL.revokeObjectURL(url) }
      urls.clear()
      form.remove()
    },
  }
}
