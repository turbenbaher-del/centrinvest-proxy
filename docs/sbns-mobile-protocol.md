# Протокол `sbns-mobile` (реверс из APK v4.8.3.30, build 48330)

Цель: заменить браузерный скрапинг `sbns-web` (Playwright) на прямые HTTP-запросы
к мобильному API банка. Реверс сделан androguard'ом из
`ru.centrinvest.mobilebank.mbk-48330.apk`.

## Транспорт

- **Base URL:** `https://dbo.centrinvest.ru:443/sbns-mobile`
- **Endpoint:** `<base>` + суффикс из SharedPreferences `SUFFIX` (дефолт `/service/`) + `?`
  → `https://dbo.centrinvest.ru:443/sbns-mobile/service/?`
- **Метод:** POST
- **Content-Type:** `application/json; charset=UTF-8`
- **Тело:** JSON-сериализация документа (класс-модель `screen/model/docs/**`).
  Сериализатор — `DocumentUtils` (метод `stringToXml` — историческое имя, по факту JSON).
- **Сессия:** после `signin` в ответе приходит `verification.sessionId`.
  Дальше он шлётся HTTP-заголовком. Имя заголовка хранится в prefs `HEADER_NAME_SID`,
  шаблон значения из BankBusinessCard.HTTP_Headers = `Rts-request=[SID]`
  → заголовок **`Rts-request: <sessionId>`** (плейсхолдер `[SID]` заменяется на sessionId).

## Конверт документа (BaseDocument)

Все запросы наследуют `BaseDocument` с полями:
```
version, name, documentType, context
```
`name` + `documentType` определяют действие. `context` обычно `""`.

## Auth-цепочка

### 1. preLogin  (без сессии)
`PreLoginRequest`:
```json
{
  "version": "1.0",
  "name": "preLogin",
  "documentType": "auth",
  "context": "",
  "authData": { "login": "<username>", "deviceId": "<optional>" }
}
```
`PreLoginResponse`:
```json
{ "bBytes": "...", "clientSalt": "...", "login": "...", "preLoginId": "...", "salt": "..." }
```
Маппинг на `srp.js`: `clientSalt→vS`, `bBytes→vBbs (B)`, `salt→salt`, `preLoginId` хранить.
Мобильный клиент использует **2048-битную** ветку SRP (поля `passwordDataExt`/`extPasswordDataExt`).

### 2. signin  (без сессии, создаёт её)
`SignInRequest`:
```json
{
  "version": "1.0",
  "name": "signin",
  "documentType": "auth",
  "context": "",
  "loginData": { "login": "...", "preLoginId": "<из preLogin>", "deviceId": "..." },
  "passwordDataExt": "<SRP makeAuthorizationData(salt, password)>",
  "extPasswordDataExt": "<SRP getAbytes() = A hex>"
}
```
`SignInResponse.verification`:
```json
{ "sessionId": "...", "nextStep": "0|1|2|3|4|5|6",
  "confirmAuth": "...", "changePassword": "...", "allowTouchIdForUser": "..." }
```
**nextStep** (второй фактор): `0`/`""`=NONE(готово), `1`=SMS, `2`=CARD_CODE,
`3`=TOKEN_PASS, `4`=MAC, `5`=SMS_OR_CARD_CODE, `6`=SMS_OR_TOKEN_PASS.
Логика в `SignInResponse$Verification.getNextStep()`.

⚠️ Для headless-прокси: новый `deviceId` почти наверняка потребует SMS-подтверждения
(nextStep=1). После подтверждения устройство становится доверенным
(functionality `trustedDevice`) и последующие логины с тем же deviceId идут без SMS.
→ План: один раз пройти подтверждение интерактивно, зафиксировать deviceId, переиспользовать.

### 3. confirmation (если nextStep != 0)
- `ConfirmationCodeRequest` — запросить код (SMS).
- `CheckConfirmationCodeRequest` — проверить введённый код.
- `SendDeviceMacRequest` — для MAC-фактора.

### 4. access (нужна сессия)
`GetAvailableAccessRequest`: `name="access"`, `documentType="auth"`.
Ответ `GetAvailableAccessResponse` — детали пользователя, доступы, настройки,
делегаты, WebIM-инфо и т.п.

