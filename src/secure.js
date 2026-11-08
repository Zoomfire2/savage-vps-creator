"use strict";
const crypto = require("crypto");
const { execFile } = require("child_process");

const LOWER = "abcdefghijkmnopqrstuvwxyz";
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const DIGIT = "23456789";
const SYMBOL = "@#%^*-_=+";

function generatePassword(len = 24) {
  const all = LOWER + UPPER + DIGIT + SYMBOL;
  const pick = set => set[crypto.randomInt(set.length)];
  const chars = [pick(LOWER), pick(UPPER), pick(DIGIT), pick(SYMBOL)];
  while (chars.length < len) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

// SHA-512 crypt hash, so the plaintext password never goes into the Machine's env.
function hashPassword(password) {
  return new Promise((resolve, reject) => {
    const p = execFile("openssl", ["passwd", "-6", "-stdin"], { timeout: 10000 }, (err, out) => {
      if (err) return reject(new Error("password hashing failed (openssl missing?)"));
      const h = String(out).trim();
      h.startsWith("$6$") ? resolve(h) : reject(new Error("password hashing failed"));
    });
    p.stdin.end(password);
  });
}

const keyOf = secret => crypto.createHash("sha256").update("savage-vps:" + secret).digest();

function encrypt(text, secret) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const ct = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return [iv, c.getAuthTag(), ct].map(b => b.toString("base64url")).join(".");
}

function decrypt(blob, secret) {
  try {
    const [iv, tag, ct] = String(blob).split(".").map(s => Buffer.from(s, "base64url"));
    const d = crypto.createDecipheriv("aes-256-gcm", keyOf(secret), iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(ct), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

const redact = (s, ...secrets) =>
  secrets.filter(Boolean).reduce((acc, x) => acc.split(x).join("***"), String(s));

module.exports = { generatePassword, hashPassword, encrypt, decrypt, redact };
