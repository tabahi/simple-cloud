'use strict';

// RFC 6238 TOTP — zero dependencies, Node `crypto` only.
//
// Used by the optional web UI as a second factor. Secrets are base32 strings
// (the format authenticator apps expect). Codes are 6 digits over a 30s window.

const crypto = require('crypto');

const DIGITS = 6;
const PERIOD = 30; // seconds
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// ── base32 (RFC 4648, no padding) ──────────────────────────────────────────────

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Invalid base32 character in TOTP secret');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ── TOTP ────────────────────────────────────────────────────────────────────────

// Generate a new random base32 secret (default 20 bytes = 160 bits, standard).
function generateSecret(bytes = 20) {
  return base32Encode(crypto.randomBytes(bytes));
}

// Compute the TOTP code for a given counter (time-step).
function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  // 64-bit big-endian counter
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter >>> 0, 4);

  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

// Current TOTP code for a base32 secret.
function generate(secretBase32, atMs = Date.now()) {
  const counter = Math.floor(atMs / 1000 / PERIOD);
  return hotp(base32Decode(secretBase32), counter);
}

// Verify a user-supplied code, allowing ±`window` steps for clock skew.
// Comparison is constant-time. Returns true/false.
function verify(token, secretBase32, window = 1, atMs = Date.now()) {
  if (!token || !secretBase32) return false;
  const clean = String(token).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(clean)) return false;

  let secretBuf;
  try {
    secretBuf = base32Decode(secretBase32);
  } catch (_) {
    return false;
  }

  const counter = Math.floor(atMs / 1000 / PERIOD);
  for (let w = -window; w <= window; w++) {
    const expected = hotp(secretBuf, counter + w);
    // Constant-time compare (both are 6 ASCII digits → equal length).
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(clean))) {
      return true;
    }
  }
  return false;
}

// Build an otpauth:// URL to show as a QR / paste into an authenticator app.
function otpauthURL(secretBase32, { issuer = 'simplecloud', account = 'web' } = {}) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(PERIOD),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = { generateSecret, generate, verify, otpauthURL, base32Encode, base32Decode };
