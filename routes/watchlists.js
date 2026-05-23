import express from 'express';
import User from '../models/User.js';
import { requireAuth } from '../middleware/authSecurity.js';

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const user = await User.findById(req.user.id);

  return res.json({
    watchlists: user?.watchlists || [],
  });
});

router.post('/', requireAuth, async (req, res) => {
  const { name, symbols } = req.body;

  const user = await User.findById(req.user.id);

  user.watchlists.push({
    name,
    symbols,
  });

  await user.save();

  return res.json({
    success: true,
    watchlists: user.watchlists,
  });
});

export default router;
