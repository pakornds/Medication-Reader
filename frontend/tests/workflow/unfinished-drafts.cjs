// Run with Playwright and Chrome against the staff workspace and a dedicated synthetic backend.
// Set TEST_DEMO_URL to the local presenter URL and CHROME_PATH to the Chrome executable.
const assert = require('node:assert/strict')
const { chromium } = require('playwright')

const url = process.env.TEST_DEMO_URL
assert.ok(url, 'Set TEST_DEMO_URL for the staff workspace in presenter mode.')

const button = (page, name) => page.getByRole('button', { name, exact: true })
const field = (page, name) => page.getByLabel(name, { exact: true })
const stage = (page, name) =>
  page.getByRole('navigation', { name: 'New Patient stages' }).locator('a[href="/new-patient/' + name + '"]').click()

async function checkDrafts(page) {
  page.setDefaultTimeout(10000)
  const account = 'Synthetic interview account'
  const schedule = 'each morning as reported'
  const source = 'Synthetic transfer record lists the medicine'
  const name = field(page, 'Product name or code')
  const wording = field(page, 'Directions as written or reported')
  const sourceWording = page.locator('label:has-text("Source wording or reference") textarea')
  const interviewWording = page.locator('label:has-text("Original interview wording") textarea')
  const interviewRequests = []
  page.on('request', request => {
    if (request.url().endsWith('/actions') && request.method() === 'POST') {
      interviewRequests.push(request.postDataJSON().command)
    }
  })

  await page.goto(url + '/new-patient/input')
  await button(page, 'Enter medicine manually').click()
  await name.fill('117365')
  const product = page.getByRole('option').filter({ hasText: '117365' }).first()
  await product.click()
  const productName = await name.inputValue()
  assert.match(productName, /ZOCOR/i)
  await sourceWording.fill(source)
  await wording.fill('1 tablet each morning')
  await button(page, 'Fill fields from wording').click()
  await page.locator('.directions-card button[aria-pressed=true]').filter({ hasText: 'Morning' }).waitFor()

  await stage(page, 'review')
  assert.equal(await page.locator('.draft-line').count(), 0)
  assert.equal(await button(page, 'Save draft and open clinical review').count(), 0)
  await button(page, 'Start fresh case').click()
  await button(page, 'Keep current case').click()
  await stage(page, 'input')
  await button(page, 'Enter medicine manually').click()
  assert.equal(await name.inputValue(), productName)
  assert.equal(await sourceWording.inputValue(), source)
  assert.equal(await wording.inputValue(), '1 tablet each morning')
  assert.equal(await field(page, 'Dose unit').inputValue(), 'tablet')
  assert.equal(await button(page, 'Morning').getAttribute('aria-pressed'), 'true')
  await button(page, 'Add to draft').click()
  await name.fill('Synthetic second medicine')
  await sourceWording.fill('Synthetic second source')
  await button(page, 'Add to draft').click()

  await stage(page, 'review')
  const savedIntake = page.waitForResponse(r => r.url().endsWith('/admissions/intake') && r.request().method() === 'POST')
  await button(page, 'Save draft and open clinical review').click()
  const intake = await savedIntake
  assert.equal(intake.status(), 200, await intake.text())
  const encounter = await intake.json()
  const firstMedicine = page.getByRole('button', { name: /ZOCOR/i }).first()
  const secondMedicine = page.getByRole('button', { name: /Synthetic second medicine/i }).first()
  await firstMedicine.click()
  await interviewWording.fill(account)
  await field(page, 'Actual schedule').fill(schedule)
  await secondMedicine.click()
  assert.equal(await field(page, 'Actual schedule').inputValue(), '')
  await field(page, 'Actual schedule').fill('second synthetic schedule')
  await firstMedicine.click()
  assert.equal(await field(page, 'Actual schedule').inputValue(), schedule)
  assert.equal(await interviewWording.inputValue(), account)
  await stage(page, 'output')
  await stage(page, 'review')
  await firstMedicine.click()
  await button(page, 'Start fresh case').click()
  await button(page, 'Keep current case').click()
  assert.equal(await field(page, 'Actual schedule').inputValue(), schedule)
  assert.equal(interviewRequests.length, 0)

  const savedInterview = page.waitForResponse(r => r.url().endsWith('/actions') && r.request().postDataJSON()?.command.action === 'interview')
  await button(page, 'Save interview').click()
  const interview = await savedInterview
  assert.equal(interview.status(), 200, await interview.text())
  assert.deepEqual(interviewRequests.map(command => command.action), ['link', 'interview'])
  assert.equal(interviewRequests[1].schedule, schedule)
  await secondMedicine.click()
  assert.equal(await field(page, 'Actual schedule').inputValue(), 'second synthetic schedule')

  await button(page, 'Start fresh case').click()
  await button(page, 'Discard and start fresh').click()
  await button(page, 'Enter medicine manually').click()
  assert.equal(await name.inputValue(), '')
  assert.equal(await wording.inputValue(), '')
  assert.equal(await sourceWording.inputValue(), '')
  assert.equal(await page.locator('.draft-line').count(), 0)
  assert.equal(await button(page, 'Morning').getAttribute('aria-pressed'), 'false')

  const readback = await page.request.get(url + '/admissions/' + encodeURIComponent(encounter.id))
  assert.equal(readback.status(), 200, await readback.text())
  const rows = Object.values((await readback.json()).rows)
  assert.equal(rows.filter(row => row.interview?.schedule === schedule).length, 1)
  assert.equal(rows.filter(row => row.interview).length, 1)
  assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(key => !key.startsWith('medrec.'))), [])
  assert.equal(await page.evaluate(() => sessionStorage.length), 0)
}

async function run() {
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH })
  try {
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } })
      try {
        await checkDrafts(page)
        console.log('PASS staff draft navigation, interview save and discard in Chrome at ' + width + 'px')
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser.close()
  }
}
run().catch(error => { console.error(error); process.exitCode = 1 })
