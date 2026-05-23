import express from 'express';
import Execution from '../models/Execution.js';
import { requireAuth } from '../middleware/authSecurity.js';

const router = express.Router();

router.get('/', requireAuth, async (req, res) => {
  const executions = await Execution.find({
    userId: req.user.id,
  }).sort({ createdAt: -1 });

  return res.json({ executions });
});

router.post('/', requireAuth, async (req, res) => {
  const execution = await Execution.create({
    ...req.body,
    userId: req.user.id,
  });

  return res.json({
    success: true,
    execution,
  });
});

export default router;
