import { useEffect } from 'react'
import { LuCamera, LuClipboardCheck, LuFolderOpen, LuPackageCheck } from 'react-icons/lu'
import { StartFreshCaseButton } from '../new-patient/StartFreshCaseButton'
import { Link } from 'react-router-dom'
import { messages, type Language } from '../../i18n/messages'

const instructions = {
  en: {
    intro: 'Prepare a medication list to review with the patient and hand off to the next care team.',
    input: 'Photograph the label sides together. For an optional second photo, flip the same items in place to show the pill sides. Add reports, source notes, or manual entries as needed.',
    review: 'Open the cited sources and compare label directions with reported use. Verify current use or refer an unresolved medicine to pharmacy. Print a dated handoff with pending medicines.',
    output: 'An assigned pharmacist can approve and import selected eligible rows into the mock hospital.',
  },
  th: {
    intro: 'จัดทำรายการยาเพื่อทบทวนกับผู้ป่วยและส่งต่อให้ทีมที่ดูแลต่อ',
    input: 'ถ่ายด้านฉลากของยาทุกรายการในภาพเดียว หากถ่ายภาพที่สอง ให้พลิกยาแต่ละรายการที่ตำแหน่งเดิมเพื่อถ่ายด้านเม็ดยา เพิ่มข้อมูลที่ผู้ป่วยแจ้ง บันทึกจากแหล่งอื่น หรือกรอกรายการยาเองตามต้องการ',
    review: 'เปิดดูแหล่งข้อมูลและเปรียบเทียบวิธีใช้บนฉลากกับวิธีใช้ที่ผู้ป่วยแจ้ง ยืนยันการใช้ยาปัจจุบันหรือส่งรายการยาที่ยังไม่ทราบชนิดให้เภสัชกร แล้วพิมพ์เอกสารส่งต่อที่ระบุวันที่และแสดงรายการที่ยังรอทบทวน',
    output: 'เภสัชกรที่ได้รับมอบหมายสามารถอนุมัติและนำเข้ารายการที่เลือกและผ่านเกณฑ์ไปยังระบบโรงพยาบาลจำลอง',
  },
}

const steps = [
  { stage: 'input', Icon: LuCamera },
  { stage: 'review', Icon: LuClipboardCheck },
  { stage: 'output', Icon: LuPackageCheck },
] as const

type Props = {
  language: Language
  hasWork: boolean
  canResume: boolean
  onStartFresh: () => void
}

export function HomePage({ language, hasWork, canResume, onStartFresh }: Props) {
  const t = messages[language]
  const text = instructions[language]

  useEffect(() => {
    document.title = t.home + ' · MedRec TH'
  }, [t.home])

  return (
    <div className="mx-auto w-full max-w-3xl pb-12">
      <section aria-labelledby="home-heading" className="rounded-2xl border border-line bg-2">
        <div className="border-b border-line px-5 py-6 sm:px-8 sm:py-8">
          <h1 id="home-heading" className="text-2xl leading-normal font-semibold">{t.home}</h1>
          <p className="mt-2 leading-relaxed text-2">{text.intro}</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {canResume && (
              <Link className="primary-btn" to="/new-patient">
                <LuFolderOpen aria-hidden="true" />
                {t.resumeCase}
              </Link>
            )}
            <StartFreshCaseButton language={language} hasWork={hasWork}
              onStartFresh={onStartFresh} variant={canResume ? 'secondary' : 'primary'} />
          </div>
        </div>
        <ol className="divide-y divide-line px-5 sm:px-8" role="list">
          {steps.map(({ stage, Icon }) => (
            <li key={stage} className="flex gap-4 py-5 sm:gap-5 sm:py-6">
              <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-selected text-accent">
                <Icon aria-hidden="true" className="size-5" />
              </span>
              <div className="min-w-0">
                <h2 className="text-lg leading-normal font-semibold">{t[stage]}</h2>
                <p className="mt-1 leading-relaxed text-2">{text[stage]}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>
    </div>
  )
}
