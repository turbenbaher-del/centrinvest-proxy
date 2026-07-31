# Перехват реального save-запроса платёжки (Frida)

Цель: снять **одно** реальное тело запроса, которое приложение шлёт при сохранении черновика
платёжки, и переиграть его через `mobile.js`. Это снимает блокер `CR000` на `save`.

## Почему Frida, а не mitmproxy
Банк отдаёт **GOST-TLS** сертификат. mitmproxy сидит посередине: `app → mitmproxy` (можно, если
подсунуть CA) **и** `mitmproxy → сервер` (нужен GOST-TLS, которого у mitmproxy/OpenSSL нет).
Плюс вероятен certificate pinning. Frida хукает **сам код приложения** и снимает тело **до TLS** —
ни GOST, ни пиннинг не мешают. Проксировать на сервер не нужно: тело мы переиграем сами.

**Что хукаем:** `androidx.appcompat.widget.y.m()` — сериализатор DOM→строка (реверс подтверждён:
Transformer+StreamResult, результат кладётся в поле `this.x` перед отправкой в okhttp). Хук читает
`this.x` и печатает готовый XML.

## Что понадобится
- Телефон с установленным приложением ЦентрИнвест (тот же аккаунт `24cmvKy8`), доступ к банку через РФ-IP.
- Frida на ПК: `pip install frida-tools` (проверь: `frida --version`).
- Один из способов запуска Frida на телефоне (см. ниже).

## Способ A — рутованный Android (проще всего)
1. Скачай `frida-server` под архитектуру телефона (обычно arm64) с github.com/frida/frida/releases,
   версию **в тон** desktop-frida (`frida --version`).
2. Залей и запусти под root:
   ```
   adb push frida-server-XX-android-arm64 /data/local/tmp/frida-server
   adb shell "chmod 755 /data/local/tmp/frida-server"
   adb shell "su -c /data/local/tmp/frida-server &"
   ```
3. С ПК спавни приложение с хуком:
   ```
   frida -U -f ru.centrinvest.mobilebank.mbk -l docs/frida_capture.js
   ```
   (`-U` = USB. Если приложение уже открыто — можно `frida -U -n "ЦентрИнвест" -l docs/frida_capture.js`.)

## Способ B — без root (repackage APK с gadget)
1. `pip install objection` (тянет frida).
2. Пропатчить APK (добавит frida-gadget, пересоберёт, подпишет):
   ```
   objection patchapk -s ru.centrinvest.mobilebank.mbk-48330.apk
   ```
3. Установить пропатченный `*.objection.apk` на телефон (удалив оригинал), запустить приложение —
   оно повиснет на старте, ожидая Frida. Затем:
   ```
   frida -U -n Gadget -l docs/frida_capture.js
   ```

## Снятие запроса
1. После `[capture] hook installed …` — залогинься в приложении.
2. (Санити-чек) открой «Счета» — если поставить `LOG_ALL = true` в скрипте, увидишь `[req] <R …account…>`.
3. Открой создание платежа: **любой** перевод (можно 10 ₽ на свой же счёт), заполни поля,
   нажми **«Сохранить»/«Сохранить как черновик»** — **НЕ подписывать!** (Save денег не двигает.)
4. В консоли появится блок:
   ```
   ===REQ PaymentOrder===
   <R v="…" t="document" n="PaymentOrder" c="…" s="…">…<RequestedAction v="SAVE"/>…</R>
   ===END===
   ```
5. Скопируй **весь** `<R …>…</R>` и пришли его сюда (или сохрани в `docs/_captured_save.xml`).
   Session `s="…"` можно затереть — важна структура (context, порядок и имена `<p n= v=>`, версия `v=`).

## Что дальше
По захваченному телу я:
- поправлю `savePaymentDraft()` в `mobile.js` под точный формат (context/версия/поля),
- проверю save-черновик через `mobile.js` (без денег),
- затем реализую подпись (put→Profiles→PayControl) — но **боевой SIGN_AND_SEND только с твоего явного
  подтверждения** конкретной суммы и счёта.

## Если хук не встал
- `could not hook y.m` — имя класса в твоей сборке иное. Запусти
  `frida -U -f ru.centrinvest.mobilebank.mbk -l -` и выполни `Java.enumerateLoadedClasses` или проще —
  сними лог `frida-trace -U -j 'javax.xml.transform.Transformer!transform' -f ru.centrinvest.mobilebank.mbk`
  (тело всё равно проходит через Transformer.transform — можно печатать его аргумент `DOMSource`).
- Приложение падает при старте (anti-Frida) — используй Способ B (gadget стелсовее) или добавь
  обход детекта (`frida-server` под другим именем/портом).
