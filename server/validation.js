// Request-body schemas, checked before a route handler ever runs. A
// malformed request gets a specific 400 instead of being coerced silently
// (or crashing the route with a 500 on a shape it didn't expect).
const { z } = require('zod');

const loginSchema = z.object({
  username: z.string().trim().min(1, 'Username is required.'),
  password: z.string().min(1, 'Password is required.'),
});

const responseItemSchema = z.object({
  itemId: z.number().int(),
  type: z.enum(['quiz', 'task', 'qa']),
  selectedIndex: z.number().int().optional(),
  text: z.string().optional(),
  confidence: z.number().optional(),
});

const submitSchema = z.object({
  responses: z.array(responseItemSchema).min(1, 'Submit at least one answer.'),
});

const reviewSchema = z.object({
  submissionId: z.number().int(),
  score: z.number().min(0).max(100),
});

const remediateSchema = z.object({
  topicKey: z.string().trim().min(1, 'topicKey is required.'),
});

function validate(schema) {
  return (req, res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) {
      return res.status(400).json({ error: result.error.issues[0]?.message || 'Invalid request.' });
    }
    req.body = result.data;
    next();
  };
}

module.exports = { validate, loginSchema, submitSchema, reviewSchema, remediateSchema };