### Прочее в auth
- `SignInAsDemoRequest` — `name="demologin"` (демо-вход, без пароля — удобно для тестов транспорта).
- `CheckSessionRequest` — `name="checksession"` (проверка живости сессии).
- `SigninByPinRequest`, `CreatePinCodeRequest`, `ResetPinCodeRequest` — пин-код.
- `GetSignatireMethodsRequest` (sic, опечатка вендора) — методы подписи.

## Bootstrap до логина
- `MyBankRequest` → `MyBankResponse { banks[], serverSettings, functionalitySettings }`.
  Обработчик `x2/b->u`: находит банк с `dbo==1`, берёт `service.url`, строит рабочий URL
  (`url + prefs[SUFFIX] + "?"`), сохраняет BankBusinessCard/ServerSettings/FunctionalitySettings
  в локальную (sqlcipher) БД. Даёт список фич (CorpCard, PaymentOrder, Statement, Chat, …).

## Классы-ориентиры (для дальнейшего реверса)
- Логин-оркестратор: `Lm9/u;->u(BaseDocument)` (считает SRP, строит SignInRequest).
- SRP: `Lq3/b;` (контекст), `Lq3/a;` (результат: passwordDataExt=`.d`, extPasswordDataExt=`.b`).
- Транспорт/отправка документа: `Lg3/g0;->a(BaseDocument, f0)`, URL: `Lg3/c;`, `Lp3/b;->d()`.
- Сериализация: `Lcom/bssys/mbcphone/screen/model/docs/DocumentUtils;` (stringToXml/xmlToString).
- Ответ myBank: `Lx2/b;->u()`.

## Каталог документов (все `screen/model/docs/**/*Request`)
Полный список классов есть; `name/documentType` для не-auth документов нужно
дочитать индивидуально (парсер путал их с полем `version`). Известные категории:
`docs/auth`, `docs/bank` (MyBank), `docs/dictionary` (Atm, Office, News, Versions,
Attachment, Localization), `docs/statement`, `docs/pay` (PaymentOrder), `docs/corpcard`,
`docs/sbp` и т.д. — соответствуют `assets/dynamic_structures/*.xml` из APK.

## Точный XML-формат (подтверждён annotations + живым сервером)

Формат — **XML** (Simple-XML), НЕ JSON. Content-Type `application/json` вводит в
заблуждение — сервер парсит тело как XML. Компактные теги: **`R`=Request, `A`=Answer,
`E`=Error**. Атрибуты конверта: `v`=version, `n`=name, `t`=documentType, `c`=context.

**preLogin (рабочий, проверен live):**
```xml
<R v="1.0" n="preLogin" t="auth" c=""><p login="<user>" d="<deviceId>"/></R>
```
- `<p>` = authData; атрибуты `login`, `d`=deviceId (**обязателен** — без него `P101`).
- Ответ:
```xml
<A v="1.0"><salt>..</salt><bBytes>..(512hex=2048bit)..</bBytes>
<login>1855071559</login><clientSalt>..</clientSalt><preLoginId>uuid</preLoginId></A>
```
- `login` в ответе — внутренний числовой id пользователя (не логин-строка).

**signin:**
```xml
<R v="1.0" n="signin" t="auth" c="">
  <p login="<user|id>" preLoginId="<из preLogin>" d="<deviceId>"/>
  <passwordDataExt>SRP.makeAuthorizationData(salt,password)</passwordDataExt>
  <extPasswordDataExt>SRP.getAbytes() (A hex)</extPasswordDataExt>
</R>
```
- Ответ: `<A v="1.0"><s v="<sessionId>" n="<nextStep>" c="<changePw>" cr="<confirmAuth>" touch=".."/></A>`
- `<s>` = verification; `v`=sessionId, `n`=nextStep, `c`=changePassword, `cr`=confirmAuth.

**Ошибка:** `<E v="1.0"><e l="0" n="<CODE>">текст</e></E>` (напр. `P101`, `CR000`).

