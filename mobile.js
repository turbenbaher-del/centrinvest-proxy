/**
 * Direct sbns-mobile client (no browser). Reverse-engineered from APK 48330.
 * See docs/sbns-mobile-protocol.md
 *
 * Transport notes:
 *  - Wire format is XML (Simple-XML framework), NOT JSON, despite the
 *    Content-Type: application/json the app sends. Compact tags: R=Request,
 *    A=Answer, E=Error.
 *  - The bank serves a GOST TLS certificate that Node's OpenSSL cannot parse
 *    (EPROTO / X509_PUBKEY decode error), so we shell out to curl.exe which
 *    uses Windows Schannel. Same approach as auth.js.
 */
const { execFileSync } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { MobileSRP } = require('./srp-mobile')

const BASE   = process.env.MOBILE_BASE   || 'https://dbo.centrinvest.ru:443/sbns-mobile'
const SUFFIX = process.env.MOBILE_SUFFIX || '/service/'
const ENDPOINT = `${BASE}${SUFFIX}?`
const UA = 'okhttp/4.12.0'

function xmlEscape(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

/** POST a raw XML document body via curl.exe. Returns { status, body }. */
function postXml(xml, { sessionId } = {}) {
  const args = [
    '-s', '-k', '-w', '\n[HTTP %{http_code}]',
    '-X', 'POST',
    '-H', 'Content-Type: application/json; charset=UTF-8',
    '-H', `User-Agent: ${UA}`,
  ]
  if (sessionId) args.push('-H', `Rts-request: ${sessionId}`)
  // Write body to a temp file as UTF-8 bytes and send via @file — passing the XML as a
  // command-line arg mangles Cyrillic (Windows converts argv to ANSI/cp1251).
  const tmp = path.join(os.tmpdir(), `sbns-${process.pid}-${postXml._n = (postXml._n || 0) + 1}.xml`)
  fs.writeFileSync(tmp, Buffer.from(xml, 'utf8'))
  args.push('--data-binary', `@${tmp}`, ENDPOINT)

  try {
    const out = execFileSync('curl.exe', args, { encoding: 'utf8', timeout: 20000, maxBuffer: 32 * 1024 * 1024 })
    const m = out.match(/\n\[HTTP (\d+)\]\s*$/)
    const status = m ? parseInt(m[1], 10) : 0
    const body = m ? out.slice(0, m.index) : out
    return { status, body }
  } finally {
    try { fs.unlinkSync(tmp) } catch {}
  }
}

/** Minimal XML value extractors for the flat RTS answers. */
function attr(xml, tag, name) {
  const re = new RegExp(`<${tag}\\b[^>]*\\b${name}="([^"]*)"`)
  const m = xml.match(re); return m ? m[1] : null
}
function elem(xml, name) {
  const re = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)
  const m = xml.match(re); return m ? m[1] : null
}
function parseError(xml) {
  const m = xml.match(/<e\b[^>]*\bn="([^"]*)"[^>]*>([\s\S]*?)<\/e>/)
  return m ? { code: m[1], message: m[2].trim() } : null
}

/** Step 1: preLogin — SRP params for a username. deviceId is REQUIRED (server P101). */
function preLogin(login, deviceId) {
  if (!deviceId) throw new Error('preLogin requires deviceId')
  const xml = `<R v="1.0" n="preLogin" t="auth" c=""><p login="${xmlEscape(login)}" d="${xmlEscape(deviceId)}"/></R>`
  const { status, body } = postXml(xml)
  const err = parseError(body)
  if (err) return { ok: false, status, error: err, raw: body }
  return {
    ok: true, status, raw: body,
    salt:       elem(body, 'salt'),
    bBytes:     elem(body, 'bBytes'),
    login:      elem(body, 'login'),       // internal user id
    clientSalt: elem(body, 'clientSalt'),
    preLoginId: elem(body, 'preLoginId'),
  }
}

/** Build the signin XML body from a preLogin response + password.
 *  Mobile SRP (reversed from q3/b): identity hash = SHA1(login:password) where
 *  `login` is the INTERNAL user id from preLogin (<login> in response), and
 *  x = SHA1hex(salt + h) — i.e. vS is `salt`, NOT clientSalt. */
