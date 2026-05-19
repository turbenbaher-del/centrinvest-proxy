/**
 * SRP6a implementation ported from BSS bank's srp.js + sha.js
 * Uses Node.js native BigInt and crypto module
 */
const crypto = require('crypto')

// SRP group parameters from bank's srp.js
const pN256 = BigInt('0x115b8b692e0e045692cf280b436735c77a5a9e8a9e7ed56c965f87db5b2a2ece3')
const pk256 = BigInt('0xdbe5dfe0704fee4c85ff106ecd38117d33bcfe50')
const pN2048 = BigInt('0xc0e67812bb81d36630372af77b286d35697fc7e45835ec1595ba407b429c15ea61a6c2137d31c8eeadac9e6f27933092ecca8b73a63ea77d65f3cf0bde06cf2d0ed8a0257d2f16f764b4bff73833dcd4be2a26853f554b47a8150f9a376f4243690654feb8e65b0c164620363adb5cdfb14e24bd7c6c9ba889b6ba967e9a369c2baf5d3500d0dbfaa608a03c3b19c83434203f5f793e4f996b61bd1fc7cbe982fef65ef20633402fa3b3880fcccc9fadaacce241c320c21a5917ec63da57fdb9d8a7b66dfa2fc5c1d4a416de06000e02823e9082e75c26cd0ac71dc6b8ee8aff1028f185e73fdb9e9aa9cf2923f70b4d7bbef172a343a7bba48781e54961aa7b')
const pk2048 = BigInt('0x1b4a84af4ee4b654bda282e742190299c7e5fdac')
const g = BigInt(2)

function sha1str(str) {
  return crypto.createHash('sha1').update(str, 'utf8').digest('hex')
}

function sha1hex(hexStr) {
  return crypto.createHash('sha1').update(Buffer.from(hexStr, 'hex')).digest('hex')
}

function powMod(base, exp, mod) {
  let result = BigInt(1)
  base = base % mod
  while (exp > BigInt(0)) {
    if (exp & BigInt(1)) result = result * base % mod
    exp >>= BigInt(1)
    base = base * base % mod
  }
  return result
}

function randomBigInt256() {
  return BigInt('0x' + crypto.randomBytes(32).toString('hex'))
}

class SRPClientContext {
  constructor(vS, vBbs, is2048) {
    this.pN = is2048 ? pN2048 : pN256
    this.pNBitsLen = is2048 ? 2048 : 264
    this.pk = is2048 ? pk2048 : pk256
    this.vS = vS       // first segment from prelogin (used as salt param in xCalculate)
    this.vBbs = vBbs   // B (server public key hex string)
    this.va = randomBigInt256()
    this.vA = powMod(g, this.va, this.pN)
  }

  getAbytes() {
    return this.vA.toString(16)
  }

  xCalculate(h, vS) {
    // calcSHA1Hex(vS + h) — SHA1 of hex bytes (vS concat h as hex strings → bytes)
    const x = BigInt('0x' + sha1hex(vS + h))
    return x >= this.pN ? x % this.pN : x
  }

  srpComputeU(aBytes, bBytes) {
    // Pad both to c = 2 * (pNBitsLen >> 3) chars
    const c = 2 * (this.pNBitsLen >> 3)
    const padded = aBytes.padStart(c, '0') + bBytes.padStart(c, '0')
    const u = BigInt('0x' + sha1hex(padded))
    return u >= this.pN ? u % this.pN : u
  }

  makeAuthorizationData(salt, password) {
    // h = SHA1(salt + ":" + password) as hex string
    const h = sha1str(salt + ':' + (password == null ? '' : password))

    // x = SHA1Hex(vS + h) as BigInt
    const x = this.xCalculate(h, this.vS)

    // u = SRP compute_u
    const u = this.srpComputeU(this.getAbytes(), this.vBbs)

    const B = BigInt('0x' + this.vBbs)
    if (B % this.pN === BigInt(0) || u === BigInt(0)) {
      throw new Error('Bad SRP server data')
    }

    // S = (B + N*k - g^x*k) mod N
    let d = powMod(g, x, this.pN) * this.pk
    let S = (B + this.pN * this.pk - d) % this.pN
    if (S < BigInt(0)) S += this.pN

    // S = S^(a + x*u) mod N
    const exp = this.va + x * u
    S = powMod(S, exp, this.pN)

    return sha1hex(S.toString(16))
  }
}

module.exports = { SRPClientContext }
