const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const COOKIE = 'lsp_session';

function sign(user) {
  return jwt.sign({ uid: user.id, email: user.email }, SECRET, { expiresIn: '30d' });
}

function setSession(res, user) {
  res.cookie(COOKIE, sign(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 30 * 24 * 3600 * 1000,
  });
}

function clearSession(res) { res.clearCookie(COOKIE); }

function readSession(req) {
  const raw = req.cookies?.[COOKIE];
  if (!raw) return null;
  try { return jwt.verify(raw, SECRET); } catch { return null; }
}

const signState = (payload) => jwt.sign(payload, SECRET, { expiresIn: '10m' });
const readState = (s) => { try { return jwt.verify(s, SECRET); } catch { return null; } };

const hashCode = (code) => crypto.createHash('sha256').update(String(code) + SECRET).digest('hex');
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

module.exports = { sign, setSession, clearSession, readSession, signState, readState, hashCode, newCode, COOKIE };