function buildSignInXml(pre, password, deviceId, loginName) {
  const is2048 = (pre.bBytes || '').length > 66
  const srp = new MobileSRP(pre.salt, pre.bBytes, is2048)
  const passwordDataExt    = srp.authData(pre.login, password) // identity = internal id
  const extPasswordDataExt = srp.getAbytes()
  const p = `<p login="${xmlEscape(loginName)}" preLoginId="${xmlEscape(pre.preLoginId)}" d="${xmlEscape(deviceId)}"/>`
  return `<R v="1.0" n="signin" t="auth" c="">${p}`
    + `<passwordDataExt>${passwordDataExt}</passwordDataExt>`
    + `<extPasswordDataExt>${extPasswordDataExt}</extPasswordDataExt></R>`
}

const STEP = { '0': 'NONE', '': 'NONE', '1': 'SMS', '2': 'CARD_CODE', '3': 'TOKEN_PASS',
               '4': 'MAC', '5': 'SMS_OR_CARD_CODE', '6': 'SMS_OR_TOKEN_PASS' }

/** Step 2: signin — authenticates. MAY trigger a second factor (nextStep).
 *  IMPORTANT: loginData.login must be the USERNAME the user typed (loginName),
 *  while the SRP proof is computed over the INTERNAL id (pre.login). */
function signIn(pre, password, deviceId, loginName) {
  const xml = buildSignInXml(pre, password, deviceId, loginName)
  const { status, body } = postXml(xml)
  const err = parseError(body)
  if (err) return { ok: false, status, error: err, raw: body }
  const nextStep = attr(body, 's', 'n')
  return {
    ok: true, status, raw: body,
    sessionId:   attr(body, 's', 'v'),
    nextStep,
    nextStepName: STEP[nextStep] ?? `UNKNOWN(${nextStep})`,
    confirmAuth: attr(body, 's', 'cr'),
    changePassword: attr(body, 's', 'c'),
  }
}

/** Device fingerprint for macip (device registration). mac is empty — no crypto (reversed). */
function deviceInfoXml(deviceId) {
  const di = [
    `d="${xmlEscape(deviceId)}"`, `i=""`, `m=""`,
    `apv="4.8.3.30"`, `osv="Android 13 (API 33)"`, `osvk="TQ3A.230805.001"`,
    `pn="ru.centrinvest.mobilebank.mbk"`, `apc="48330"`,
    `model="Xiaomi Redmi Note 10 (sunny)"`, `termsDate=""`,
  ].join(' ')
  return `<p ${di}/>`
}

/** Step 3: macip — register/trust the device. Needed when signin returns nextStep=MAC. */
function sendDeviceMac(sessionId, deviceId) {
  // userSessionId is carried as attribute s on <R>; deviceInfo is <p>.
  const xml = `<R v="3.0" n="macip" t="auth" c="" s="${xmlEscape(sessionId)}">${deviceInfoXml(deviceId)}</R>`
  const { status, body } = postXml(xml, { sessionId })
  const err = parseError(body)
  if (err) return { ok: false, status, error: err, raw: body }
  return { ok: true, status, nextStep: attr(body, 's', 'n'), raw: body }
}

/** Authenticated document call. Session is passed as attribute s on <R> (KEY!). */
function call(sessionId, { name, documentType = 'auth', version = '1.0', context = '', childXml = '' }) {
  const xml = `<R v="${version}" n="${name}" t="${documentType}" c="${context}" s="${xmlEscape(sessionId)}">${childXml}</R>`
  const { status, body } = postXml(xml, { sessionId })
  const err = parseError(body)
  return { ok: !err, status, error: err, raw: body }
}

/** Parse the flat <a .../> account rows from a dictionary/account/user answer.
 *  Attr map (n4/b.c): a=number, b=balance, e=name, f=branchUuid, h=typeText,
 *  o=customerUuid, t=typeCode(1=р/с,4=депозит), u=serverId, v=curNum, y=curIso. */
function parseAccounts(xml) {
  const rows = []
  const re = /<a\b([^>]*)\/>/g
  let m
  while ((m = re.exec(xml))) {
    const at = (n) => (m[1].match(new RegExp(`\\b${n}="([^"]*)"`)) || [, ''])[1]
    rows.push({
      number: at('a'), balance: at('b'), name: at('e'), branchUuid: at('f'),
      typeText: at('h'), available: at('k'), customerUuid: at('o'),
      typeCode: at('t'), serverId: at('u'), currency: at('y'),
    })
  }
  return rows
}