## Статус
- [x] Транспорт (URL, метод, content-type, заголовок сессии `Rts-request`) — определён.
- [x] Формат — XML (Simple-XML), схема тегов R/A/E + атрибуты — извлечены из аннотаций.
- [x] Auth preLogin/signin/access — поля определены.
- [x] SRP — портирован в `srp.js` (2048-битная ветка, bBytes=512hex).
- [x] **preLogin проверен на живом сервере** — работает (`mobile.js`).
- [x] deviceId **обязателен** уже на preLogin.
- [x] **signin РАБОТАЕТ** — получаем `sessionId`. Ключевая деталь бага P301:
      `loginData.login` (`<p login=...>`) = **username** (`24cmvKy8`), а SRP-доказательство
      считается по **внутреннему id** (`pre.login`=1855071559). Разные значения в разных местах!
- [x] **MAC-шаг РЕШЁН** — `SendDeviceMacRequest` (name="macip", v3.0). Никакой крипты: `mac=""`.
- [x] **ВЕСЬ мобильный канал работает end-to-end** (login→access→данные, реальный пользователь).

### macip (регистрация устройства, после signin nextStep=MAC)
```xml
<R v="3.0" n="macip" t="auth" c="" s="<sessionId>"><p d="<deviceId>" i="" m=""
  apv="4.8.3.30" osv="Android 13 (API 33)" osvk="TQ3A.230805.001"
  pn="ru.centrinvest.mobilebank.mbk" apc="48330" model="<любой>" termsDate=""/></R>
```
- `<p>` = deviceInfo; атрибуты: `d`=deviceId, `i`=ip(""), `m`=mac(**""** — не крипта!),
  `apv`/`apc`=версия, `osv`/`osvk`=ОС, `pn`=пакет, `model`=Build, `termsDate`.
- Ответ `<A v="3.0"><s n="0"/></A>` → n=0 = NONE = устройство зарегистрировано.

### 🔑 ГЛАВНЫЙ КЛЮЧ ко всем авторизованным запросам
Сессия передаётся **атрибутом `s="<sessionId>"` на `<R>`** (а НЕ заголовком Rts-request!).
Без `s=` на конверте — `CR000`. Это относится и к macip, и к access, и ко всем data-документам.

### access (после macip, с s=)
`<R v="1.0" n="access" t="auth" c="" s="<sessionId>"/>` → реальные данные:
`<ui f="<ФИО>" id="<uuid>"/>`, `<lastAuth m="..."/>`, `<usersettings><corpcards>...`.
`checksession`: `<R v="1.0" n="checksession" t="auth" c="" s="<sid>"/>` → `<s v="1"/>`.

### Реализация (`mobile.js`) — рабочая
`login(user,pass,deviceId)` = preLogin→signin→(macip если MAC) → `{sessionId,intId}`.
`call(sessionId,{name,...})` — авторизованный документ (сам ставит `s=`). Проверено:
login ok, access → «ПОПЕНКОВ СЕРГЕЙ ВАСИЛЬЕВИЧ», checksession valid.
Мобильный endpoint **НЕ гео-блокируется** (в отличие от sbns-web) — работает с любого IP.
- [x] **Список счетов — РАБОТАЕТ live** (реальные балансы, см. «Data-документы чтения» ниже).
- [x] **Выписка — РАБОТАЕТ live end-to-end** (реальные контрагенты/суммы). Блокеры сняты: филиал = `filter/user`, **даты = epoch-миллисекунды** (см. ниже).
- [~] Отправка платежа + подпись (PayControl) — архитектура отревершена (см. ниже), сборка/тест в процессе.

## Data-документы чтения (accounts / statement) — реверс из dex 48330

Все data-запросы строятся методом `Lt3/p;->d(type, name, action)` →
`<R t="<type>" n="<name>" c="<action>" v="<ver>" s="<sid>">…</R>`. Полный каталог из
142 троек (type,name,action) собран в анализе; ключевые для чтения:

