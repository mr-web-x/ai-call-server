import express from 'express';
import axios from 'axios';
import { outboundManager } from '../services/outboundManager.js';
import { Call } from '../models/Call.js';
import { ttsQueue } from '../queues/setup.js';
import { logger } from '../utils/logger.js';

const router = express.Router();

// =====================================================
// MAIN TWIML ENDPOINT (без callId - обрабатывает все звонки)
// =====================================================

router.post('/twiml', async (req, res) => {
  logger.info(`📞 TwiML requested (main endpoint)`);
  logger.info(`📞 Request headers:`, {
    'user-agent': req.headers['user-agent'],
    'content-type': req.headers['content-type'],
    'x-twilio-signature': req.headers['x-twilio-signature']
      ? 'present'
      : 'missing',
  });
  logger.info(`📞 Request body:`, req.body);

  try {
    // Verify this is a request from Twilio
    if (!req.headers['user-agent']?.includes('TwilioProxy')) {
      logger.warn(
        `⚠️ Non-Twilio request to TwiML endpoint from: ${req.headers['user-agent']}`
      );
    }

    // Check if this is a debugger event
    if (req.body && req.body.Payload) {
      logger.warn(`🐛 Twilio debugger event received:`, req.body);
      res.status(200).send('OK');
      return;
    }

    // Try to find callId from CallSid in request body
    let callId = null;
    if (req.body && req.body.CallSid) {
      callId = outboundManager.findCallIdByTwilioSid(req.body.CallSid);
      if (callId) {
        logger.info(
          `✅ Found callId from CallSid: ${callId} -> ${req.body.CallSid}`
        );
      } else {
        logger.warn(
          `❌ Could not find callId for CallSid: ${req.body.CallSid}`
        );
      }
    }

    // If we found callId, generate proper TwiML
    if (callId) {
      const twimlResponse = await outboundManager.generateTwiMLResponse(
        callId,
        'initial'
      );

      if (!twimlResponse) {
        logger.error(`❌ No TwiML generated for call: ${callId}`);
        res.type('text/xml');
        res.send(outboundManager.generateErrorTwiML());
        return;
      }

      // Log TwiML response type for debugging
      if (twimlResponse.includes('<Play>')) {
        logger.info(`🎵 Sending PLAY TwiML (ElevenLabs) for call: ${callId}`);
        const urlMatch = twimlResponse.match(/<Play>(.*?)<\/Play>/);
        if (urlMatch) {
          logger.info(`🎵 Audio URL: ${urlMatch[1]}`);
        }
      } else if (twimlResponse.includes('<Say>')) {
        logger.warn(
          `🔊 Sending SAY TwiML (Twilio fallback) for call: ${callId}`
        );
        const voiceMatch = twimlResponse.match(/voice="([^"]+)"/);
        const textMatch = twimlResponse.match(/<Say[^>]*>(.*?)<\/Say>/s);
        if (voiceMatch) {
          logger.info(`🔊 Voice: ${voiceMatch[1]}`);
        }
        if (textMatch) {
          logger.info(`🔊 Text: ${textMatch[1].substring(0, 50)}...`);
        }
      } else if (twimlResponse.includes('<Redirect>')) {
        logger.info(
          `🔄 Sending REDIRECT TwiML (waiting for TTS) for call: ${callId}`
        );
      } else if (twimlResponse.includes('<Hangup>')) {
        logger.info(`📴 Sending HANGUP TwiML (error) for call: ${callId}`);
      }

      // Log full TwiML for debugging
      logger.info(`📋 Full TwiML response for call ${callId}:`);
      logger.info(twimlResponse);

      res.type('text/xml');
      res.send(twimlResponse);
      logger.info(`✅ TwiML sent successfully for call: ${callId}`);
      return;
    }

    // Fallback if no callId found
    logger.warn(
      `❌ Could not determine callId from request, sending generic error`
    );
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Polly.Tatyana" language="ru-RU">Системная ошибка. Call ID не найден. До свидания.</Say>
    <Hangup/>
</Response>`);
  } catch (error) {
    logger.error(`❌ TwiML generation error:`, error);
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Polly.Tatyana" language="ru-RU">Произошла техническая ошибка. До свидания.</Say>
    <Hangup/>
</Response>`);
  }
});

// =====================================================
// LEGACY TWIML ENDPOINT (с callId - для обратной совместимости)
// =====================================================