/** Read: account list with balances. Reversed from t3/a.z:
 *  d("dictionary","account","user") → <R t="dictionary" n="account" c="user" s=sid/> (empty body). */
function getAccounts(sessionId) {
  const r = call(sessionId, { documentType: 'dictionary', name: 'account', context: 'user' })
  if (r.ok) r.accounts = parseAccounts(r.raw)
  return r
}

/** Read: customers + BRANCHES table. Reversed from t3/a.run case 27: f("dictionary","filter","user").
 *  Branch elements <f a=corrAcc b=BIK c=engName i=UUID n=name s=SWIFT .../> (parser n4/n0).
 *  Returns { branches: [{uuid,bic,name,corrAccount,swift}], byUuid: {uuid: bic} }.
 *  🔑 The statement <a f=…> needs Branch.I = branch @b (BIK), matched to an account by its branchUuid. */
function getBranches(sessionId) {
  const r = call(sessionId, { documentType: 'dictionary', name: 'filter', context: 'user' })
  if (!r.ok) return r
  const branches = []
  const byUuid = {}
  const re = /<f\b([^>]*)\/>/g
  let m
  while ((m = re.exec(r.raw))) {
    const at = (n) => (m[1].match(new RegExp(`\\b${n}="([^"]*)"`)) || [, ''])[1]
    const b = { uuid: at('i'), bic: at('b'), name: at('n'), corrAccount: at('a'), swift: at('s') }
    if (b.uuid) { branches.push(b); byUuid[b.uuid] = b.bic }
  }
  r.branches = branches
  r.byUuid = byUuid
  return r
}

/** Coerce a date to the epoch-millis STRING the bank expects (🔑 CR000 if not millis).
 *  Accepts: number/numeric-string (already ms), Date, or "dd.MM.yyyy". */
function toMillis(v) {
  if (v == null || v === '') return ''
  if (v instanceof Date) return String(v.getTime())
  if (typeof v === 'number') return String(v)
  const s = String(v)
  if (/^\d{11,}$/.test(s)) return s                       // already epoch ms
  const dm = s.match(/^(\d{2})\.(\d{2})\.(\d{4})$/)        // dd.MM.yyyy → local midnight
  if (dm) return String(new Date(+dm[3], +dm[2] - 1, +dm[1]).getTime())
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) return String(new Date(+iso[1], +iso[2] - 1, +iso[3]).getTime())
  return s
}

/** Read: statement (transactions) for one account over a period. Reversed from t3/b.i + t3/b.h.
 *  d("dictionary","statement","analytic") with <p> filter + <a> account child.
 *  Fields (t3/b, caller y.D): s=from, e=to (🔑 EPOCH MILLIS), t=OperationType(int, default 2),
 *  a=MinAmount, b=MaxAmount, c="0", g=""; sh="1" unless t==2; <a a=number f=branchBic/>; <c n=Receivers/>.
 *  branchBic = Branch @b (BIK) for the account's branch — see getBranches(). Max period ~1 year (P105).
 *  Analytic answer: <d n=counterparty o=order s=sum/>. */
function getStatement(sessionId, { accountNumber, branchBic = '', from, to, type = 2,
                                   amountFrom = '', amountTo = '', receivers = '' }) {
  const sh = type !== 2 ? ' sh="1"' : ''
  const p = `<p s="${toMillis(from)}" e="${toMillis(to)}" t="${type}"`
    + ` a="${xmlEscape(amountFrom)}" b="${xmlEscape(amountTo)}" g="" c="0"${sh}>`
    + `<a a="${xmlEscape(accountNumber)}" f="${xmlEscape(branchBic)}"/>`
    + `<c n="${xmlEscape(receivers)}"/></p>`
  return call(sessionId, { documentType: 'dictionary', name: 'statement', context: 'analytic', childXml: p })
}

