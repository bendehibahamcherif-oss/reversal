import express from 'express';
import crypto from 'crypto';

const router = express.Router();

const resetTokens = new Map();

router.post('/forgot-password', async (req, res) => {
  const { email } = req.body;

  if (!email) {
    return res.status(400).json({
      error: 'Email required',
    });
  }

  const token = crypto.randomBytes(32)
    .toString('hex');

  resetTokens.set(token, {
    email,
    expiresAt:
      Date.now() + 1000 * 60 * 15,
  });

  return res.json({
    success: true,
    resetToken: token,
  });
});

router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body;

  const entry = resetTokens.get(token);

  if (!entry) {
    return res.status(400).json({
      error: 'Invalid token',
    });
  }

  if (Date.now() > entry.expiresAt) {
    return res.status(400).json({
      error: 'Token expired',
    });
  }

  resetTokens.delete(token);

  return res.json({
    success: true,
    message: 'Password reset completed',
  });
});

export default router;
