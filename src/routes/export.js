'use strict';

const crypto = require('crypto');
const express = require('express');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const excel = require('../excel');
const v = require('../validate');

/**
 * GET /api/export/dsr.xlsx?token=<EXPORT_TOKEN>
 *
 * A live workbook URL for Excel Power Query ("Data > From Web") and Power BI,
 * which cannot sign in through the login page. On Vercel there is no DSR.xlsx
 * on disk to point them at, so this is how dashboards refresh.
 *
 * Disabled unless EXPORT_TOKEN is set to something long enough to be a secret.
 * The token can also be sent as an "Authorization: Bearer <token>" header.
 */

const router = express.Router();

const MIN_TOKEN_LENGTH = 24;

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many export requests. Try again shortly.' },
});

// Compare digests so the comparison is constant-time regardless of length.
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();

function tokenMatches(presented) {
  if (!presented) return false;
  return crypto.timingSafeEqual(digest(presented), digest(config.exportToken));
}

router.get('/dsr.xlsx', limiter, v.asyncRoute(async (req, res) => {
  if (config.exportToken.length < MIN_TOKEN_LENGTH) {
    return res.status(404).json({ error: 'The export feed is not enabled on this deployment' });
  }

  const header = req.get('authorization') || '';
  const presented = header.startsWith('Bearer ') ? header.slice(7).trim() : req.query.token;
  if (!tokenMatches(presented)) {
    return res.status(401).json({ error: 'Invalid or missing export token' });
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="DSR.xlsx"');
  res.setHeader('Cache-Control', 'no-store');
  await excel.writeToStream(res);
  res.end();
}));

module.exports = router;