router.post('/twiml/:callId', async (req, res) => {
  const { callId } = req.params;

  logger.info(`📞 TwiML requested for specific call: ${callId}`);
  logger.info(`📞 Request body:`, req.body);

  try {
    const twimlResponse = await outboundManager.generateTwiMLResponse(
      callId,
      'initial'
    );

    if (!twimlResponse) {
      logger.error(`❌ No TwiML generated for call: ${callId}`);
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
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Polly.Tatyana" language="ru-RU">Произошла техническая ошибка. До свидания.</Say>
    <Hangup/>
</Response>`);
  }
});

// =====================================================
// CALL STATUS WEBHOOK
// =====================================================

router.post('/status/:callId', async (req, res) => {
  const { callId } = req.params;
  const { CallStatus, CallDuration, CallSid, SipResponseCode } = req.body;

  logger.info(`📞 Call status update: ${callId} - ${CallStatus}`, {
    callSid: CallSid,
    duration: CallDuration,
    sipCode: SipResponseCode,
  });

  try {
    // Update call status in database
    const updateData = {
      status: CallStatus,
      twilio_call_sid: CallSid,
    };

    if (CallDuration) {
      updateData.duration = parseInt(CallDuration) * 1000; // Convert to milliseconds
    }

    await Call.findOneAndUpdate({ call_id: callId }, updateData);

    // Handle different call statuses
    switch (CallStatus) {
      case 'answered':
        logger.info(`✅ Call answered: ${callId}`);
        // Note: We don't call handleCallAnswered here because TwiML endpoint handles it
        break;

      case 'in-progress':
        logger.info(`📞 Call in progress: ${callId}`);
        // Call is active, TwiML endpoint manages the conversation
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

      case 'initiated':
        logger.info(`📞 Call initiated: ${callId}`);
        break;

      default:
        logger.info(`📞 Unknown call status: ${callId} - ${CallStatus}`);
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

  logger.info(`🎤 Recording received for call: ${callId}`, {
    url: RecordingUrl,
    duration: RecordingDuration,
  });

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
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Pause length="2"/>
    <Redirect method="POST">${process.env.SERVER_URL}/api/webhooks/twiml</Redirect>
</Response>`);
    } else {
      // End conversation
      logger.info(`📞 Conversation completed for call: ${callId}`);
      res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Polly.Tatyana" language="ru-RU">Спасибо за разговор. До свидания.</Say>
    <Hangup/>
</Response>`);
    }
  } catch (error) {
    logger.error(`❌ Recording processing error for call ${callId}:`, error);

    // Graceful error handling
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Polly.Tatyana" language="ru-RU">Произошла ошибка при обработке. До свидания.</Say>
    <Hangup/>
</Response>`);
  }
});

// =====================================================
// RECORDING STATUS WEBHOOK
// =====================================================

router.post('/recording-status/:callId', async (req, res) => {
  const { callId } = req.params;
  const { RecordingStatus, RecordingSid, RecordingUrl } = req.body;

  logger.info(`🎤 Recording status update: ${callId} - ${RecordingStatus}`, {
    recordingSid: RecordingSid,
    url: RecordingUrl,
  });

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
    logger.error(
      `❌ Recording status webhook error for call ${callId}:`,
      error
    );
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
// DEBUG WEBHOOK ENDPOINT (для Twilio Debugger)
// =====================================================

router.post('/debug', async (req, res) => {
  logger.info('🐛 Twilio Debug webhook called:', {
    headers: req.headers,
    body: req.body,
    query: req.query,
  });

  // Always return success for debug webhook
  res.status(200).json({
    success: true,
    message: 'Debug webhook received',
    timestamp: new Date().toISOString(),
    data: req.body,
  });
});

// =====================================================
// HEALTH CHECK FOR WEBHOOKS
// =====================================================

router.get('/health', (req, res) => {
  const activeCalls = outboundManager.getAllActiveCalls();
  const metrics = outboundManager.getCallMetrics();

  res.json({
    status: 'healthy',
    service: 'webhooks',
    timestamp: new Date().toISOString(),
    activeCalls: activeCalls.length,
    metrics,
    endpoints: {
      twiml: '/api/webhooks/twiml',
      twimlWithCallId: '/api/webhooks/twiml/:callId',
      status: '/api/webhooks/status/:callId',
      recording: '/api/webhooks/recording/:callId',
      recordingStatus: '/api/webhooks/recording-status/:callId',
      continue: '/api/webhooks/continue/:callId',
      debug: '/api/webhooks/debug',
    },
  });
});

// =====================================================
// SIMPLE TEST ENDPOINT
// =====================================================

router.get('/test', (req, res) => {
  logger.info('🧪 Test webhook endpoint called');

  const testResult = outboundManager.test();

  res.json({
    success: true,
    message: 'Webhook routes are working',
    timestamp: new Date().toISOString(),
    outboundManagerTest: testResult,
    server: process.env.SERVER_URL,
  });
});

// =====================================================
// PING ENDPOINT
// =====================================================

router.get('/ping', (req, res) => {
  res.json({
    success: true,
    message: 'Webhook service is alive',
    timestamp: new Date().toISOString(),
    server: process.env.SERVER_URL,
    uptime: process.uptime(),
  });
});

// =====================================================
// ERROR HANDLING MIDDLEWARE
// =====================================================

router.use((error, req, res, next) => {
  logger.error('Webhook error:', error);

  // Always return valid TwiML for Twilio webhook requests
  if (req.path.includes('/twiml') || req.path.includes('/recording')) {
    res.type('text/xml');
    res.send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Polly.Tatyana" language="ru-RU">Произошла техническая ошибка. До свидания.</Say>
    <Hangup/>
</Response>`);
  } else {
    res.status(500).json({
      success: false,
      error: 'Internal Server Error',
      timestamp: new Date().toISOString(),
    });
  }
});

export default router;