/** Read: balance graph / rests for an account+period. Reversed from t3/b.j (same <p> filter, epoch ms). */
function getStatementGraph(sessionId, opts) {
  const { accountNumber, branchBic = '', from, to, type = 2 } = opts
  const sh = type !== 2 ? ' sh="1"' : ''
  const p = `<p s="${toMillis(from)}" e="${toMillis(to)}" t="${type}" a="" b="" g="" c="0"${sh}>`
    + `<a a="${xmlEscape(accountNumber)}" f="${xmlEscape(branchBic)}"/><c n=""/></p>`
  return call(sessionId, { documentType: 'dictionary', name: 'statementgraph40', context: 'all', childXml: p })
}

/** Parse a deposits/deals answer. Deals are <d>…</d> with <f n=Field v=Value/> children;
 *  <ds b=.. l=../> is the summary. Reversed from n4/g0 (mode 1) + InvestmentDeal fields. */
function parseDeals(xml) {
  const deals = []
  const dre = /<d\b[^>]*>([\s\S]*?)<\/d>/g
  let dm
  while ((dm = dre.exec(xml || ''))) {
    const fields = {}
    const fre = /<f\b[^>]*\bn="([^"]*)"[^>]*\bv="([^"]*)"[^>]*\/>/g
    let fm
    while ((fm = fre.exec(dm[1]))) fields[fm[1]] = fm[2]
    deals.push(fields)
  }
  const summary = {}
  const ds = (xml || '').match(/<ds\b([^>]*)\/>/)
  if (ds) { let am; const are = /\b(\w+)="([^"]*)"/g; while ((am = are.exec(ds[1]))) summary[am[1]] = am[2] }
  return { deals, summary }
}

/** Read: term deposits / placements (вклады). Reversed from InvestmentDealsListPresenter.B →
 *  InvestmentDealsListDataWorker → t3/s.R: d("deals","investmentsMinBalance","headers") with
 *  body <p p=PageNumber g=CustomerBankRecordId><p n="type" v="1|2"/></p> (1=deposits, 2=minBalance/НСО).
 *  Deal <f>-fields: Amount, InterestRate, PlacementPeriodStartDate/EndDate, CurrentBalance,
 *  ReplenishmentTerm, ContractDate, Status, PetitionStatus, InArchive, PetitionDate.
 *  Note: also the deposit is exposed as a type-4 account in getAccounts() (Счет по вкладу). */
function getDeposits(sessionId, { type = '1', page = 0, customerUuid } = {}) {
  if (!customerUuid) {
    const acc = getAccounts(sessionId)
    customerUuid = acc.ok && acc.accounts[0] ? acc.accounts[0].customerUuid : ''
  }
  const body = `<p p="${page}" g="${xmlEscape(customerUuid)}"><p n="type" v="${xmlEscape(type)}"/></p>`
  const r = call(sessionId, { documentType: 'deals', name: 'investmentsMinBalance', context: 'headers', childXml: body })
  if (r.ok) Object.assign(r, parseDeals(r.raw))
  return r
}

/** Convenience: deposit ACCOUNTS from the account list (typeCode "4" = Счет по вкладу (депозиту)). */
function getDepositAccounts(sessionId) {
  const r = getAccounts(sessionId)
  if (r.ok) r.deposits = r.accounts.filter((a) => a.typeCode === '4')
  return r
}

/** Corp-card <c .../> attribute → field map (reversed from n4/k, mode 4). */
const CORPCARD_ATTR = {
  a: 'accountNumber', b: 'branchUuid', i: 'cardId', o: 'customerUuid', s: 'statusName',
  t: 'type', ba: 'balance', bh: 'blockedFunds', cc: 'currCode', ce: 'cardNumberEncoded',
  ci: 'currIso', cn: 'cardNumberMasked', ed: 'expiryDate', en: 'ownerNameEmbossed',
  sn: 'status', ti: 'typeId', chn: 'ownerName', logo: 'typeLogo', personid: 'ownerId',
  digital: 'isDigital',
}

/** Parse a corpcard/getdict answer: <c .../> cards + <p b=.. l=../> summary. */
function parseCorpCards(xml) {
  const cards = []
  const re = /<c\b([^>]*)\/>/g
  let m
  while ((m = re.exec(xml || ''))) {
    const card = {}
    const are = /\b([a-z]+)="([^"]*)"/gi
    let am
    while ((am = are.exec(m[1]))) card[CORPCARD_ATTR[am[1]] || am[1]] = am[2]
    cards.push(card)
  }
  const summary = {}
  const p = (xml || '').match(/<p\b([^>]*)\/>/)
  if (p) { let am; const are = /\b(\w+)="([^"]*)"/g; while ((am = are.exec(p[1]))) summary[am[1]] = am[2] }
  return { cards, summary }
}

