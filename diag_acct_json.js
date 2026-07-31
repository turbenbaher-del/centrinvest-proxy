const { chromium } = require('playwright-chromium')
const fs = require('fs')
const BASE = 'https://dbo.centrinvest.ru/sbns-web'
const OUT = 'C:/Users/user/AppData/Local/Temp/claude/C--Users-user-Downloads-DBO/197fc59c-41a3-46ad-9eaa-cff6753ac430/scratchpad/acct.jsonl'
;(async () => {
  const b = await chromium.launch({ headless: true, proxy: { server: 'socks5://127.0.0.1:10810' } })
  const ctx = await b.newContext({ ignoreHTTPSErrors: true, userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' })
  const page = await ctx.newPage()
  const out = fs.createWriteStream(OUT)
  page.on('response', async r=>{ try{ const u=r.url(); if(!u.includes('centrinvest.ru'))return; if(!(r.headers()['content-type']||'').includes('json'))return; const bd=await r.text(); if(/4\d{19}/.test(bd) || /ГО|корп|р\/с|alias|accountName|balance/i.test(bd)) out.write(JSON.stringify({url:u.replace('https://dbo.centrinvest.ru',''),len:bd.length,body:bd})+'\n') }catch{} })
  const dismiss=async()=>{try{await page.evaluate(()=>{const m=document.querySelector('[data-at="modal-ui/messages/mustRead"]');if(m){const bs=[...m.querySelectorAll('button,[role=button]')];(bs[bs.length-1]||{click(){}}).click()}})}catch{}}
  await page.goto(`${BASE}/ru/html/login.html`,{waitUntil:'commit',timeout:30000})
  await page.waitForSelector('#userName',{timeout:30000,state:'attached'})
  try{await page.click('#btn',{timeout:3000})}catch{}
  await page.fill('#userName','24cmvky8');await page.fill('#password','dbocib14Z');await page.click('#submitButton')
  await page.waitForURL(u=>!u.toString().includes('login.html'),{timeout:30000,waitUntil:'commit'})
  await page.waitForTimeout(6000); await dismiss()
  // click through accounts + open own-transfer (loads account list with aliases)
  for (const l of ['Счета и платежи','Счета','Оплатить','Создать','Между своими']) { try{await dismiss();await page.click(`text=${l}`,{timeout:2500});await page.waitForTimeout(2500)}catch{} }
  await page.waitForTimeout(2000)
  out.end(); await b.close(); console.log('DONE')
})()
