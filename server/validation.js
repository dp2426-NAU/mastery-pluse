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

const integrityEventSchema = z.object({
  type: z.string(),
  ts: z.number(),
});

const submitSchema = z.object({
  responses: z.array(responseItemSchema).min(1, 'Submit at least one answer.'),
  integrityEvents: z.array(integrityEventSchema).max(200).optional(),
  // Set by the client when a 3rd webcam strike force-ends the exam — the
  // server forces every submission in this attempt to a 0% hard fail.
  forcedFail: z.boolean().optional(),
});

const reviewSchema = z.object({
  submissionId: z.number().int(),
  score: z.number().min(0).max(100),
});

const remediateSchema = z.object({
  topicKey: z.string().trim().min(1, 'topicKey is required.'),
});

// Names are rendered in other people's dashboards, so markup is refused here.
const nameField = z.string().trim().min(2, 'Name must be at least 2 characters.').max(60, 'Name is too long.')
  .regex(/^[^<>&"`]*$/, 'Name contains characters that are not allowed.');
const passwordField = z.string().min(8, 'Password must be at least 8 characters.')
  .refine((p) => Buffer.byteLength(p) <= 72, 'Password is too long.');
const roleField = z.enum(['student', 'instructor', 'admin'], 'Choose a valid role.');

const createUserSchema = z.strictObject({
  username: z.string().trim().toLowerCase().regex(/^[a-z0-9._-]{3,32}$/, 'Username must be 3-32 letters, numbers, dots, dashes or underscores.'),
  name: nameField,
  role: roleField,
  password: passwordField.optional(),
});
const updateUserSchema = z.strictObject({
  name: nameField.optional(), role: roleField.optional(), active: z.boolean().optional(),
});
const resetPasswordSchema = z.strictObject({ password: passwordField.optional() });
const permissionSchema = z.strictObject({ key: z.string(), allowed: z.boolean() });
const settingsSchema = z.strictObject({
  maintenanceMode: z.boolean(),
  studentLoginEnabled: z.boolean(),
  instructorLoginEnabled: z.boolean(),
  webcamMonitoring: z.boolean(),
  secondsPerQuestion: z.number().int().min(15, 'Time per question must be 15-600 seconds.').max(600, 'Time per question must be 15-600 seconds.'),
  sessionHours: z.number().int().min(1, 'Session length must be 1-24 hours.').max(24, 'Session length must be 1-24 hours.'),
  announcement: z.string().trim().max(300, 'Announcement must be 300 characters or fewer.'),
}).partial();

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

module.exports = { validate, loginSchema, submitSchema, reviewSchema, remediateSchema,
  createUserSchema, updateUserSchema, resetPasswordSchema, permissionSchema, settingsSchema,
};