/** Read: corporate cards list. Reversed from t3/q.j (case CorpCard):
 *  d("dictionary","corpcard","getdict") + <p p=page o=CustomerBankRecordId cn=cardNumberFilter chn=search>
 *    [<a a=accNumber f=branchBic d=0|1|2/>]  (per-account filter, optional)
 *    [<s v=status/>]  (SYSTEM_STATUSES filter)  [<t v=typeId/>]  (CORP_CARD_TYPES_IDS filter).
 *  Card <c> fields (n4/k): accountNumber(a), cardId(i), customerUuid(o), statusName(s), status(sn),
 *  type(t)/typeId(ti), balance(ba), blockedFunds(bh), currCode(cc)/currIso(ci), cardNumberMasked(cn),
 *  expiryDate(ed, ms), ownerName(chn)/ownerNameEmbossed(en), ownerId(personid), isDigital(digital). */
function getCorpCards(sessionId, { customerUuid, page = 0, cardNumber = '', search = '',
                                   statuses = [], typeIds = [] } = {}) {
  if (!customerUuid) {
    const acc = getAccounts(sessionId)
    customerUuid = acc.ok && acc.accounts[0] ? acc.accounts[0].customerUuid : ''
  }
  let body = `<p p="${page}" o="${xmlEscape(customerUuid)}" cn="${xmlEscape(cardNumber)}" chn="${xmlEscape(search)}">`
  for (const s of statuses) body += `<s v="${xmlEscape(s)}"/>`
  for (const t of typeIds) body += `<t v="${xmlEscape(t)}"/>`
  body += `</p>`
  const r = call(sessionId, { documentType: 'dictionary', name: 'corpcard', context: 'getdict', childXml: body })
  if (r.ok) Object.assign(r, parseCorpCards(r.raw))
  return r
}

/** Read: corp-card operations (transactions) by day. Reversed from t3/a.M:
 *  d("dictionary","ccoperationsbyday","getdict") + <p p=page i=CORP_CARD_ID b=from e=to a=minAmt c=maxAmt>.
 *  cardId = the card's `cardId` (i) from getCorpCards(). Dates from/to → EPOCH MILLIS (as statement). */
function getCorpCardOperations(sessionId, { cardId, from, to, page = 0, minAmount = '', maxAmount = '' }) {
  let body = `<p p="${page}" i="${xmlEscape(cardId)}"`
  const f = toMillis(from), t = toMillis(to)
  if (f) body += ` b="${f}"`
  if (t) body += ` e="${t}"`
  if (minAmount !== '') body += ` a="${xmlEscape(minAmount)}"`
  if (maxAmount !== '') body += ` c="${xmlEscape(maxAmount)}"`
  body += `/>`
  return call(sessionId, { documentType: 'dictionary', name: 'ccoperationsbyday', context: 'getdict', childXml: body })
}

function xmlUnescape(s) {
  return String(s == null ? '' : s)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#13;/g, '\r').replace(/&#10;/g, '\n')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&')
}

/** Contractor <r .../> attribute → field map (reversed from n4/k mode 1 + live data). */
const CONTRACTOR_ATTR = {
  a: 'id', b: 'name', c: 'defaultPurpose', d: 'bankAddress', f: 'bankBic', g: 'bankName',
  h: 'city', j: 'cityType', s: 'account', v: 'inn', x: 'kpp', z: 'corrAccount',
  bu: 'isBudget', ja: 'city2', svc: 'riskCode', svm: 'riskMessage', email: 'email',
  phone: 'phone', t: 'branchUuid', y: 'customerUuid', idReq: 'idReq',
}

/** Parse a contractors/getdict answer: <p b=.. l=..> wrapper with <r .../> contractor rows. */
function parseContractors(xml) {
  const list = []
  const re = /<r\b([^>]*)\/>/g
  let m
  while ((m = re.exec(xml || ''))) {
    const c = {}
    const are = /\b([a-zA-Z]+)="([^"]*)"/g
    let am
    while ((am = are.exec(m[1]))) c[CONTRACTOR_ATTR[am[1]] || am[1]] = xmlUnescape(am[2])
    list.push(c)
  }
  const summary = {}
  const p = (xml || '').match(/<p\b([^>]*)>/)
  if (p) { let am; const are = /\b(\w+)="([^"]*)"/g; while ((am = are.exec(p[1]))) summary[am[1]] = am[2] }
  return { contractors: list, summary }
}

