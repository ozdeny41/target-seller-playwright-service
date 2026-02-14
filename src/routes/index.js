const express = require('express');
const router = express.Router();

// Seller information routes
router.use('/sellers', require('./sellers'));

module.exports = router;
