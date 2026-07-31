// Live end-to-end test of mobile read-documents: accounts + branches + statement.
// Run: node diag_read.js
const m = require('./mobile')
const fs = require('fs')

const USER = process.env.DBO_LOGIN || '24cmvKy8'
const PASS = process.env.DBO_PASSWORD || 'dbocib14Z'
const DEVICE = fs.readFileSync('.deviceid', 'utf8').trim()

;(async () => {
  const s = m.login(USER, PASS, DEVICE)
  console.log('login ->', s.ok ? 'ok ' + s.sessionId : JSON.stringify(s))
  if (!s.ok) return
  const sid = s.sessionId

  const acc = m.getAccounts(sid)
  console.log(`\nACCOUNTS (${acc.accounts.length}):`)
  for (const a of acc.accounts) console.log(`  ${a.number}  ${a.balance} ${a.currency}  ${a.name}`)

  const br = m.getBranches(sid)
  console.log(`\nBRANCHES (${br.branches.length}):`)
  for (const b of br.branches) console.log(`  ${b.bic}  ${b.uuid}  ${b.name}`)

  // Statement for each account over the last ~92 days; branch BIC auto-resolved from account.
  const to = new Date()
  const from = new Date(Date.now() - 92 * 864e5)
  console.log(`\nSTATEMENTS ${from.toLocaleDateString()} – ${to.toLocaleDateString()}:`)
  for (const a of acc.accounts) {
    const bic = br.byUuid[a.branchUuid] || ''
    const r = m.getStatement(sid, { accountNumber: a.number, branchBic: bic, from, to })
    const rows = (r.raw || '').match(/<d\b[^>]*\/>/g) || []
    console.log(`  ${a.number} (bic ${bic}): ${r.ok ? rows.length + ' rows' : r.error.code}`)
    for (const row of rows) {
      const n = (row.match(/n="([^"]*)"/) || [, ''])[1]
      const sum = (row.match(/s="([^"]*)"/) || [, ''])[1]
      console.log(`      ${sum.padStart(12)}  ${n}`)
    }
    if (r.ok) fs.writeFileSync(`_stmt_${a.number}.xml`, r.raw)
  }

  // Deposits: type-4 accounts (Счета по вкладу) + term-deposit deals list.
  const da = m.getDepositAccounts(sid)
  console.log(`\nDEPOSIT ACCOUNTS (${da.deposits.length}):`)
  for (const a of da.deposits) console.log(`  ${a.number}  ${a.balance} ${a.currency}  ${a.typeText}`)
  for (const type of ['1', '2']) {
    const dep = m.getDeposits(sid, { type })
    console.log(`DEPOSIT DEALS type=${type}: ${dep.ok ? dep.deals.length + ' deals, summary ' + JSON.stringify(dep.summary) : dep.error.code}`)
    for (const deal of dep.deals || []) {
      console.log(`   ${deal.Amount || ''} @ ${deal.InterestRate || ''}%  ${deal.PlacementPeriodStartDate || ''}–${deal.PlacementPeriodEndDate || ''}  bal ${deal.CurrentBalance || ''}`)
    }
  }

  // Corp cards: list + operations for each card.
  const cc = m.getCorpCards(sid)
  console.log(`\nCORP CARDS: ${cc.ok ? cc.cards.length + ' cards, summary ' + JSON.stringify(cc.summary) : cc.error.code}`)
  for (const c of cc.cards) {
    console.log(`  ${c.cardNumberMasked}  ${c.ownerName}  ${c.balance} ${c.currIso}  [${c.statusName}]`)
    const ops = m.getCorpCardOperations(sid, { cardId: c.cardId, from, to })
    console.log(`     operations: ${ops.ok ? (ops.raw.match(/<[a-z]\b/g) || []).length + ' nodes' : ops.error.code}`)
  }

  // Contractors (counterparties).
  const co = m.getContractors(sid)
  console.log(`\nCONTRACTORS (${co.ok ? co.contractors.length : co.error.code}):`)
  for (const c of (co.contractors || []).slice(0, 10)) {
    console.log(`  ${(c.name || '').slice(0, 34).padEnd(35)} ИНН ${(c.inn || '-').padEnd(12)} сч ${c.account || '-'}  ${c.bankName || ''}`)
  }
  if ((co.contractors || []).length > 10) console.log(`  … +${co.contractors.length - 10} more`)

  // Credits / loans.
  const cr = m.getCredits(sid)
  if (cr.ok) {
    console.log(`\nCREDITS (${cr.credits.length}):`)
    for (const c of cr.credits) console.log(`  ${c.Amount || ''} @ ${c.Rate || ''}%  долг ${c.Debt || ''}  просрочка ${c.Arrears || ''}  ${c.Status || ''}`)
  } else {
    console.log(`\nCREDITS: ${cr.error.code} ${cr.error.message}`)
  }

  // Payment orders (history) + full document read.
  const pl = m.getPayments(sid)
  console.log(`\nPAYMENTS (${pl.ok ? pl.days.length + ' days' : pl.error.code}):`)
  let firstDoc
  for (const day of (pl.days || []).slice(0, 4)) {
    console.log(`  ${day.date}`)
    for (const doc of day.documents) {
      firstDoc = firstDoc || doc
      console.log(`     №${doc.DocumentNumber}  ${doc.Amount}  → ${(doc.Receiver || '').slice(0, 30)} (${doc.ReceiverAccount})`)
    }
  }
  if (firstDoc) {
    const g = m.getPayment(sid, firstDoc.BankRecordID)
    console.log(`  GET ${firstDoc.BankRecordID}: ${g.ok ? Object.keys(g.payment).length + ' fields, ' + g.payment.PayerAccount + '→' + g.payment.ReceiverAccount : g.error.code}`)
  }
})()
