const GB = 1024 ** 3;

// Storage is the headline number: everyone starts on 40 GB, free.
const PLANS = {
  starter: {
    id: 'starter', name: 'Starter', quota: 40 * GB, paise: 0, period: null,
    perks: ['40 GB of mail storage', 'One address', 'Send and receive from day one', 'Sign in with Google, Yahoo, GitHub or a code'],
  },
  pro: {
    id: 'pro', name: 'Pro', quota: 500 * GB, paise: 29900, period: 'month',
    perks: ['500 GB of mail storage', 'Up to 5 addresses', 'Attachments up to 30 MB', 'Priority sending'],
  },
  business: {
    id: 'business', name: 'Business', quota: 2048 * GB, paise: 99900, period: 'month',
    perks: ['2 TB of mail storage', 'Unlimited addresses', 'Bring or buy your own domain', 'Domain sending records handled for you'],
  },
};

const DOMAIN_PRICE_PAISE = 99900; // ₹999 per domain, per year

function fmtBytes(n) {
  n = Number(n) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

module.exports = { PLANS, DOMAIN_PRICE_PAISE, fmtBytes, GB };
