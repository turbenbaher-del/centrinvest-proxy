const { chromium } = require('playwright-chromium')
const fs = require('fs')
const BASE = 'https://dbo.centrinvest.ru/sbns-web'
const OUT = 'C:/Users/user/AppData/Local/Temp/claude/C--Users-user-Downloads-DBO/197fc59c-41a3-46ad-9eaa-cff6753ac430/scratchpad/receiver.txt'
;(async () => {
  const b = await chromium.launch({ headless: true, proxy: { server: 'socks5://127.0.0.1:10810' } })
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })
  const page = await ctx.newPage()
  const dismiss=async()=>{try{await page.evaluate(()=>{const m=document.querySelector('[data-at="modal-ui/messages/mustRead"]');if(m){const bs=[...m.querySelectorAll('button,[role=button]')];(bs[bs.length-1]||{click(){}}).click()}})}catch{}}
  await page.goto(`${BASE}/ru/html/login.html`,{waitUntil:'commit',timeout:30000})
  await page.waitForSelector('#userName',{timeout:30000,state:'attached'})
  try{await page.click('#btn',{timeout:3000})}catch{}
  await page.fill('#userName','24cmvky8');await page.fill('#password','dbocib14Z');await page.click('#submitButton')
  await page.waitForURL(u=>!u.toString().includes('login.html'),{timeout:30000,waitUntil:'commit'})
  await page.waitForTimeout(6000);await dismiss()
  for(const l of ['Оплатить','Создать','Между своими счетами','Между своими']){try{await dismiss();await page.click(`text=${l}`,{timeout:2500});await page.waitForTimeout(2200)}catch{}}
  await page.waitForTimeout(1500);await dismiss()
  let report='title='+await page.title()+'\n'
  // pick payer first (ГО)
  try{ await page.click('[name="payerAccount"]',{force:true,timeout:5000}); await page.waitForTimeout(1200)
    await page.evaluate(()=>{const e=[...document.querySelectorAll('div,span,li,[role=option]')].find(x=>(x.textContent||'').trim().startsWith('ГО'));if(e)e.click()}); await page.waitForTimeout(1200)
    report+='payer picked\n'
  }catch(e){report+='payer err '+e.message+'\n'}
  // open receiver via data-at, dump options
  const openTry = async (sel) => {
    try{ await page.click(sel,{force:true,timeout:4000}); await page.waitForTimeout(1500)
      const opts = await page.evaluate(()=>[...new Set([...document.querySelectorAll('[role=option],li,[class*=option],[class*=item],[class*=dropdown] div,[class*=dropdown] span')].map(e=>(e.textContent||'').replace(/\s+/g,' ').trim()).filter(t=>t&&t.length<120))].slice(0,25))
      return opts
    }catch(e){return ['ERR '+e.message]}
  }
  report+='\n=== receiver via [data-at=select-receiverAccountId] ===\n'+(await openTry('[data-at="select-receiverAccountId"]')).join('\n')+'\n'
  await page.keyboard.press('Escape').catch(()=>{})
  fs.writeFileSync(OUT,report); await b.close(); console.log('DONE')
})()