### Список счетов — ✅ РАБОТАЕТ (`Lt3/a;.z`)
`d("dictionary","account","user")` → `<R t="dictionary" n="account" c="user" v="1.0" s="<sid>"/>`
(**тело пустое**). Реализация: `mobile.js`→`getAccounts(sid)`. Ответ (проверено live):
```xml
<A v="1.0"><a a="40802810520000018686" b="107.07" e="ПОПЕНКОВ…(ИП)"
   f="05653bbb-…uuid" h="р/с" i="1" k="107.07" o="068a67b6-…uuid" t="1" u="1782950480306"
   v="810" y="RUR"/> … </A>
```
Маппинг атрибутов `<a>` (парсер `Ln4/b;.c`, switch по hashCode):
`a`→N (**номер счёта**), `b`→T (баланс, double), `c`→U, `d`→V, `e`→O (**имя/описание**),
`f`→J (**UUID филиала**), `h`→M (тип «р/с»/«депозит»), `i`→игнор, `o`→I (**UUID клиента/орг**),
`s`→W, `t`→L (тип-код: 1=расчётный, 4=депозит), `u`→Q (**серверный id счёта**),
`v`→Currency.I (810), `w`→X, `y`→Currency.H (RUR), `id`→G (внутр. id — в этом ответе ОТСУТСТВУЕТ),
`ab`→R, `sa`→Y, `abi`→S, `swa`→Z, `card`→e0, `sdoc`→d0, `srub`→h0, `srubcurr`→i0,
`sdoccurr`→g0, `contractID`→K, `clientName`→f0, `digitalCard`→j0. Атрибуты `k`,`m`,`p` — игнор.

### Таблица филиалов — ✅ `filter/user` (`Lt3/a;.run` case 27)
`f("dictionary","filter","user")` → `<R t="dictionary" n="filter" c="user" s="<sid>"/>` (пустое тело).
Ответ (парсер `Ln4/n0;`) — customers + **branches** + confirmation-настройки. Филиалы = элементы `<f>`:
```xml
<f a="30101810100000000762" b="046015762" c="CENTER-INVEST CB" i="05653bbb-…uuid"
   n="ПАО КБ ЦЕНТР-ИНВЕСТ" s="CCIVRU2R" g="Ростов-на-Дону" w="344000, …"/>
<f a="30101810400000000734" b="040702734" … i="f224b8e9-…" n="ФИЛИАЛ №4" s="CCIVRU2R"/>
```
Маппинг `<f>` (парсер, case 5): `a`→N(корр-счёт), **`b`→I (БИК = `Branch.I`!)**, `c`→L(eng),
`i`→J(**UUID**), `n`→G(имя), `s`→R(SWIFT), `m`→H, `g`→P(город)… Также в ответе `<c>` (клиент:
ИНН`a`, ОКПО`okpo`, UUID`i`), адреса `<ad>`, `<confirmation>` (какие доки требуют подпись),
`<v>` (флаги сервисов на клиента/филиал + `<contracts>`). `mobile.js`→`getBranches(sid)`
(отдаёт `branches[]` и `byUuid: {branchUuid: bic}`).
**Связь счёт↔филиал:** `Account.f`(UUID) === `Branch.i`(UUID) → берём `Branch.b` (БИК).

### Выписка — ✅ РАБОТАЕТ (`Lt3/b;.i`+`.h`, caller `y.D`)
`d("dictionary","statement","analytic")` + фильтр (Java из `t3/b.h`):
```xml
<R t="dictionary" n="statement" c="analytic" v="1.0" s="<sid>">
  <p s="<от EPOCH-MS>" e="<до EPOCH-MS>" t="2" a="<сумма от>" b="<сумма до>"
     g="" c="0">                   <!-- sh="1" ДОБАВЛЯЕТСЯ только если t != 2 -->
    <a a="<НОМЕР счёта>" f="<БИК филиала>"/>   <!-- f = Branch.I = <f b=…> из filter/user -->
    <c n="<Receivers / текст-фильтр>"/>
  </p></R>
```
Поля t3/b (из `y.D`): `G`=s=**StartDatePeriod (EPOCH-MS!)**, `H`=e=EndDatePeriod(EPOCH-MS),
`I`=a=`y3.d.c(MinAmount)`, `J`=b=MaxAmount, `K`=`<c n>`=Receivers, **`L`=t=OperationType, ДЕФОЛТ 2**.

**🔑 ГЛАВНОЕ (что снимало 2 блокера):**
1. `<a f=…>` = **БИК филиала** (`Branch.I`), берётся из `filter/user` по UUID счёта (см. выше).
   Неверный/пустой `f` → **P729 «Счёт не найден»**.
