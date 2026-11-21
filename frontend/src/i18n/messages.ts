export const messages = {
  en: {
    home: 'Home', patient: 'New Patient', history: 'History',
    stages: 'New Patient stages', input: 'Input', review: 'Review', output: 'Output',
    navigation: 'Main navigation', language: 'Switch to Thai',
    light: 'Use light theme', dark: 'Use dark theme',
    freshCase: 'Start fresh case', discardTitle: 'Discard the current case?',
    discardDescription: 'The photos, notes and medication rows in this draft will be cleared.',
    keepCase: 'Keep current case', discardCase: 'Discard and start fresh',
  },
  th: {
    home: 'หน้าหลัก', patient: 'ผู้ป่วยใหม่', history: 'ประวัติ',
    stages: 'ขั้นตอนสำหรับผู้ป่วยใหม่', input: 'ป้อนข้อมูล', review: 'ทบทวน', output: 'ผลลัพธ์',
    navigation: 'เมนูหลัก', language: 'เปลี่ยนเป็นภาษาอังกฤษ',
    light: 'ใช้ธีมสว่าง', dark: 'ใช้ธีมมืด',
    freshCase: 'เริ่มเคสใหม่', discardTitle: 'ทิ้งข้อมูลของเคสปัจจุบันหรือไม่',
    discardDescription: 'รูปถ่าย บันทึก และรายการยาในฉบับร่างนี้จะถูกล้าง',
    keepCase: 'เก็บเคสปัจจุบัน', discardCase: 'ทิ้งข้อมูลและเริ่มเคสใหม่',
  },
}

export type Language = keyof typeof messages
