const { chromium } = require('playwright-chromium')
const fs = require('fs')
const BASE = 'https://dbo.centrinvest.ru/sbns-web'
const OUT = 'C:/Users/user/AppData/Local/Temp/claude/C--Users-user-Downloads-DBO/197fc59c-41a3-46ad-9eaa-cff6753ac430/scratchpad/tmpl.txt'
const TARGET = '40802810626300001183'
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
  let rep='logged in: '+page.url()+'\n'
  // navigate to payments/templates
  for(const l of ['Счета и платежи','Платежи','Оплатить','Создать']){try{await dismiss();await page.click(`text=${l}`,{timeout:2500});await page.waitForTimeout(2000)}catch{}}
  await dismiss()
  // open templates
  for(const l of ['Все шаблоны','Шаблоны']){try{await dismiss();await page.click(`text=${l}`,{timeout:2500});await page.waitForTimeout(2500);rep+='clicked '+l+'\n'}catch{}}
  await page.waitForTimeout(1500)
  // dump template list text + whether target account visible
  const info = await page.evaluate((tgt)=>{
    const txt=document.body.innerText
    const q=(s)=>Array.from(document.querySelectorAll(s))
    return {
      title: document.title,
      hasTarget: txt.includes(tgt),
      tmplNames: [...new Set(q('[class*=template],[class*=card],li,tr').map(e=>(e.textContent||'').replace(/\s+/g,' ').trim()).filter(t=>t&&t.length<120&&/руб|₽|шаблон|ИП|ООО|ПОПЕНК/i.test(t)))].slice(0,25),
      bodyHasPopenkov: txt.includes('ПОПЕНКОВ'),
    }
  }, TARGET)
  rep+='\n'+JSON.stringify(info,null,1)
  fs.writeFileSync(OUT, rep)
  await b.close(); console.log('DONE hasTarget=',info.hasTarget)
})()
