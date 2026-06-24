'use strict';

// Helper invoked by setup.sh to provision the web UI without reimplementing
// scrypt/TOTP in bash. Reads the password from stdin (so it never appears in
// the process list / shell history) and prints, to stdout:
//
//   SC_WEB_PASSWORD_HASH=...
//   SC_WEB_SESSION_SECRET=...
//   SC_WEB_TOTP_SECRET=...           (only when 2FA is on)
//   #OTPAUTH <otpauth://...>          (comment line setup.sh shows to the user)
//
// Usage: echo -n "<password>" | node src/web/setupWeb.js [--no-totp]

const crypto = require('crypto');
const totp = require('./totp'); // dependency-free; safe to load standalone

// Inline scrypt hashing (mirrors webSession.hashPassword) so this helper has no
// dependency on config/dotenv — it runs during setup before `npm install`.
function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 32);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
  });
}

(async () => {
  const noTotp = process.argv.includes('--no-totp');
  const password = (await readStdin()).replace(/\r?\n$/, '');
  if (!password) {
    process.stderr.write('No password provided on stdin\n');
    process.exit(1);
  }

  const out = [];
  out.push(`SC_WEB_PASSWORD_HASH=${hashPassword(password)}`);
  out.push(`SC_WEB_SESSION_SECRET=${crypto.randomBytes(32).toString('hex')}`);

  if (noTotp) {
    out.push('SC_WEB_TOTP_ENABLED=false');
    out.push('SC_WEB_TOTP_SECRET=');
  } else {
    const secret = totp.generateSecret();
    out.push('SC_WEB_TOTP_ENABLED=true');
    out.push(`SC_WEB_TOTP_SECRET=${secret}`);
    out.push(`#OTPAUTH ${totp.otpauthURL(secret, { issuer: 'simple-cloud', account: 'web' })}`);
  }

  process.stdout.write(out.join('\n') + '\n');
})();
