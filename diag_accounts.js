const { chromium } = require('playwright-chromium')
const fs = require('fs')
const BASE = 'https://dbo.centrinvest.ru/sbns-web'
const OUT = 'C:/Users/user/AppData/Local/Temp/claude/C--Users-user-Downloads-DBO/197fc59c-41a3-46ad-9eaa-cff6753ac430/scratchpad/accounts_map.txt'
;(async () => {
  const b = await chromium.launch({ headless: true, proxy: { server: 'socks5://127.0.0.1:10810' } })
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })
  const page = await ctx.newPage()
  const dismiss = async () => { try { await page.evaluate(() => { const m=document.querySelector('[data-at="modal-ui/messages/mustRead"]'); if(m){const bs=[...m.querySelectorAll('button,[role=button]')]; (bs[bs.length-1]||{click(){}}).click()} }) } catch {} }
  await page.goto(`${BASE}/ru/html/login.html`,{waitUntil:'commit',timeout:30000})
  await page.waitForSelector('#userName',{timeout:30000,state:'attached'})
  try{await page.click('#btn',{timeout:3000})}catch{}
  await page.fill('#userName','24cmvky8');await page.fill('#password','dbocib14Z');await page.click('#submitButton')
  await page.waitForURL(u=>!u.toString().includes('login.html'),{timeout:30000,waitUntil:'commit'})
  await page.waitForTimeout(5000); await dismiss()
  let report='HOME url='+page.url()+'\n'

  // navigate to Счета / accounts
  for (const l of ['Счета и платежи','Счета','Мои счета','Продукты']) { try{await dismiss();await page.click(`text=${l}`,{timeout:2500});await page.waitForTimeout(2500);report+='clicked '+l+'\n'}catch{} }
  await page.waitForTimeout(1500); await dismiss()

  // capture full page text and extract 20-digit accounts with context
  const text = await page.evaluate(()=>document.body.innerText)
  report += '\n=== 20-digit accounts with context ===\n'
  const lines = text.split('\n').map(s=>s.trim()).filter(Boolean)
  for (let i=0;i<lines.length;i++){
    const m = lines[i].match(/\b(4\d{19})\b/)
    if (m) {
      const ctx = lines.slice(Math.max(0,i-3), i+3).join(' | ')
      report += `ACCT ${m[1]}  ::  ${ctx}\n`
    }
  }
  // also dump account cards structured
  const cards = await page.evaluate(()=>{
    const q=(s)=>Array.from(document.querySelectorAll(s))
    return q('[class*=card],[class*=account],[data-at*=account],li').map(e=>(e.textContent||'').replace(/\s+/g,' ').trim()).filter(t=>/4\d{19}/.test(t)||/ГО|корп|р\/с|расчет|карт/i.test(t)).filter(t=>t.length<200)
  })
  report += '\n=== account cards ===\n'+[...new Set(cards)].slice(0,30).join('\n')+'\n'
  fs.writeFileSync(OUT, report)
  await b.close(); console.log('DONE ->',OUT)
})()