/** Read: contractors (counterparties) list. Reversed from t3/q.j (case Contractors):
 *  d("dictionary","contractors","getdict") + <p p=page g=CustomerBankRecordId d=search>
 *    [<p n="bu" v=onlyBudget/>] </p>. Response: <p b=.. l=..><r .../>…</p> (l="0" ⇒ has more).
 *  Contractor <r> fields: id(a), name(b), defaultPurpose(c), account(s), inn(v), kpp(x),
 *  corrAccount(z), bankBic(f), bankName(g), city(h), isBudget(bu), riskCode(svc)/riskMessage(svm),
 *  email, phone. Note: contractors/getfull is a SINGLE lookup by INN/account (needs params, else P102). */
function getContractors(sessionId, { customerUuid, page = 0, search = '', onlyBudget = '' } = {}) {
  if (!customerUuid) {
    const acc = getAccounts(sessionId)
    customerUuid = acc.ok && acc.accounts[0] ? acc.accounts[0].customerUuid : ''
  }
  let body = `<p p="${page}" g="${xmlEscape(customerUuid)}" d="${xmlEscape(search)}">`
  if (onlyBudget !== '') body += `<p n="bu" v="${xmlEscape(onlyBudget)}"/>`
  body += `</p>`
  const r = call(sessionId, { documentType: 'dictionary', name: 'contractors', context: 'getdict', childXml: body })
  if (r.ok) Object.assign(r, parseContractors(r.raw))
  return r
}

/** Read: credits / loans list. Reversed from t3/a.R + t3/a.t:
 *  d("deals","credits","headers") + <p p=page g=CustomerBankRecordId/>.
 *  Deals parsed as <d><f n=Field v=val/>…</d> (parser n4/g0, same shape as deposits → parseDeals).
 *  Credit <f>-fields: Amount, Rate, Debt, Fine, Arrears, Status, DateFrom, DateTo, ApplicationDate,
 *  DocumentDate, NextPaymentDate, NextPaymentAmount (deal types CreditContract/CreditApplication/CreditTerms).
 *  NB: returns P177 if the "Кредиты Light" service isn't enabled for the customer. */
function getCredits(sessionId, { customerUuid, page = 0 } = {}) {
  if (!customerUuid) {
    const acc = getAccounts(sessionId)
    customerUuid = acc.ok && acc.accounts[0] ? acc.accounts[0].customerUuid : ''
  }
  const body = `<p p="${page}" g="${xmlEscape(customerUuid)}"/>`
  const r = call(sessionId, { documentType: 'deals', name: 'credits', context: 'headers', childXml: body })
  if (r.ok) { Object.assign(r, parseDeals(r.raw)); r.credits = r.deals }
  return r
}

/** Read: available credit OFFERS. Reversed from t3/a.S: d("offers","credits","get") + <p p g/>.
 *  (P177 if no product currently available.) */
function getCreditOffers(sessionId, { customerUuid, page = 0 } = {}) {
  if (!customerUuid) {
    const acc = getAccounts(sessionId)
    customerUuid = acc.ok && acc.accounts[0] ? acc.accounts[0].customerUuid : ''
  }
  return call(sessionId, { documentType: 'offers', name: 'credits', context: 'get',
    childXml: `<p p="${page}" g="${xmlEscape(customerUuid)}"/>` })
}

/** Parse a document's <f n=Field v=value/> children into a field map (with unescaping). */
function parseDocFields(inner) {
  const f = {}
  for (const x of (inner || '').matchAll(/<f n="([^"]*)" v="([^"]*)"\s*\/?>/g)) f[x[1]] = xmlUnescape(x[2])
  return f
}

