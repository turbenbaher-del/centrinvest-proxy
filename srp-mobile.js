/**
 * SRP client for sbns-MOBILE, ported to exactly match APK class q3/b
 * (build 48330). Differs from the web srp.js in hex formatting of u and S:
 *   - hex via q3/b.a():  bigint.toString(16).toUpperCase(), left-pad to EVEN length
 *     (NOT fixed 512-width padding like the web variant)
 *   - identity hash uses the INTERNAL login id: h = SHA1(login + ":" + password)
 *   - x = SHA1hex(salt + h)   (salt field, not clientSalt)
 *   - S = (B + N*k - k*g^x) ^ (a + u*x) mod N ; proof = SHA1hex( evenHex(S) )
 * Hashes: f9/d.n = SHA1(utf8 string); q3/b.b = SHA1(hex-decoded bytes).
 */
const crypto = require('crypto')

const N2048 = BigInt('0xc0e67812bb81d36630372af77b286d35697fc7e45835ec1595ba407b429c15ea61a6c2137d31c8eeadac9e6f27933092ecca8b73a63ea77d65f3cf0bde06cf2d0ed8a0257d2f16f764b4bff73833dcd4be2a26853f554b47a8150f9a376f4243690654feb8e65b0c164620363adb5cdfb14e24bd7c6c9ba889b6ba967e9a369c2baf5d3500d0dbfaa608a03c3b19c83434203f5f793e4f996b61bd1fc7cbe982fef65ef20633402fa3b3880fcccc9fadaacce241c320c21a5917ec63da57fdb9d8a7b66dfa2fc5c1d4a416de06000e02823e9082e75c26cd0ac71dc6b8ee8aff1028f185e73fdb9e9aa9cf2923f70b4d7bbef172a343a7bba48781e54961aa7b')
const k2048 = BigInt('0x1b4a84af4ee4b654bda282e742190299c7e5fdac')
const N256  = BigInt('0x115b8b692e0e045692cf280b436735c77a5a9e8a9e7ed56c965f87db5b2a2ece3')
const k256  = BigInt('0xdbe5dfe0704fee4c85ff106ecd38117d33bcfe50')
const G = 2n

const sha1str = s => crypto.createHash('sha1').update(String(s), 'utf8').digest('hex')          // f9/d.n
const sha1hex = h => crypto.createHash('sha1').update(Buffer.from(h, 'hex')).digest('hex')        // q3/b.b

/** q3/b.a — BigInteger -> uppercase hex, left-padded to even length. */
function evenHex(bi) {
  let h = bi.toString(16).toUpperCase()
  if (h.length % 2 === 1) h = '0' + h
  return h
}

function powMod(base, exp, mod) {
  let r = 1n; base %= mod
  while (exp > 0n) { if (exp & 1n) r = r * base % mod; exp >>= 1n; base = base * base % mod }
  return r
}

class MobileSRP {
  constructor(salt, bBytesHex, is2048) {
    this.salt = salt
    this.Bhex = bBytesHex
    this.N = is2048 ? N2048 : N256
    this.k = is2048 ? k2048 : k256
    this.bitLen = is2048 ? 2048 : 264            // q3/b.e field
    this.hexWidth = (this.bitLen >> 3) * 2       // u-padding width: 512 (2048) / 66 (256)
    // private a = new BigInteger(256, Random)
    this.a = BigInt('0x' + crypto.randomBytes(32).toString('hex'))
    this.A = powMod(G, this.a, this.N)
  }

  /** extPasswordDataExt = A as even-hex (matches a(this.h)). */
  getAbytes() { return evenHex(this.A) }

  /** passwordDataExt = q3/b.c(login, password). */
  authData(login, password) {
    const h = sha1str(login + ':' + (password == null ? '' : password))
    let x = BigInt('0x' + sha1hex(this.salt + h))
    if (x > this.N) x = x % this.N
    const B = BigInt('0x' + this.Bhex)
    // u = SHA1( PAD_LEFT(evenHex(A), width) + PAD_LEFT(evenHex(B), width) )
    const padA = evenHex(this.A).padStart(this.hexWidth, '0')
    const padB = evenHex(B).padStart(this.hexWidth, '0')
    let u = BigInt('0x' + sha1hex(padA + padB))
    if (u > this.N) u = u % this.N
    const gx = powMod(G, x, this.N)
    let S = (B + this.N * this.k - gx * this.k) % this.N
    if (S < 0n) S += this.N
    S = powMod(S, this.a + x * u, this.N)
    return sha1hex(evenHex(S))
  }
}

module.exports = { MobileSRP, evenHex, sha1str, sha1hex }
