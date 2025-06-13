import express from 'express';
import axios from 'axios';
import { outboundManager } from '../services/outboundManager.js';
import { Call } from '../models/Call.js';
import { ttsQueue } from '../queues/setup.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// =====================================================
// TWIML GENERATION WEBHOOK
// =====================================================

router.post('/twiml/:callId', async (req, res) => {
  const { callId } = req.params;

  logger.info(`📞 TwiML requested for call: ${callId}`);

  try {
    // Generate TwiML response using OutboundManager
    const twimlResponse = await outboundManager.generateTwiMLResponse(
      callId,
      'initial'
    );

    if (!twimlResponse) {
      logger.warn(`❌ No TwiML generated for call: ${callId}`);
      res.type('text/xml');
      res.send(outboundManager.generateErrorTwiML());
      return;
    }

    logger.info(`✅ TwiML generated for call: ${callId}`);
    res.type('text/xml');
    res.send(twimlResponse);
  } catch (error) {
    logger.error(`❌ TwiML generation error for call ${callId}:`, error);
    res.type('text/xml');
    res.send(outboundManager.generateErrorTwiML());
  }
});

// =====================================================
// CALL STATUS WEBHOOK
// =====================================================

router.post('/status/:callId', async (req, res) => {
  const { callId } = req.params;
  const { CallStatus, CallDuration, CallSid } = req.body;

  logger.info(`📞 Call status update: ${callId} - ${CallStatus}`);

  try {
    // Update call status in database
    await Call.findOneAndUpdate(
      { call_id: callId },
      {
        status: CallStatus,
        twilio_call_sid: CallSid,
        ...(CallDuration && { duration: parseInt(CallDuration) * 1000 }),
      }
    );

    switch (CallStatus) {
      case 'answered':
        logger.info(`✅ Call answered: ${callId}`);
        await outboundManager.handleCallAnswered(callId);
        break;

      case 'completed':
      case 'busy':
      case 'no-answer':
      case 'failed':
      case 'canceled':
        logger.info(`📞 Call ended: ${callId} with status: ${CallStatus}`);
        await outboundManager.endCall(callId, CallStatus);
        break;

      case 'ringing':
        logger.info(`📞 Call ringing: ${callId}`);
        break;

      default:
        logger.info(`📞 Call status: ${callId} - ${CallStatus}`);
    }

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`❌ Status webhook error for call ${callId}:`, error);
    res.status(500).send('Error');
  }
});

// =====================================================
// RECORDING PROCESSING WEBHOOK
// =====================================================

router.post('/recording/:callId', async (req, res) => {
  const { callId } = req.params;
  const { RecordingUrl, RecordingDuration } = req.body;

  logger.info(`🎤 Recording received for call: ${callId}`);

  try {
    // Process recording through OutboundManager
    const result = await outboundManager.processRecording(
      callId,
      RecordingUrl,
      RecordingDuration
    );

    if (!result) {
      logger.warn(`❌ No processing result for call: ${callId}`);
      res.type('text/xml');
      res.send(outboundManager.generateErrorTwiML());
      return;
    }

    logger.info(
      `✅ Recording processed for call: ${callId} - ${result.classification}`
    );

    // Generate next TwiML response
    res.type('text/xml');

    if (result.response && result.nextStage !== 'completed') {
      // Continue conversation - redirect to wait for TTS completion
      res.send(`
                <?xml version="1.0" encoding="UTF-8"?>
                <Response>
                    <Pause length="2"/>
                    <Redirect method="POST">${process.env.SERVER_URL}/api/webhooks/twiml/${callId}</Redirect>
                </Response>
            `);
    } else {
      // End conversation
      logger.info(`📞 Conversation completed for call: ${callId}`);
      res.send(`
                <?xml version="1.0" encoding="UTF-8"?>
                <Response>
                    <Say voice="alice" language="ru-RU">Спасибо за разговор. До свидания.</Say>
                    <Hangup/>
                </Response>
            `);
    }
  } catch (error) {
    logger.error(`❌ Recording processing error for call ${callId}:`, error);

    // Graceful error handling
    res.type('text/xml');
    res.send(`
            <?xml version="1.0" encoding="UTF-8"?>
            <Response>
                <Say voice="alice" language="ru-RU">Произошла ошибка при обработке. До свидания.</Say>
                <Hangup/>
            </Response>
        `);
  }
});

// =====================================================
// RECORDING STATUS WEBHOOK
// =====================================================

router.post('/recording-status/:callId', async (req, res) => {
  const { callId } = req.params;
  const { RecordingStatus, RecordingSid, RecordingUrl } = req.body;

  logger.info(`🎤 Recording status update: ${callId} - ${RecordingStatus}`);

  try {
    // Update recording status in database
    await Call.findOneAndUpdate(
      { call_id: callId },
      {
        $push: {
          recording_events: {
            status: RecordingStatus,
            recording_sid: RecordingSid,
            url: RecordingUrl,
            timestamp: new Date(),
          },
        },
      }
    );

    res.status(200).send('OK');
  } catch (error) {
    logger.error(`❌ Recording status webhook error:`, error);
    res.status(500).send('Error');
  }
});

// =====================================================
// FALLBACK WEBHOOK FOR REDIRECTS
// =====================================================

router.post('/continue/:callId', async (req, res) => {
  const { callId } = req.params;

  logger.info(`🔄 Continue webhook called for call: ${callId}`);

  try {
    // Generate TwiML for continuation
    const twimlResponse = await outboundManager.generateTwiMLResponse(
      callId,
      'continue'
    );

    res.type('text/xml');
    res.send(twimlResponse);
  } catch (error) {
    logger.error(`❌ Continue webhook error for call ${callId}:`, error);
    res.type('text/xml');
    res.send(outboundManager.generateErrorTwiML());
  }
});

// =====================================================
// HEALTH CHECK FOR WEBHOOKS
// =====================================================

router.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    service: 'webhooks',
    timestamp: new Date().toISOString(),
    endpoints: {
      twiml: '/api/webhooks/twiml/:callId',
      status: '/api/webhooks/status/:callId',
      recording: '/api/webhooks/recording/:callId',
      recordingStatus: '/api/webhooks/recording-status/:callId',
      continue: '/api/webhooks/continue/:callId',
    },
  });
});

// =====================================================
// ERROR HANDLING MIDDLEWARE
// =====================================================

router.use((error, req, res, next) => {
  logger.error('Webhook error:', error);

  // Always return valid TwiML for Twilio
  if (req.path.includes('/twiml/') || req.path.includes('/recording/')) {
    res.type('text/xml');
    res.send(`
            <?xml version="1.0" encoding="UTF-8"?>
            <Response>
                <Say voice="alice" language="ru-RU">Произошла техническая ошибка. До свидания.</Say>
                <Hangup/>
            </Response>
        `);
  } else {
    res.status(500).send('Internal Server Error');
  }
});

export default router;