2. **Даты `s`/`e` — в EPOCH-МИЛЛИСЕКУНДАХ** (`new Date(...).getTime()`), НЕ «dd.MM.yyyy»!
   Любой строковый формат даты → **CR000 «Ошибка выполнения запроса»** (серверное исключение парса).
3. `t` (OperationType) дефолт **2**; период ≤ ~1 год (иначе **P105**).

**Ответ (analytic, сгруппировано по контрагенту):**
```xml
<A v="1.0"><d n="ООО …Ростсельмаш" o="4" s="0.01"/><d n="ИП Попенков…" o="1" s="120.00"/>…</A>
```
`<d n=контрагент o=порядок s=сумма/>`. Пустой период → `<A v="1.0"></A>` (валидно, 0 строк).
График/остатки — `d("dictionary","statementgraph40","all")` (тот же `<p>` epoch-ms), `Lt3/b;.j`.

**Проверено live (03.07.2026):** счёт `40802810600000018205` за 92 дня → 4 контрагента
(ИП Попенков 120.00/50.00, ПАО КБ Центр-инвест 20.00, ООО «Ростсельмаш» 0.01).

### Депозиты / вклады — ✅ РАБОТАЕТ
Депозит представлен **двумя способами**:
1. **Как счёт типа 4** в `getAccounts()` (`typeCode="4"`, `h="Счет по вкладу (депозиту)"`,
   номер 421xx). `mobile.js`→`getDepositAccounts(sid)` фильтрует их. У тест-клиента: `42109810909530500556`.
2. **Как «сделка» (срочный вклад/размещение)** — список через worker `InvestmentDealsListDataWorker`
   → `Lt3/s;.R` = `d("deals","investmentsMinBalance","headers")`, тело (из `t3/s.u` + презентер
   `InvestmentDealsListPresenter.B`): `<p p="<стр>" g="<CustomerBankRecordId>"><p n="type" v="1|2"/></p>`
   (**type 1=вклады/депозиты, 2=НСО/minBalance**). Ответ: `<A><ds b=.. l=../><d><f n=Поле v=знач/>…</d>…</A>`.
   Поля сделки `<d>` (парсер `Ln4/g0;`+`InvestmentDeal`): **Amount** (сумма), **InterestRate** (ставка),
   **PlacementPeriodStartDate/EndDate** (даты размещения/окончания), **CurrentBalance** (тек. остаток),
   **ReplenishmentTerm** (срок пополнения), **ContractDate**, **Status**, **PetitionStatus**, **InArchive**,
   **PetitionDate**. `mobile.js`→`getDeposits(sid,{type,customerUuid})` (авто-резолв customerUuid из счетов)
   → `{deals:[{Amount,InterestRate,…}], summary:{b,l}}`.
   Проверено live: у тест-клиента активных сделок нет (`<ds b="1" l="1"/>`, 0 `<d>`), вклад виден как счёт.

### Корпоративные карты — ✅ РАБОТАЕТ
**Список карт** (реверс `t3/q.j` case CorpCard → парсер `n4/k` mode 4):
`d("dictionary","corpcard","getdict")` + тело:
```xml
<R t="dictionary" n="corpcard" c="getdict" s="<sid>">
  <p p="<стр>" o="<CustomerBankRecordId>" cn="<фильтр по номеру>" chn="<поиск>">
    <a a="<номерСчёта>" f="<БИК>" d="0|1|2"/>   <!-- фильтр по счёту (опц.) -->
    <s v="<статус>"/>   <!-- SYSTEM_STATUSES (опц.) -->   <t v="<typeId>"/>   <!-- CORP_CARD_TYPES_IDS (опц.) -->
  </p></R>
```
Ответ: `<A><p b=.. l=../><c …/>…</A>`. Карта `<c>` (маппинг `n4/k`):
`a`→accountNumber, `b`→branchUuid, `i`→**cardId** (BankRecordID, нужен для операций), `o`→customerUuid,
`s`→statusName, `sn`→status, `t`→type, `ti`→typeId, `ba`→**balance**, `bh`→blockedFunds,
`cc`→currCode, `ci`→currIso, `cn`→**cardNumberMasked**, `ed`→expiryDate(ms), `chn`→**ownerName**,
`en`→ownerNameEmbossed, `personid`→ownerId, `digital`→isDigital. `mobile.js`→`getCorpCards(sid,{customerUuid,…})`
→ `{cards:[{cardNumberMasked,ownerName,balance,…}], summary}`.

