'use strict';

module.exports = async function handler(req, res) {
    res.status(200).json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        env: process.env.NODE_ENV || 'production'
    });
};
