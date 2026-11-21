import { ApiError } from '../../api/client'
import type { Language } from '../../i18n/messages'

export function analysisErrorMessage(error: unknown, language: Language): string {
  const th = language === 'th'
  if (!(error instanceof ApiError)) {
    return th ? 'ติดต่อเซิร์ฟเวอร์วิเคราะห์ไม่ได้ ภาพยังอยู่ ลองอีกครั้งเมื่อเชื่อมต่อได้' :
      'Could not reach the analysis server. Your photo is still here. Retry once the connection is available.'
  }
  return analysisProviderMessage(error.service?.code ?? '', language) || error.service?.message || (th ? 'เซิร์ฟเวอร์ประมวลผลไม่ได้' : 'The analysis server could not process the request') + ' (HTTP ' + error.status + ').'
}

export function analysisProviderMessage(code: string, language: Language): string | undefined {
  const th = language === 'th'
  switch (code) {
    case 'provider_unconfigured':
      return th ? 'เซิร์ฟเวอร์ยังไม่ได้ตั้งค่า OpenAI ผู้ดูแลต้องตั้งค่าคีย์และรุ่นโมเดลก่อนวิเคราะห์' :
        'OpenAI is not configured on this server. An administrator needs to set the server API key and model before retrying.'
    case 'provider_http_error':
      return th ? 'OpenAI ปฏิเสธคำขอ ให้ผู้ดูแลตรวจสิทธิ์คีย์และโมเดล ภาพยังอยู่' :
        'OpenAI rejected the request. Check the server key and model access. Your photo is still here.'
    case 'provider_timeout':
    case 'provider_rate_limited':
      return th ? 'OpenAI ยังตอบไม่ได้ ภาพยังอยู่ โปรดลองวิเคราะห์อีกครั้งในภายหลัง' :
        'OpenAI could not respond in time or is busy. Your photo is still here. Retry shortly.'
    default:
      return undefined
  }
}
