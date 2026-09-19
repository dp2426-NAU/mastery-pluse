const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

// Disabled during automated tests (which log in dozens of times per run) —
// Jest sets NODE_ENV=test automatically.
const skipInTest = () => process.env.NODE_ENV === 'test';

// Keyed by username + IP, not IP alone. This app's whole demo workflow is
// "open a tab per student and log in as ten different accounts from one
// machine" (see README) -- keying by IP alone means trying student1..10
// shares ONE shrinking budget, so the 6th or 7th legitimate login gets
// blocked. Keying by account instead means brute-forcing ONE account is
// still capped tightly, without punishing "many different real accounts,
// same machine." ipKeyGenerator() normalizes the IP for IPv6 safety.
function loginKey(req) {
  const username = typeof req.body?.username === 'string' ? req.body.username.trim().toLowerCase() : '';
  const ip = ipKeyGenerator(req.ip);
  return username ? `${username}:${ip}` : ip;
}

// Brute-force defense: a real password guesser needs far more than 10
// tries against one account.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  keyGenerator: loginKey,
  message: { error: 'Too many login attempts for this account. Try again in a few minutes.' },
});

// Generous enough for a real classroom (nobody submits 30 exams/minute),
// tight enough to stop a scripted spam loop.
const submitLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { error: 'Too many submissions — slow down and try again shortly.' },
});

module.exports = { loginLimiter, submitLimiter };
