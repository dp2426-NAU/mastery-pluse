const rateLimit = require('express-rate-limit');

// Disabled during automated tests (which log in dozens of times per run) —
// Jest sets NODE_ENV=test automatically.
const skipInTest = () => process.env.NODE_ENV === 'test';

// Brute-force defense: a real password guesser needs far more than 20 tries.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  skip: skipInTest,
  message: { error: 'Too many login attempts. Try again in a few minutes.' },
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
