import { Router } from 'express';

const replaySessionRoutes = Router();

const replaySessionState = {
  active: false,
  paused: false,
  startedAt: null,
  updatedAt: null,
};

function markUpdate() {
  replaySessionState.updatedAt = new Date().toISOString();
}

replaySessionRoutes.post('/start', (req, res) => {
  replaySessionState.active = true;
  replaySessionState.paused = false;
  replaySessionState.startedAt = new Date().toISOString();
  markUpdate();

  res.json({ ok: true, action: 'start', state: replaySessionState });
});

replaySessionRoutes.post('/pause', (req, res) => {
  if (replaySessionState.active) {
    replaySessionState.paused = true;
  }
  markUpdate();

  res.json({ ok: true, action: 'pause', state: replaySessionState });
});

replaySessionRoutes.post('/resume', (req, res) => {
  if (replaySessionState.active) {
    replaySessionState.paused = false;
  }
  markUpdate();

  res.json({ ok: true, action: 'resume', state: replaySessionState });
});

replaySessionRoutes.post('/stop', (req, res) => {
  replaySessionState.active = false;
  replaySessionState.paused = false;
  markUpdate();

  res.json({ ok: true, action: 'stop', state: replaySessionState });
});

export default replaySessionRoutes;
