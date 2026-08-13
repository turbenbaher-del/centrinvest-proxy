// Самопроверка подписи БЕЗ похода в банк: `node sign-selftest.js`.
//
// Подставной банк отвечает ровно так, как снято с живой веб-версии
// (docs СВЕРКА-С-ВЕБ-ВЕРСИЕЙ.md, раздел «Как веб-версия подписывает документ»),
// а `browser.js` подменяется в кэше модулей — Playwright и сессия ДБО не нужны.
// Реальных банковских данных здесь нет: идентификаторы и суммы выдуманы.
//
// Что проверяется: ключ токена → код из СМС (с отклонённым кодом) → отправка;
// исчерпание попыток и синхронизация токена; PayControl с ожиданием и ручным
// кодом; запрет подписи строки; документ глубже первой страницы вкладки;
// истёкшая подпись. И главное — что continueSign не вызывается вовсе.
const path = require('path')
const ROOT = __dirname

const calls = []
let scenario = 'ok'

const cmd = (name, token, extra = {}) => ({ command: 'formInit', instanceName: name, instanceToken: token, ...extra })
const wrap = (commands) => ({ status: 200, json: { commands } })

let smsTries = 0
let sent = false
let noSign = false
let pages = 0
let marked = false

async function fakeBankApi(p, method, url, body) {
  calls.push({ method, url, body })
  const k = `${method} ${url}`

  if (k === 'POST /api/v1/menu/click') {
    const rows = scenario === 'paged'
      ? [{ id: 'DOC-OTHER', description: 'Чужой', actions: { sign: true } }]
      : [
        { id: 'DOC-OTHER', description: 'Чужой', actions: { sign: true } },
        { id: 'DOC-1', description: 'Оплата по счёту 70', actions: { sign: !noSign } },
      ]
    return wrap([
      cmd('ui/mixedDoc', 'T-root'),
      cmd('ui/mixedDoc/out/partlySigned', 'T-tab', {
        actions: { _sign: { label: 'Подписать', disabled: true }, _send: { label: 'Отправить', disabled: true }, loadMore: { label: 'Показать ещё' } },
        fields: { mixedDocs: { items: rows } },
      }),
    ])
  }

  if (k === 'PUT /api/v1/ui/mixedDoc/out/partlySigned/stateUpdate') {
    if (body.submitField !== 'mixedDocs') throw new Error('строка отмечается не тем полем: ' + body.submitField)
    if (JSON.stringify(body.fields?.mixedDocs?.value) !== JSON.stringify(['DOC-1'])) {
      throw new Error('отмечена не та строка: ' + JSON.stringify(body.fields))
    }
    marked = true
    // Банк отвечает на выделение строки командой stateUpdate: то же имя формы,
    // тот же токен, ОДНИ ПОЛЯ И НИ ОДНОЙ КНОПКИ. Приняв её за новую форму,
    // сервис терял действие подписи (живой прогон 13.08.2026). Здесь это
    // воспроизводится: если код заменит форму этим ответом, действий не
    // останется и подпись не начнётся.
    return wrap([{
      command: 'stateUpdate',
      instanceName: 'ui/mixedDoc/out/partlySigned',
      instanceToken: 'T-tab',
      fields: { mixedDocs: { items: [{ id: 'DOC-1', selected: true }] } },
    }])
  }
  if (k === 'PUT /api/v1/ui/mixedDoc/out/partlySigned/doAction' && body.actionId === 'loadMore') {
    pages += 1
    return wrap([cmd('ui/mixedDoc/out/partlySigned', 'T-tab-' + pages, {
      actions: { _sign: { label: 'Подписать' }, loadMore: { label: 'Показать ещё' } },
      fields: { mixedDocs: { items: pages === 1
        ? [{ id: 'DOC-OTHER' }, { id: 'DOC-2ND' }]
        : [{ id: 'DOC-OTHER' }, { id: 'DOC-2ND' }, { id: 'DOC-1', description: 'Со второй страницы', actions: { sign: true } }] } },
    })])
  }
  if (k === 'PUT /api/v1/ui/mixedDoc/out/partlySigned/doAction') {
    if (body.actionId !== '_sign') throw new Error('нажато не то действие: ' + body.actionId)
    if (!marked) throw new Error('подпись нажата, пока строка не отмечена — банк держит кнопку выключенной')
    if (JSON.stringify(body.fields?.mixedDocs?.value) !== JSON.stringify(['DOC-1'])) {
      throw new Error('строка грида отмечена неверно: ' + JSON.stringify(body.fields))
    }
    return wrap([cmd('ui/messages/errorsSave', 'T-es', {
      actions: { _back: { label: 'Вернуться к редактированию' }, _save: { label: 'Продолжить' } },
      fields: { message: { value: 'Проверка контрагента: сведения не подтверждены' } },
    })])
  }

  if (k === 'PUT /api/v1/ui/messages/errorsSave/doAction') {
    if (body.actionId !== '_save') throw new Error('в окне проверки нажато: ' + body.actionId)
    return wrap([cmd('client/cryptoProfileSelect', 'T-sel', {
      actions: { _save: { label: 'Далее' }, _close: { label: 'Отмена' } },
      fields: { cryptoProfiles: { items: [
        { id: 'CP-SMS', values: ['SmsCrypto'] },
        { id: 'CP-PC', values: ['приложение PayControl'] },
      ] } },
    })])
  }

  if (k === 'PUT /api/v1/client/cryptoProfileSelect/stateUpdate') return wrap([])
  if (k === 'PUT /api/v1/client/cryptoProfileSelect/doAction') {
    if (scenario === 'pc') {
      if (body.fields?.cryptoProfiles?.value !== 'CP-PC') throw new Error('выбрано не то средство: ' + JSON.stringify(body.fields))
      return wrap([cmd('client/paycontrol/sign', 'T-pc', {
        actions: { sign: { label: 'Подтвердить' }, _close: { label: 'Отмена' } },
        fields: {
          docDesc: { value: 'Платёжное поручение №54 на 1,00 ₽' },
          confirmCode: { value: '' },
          qrCode: { value: '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />' },
        },
        params: { confirmAttempts: 3 },
      })])
    }
    if (body.fields?.cryptoProfiles?.value !== 'CP-SMS') throw new Error('выбрано не то средство: ' + JSON.stringify(body.fields))
    return wrap([cmd('client/eTokenPassSign', 'T-etoken', {
      actions: { ready: { label: 'Подписать' }, _close: { label: 'Отмена' } },
      fields: { docDesc: { value: 'Платёжное поручение №54 на 1,00 ₽' }, serial: { value: '0123456789' }, key: { value: '' } },
      params: { maxAttempts: 3 },
    })])
  }

  if (k === 'PUT /api/v1/client/eTokenPassSign/stateUpdate') {
    if (body.submitField !== 'key') throw new Error('ключ уходит не в то поле: ' + body.submitField)
    return wrap([])
  }
  if (k === 'PUT /api/v1/client/eTokenPassSign/doAction') {
    if (body.actionId !== 'ready') throw new Error('на форме токена нажато: ' + body.actionId)
    if (scenario === 'sync') {
      return wrap([cmd('client/eTokenPassSynchronize', 'T-sync', {
        actions: { ready: { label: 'Подписать' } },
        fields: { serialNumber: { value: '0123456789' } },
        params: { errorMessage: 'Попытки ввода ключа исчерпаны' },
      })])
    }
    return wrap([cmd('client/smsSign', 'T-sms', {
      actions: { sign: { label: 'Подписать' }, regenerateButton: { label: 'Перегенерировать пароль' }, _close: { label: 'Отмена' } },
      fields: { docDesc: { value: 'Платёжное поручение №54 на 1,00 ₽' }, password: { value: '' } },
      params: { timeToLive: 300, phoneNumber: '+7 918 ***-**-11', hasAttempts: true },
    })])
  }

  if (k === 'PUT /api/v1/client/smsSign/stateUpdate') {
    if (body.submitField !== 'password') throw new Error('код уходит не в то поле: ' + body.submitField)
    return wrap([])
  }
  if (k === 'PUT /api/v1/client/smsSign/doAction') {
    if (body.actionId !== 'sign') throw new Error('на форме СМС нажато: ' + body.actionId)
    smsTries += 1
    if (smsTries === 1) {
      // Первый ввод банк отклоняет — ровно тем текстом, из-за которого всё затевалось
      return wrap([cmd('client/smsSign', 'T-sms2', {
        actions: { sign: { label: 'Подписать' }, _close: { label: 'Отмена' } },
        fields: { docDesc: { value: 'Платёжное поручение №54' }, password: { value: '' } },
        params: { errorMessage: 'Введен неверный пароль', timeToLive: 240, attemptsLeft: 2 },
      })])
    }
    return wrap([cmd('client/signResult', 'T-res', {
      actions: { send: { label: 'Отправить' }, _close: { label: 'Закрыть' } },
      fields: { total: { value: '1' }, success: { value: '1' }, failed: { value: '0' }, toSend: { value: '1' } },
    })])
  }

  if (k === 'PUT /api/v1/client/signResult/doAction') {
    if (body.actionId !== 'send') throw new Error('в итоге подписи нажато: ' + body.actionId)
    sent = true
    return wrap([cmd('ui/messages/confirmDialog', 'T-ok', {
      actions: { _ok: { label: 'ОК' } },
      fields: { message: { value: 'Документы отправлены в банк' } },
    })])
  }
  if (k === 'PUT /api/v1/ui/messages/confirmDialog/doAction') return wrap([])

  if (k === 'PUT /api/v1/client/paycontrol/sign/stateUpdate') {
    if (body.submitField !== 'confirmCode') throw new Error('код PayControl уходит не в то поле: ' + body.submitField)
    return wrap([])
  }
  if (k === 'PUT /api/v1/client/paycontrol/sign/doAction') {
    if (body.actionId !== 'sign') throw new Error('на форме PayControl нажато: ' + body.actionId)
    return wrap([cmd('client/signResult', 'T-res', {
      actions: { send: { label: 'Отправить' } },
      fields: { total: { value: '1' }, success: { value: '1' }, failed: { value: '0' }, toSend: { value: '1' } },
    })])
  }

  if (k === 'PUT /api/v1/client/eTokenPassSynchronize/stateUpdate') return wrap([])
  if (k === 'PUT /api/v1/client/eTokenPassSynchronize/doAction') {
    return wrap([cmd('client/signResult', 'T-res', {
      actions: { send: { label: 'Отправить' } },
      fields: { total: { value: '1' }, success: { value: '1' }, failed: { value: '0' }, toSend: { value: '1' } },
    })])
  }

  if (k === 'GET /api/v1/client/user') return { status: 200, json: { login: 'test' } }
  if (method === 'GET' && url.startsWith('/api/v1/doc/rur/payorders/list')) {
    return { status: 200, json: { list: [{ id: 'DOC-1', state: sent ? 'delivered' : 'new' }] } }
  }
  if (k === 'POST /api/v1/doc/rur/payorders/getUserCryptoProfiles') {
    return { status: 200, json: { cryptoProfiles: [
      { id: 'CP-ET', typeName: 'устройство eTokenPass', signAuthorityTypeCode: 'CONFIRM', signConfirm: true },
      { id: 'CP-SMS', typeName: 'SmsCrypto', signAuthorityTypeCode: 'SIGN' },
      { id: 'CP-PC', typeName: 'приложение PayControl', signAuthorityTypeCode: 'SIGN' },
    ] } }
  }

  throw new Error('подставной банк не знает запроса: ' + k)
}