**Операции по карте** (реверс `t3/a.M`): `d("dictionary","ccoperationsbyday","getdict")` +
`<p p="<стр>" i="<cardId>" b="<от EPOCH-MS>" e="<до EPOCH-MS>" a="<минСумма>" c="<максСумма>"/>`
(b/e/a/c — только если непусты). `mobile.js`→`getCorpCardOperations(sid,{cardId,from,to,minAmount,maxAmount})`.
Проверено live: у тест-клиента (ИП) корп-карт нет (`<p b="1" l="1"/>`, 0 `<c>`); запрос+парсер
провалидированы на синтетической карте (все поля разложены корректно).

### Контрагенты — ✅ РАБОТАЕТ live
`d("dictionary","contractors","getdict")` + тело `<p p="<стр>" g="<CustomerBankRecordId>" d="<поиск>">`
`[<p n="bu" v="<OnlyBudget>"/>]</p>`. Ответ: `<A><p b=.. l=..><r …/>…</p></A>` (**`l="0"` ⇒ есть ещё страницы**).
Контрагент `<r>` (парсер `n4/k` mode 1, поля-буквы `Contractor`; семантика по live-данным):
`a`→id(uuid), `b`→**name**, `c`→defaultPurpose(назначение), `d`→bankAddress, `f`→**bankBic**,
`g`→bankName, `h`/`ja`→city, `s`→**account**, `v`→**inn**, `x`→**kpp**, `z`→corrAccount,
`bu`→isBudget, `svc`→riskCode, `svm`→riskMessage(115-ФЗ), `email`, `phone`, `t`→branchUuid, `y`→customerUuid.
`mobile.js`→`getContractors(sid,{customerUuid,page,search,onlyBudget})` → `{contractors:[{name,inn,account,…}], summary}`
(`parseContractors` раскодирует XML-сущности через `xmlUnescape`). Проверено live: **20 контрагентов**
(Тинькофф/ТБанк, ИП Орехов, ИП Попенков в Центр-инвест/Альфа-банк — ИНН/счета/БИК корректны).
**`contractors/getfull`** — это ТОЧЕЧНЫЙ поиск одного корреспондента (по INN/ReceiverAccount/BankRecordID),
без параметров → **P102**; для списка использовать `getdict`.

### Кредиты — ✅ РАБОТАЕТ (формат подтверждён)
**Список кредитов** (`t3/a.R` + `t3/a.t`): `d("deals","credits","headers")` + `<p p="<стр>" g="<CustomerBankRecordId>"/>`.
Ответ — `<ds/>` + `<d><f n=Поле v=знач/>…</d>` (парсер `n4/g0` mode 0; та же форма, что депозиты → `parseDeals`).
Поля кредита `<f>`: **Amount** (сумма), **Rate** (ставка), **Debt** (тек. долг), **Fine** (штраф),
**Arrears** (просрочка), **Status**, **DateFrom/DateTo** (срок), **NextPaymentDate/NextPaymentAmount**
(след. платёж), **ApplicationDate**, **DocumentDate** (типы сделок CreditContract/CreditApplication/CreditTerms).
Также: **предложения** `d("offers","credits","get")` (`getCreditOffers`), заявка `d("bankrequest","credits","get")`.
`mobile.js`→`getCredits(sid,{customerUuid,page})` → `{credits:[{Amount,Rate,Debt,…}], summary}`.
Проверено live: у тест-клиента (ИП) услуга не подключена → осмысленный **P177 «Услуга 'D2BM. Кредиты Light'
не подключена»** (формат запроса корректен); парсер провалидирован на синтетическом кредите.

### Прочие reversed-триплеты (готовы к реализации)
корп-карты `dictionary/ccoperationsbyday/getdict` (`<p n=стр i=cardId b=от e=до a=сумма_от c=сумма_до>`,
`Lt3/a;.M`); контрагенты `dictionary/contractors/getfull` (`Lt3/a;.K`); переименование счёта
`dictionary/rename/account` (`<p i=Account.G n=НовоеИмя>`, `Lt3/s;.E` — использует `Account.G`);
СБП-выписка `dictionary/sbp/analytic` (`Lt3/x;.i`).

