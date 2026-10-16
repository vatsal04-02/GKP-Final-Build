// Run: node n8n/snippets/hmac-sha256.test.js
// Checks the plain-JS HMAC against Node's own crypto, so a typo in the SHA-256 constants cannot hide.
const assert = require('assert');
const crypto = require('crypto');
const { hmacSha256Hex, sha256Bytes, utf8Bytes, safeEqual } = require('./hmac-sha256');

const ref = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex');

// RFC 4231 test case 1 and 2
assert.strictEqual(hmacSha256Hex('\x0b'.repeat(20), 'Hi There'), 'b0344c61d8db38535ca8afceaf0bf12b881dc200c9833da726e9376c2e32cff7');
assert.strictEqual(hmacSha256Hex('Jefe', 'what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');

// plain SHA-256 of "abc" (FIPS 180-2 example)
assert.strictEqual(Buffer.from(sha256Bytes(utf8Bytes('abc'))).toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');

// message lengths around the 55/56/63/64/65 byte padding boundaries, long keys, unicode, empty
let n = 0;
for (const len of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 121, 127, 128, 129, 1000, 2939]) {
  for (const keyLen of [0, 1, 20, 63, 64, 65, 200]) {
    const msg = crypto.randomBytes(len).toString('base64').slice(0, len);
    const key = crypto.randomBytes(keyLen).toString('base64').slice(0, keyLen);
    assert.strictEqual(hmacSha256Hex(key, msg), ref(key, msg), `len ${len}, key ${keyLen}`);
    n++;
  }
}
for (const s of ['नमस्ते', 'Ünïcödé ✓', '😀 emoji 𝒳', '{"name":"Asha Rao","note":"café"}']) {
  assert.strictEqual(hmacSha256Hex('s3cret-ключ', s), ref('s3cret-ключ', s), s);
  n++;
}
for (let i = 0; i < 300; i++) {
  const msg = JSON.stringify({ i, r: crypto.randomBytes(1 + (i % 90)).toString('hex') });
  assert.strictEqual(hmacSha256Hex('k' + i, msg), ref('k' + i, msg));
  n++;
}

assert.strictEqual(safeEqual('abc', 'abc'), true);
assert.strictEqual(safeEqual('abc', 'abd'), false);
assert.strictEqual(safeEqual('abc', 'abcd'), false);
assert.strictEqual(safeEqual('', ''), true);

console.log(`All ${n + 7} hmac-sha256 cases pass (identical to Node crypto)`);