// Подменяем browser.js: настоящий тянет Playwright и живой банк
const browserPath = require.resolve(path.join(ROOT, 'browser.js'))
require.cache[browserPath] = {
  id: browserPath, filename: browserPath, loaded: true, exports: {
    ensureLoggedIn: async () => ({ page: true }),
    bankApi: fakeBankApi,
    waitForAppReady: async () => true,
    bankBinary: async () => ({ buffer: Buffer.from('qr'), contentType: 'image/png' }),
    pickConfirmAction: (c) => {
      const acts = Object.entries(c?.actions || {}).map(([id, a]) => ({ id, label: String(a?.label || '') }))
      const go = acts.find(a => /продолж|сохран|подтверд|^да$|^ок$|отправ/i.test(a.label))
      return (go || acts[0] || { id: '_save' }).id
    },
    collectMessages: (c) => Object.values(c?.fields || {}).map(f => f?.value).filter(v => typeof v === 'string').join('. '),
    DOC_STATE_NAMES: { new: 'Создан', delivered: 'Доставлен' },
    SIGN_MODULE: 'doc/rur/payorders',
  },
}

const sign = require(path.join(ROOT, 'sign.js'))
const creds = ['user', 'pass']

const show = (name, r) => console.log('\n▸ ' + name + ':', JSON.stringify(r, null, 1))
let failed = 0
const check = (cond, what) => { console.log((cond ? '  ✓ ' : '  ✗ ') + what); if (!cond) failed++ }

