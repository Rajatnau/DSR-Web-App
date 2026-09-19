'use strict';

const config = require('./config');

// en-CA formats as YYYY-MM-DD, which is exactly the ISO date we store.
const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: config.timeZone,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Today's calendar date in the team's timezone. A DSR is a human workday, and
 * serverless clocks run on UTC — without this, an Indian team logging time
 * before 05:30 IST would be told today's date is "in the future".
 */
function today() {
  return formatter.format(new Date());
}

function shiftDays(isoDate, delta) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

module.exports = { today, shiftDays };
