import express from 'express';
import User from '../models/User.js';
import { requireAuth } from '../middleware/authSecurity.js';

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const user = await User.findById(req.user.id);

  return res.json({
    layouts: user?.workspaceLayouts || {},
  });
});

router.post('/', requireAuth, async (req, res) => {
  const { layouts } = req.body;

  const user = await User.findById(req.user.id);

  user.workspaceLayouts = layouts;

  await user.save();

  return res.json({
    success: true,
    layouts,
  });
});

export default router;
