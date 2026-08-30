const { readSession } = require('../lib/tokens');
const { one } = require('../db');

async function attachUser(req, _res, next) {
  const s = readSession(req);
  if (s) req.user = await one('select * from users where id = $1', [s.uid]);
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Sign in to continue.' });
  next();
}

module.exports = { attachUser, requireUser };
