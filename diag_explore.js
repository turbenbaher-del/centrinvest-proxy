const { chromium } = require('playwright-chromium')
const fs = require('fs')
const BASE = 'https://dbo.centrinvest.ru/sbns-web'
const OUT = 'C:/Users/user/AppData/Local/Temp/claude/C--Users-user-Downloads-DBO/197fc59c-41a3-46ad-9eaa-cff6753ac430/scratchpad/explore.txt'
;(async () => {
  const b = await chromium.launch({ headless: true, proxy: { server: 'socks5://127.0.0.1:10810' } })
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })
  const page = await ctx.newPage()
  const dismiss = async () => { try { await page.evaluate(() => { const m=document.querySelector('[data-at="modal-ui/messages/mustRead"]'); if(m){const bs=[...m.querySelectorAll('button,[role=button]')]; (bs[bs.length-1]||{click(){}}).click()} }) } catch {} }
  const snap = async (tag) => {
    const d = await page.evaluate(() => {
      const q=(s)=>Array.from(document.querySelectorAll(s))
      return {
        url: location.href, title: document.title,
        buttons: [...new Set(q('button,[role=button],[role=menuitem],a').map(e=>(e.textContent||'').trim()).filter(t=>t&&t.length<45))].slice(0,60),
      }
    })
    return `\n===== ${tag} =====\nurl=${d.url}\ntitle=${d.title}\nBUTTONS/ITEMS:\n  ${d.buttons.join('\n  ')}\n`
  }
  let report=''
  await page.goto(`${BASE}/ru/html/login.html`,{waitUntil:'commit',timeout:30000})
  await page.waitForSelector('#userName',{timeout:30000,state:'attached'})
  try{await page.click('#btn',{timeout:3000})}catch{}
  await page.fill('#userName','24cmvky8');await page.fill('#password','dbocib14Z');await page.click('#submitButton')
  await page.waitForURL(u=>!u.toString().includes('login.html'),{timeout:30000,waitUntil:'commit'})
  await page.waitForTimeout(5000); await dismiss()
  report += await snap('HOME')

  // open "Создать" / "Оплатить" menu of payment types
  for (const l of ['Оплатить','Создать']) { try{await dismiss();await page.click(`text=${l}`,{timeout:3000});await page.waitForTimeout(2500);report+=await snap('after '+l)}catch{} }

  // capture the payment-type submenu (Контрагенту / Между своими / Налог / СБП / ЖКУ ...)
  report += '\n=== payment-type submenu (visible menu text) ===\n'
  try {
    const menu = await page.evaluate(() => {
      const q=(s)=>Array.from(document.querySelectorAll(s))
      return [...new Set(q('[role=menuitem],[role=option],li,button,a,div,span').map(e=>(e.textContent||'').trim()).filter(t=>t&&t.length<50 && /контраген|между сво|налог|бюджет|СБП|ЖКУ|валют|зарплат|перевод|физ|поручен|платеж/i.test(t)))].slice(0,40)
    })
    report += '  '+menu.join('\n  ')+'\n'
  } catch(e){ report+='menu err '+e.message+'\n' }

  // go into own-transfer and dump BOTH account dropdowns fully
  for (const l of ['Между своими','Перевод между своими счетами']) { try{await dismiss();await page.click(`text=${l}`,{timeout:2500});await page.waitForTimeout(2500)}catch{} }
  await dismiss()
  const dumpDropdown = async (name) => {
    try {
      await page.click(`[name="${name}"]`,{timeout:4000}); await page.waitForTimeout(1500)
      const opts = await page.evaluate(() => [...new Set(Array.from(document.querySelectorAll('[role=option],li,[class*=option],[class*=item]')).map(e=>(e.textContent||'').replace(/\s+/g,' ').trim()).filter(t=>t&&t.length<160))].slice(0,30))
      // close dropdown
      await page.keyboard.press('Escape').catch(()=>{})
      return opts
    } catch(e){ return ['FAIL: '+e.message] }
  }
  report += '\n=== OWN-TRANSFER form: '+(await page.title())+' ===\n'
  report += 'payerAccount options:\n  '+(await dumpDropdown('payerAccount')).join('\n  ')+'\n'
  await page.waitForTimeout(800)
  report += 'receiverAccount options:\n  '+(await dumpDropdown('receiverAccount')).join('\n  ')+'\n'

  fs.writeFileSync(OUT, report)
  await b.close(); console.log('DONE ->', OUT)
})()