### Реализация клиента (всё ✅ live)
`mobile.js`: `getAccounts(sid)` → `{accounts:[{number,balance,name,branchUuid,typeCode,…}]}`;
`getBranches(sid)` → `{branches:[{uuid,bic,name,corrAccount,swift}], byUuid}`;
`getStatement(sid,{accountNumber,branchBic,from,to,type=2,amountFrom,amountTo,receivers})`
(`from/to` принимают Date/epoch-ms/`dd.MM.yyyy`/`yyyy-MM-dd` — `toMillis()` конвертит в epoch-ms);
`getStatementGraph(...)`; `parseAccounts()`, `toMillis()`. Тест-харнес `diag_read.js` (login→счета→
филиалы→выписка с авто-резолвом БИК по `byUuid[account.branchUuid]`).
Сырые ответы-образцы: `_accounts.xml`, `_filter.xml`, `_access.xml`.

### Платёжки: чтение — ✅ РАБОТАЕТ / отправка — ⚠️ save даёт CR000
**История платёжек** (`t3/v.t`): `d("document","PaymentOrder","headersbyday")` +
`<p p="<стр>" g="<CustomerBankRecordId>"><f s="<ListType>" t="<PaymentType>" [b=от e=до m=получатель
w=минСумма v=максСумма]/></p>` (даты epoch-ms). Ответ: `<ds/><m n="18 Июня 2026 г."><d><f n=Поле v=знач/>…</d></m>`
(документы сгруппированы по дням). `mobile.js`→`getPayments(sid,{…})` → `{days:[{date,documents:[{…}]}]}`.
**Полный документ** (`t3/v.p`): `d("document","PaymentOrder","get")` + `<p i="<BankRecordID>"/>` →
59 полей: `getPayment(sid,bankRecordId)` → `{payment:{PayerAccount,PayerINN,PayerBIC,PayerCorrAccount,
ReceiverAccount,ReceiverINN,ReceiverKPP,ReceiverBIC,ReceiverBankName,ReceiverCorrAccount,Receiver,
Amount,NDS,NDSCalculationType,NDSSystemName,Ground,DocumentNumber,DocumentDate(ms),PaymentType,
PaymentUrgent,OperType,CustomerBankRecordID,BranchBankRecordID,…}}`. Проверено live: 8 дней истории,
реальные переводы 10 ₽. (Шаблон для нового платежа — тот же `get`, но `<p i="">` + SearchParams-префилл.)

**⚠️ Отправка (save-черновик) — блокер CR000.** Реверс сериализации: `t3/r.l`=`d("document",doc.k(),"put")`
+ `<RequestedAction v="SAVE|SIGN|CONFIRM|SEND_NO_SIGN|…"/>`; поля — `BasePayDocument.K()` (`super`=BankRecordID/
Status/DocumentDate/DocumentNumber + `<u>`/`<sign>`) + SenderOfficials/CustomerBankRecordID/BranchBankRecordID
(это МИНИМАЛЬНЫЙ payload для put-под-подпись уже сохранённого документа). Полный save-черновик из формы шлёт
все вводимые поля. Перебор live (черновик, без денег): все поля из `get` / сокращённый набор / версии 1.0–7.0 /
context `put`+RequestedAction / context `save` / без RequestedAction — **везде CR000**. Read-операции тем же
`call()` работают → проблема специфична для write-контекста. **Осталось:** реверснуть точную сериализацию
формы сохранения (DocumentFormSaveWorker) ИЛИ перехватить реальный save-запрос приложения (mitmproxy на телефоне).
Send/подпись (PayControl) — архитектура ниже.

## Document-операции (создание/подпись/отправка платежа) — АРХИТЕКТУРА

Класс `t3/p` — база всех document-операций; `t3/u` — билдер операций; `t3/c` — подпись/код.

