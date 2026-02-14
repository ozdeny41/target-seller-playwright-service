const express = require('express');
const router = express.Router();

// Target Seller information routes
router.use('/sellers', require('./sellers'));

module.exports = router;
