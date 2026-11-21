const express = require('express');
const { z } = require('zod');
const rateLimit = require('express-rate-limit');
const auth = require('../middleware/auth');
const validate = require('../middleware/validate');
const asyncHandler = require('../utils/asyncHandler');
const { generateTaskDescription } = require('../services/ai');

const router = express.Router();
router.use(auth());
router.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    skip: () => process.env.NODE_ENV === 'test',
    message: { error: { message: 'AI rate limit reached, try again in a minute' } },
  })
);

// Turns a short idea ("fix login bug on mobile") into a title, description and checklist.
router.post(
  '/task-description',
  validate(z.object({ prompt: z.string().trim().min(3).max(500) })),
  asyncHandler(async (req, res) => {
    res.json(await generateTaskDescription(req.body.prompt));
  })
);

module.exports = router;
