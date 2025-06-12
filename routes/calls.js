import express from 'express';
import mongoose from 'mongoose';
import { outboundManager } from '../services/outboundManager.js';
import { Client } from '../models/Client.js';
import { Call } from '../models/Call.js';
import { validateClientId } from '../middleware/validation.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// Initiate call to specific client
router.post('/client/:clientId', validateClientId, async (req, res) => {
    try {
        const { clientId } = req.params;
        const result = await outboundManager.initiateCall(clientId);
        
        logger.info(`Call initiated for client: ${clientId}`);
        res.json({
            success: true,
            message: 'Call initiated successfully',
            ...result
        });

    } catch (error) {
        logger.error('Call initiation error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Bulk calls to multiple clients
router.post('/bulk', async (req, res) => {
    try {
        const { clientIds, delay = 60000 } = req.body;
        
        if (!Array.isArray(clientIds)) {
            return res.status(400).json({ 
                success: false,
                error: 'clientIds must be an array' 
            });
        }

        const results = [];
        
        for (let i = 0; i < clientIds.length; i++) {
            try {
                const result = await outboundManager.initiateCall(clientIds[i]);
                results.push({ 
                    clientId: clientIds[i], 
                    success: true,
                    ...result 
                });
                
                // Delay between calls
                if (i < clientIds.length - 1) {
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            } catch (error) {
                results.push({ 
                    clientId: clientIds[i], 
                    success: false,
                    error: error.message
                });
            }
        }

        res.json({
            success: true,
            message: `Processed ${results.length} calls`,
            results
        });

    } catch (error) {
        logger.error('Bulk call error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get active calls
router.get('/active', (req, res) => {
    try {
        const activeCalls = outboundManager.getAllActiveCalls();
        
        res.json({
            success: true,
            count: activeCalls.length,
            calls: activeCalls
        });
    } catch (error) {
        logger.error('Get active calls error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Get call details
router.get('/:callId', async (req, res) => {
    try {
        const { callId } = req.params;
        const call = await Call.findOne({ call_id: callId }).populate('client_id');
        
        if (!call) {
            return res.status(404).json({
                success: false,
                error: 'Call not found'
            });
        }

        res.json({
            success: true,
            call
        });
    } catch (error) {
        logger.error('Get call details error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Terminate specific call
router.post('/:callId/hangup', async (req, res) => {
    try {
        const { callId } = req.params;
        await outboundManager.endCall(callId, 'manual_hangup');
        
        res.json({
            success: true,
            message: 'Call terminated successfully'
        });
    } catch (error) {
        logger.error('Call termination error:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

export default router;