;(async () => {
  console.log('=== СЦЕНАРИЙ 1: токен → СМС (первый код отклонён) → отправка ===')
  const start = await sign.signStart(...creds, { id: 'DOC-1', mainProfileId: 'CP-SMS', confirmProfileId: 'CP-ET' })
  show('signStart', start)
  check(start.stage === 'needKey' && start.mean.kind === 'etoken', 'банк просит ключ с токена')
  check(start.serial === '0123456789', 'серийник токена показан')

  const afterToken = await sign.signSubmitKey(...creds, { id: 'DOC-1', key: '111111' })
  show('ключ токена', afterToken)
  check(afterToken.stage === 'needKey' && afterToken.mean.kind === 'otp', 'дальше — код из СМС')
  check(afterToken.timeToLive === 300 && !!afterToken.phone, 'срок жизни кода и телефон переданы')

  const wrong = await sign.signSubmitKey(...creds, { id: 'DOC-1', key: '000000' })
  show('неверный код', wrong)
  check(wrong.stage === 'needKey' && (wrong.errors || [])[0] === 'Введен неверный пароль', 'отказ банка виден человеку')
  check(wrong.attempts === 2, 'осталось попыток — 2')

  const done = await sign.signSubmitKey(...creds, { id: 'DOC-1', key: '654321' })
  show('верный код', done)
  check(done.stage === 'done', 'документ подписан и отправлен')

  const sentAction = calls.find(c => c.url === '/api/v1/client/signResult/doAction')
  check(!!sentAction, 'нажата кнопка отправки в итоге подписи')
  check(!calls.some(c => /continueSign|prepareSign/.test(c.url)), 'continueSign НЕ вызывался ни разу')

  console.log('\n=== СЦЕНАРИЙ 2: попытки исчерпаны → синхронизация токена ===')
  scenario = 'sync'; smsTries = 0; sent = false; marked = false
  const s2 = await sign.signStart(...creds, { id: 'DOC-1' })
  check(s2.stage === 'needKey', 'снова просят ключ')
  const sync = await sign.signSubmitKey(...creds, { id: 'DOC-1', key: '222222' })
  show('после исчерпания попыток', sync)
  check(sync.stage === 'sync', 'банк просит синхронизацию')
  const after = await sign.signSyncToken(...creds, { id: 'DOC-1', firstKey: '111', secondKey: '222' })
  show('синхронизация', after)
  check(after.stage === 'done', 'после синхронизации документ ушёл в банк')

  console.log('\n=== СЦЕНАРИЙ 4: PayControl — ожидание на телефоне и ручной код ===')
  scenario = 'pc'; smsTries = 0; sent = false; marked = false
  const pcStart = await sign.signStart(...creds, { id: 'DOC-1', mainProfileId: 'CP-PC' })
  show('signStart (PayControl)', pcStart)
  check(pcStart.stage === 'confirm' && pcStart.confirmType === 'payControl', 'банк ждёт подтверждения на телефоне')
  check(String(pcStart.qrCode || '').startsWith('data:image'), 'QR отдан картинкой, а не ссылкой в контур')
  check(pcStart.attempts === 3, 'попыток подтверждения — 3')

  const waiting = await sign.signStatus(...creds, { id: 'DOC-1' })
  show('опрос статуса до подтверждения', waiting)
  check(waiting.stage === 'confirm', 'пока не подтвердили — ждём, а не выдаём успех')

  const pcDone = await sign.signSubmitKey(...creds, { id: 'DOC-1', key: '123456' })
  show('код из PayControl', pcDone)
  check(pcDone.stage === 'done', 'после кода документ ушёл в банк')

  console.log('\n=== СЦЕНАРИЙ 5: банк запретил подпись строки ===')
  scenario = 'ok'; noSign = true
  try {
    await sign.signStart(...creds, { id: 'DOC-1' })
    check(false, 'должно было упасть')
  } catch (e) { check(/не даёт подписать/.test(e.message), 'внятная ошибка: ' + e.message) }
  noSign = false

  console.log('\n=== СЦЕНАРИЙ 6: документ глубже первой страницы вкладки ===')
  scenario = 'paged'; pages = 0; smsTries = 0; sent = false; marked = false
  const paged = await sign.signStart(...creds, { id: 'DOC-1' })
  show('signStart (вторая страница)', paged)
  check(paged.stage === 'needKey', 'документ найден после «Показать ещё»')
  check(pages === 2, 'страниц догружено: ' + pages)
  await sign.signCancel(...creds, { id: 'DOC-1' })
  scenario = 'ok'

  console.log('\n=== СЦЕНАРИЙ 3: подпись не начата ===')
  try {
    await sign.signSubmitKey(...creds, { id: 'DOC-НЕТ', key: '1' })
    check(false, 'должно было упасть')
  } catch (e) { check(/не начата/.test(e.message), 'внятная ошибка: ' + e.message) }

  console.log('\nЗапросов к банку: ' + calls.length + ' | провалов проверок: ' + failed)
  process.exit(failed ? 1 : 0)
})().catch(e => { console.error('\nПАДЕНИЕ:', e); process.exit(1) })
