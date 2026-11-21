import { useEffect } from 'react'
import { LuCamera, LuClipboardCheck, LuPlus, LuPrinter } from 'react-icons/lu'
import { Link } from 'react-router-dom'
import { messages, type Language } from '../../i18n/messages'

const instructions = {
  en: {
    intro: 'Open New Patient to start a medication reconciliation or return to your active case.',
    input: 'Photograph the label sides together. For an optional second photo, flip the same items in place to show the pill sides. Add reports, source notes, or manual entries as needed.',
    review: 'Open the cited sources and compare label directions with reported use. Verify current use or refer an unresolved medicine to pharmacy.',
    output: 'Print a dated handoff with pending medicines. An assigned pharmacist can approve and import selected eligible rows into the mock hospital.',
  },
  th: {
    intro: 'เลือกผู้ป่วยใหม่เพื่อเริ่มทบทวนรายการยาหรือกลับไปยังเคสที่กำลังทำอยู่',
    input: 'ถ่ายด้านฉลากของยาทุกรายการในภาพเดียว หากถ่ายภาพที่สอง ให้พลิกยาแต่ละรายการที่ตำแหน่งเดิมเพื่อถ่ายด้านเม็ดยา เพิ่มข้อมูลที่ผู้ป่วยแจ้ง บันทึกจากแหล่งอื่น หรือกรอกรายการยาเองตามต้องการ',
    review: 'เปิดดูแหล่งข้อมูลและเปรียบเทียบวิธีใช้บนฉลากกับวิธีใช้ที่ผู้ป่วยแจ้ง ยืนยันการใช้ยาปัจจุบันหรือส่งรายการยาที่ยังไม่ทราบชนิดให้เภสัชกร',
    output: 'พิมพ์เอกสารส่งต่อที่ระบุวันที่และแสดงรายการที่ยังรอทบทวน รวมถึงให้เภสัชกรอนุมัติและนำเข้ารายการที่เลือกและผ่านเกณฑ์ไปยังระบบโรงพยาบาลจำลอง',
  },
}

const steps = [
  { stage: 'input', Icon: LuCamera },
  { stage: 'review', Icon: LuClipboardCheck },
  { stage: 'output', Icon: LuPrinter },
] as const

export function HomePage({ language }: { language: Language }) {
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
          <Link className="primary-btn mt-4" to="/new-patient">
            <LuPlus aria-hidden="true" />
            {t.patient}
          </Link>
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
