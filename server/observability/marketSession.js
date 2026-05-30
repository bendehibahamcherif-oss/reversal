// ── Market Session Guardrail ──────────────────────────────────────────────────
//
// Detects NYSE regular session (Mon–Fri 09:30–16:00 ET) and blocks LIVE-mode
// order placement outside those hours.
//
// IMPORTANT: Paper trading is NEVER blocked — guardrail only fires for mode=live.
//
// Environment overrides:
//   OVERRIDE_MARKET_HOURS=true  — bypass the check (e.g. pre-market testing)
//   MARKET_TZ_OFFSET_HOURS      — ET offset hours (default -5, conservative non-DST)
//
// Uses the same conservative fixed-offset approach as cvdEngine.js so both
// components agree on session boundaries without a tzdata dependency.

const ET_OFFSET_H = Number(process.env.MARKET_TZ_OFFSET_HOURS ?? -5);

// ── Session state ─────────────────────────────────────────────────────────────

export function getMarketSessionState() {
  const now   = new Date();
  const etMs  = now.getTime() + ET_OFFSET_H * 3_600_000;
  const et    = new Date(etMs);

  const dow     = et.getUTCDay();          // 0=Sun, 6=Sat
  const weekday = dow >= 1 && dow <= 5;
  const hh      = et.getUTCHours();
  const mm      = et.getUTCMinutes();
  const minsSinceMidnight = hh * 60 + mm;

  const OPEN_MINS  = 9 * 60 + 30;   // 09:30
  const CLOSE_MINS = 16 * 60;       // 16:00
  const preOpen    = weekday && minsSinceMidnight >= 4 * 60 && minsSinceMidnight < OPEN_MINS;
  const afterHours = weekday && minsSinceMidnight >= CLOSE_MINS && minsSinceMidnight < 20 * 60;
  const isOpen     = weekday && minsSinceMidnight >= OPEN_MINS && minsSinceMidnight < CLOSE_MINS;

  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const etTimeStr = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')} ET`;

  const session = isOpen     ? 'regular'
                : preOpen    ? 'pre-market'
                : afterHours ? 'after-hours'
                : weekday    ? 'closed'
                : 'weekend';

  return {
    isOpen,
    session,
    weekday,
    etTime:  etTimeStr,
    dayName: DAYS[dow],
    overrideActive: process.env.OVERRIDE_MARKET_HOURS === 'true',
    note: isOpen
      ? 'NYSE regular session is active.'
      : `NYSE is closed (${session}). Live orders blocked unless OVERRIDE_MARKET_HOURS=true.`,
  };
}

// ── Middleware ────────────────────────────────────────────────────────────────
//
// Apply to live-execution routes.  Reads mode from body or query string.
// If mode is not 'live' the check is skipped entirely (paper is always allowed).

export function marketSessionGuard(req, res, next) {
  if (process.env.OVERRIDE_MARKET_HOURS === 'true') return next();

  const mode = req.body?.mode || req.query?.mode || 'paper';
  if (mode !== 'live') return next();

  const state = getMarketSessionState();
  if (state.isOpen) return next();

  return res.status(422).json({
    ok:      false,
    error:   'Live orders are blocked outside NYSE regular session.',
    session: state.session,
    etTime:  state.etTime,
    note:    state.note,
    hint:    'Set OVERRIDE_MARKET_HOURS=true to bypass, or use mode=paper.',
  });
}
