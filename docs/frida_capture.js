/*
 * Frida capture of sbns-mobile request bodies for ru.centrinvest.mobilebank.mbk (build 48330).
 *
 * Hooks androidx.appcompat.widget.y.m() — the app's DOM→String request serializer (Transformer +
 * StreamResult). It stores the fully-built request XML in the field `this.x` right before the body
 * is handed to okhttp. Reading it here gives the exact wire payload in PLAINTEXT, before TLS — so
 * this works regardless of the GOST TLS / certificate pinning on the network leg.
 *
 * Usage (see CAPTURE_GUIDE.md):
 *   frida -U -f ru.centrinvest.mobilebank.mbk -l frida_capture.js
 * Then in the app: open a payment, fill it, tap SAVE (Сохранить как черновик) — do NOT sign.
 * Grep the console for  ===REQ PaymentOrder===  and copy the whole <R …>…</R> line.
 */
'use strict';

// Set to true to see EVERY request body (noisy — good for a first sanity check).
var LOG_ALL = false;

Java.perform(function () {
  try {
    var Y = Java.use('androidx.appcompat.widget.y');

    Y.m.overload().implementation = function () {
      var ret = this.m();            // run the original serializer
      try {
        var body = this.x.value;     // serialized request XML (String field `x`)
        if (body) {
          var s = '' + body;
          var isDoc = s.indexOf('PaymentOrder') !== -1 || s.indexOf('RequestedAction') !== -1;
          if (isDoc) {
            send('===REQ PaymentOrder===\n' + s + '\n===END===');
            console.log('\n\n===REQ PaymentOrder===\n' + s + '\n===END===\n');
          } else if (LOG_ALL) {
            console.log('[req] ' + s.slice(0, 160));
          }
        }
      } catch (e) {
        console.log('[capture] read this.x failed: ' + e);
      }
      return ret;
    };

    console.log('[capture] hook installed on androidx.appcompat.widget.y.m() — do a draft SAVE in the app.');
  } catch (e) {
    console.log('[capture] could not hook y.m: ' + e +
      '\n  → the class name may differ in your build; run  frida-trace  or dump classes to confirm.');
  }
});