/** Parse a PaymentOrder/headersbyday answer: days <m n="date"> each with <d> documents. */
function parsePayments(xml) {
  const days = []
  for (const mm of (xml || '').matchAll(/<m\b[^>]*\bn="([^"]*)"[^>]*>([\s\S]*?)<\/m>/g)) {
    const documents = []
    for (const dm of mm[2].matchAll(/<d>([\s\S]*?)<\/d>/g)) documents.push(parseDocFields(dm[1]))
    days.push({ date: xmlUnescape(mm[1]), documents })
  }
  return days
}

/** Read: payment orders history (grouped by day). Reversed from t3/v.t + list dispatch:
 *  d("document","PaymentOrder","headersbyday") + <p p=page g=CustomerBankRecordId>
 *    [<a s=status/>] <f s=ListType t=PaymentType [b=from e=to m=receiver w=minAmt v=maxAmt]/></p>
 *  (dates epoch-ms). Doc <f>-fields: DocumentNumber, DocumentDate, Amount, PayerAccount, Receiver,
 *  ReceiverAccount, Ground, Status, PaymentType, BankRecordID, CustomerBankRecordID, BranchBankRecordID. */
function getPayments(sessionId, { customerUuid, page = 0, listType = 0, paymentType = 0,
                                  from, to, receiver = '', minAmount = '', maxAmount = '' } = {}) {
  if (!customerUuid) {
    const acc = getAccounts(sessionId)
    customerUuid = acc.ok && acc.accounts[0] ? acc.accounts[0].customerUuid : ''
  }
  let f = `<f s="${listType}" t="${paymentType}"`
  const fm = toMillis(from), tm = toMillis(to)
  if (fm) f += ` b="${fm}"`
  if (tm) f += ` e="${tm}"`
  if (receiver) f += ` m="${xmlEscape(receiver)}"`
  if (minAmount !== '') f += ` w="${xmlEscape(minAmount)}"`
  if (maxAmount !== '') f += ` v="${xmlEscape(maxAmount)}"`
  f += `/>`
  const body = `<p p="${page}" g="${xmlEscape(customerUuid)}">${f}</p>`
  const r = call(sessionId, { documentType: 'document', name: 'PaymentOrder', context: 'headersbyday', childXml: body })
  if (r.ok) r.days = parsePayments(r.raw)
  return r
}

/** Read: a single payment order with ALL fields. Reversed from t3/v.p:
 *  d("document","PaymentOrder","get") + <p i=BankRecordID/>. Returns the full field map
 *  (Payer/Receiver account, INN, KPP, BIC, bank, corrAccount, name; Amount, NDS, Ground, tax fields). */
function getPayment(sessionId, bankRecordId) {
  const r = call(sessionId, { documentType: 'document', name: 'PaymentOrder', context: 'get',
    childXml: `<p i="${xmlEscape(bankRecordId)}"/>` })
  if (r.ok) {
    const md = (r.raw || '').match(/<d>([\s\S]*?)<\/d>/)
    r.payment = parseDocFields(md ? md[1] : r.raw)
  }
  return r
}

/** Full login orchestrator: preLogin → signin → (macip if MAC) → returns { sessionId }. */
function login(user, password, deviceId) {
  const pre = preLogin(user, deviceId)
  if (!pre.ok) return { ok: false, stage: 'preLogin', error: pre.error }
  const si = signIn(pre, password, deviceId, user)
  if (!si.ok) return { ok: false, stage: 'signin', error: si.error }
  let sessionId = si.sessionId
  let nextStep = si.nextStepName
  if (si.nextStep === '4' || si.nextStepName === 'MAC') {
    const mac = sendDeviceMac(sessionId, deviceId)
    if (!mac.ok) return { ok: false, stage: 'macip', error: mac.error, sessionId }
    nextStep = STEP[mac.nextStep] ?? mac.nextStep
  }
  return { ok: true, sessionId, intId: pre.login, nextStep }
}

module.exports = {
  BASE, SUFFIX, ENDPOINT, STEP,
  postXml, xmlEscape, attr, elem, parseError,
  preLogin, buildSignInXml, signIn, deviceInfoXml, sendDeviceMac, call, login,
  getAccounts, parseAccounts, getBranches, getStatement, getStatementGraph, toMillis,
  getDeposits, getDepositAccounts, parseDeals,
  getCorpCards, getCorpCardOperations, parseCorpCards,
  getContractors, parseContractors, xmlUnescape,
  getCredits, getCreditOffers,
  getPayments, getPayment, parsePayments, parseDocFields,
}
