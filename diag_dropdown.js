const { chromium } = require('playwright-chromium')
const fs = require('fs')
const BASE = 'https://dbo.centrinvest.ru/sbns-web'
const DOM = 'C:/Users/user/AppData/Local/Temp/claude/C--Users-user-Downloads-DBO/197fc59c-41a3-46ad-9eaa-cff6753ac430/scratchpad/dropdown.txt'
;(async () => {
  const b = await chromium.launch({ headless: true, proxy: { server: 'socks5://127.0.0.1:10810' } })
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })
  const page = await ctx.newPage()
  const dismiss = async () => { try { await page.evaluate(() => { const m=document.querySelector('[data-at="modal-ui/messages/mustRead"]'); if(m){const bs=[...m.querySelectorAll('button,[role=button]')]; (bs[bs.length-1]||{click(){}}).click()} }) } catch {} }
  await page.goto(`${BASE}/ru/html/login.html`, { waitUntil:'commit', timeout:30000 })
  await page.waitForSelector('#userName',{timeout:30000,state:'attached'})
  try { await page.click('#btn',{timeout:3000}) } catch {}
  await page.fill('#userName','24cmvky8'); await page.fill('#password','dbocib14Z'); await page.click('#submitButton')
  await page.waitForURL(u=>!u.toString().includes('login.html'),{timeout:30000,waitUntil:'commit'})
  await page.waitForTimeout(5000); await dismiss()
  for (const l of ['Оплатить','Создать','Между своими','Перевод между своими счетами']) { try{await dismiss();await page.click(`text=${l}`,{timeout:2500});await page.waitForTimeout(2200)}catch{} }
  await page.waitForTimeout(1500); await dismiss()
  // click payerAccount and capture what opens
  let opened=''
  try {
    await page.click('[name="payerAccount"]',{timeout:5000}); await page.waitForTimeout(1500)
    opened = await page.evaluate(() => {
      // capture likely dropdown option elements
      const cand = Array.from(document.querySelectorAll('[role="option"],li,[class*="option"],[class*="dropdown"] *,[class*="menu"] *,[class*="list"] *'))
        .map(e=>(e.textContent||'').trim()).filter(t=>t && t.length<120)
      const uniq=[...new Set(cand)].slice(0,40)
      return uniq.join('\n')
    })
  } catch(e){ opened='CLICK FAIL: '+e.message }
  fs.writeFileSync(DOM, 'title='+await page.title()+'\n\n=== payerAccount dropdown options ===\n'+opened)
  await b.close(); console.log('DONE')
})()
