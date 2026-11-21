export const messages = {
  en: {
    home: 'Home', patient: 'New Patient', history: 'History',
    stages: 'New Patient stages', input: 'Input', review: 'Review', output: 'Output',
    navigation: 'Main navigation', language: 'Switch to Thai',
    light: 'Use light theme', dark: 'Use dark theme',
  },
  th: {
    home: 'หน้าหลัก', patient: 'ผู้ป่วยใหม่', history: 'ประวัติ',
    stages: 'ขั้นตอนสำหรับผู้ป่วยใหม่', input: 'ป้อนข้อมูล', review: 'ทบทวน', output: 'ผลลัพธ์',
    navigation: 'เมนูหลัก', language: 'เปลี่ยนเป็นภาษาอังกฤษ',
    light: 'ใช้ธีมสว่าง', dark: 'ใช้ธีมมืด',
  },
}

export type Language = keyof typeof messages
