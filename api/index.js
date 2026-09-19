'use strict';

// Vercel entry point. vercel.json rewrites every non-static request here, and
// an Express app is itself a (req, res) handler, so it can be exported as-is.
module.exports = require('../app');
