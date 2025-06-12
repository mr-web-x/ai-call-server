import express from 'express';
import axios from 'axios';
import { outboundManager } from '../services/outboundManager.js';
import { Call } from '../models/Call.js';
import { DebtCollectionScripts } from '../scripts/debtCollection.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// TwiML for call control
router.post('/twiml/:callId', async (req, res) => {
    const { callId } = req.params;
    const callData = outboundManager.getActiveCall(callId);
    
    logger.info(`TwiML requested for call: ${callId}`);
    
    if (!callData) {
        logger.warn(`Call data not found for: ${callId}`);
        res.type('text/xml');
        res.send(`
            <?xml version="1.0" encoding="UTF-8"?>
            <Response>
                <Say voice="alice" language="ru-RU">Извините, произошла техническая ошибка. До свидания.</Say>
                <Hangup/>
            </Response>
        `);
        return;
    }

    try {
        const result = await outboundManager.handleCallAnswered(callId);
        
        res.type('text/xml');
        res.send(`
            <?xml version="1.0" encoding="UTF-8"?>
            <Response>
                <Say voice="alice" language="ru-RU">${result.script}</Say>
                <Record 
                    action="${process.env.SERVER_URL}/api/webhooks/recording/${callId}"
                    method="POST"
                    maxLength="300"
                    playBeep="false"
                    timeout="10"
                    finishOnKey="#"
                    recordingStatusCallback="${process.env.SERVER_URL}/api/webhooks/recording-status/${callId}"
                />
            </Response>
        `);
    } catch (error) {
        logger.error('TwiML generation error:', error);
        res.type('text/xml');
        res.send(`
            <?xml version="1.0" encoding="UTF-8"?>
            <Response>
                <Say voice="alice" language="ru-RU">Произошла ошибка. Пожалуйста, перезвоните позже.</Say>
                <Hangup/>
            </Response>
        `);
    }
});

// Call status webhook
router.post('/status/:callId', async (req, res) => {
    const { callId } = req.params;
    const { CallStatus, CallDuration, CallSid } = req.body;
    
    logger.info(`Call status update: ${callId} - ${CallStatus}`);
    
    try {
        // Update call status in database
        await Call.findOneAndUpdate(
            { call_id: callId },
            { 
                status: CallStatus,
                ...(CallDuration && { duration: parseInt(CallDuration) * 1000 })
            }
        );

        switch (CallStatus) {
            case 'answered':
                logger.info(`Call answered: ${callId}`);
                break;
            case 'completed':
            case 'busy':
            case 'no-answer':
            case 'failed':
                await outboundManager.endCall(callId, CallStatus);
                break;
        }
        
        res.status(200).send('OK');
    } catch (error) {
        logger.error('Status webhook error:', error);
        res.status(500).send('Error');
    }
});

// Recording processing webhook
router.post('/recording/:callId', async (req, res) => {
    const { callId } = req.params;
    const { RecordingUrl, RecordingDuration } = req.body;
    const callData = outboundManager.getActiveCall(callId);
    
    logger.info(`Recording received for call: ${callId}`);
    
    if (!callData) {
        logger.warn(`Call data not found for recording: ${callId}`);
        res.status(404).send('Call not found');
        return;
    }

    try {
        // Download recording
        const audioResponse = await axios.get(RecordingUrl, {
            responseType: 'arraybuffer',
            timeout: 30000
        });
        
        const audioBuffer = Buffer.from(audioResponse.data);
        
        // Save recording info to database
        await Call.findOneAndUpdate(
            { call_id: callId },
            {
                $push: {
                    recordings: {
                        url: RecordingUrl,
                        duration: parseInt(RecordingDuration) || 0
                    }
                }
            }
        );
        
        // Process audio through our AI system
        const result = await callData.session.processAudioChunk(audioBuffer);
        
        // Generate next TwiML response
        res.type('text/xml');
        if (result && result.response && result.nextStage !== 'completed') {
            res.send(`
                <?xml version="1.0" encoding="UTF-8"?>
                <Response>
                    <Say voice="alice" language="ru-RU">${result.response}</Say>
                    <Record 
                        action="${process.env.SERVER_URL}/api/webhooks/recording/${callId}"
                        method="POST"
                        maxLength="300"
                        playBeep="false"
                        timeout="10"
                        finishOnKey="#"
                    />
                </Response>
            `);
        } else {
            // End conversation
            res.send(`
                <?xml version="1.0" encoding="UTF-8"?>
                <Response>
                    <Say voice="alice" language="ru-RU">Спасибо за разговор. До свидания.</Say>
                    <Hangup/>
                </Response>
            `);
        }
        
    } catch (error) {
        logger.error('Recording processing error:', error);
        res.type('text/xml');
        res.send(`
            <?xml version="1.0" encoding="UTF-8"?>
            <Response>
                <Say voice="alice" language="ru-RU">Произошла ошибка. До свидания.</Say>
                <Hangup/>
            </Response>
        `);
    }
});

// Recording status callback
router.post('/recording-status/:callId', async (req, res) => {
    const { callId } = req.params;
    const { RecordingStatus, RecordingSid } = req.body;
    
    logger.info(`Recording status for call ${callId}: ${RecordingStatus}`);
    
    try {
        if (RecordingStatus === 'completed') {
            // Recording is ready for processing
            logger.info(`Recording completed for call: ${callId}`);
        }
        
        res.status(200).send('OK');
    } catch (error) {
        logger.error('Recording status error:', error);
        res.status(500).send('Error');
    }
});

export default router;