### Конверт запроса (`t3/p.c(type, name, action, version)`)
Метаданные запроса (u3/y) → атрибуты `<R>` на проводе:
- `RequestType` (p4) → `t`   — напр. `"document"`, `"dictionary"`, `"auth"`
- `RequestName` (p5) → `n`   — имя документа/типа (напр. тип PaymentOrder)
- `RequestContext` (p6) → `c` — **ДЕЙСТВИЕ**: `put` / `save` / `send` / `code`
- `RequestVersion` (p7) → `v` — версия (из `w.A.k(type,name,action,0)[1]`, деф. "1.0")
- `RequestSID` → `s` — сессия (если `!C` и есть sid) — тот же ключ `s=`, что в auth
Тело = DOM (`x.e()`), дочерние элементы добавляются в `documentElement`.

### Пример: справочник GoodsService (`t3/u.k()`) — образец сериализации
`d("dictionary","goodsservice","save")` → `<R t="dictionary" n="goodsservice" c="save" ...>`
`<p i="<id>" n="<Name>" nd="<NdsType>" o="<CustomerBankRecordId>" p="<Price>" u="<Units>"/>`

### Флоу подписи (`t3/u.l()` + `t3/c`)
1. `d("document", <docType>, "put")` → `h(doc)` добавляет `<RequestedAction>` (SIGN/SEND/
   SIGN_AND_SEND/ACCEPT/REFUSE/COMPLETE → MULTI_*). Отправка `g()`.
2. Ответ содержит `Profiles` (профили подписи). Если пусто → ошибка L312 (нет подписи).
3. По профилям → PayControl: bundle {Profiles, OperationID=UUID} → `MBSClient.S.M()`.
4. Подтверждение (`t3/c.i/j`): `code` = введённый код; если `a.v()` истинно →
   подпись `u3.h.g(SIGN_PARAMS, code, key)`, иначе сырой code. Запрос:
   `d(G,"code","send")` → элемент `<c>`=code/подпись + `<u>`=AuthProfileUID. Ответ: AttemptsLeft/DeviceState.

### Осталось для сборки
- Точное имя типа документа PaymentOrder (`F`) + сериализация ВСЕХ полей структуры в тело "put".
- Round-trip put→Profiles→PayControl→send code; разбор `u3.h.g` (нужна ли клиентская подпись при PayControl или код сырой).
- Тест: сначала `save` (черновик, БЕЗ денег), затем `SIGN_AND_SEND` (боевой, PayControl на телефоне).

### SRP полностью реверснут (класс q3/b, метод c) и реализован в `srp-mobile.js`:
- Приватный `a = BigInteger(256, Random)`, `A = 2^a mod N`.
- Параметры 2048-бит: N, k (жёстко зашиты, совпали с APK). g=2.
- Идентификационный хэш `h = SHA1(login + ":" + password)`, где `login` = **внутренний id**
  из `<login>` ответа preLogin (напр. 1855071559). `f9/d.n` = `MessageDigest("SHA-1")`.
- `x = SHA1(salt || h)` (hex-decode, salt = поле `salt`, НЕ clientSalt). Если x>N: x%=N.
- `u = SHA1( PAD_left(hexUpper(A), 512) || PAD_left(hexUpper(B), 512) )`. Если u>N: u%=N.
- `S = (B + N*k - k*g^x) mod N`, затем `S = S^(a + x*u) mod N`.
- `passwordDataExt = SHA1( hexUpper(S) )`, `extPasswordDataExt = hexUpper(A)`.
- Хэш `q3/b.b` подтверждён как стандартный SHA-1 (побайтовое совпадение, 3/3 теста).
- Перебраны: identity∈{intId,user,user.lower}, hash∈{sha1,sha256,streebog256/512},
  saltX∈{salt,clientSalt}, ветки 2048/256 — **все дают P301**.
- ⚠️ Railway-прокси на браузерном логине ловит page.goto timeout к sbns-web →
  косвенный признак, что боевой web-логин тоже не проходит (пароль мог смениться).
- [ ] deviceId/trustedDevice — стратегия, чтобы не ловить SMS на каждый вход.
- [ ] Каталог data-документов (accounts, statement, payments) — поля запросов/ответов.

## Реализация
`mobile.js` — рабочий клиент (curl.exe для ГОСТ-TLS + XML). Функции:
`preLogin()` (live-ok), `buildSignInXml()`, `signIn()`, `postXml()`, парсеры `attr/elem/parseError`.
