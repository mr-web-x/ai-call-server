import express from 'express';
import { outboundManager } from '../services/outboundManager.js';
import { Call } from '../models/Call.js';
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
      const twimlResponse = outboundManager.generateTwiML(callId, 'initial');

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
// RECORDING PROCESSING WEBHOOK - УЛУЧШЕННАЯ ВЕРСИЯ
// =====================================================

router.post('/recording/:callId', async (req, res) => {
  const { callId } = req.params;
  const { RecordingUrl, RecordingDuration, Digits } = req.body;

  logger.info(`🎤 Recording received for call: ${callId}`, {
    url: RecordingUrl,
    duration: RecordingDuration,
    digits: Digits,
  });

  try {
    // ✅ ПРОВЕРКА НА ДВОЙНУЮ ОБРАБОТКУ (ТОЛЬКО ПРОВЕРКА, НЕ УСТАНОВКА)
    if (outboundManager.recordingProcessing.has(callId)) {
      const existingTimestamp = outboundManager.recordingProcessing.get(callId);
      const processingTime = Date.now() - (existingTimestamp || Date.now());

      logger.warn(
        `⚠️ Recording ${callId} already being processed (${processingTime}ms), skipping duplicate webhook`
      );
      return; // Выходим немедленно, не обрабатываем дубликат
    }

    // ✅ ВАЛИДАЦИЯ ДАННЫХ ЗВОНКА
    const callData = outboundManager.getActiveCall(callId);
    if (!callData) {
      logger.warn(
        `⚠️ No call data found for ${callId}. Call may have been completed or expired.`
      );
      // Продолжаем обработку - возможно, это поздний webhook
    }

    // ✅ ПРОВЕРКА НА ЗАВЕРШЕНИЕ ЗВОНКА
    if (Digits === 'hangup') {
      logger.info(`📞 Call hung up during recording: ${callId}`);

      outboundManager.cleanupCallDetectionResources(callId);

      // Обновляем статус звонка в базе данных
      try {
        await Call.findOneAndUpdate(
          { call_id: callId },
          {
            status: 'completed',
            end_reason: 'client_hangup',
            updated_at: new Date(),
          }
        );
      } catch (dbError) {
        logger.warn(
          `⚠️ Failed to update call status for ${callId}:`,
          dbError.message
        );
      }

      return;
    }

    // ✅ ВАЛИДАЦИЯ URL ЗАПИСИ
    if (!RecordingUrl || typeof RecordingUrl !== 'string') {
      logger.warn(`❌ Invalid or missing recording URL for call: ${callId}`, {
        recordingUrl: RecordingUrl,
        type: typeof RecordingUrl,
      });
      return;
    }

    // ✅ ВАЛИДАЦИЯ ДЛИТЕЛЬНОСТИ ЗАПИСИ
    const duration = parseInt(RecordingDuration);
    if (isNaN(duration) || duration < 1) {
      logger.warn(`❌ Invalid recording duration for call: ${callId}`, {
        duration: RecordingDuration,
        parsed: duration,
      });
      return;
    }

    // ✅ ПРОВЕРКА НА СЛИШКОМ КОРОТКИЕ ЗАПИСИ
    if (duration < 2) {
      logger.info(
        `⚠️ Recording too short for call: ${callId} (${duration}s), likely silence or noise`
      );

      // Генерируем промпт для повторения
      try {
        await outboundManager.generateResponseTTS(
          callId,
          'Я вас не слышу. Говорите пожалуйста громче.',
          'urgent',
          'prompt'
        );
      } catch (ttsError) {
        logger.warn(
          `⚠️ Failed to generate repeat prompt for ${callId}:`,
          ttsError.message
        );
      }

      return;
    }

    logger.info(`🚀 Starting SYNCHRONOUS processing for call: ${callId}`);

    const result = await outboundManager.processRecording(
      callId,
      RecordingUrl,
      RecordingDuration
    );

    // 🎯 ОБРАБАТЫВАЕМ РЕЗУЛЬТАТ И ВОЗВРАЩАЕМ TWIML
    if (result && result.success) {
      // ✅ ОБРАБОТКА УСПЕШНА
      const audioData = outboundManager.pendingAudio.get(callId);

      if (audioData && audioData.audioUrl) {
        logger.info(
          `🎵 Processing successful, returning Play TwiML for ${callId}`
        );

        // Помечаем аудио как использованное
        audioData.consumed = true;
        outboundManager.pendingAudio.set(callId, audioData);

        // Возвращаем готовый Play TwiML
        const playTwiml = outboundManager.generatePlayTwiML(
          callId,
          audioData.audioUrl
        );
        return res.type('text/xml').send(playTwiml);
      } else {
        logger.warn(
          `⚠️ Processing successful but no audio ready for ${callId}`
        );
      }
    }

    // ❌ ОБРАБОТКА ПРОВАЛИЛАСЬ ИЛИ НЕТ АУДИО - FALLBACK
    logger.warn(`⚠️ Processing failed for ${callId}, using fallback`);

    const fallbackTwiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Polly.Maxim" language="ru-RU">Извините, я не расслышал. Не могли бы вы повторить?</Say>
    <Record 
        action="${process.env.SERVER_URL}/api/webhooks/recording/${callId}"
        method="POST"
        maxLength="60"
        playBeep="false"
        timeout="3"
        finishOnKey="#"
        trim="trim-silence"
        recordingStatusCallback="${process.env.SERVER_URL}/api/webhooks/recording-status/${callId}"
    />
</Response>`;

    return res.type('text/xml').send(fallbackTwiml);

    // logger.info(`✅ Recording validation passed for call: ${callId}`, {
    //   duration: `${duration}s`,
    //   urlLength: RecordingUrl.length,
    //   hasCallData: !!callData,
    // });

    // setImmediate(() => {
    //   processRecordingAsync(callId, RecordingUrl, duration).catch((error) => {
    //     logger.error(
    //       `❌ Uncaught error in processRecordingAsync for ${callId}:`,
    //       {
    //         error: error.message,
    //         errorType: error.constructor.name,
    //         timestamp: new Date().toISOString(),
    //       }
    //     );
    //   });
    // });

    // logger.info(`🚀 Recording processing initiated for call: ${callId}`);
  } catch (error) {
    logger.error(`❌ Recording webhook error for call ${callId}:`, {
      error: error.message,
      errorType: error.constructor.name,
      stack: error.stack?.split('\n')[0],
      requestBody: {
        url: RecordingUrl?.substring(0, 100) + '...',
        duration: RecordingDuration,
        digits: Digits,
      },
      timestamp: new Date().toISOString(),
    });

    // Если еще не отвечали - отвечаем с ошибкой
    if (!res.headersSent) {
      res
        .status(500)
        .type('text/xml')
        .send(outboundManager.generateErrorTwiML());
    }
  }
});

// =====================================================
// АСИНХРОННАЯ ФУНКЦИЯ ОБРАБОТКИ ЗАПИСИ
// =====================================================

// async function processRecordingAsync(callId, recordingUrl, duration) {
//   const processingStartTime = Date.now();
//   let retryCount = 0;
//   const maxRetries = 3;
//   let processingResult = null;

//   try {
//     // Установка маркера (ВАЖНО: сохраняем время)
//     outboundManager.recordingProcessing.set(callId, processingStartTime);

//     while (retryCount < maxRetries) {
//       try {
//         logger.info(
//           `🧠 Starting enhanced AI processing for call: ${callId} (attempt ${retryCount + 1}/${maxRetries})`
//         );

//         // 🔥 НОВЫЙ ВЫЗОВ с детекцией галлюцинаций
//         const result = await outboundManager.processRecording(
//           callId,
//           recordingUrl,
//           duration
//         );

//         if (!result) {
//           logger.warn(`❌ No processing result for call: ${callId}`);
//           return;
//         }

//         processingResult = result;

//         logger.info(`✅ Enhanced processing completed for call: ${callId}`, {
//           classification: result.classification,
//           hasResponse: !!result.response,
//           nextStage: result.nextStage,
//           realSpeech: result.metadata?.realSpeech || false,
//           silenceType: result.metadata?.silenceType || 'none',
//           ignored: result.metadata?.ignored || false,
//         });

//         // Continue conversation if needed
//         if (result.response && result.nextStage !== 'completed') {
//           logger.info(`🔄 Continuing conversation for call: ${callId}`);
//         } else if (result.metadata?.ignored) {
//           logger.info(`🔇 Ignored silence/hallucination for call: ${callId}`);
//         } else {
//           logger.info(`📞 Conversation completed for call: ${callId}`);
//         }

//         break; // Успешно обработано
//       } catch (error) {
//         retryCount++;
//         logger.error(
//           `❌ Enhanced processing error for call ${callId} (attempt ${retryCount}/${maxRetries}):`,
//           {
//             error: error.message,
//             stack: error.stack?.split('\n')[0],
//             errorType: error.constructor.name,
//             recordingUrl: recordingUrl?.substring(0, 100) + '...',
//             recordingDuration: duration,
//             timestamp: new Date().toISOString(),
//           }
//         );

//         if (retryCount >= maxRetries) {
//           logger.error(
//             `❌ Max retry attempts reached for call ${callId}, giving up`
//           );
//           break;
//         }

//         // Пауза перед повторной попыткой
//         const delay = Math.min(1000 * Math.pow(2, retryCount - 1), 10000);
//         logger.info(`⏳ Retrying in ${delay}ms...`);
//         await new Promise((resolve) => setTimeout(resolve, delay));
//       }
//     }
//   } catch (criticalError) {
//     logger.error(
//       `❌ Critical error in enhanced processRecordingAsync for call ${callId}:`,
//       {
//         error: criticalError.message,
//         errorType: criticalError.constructor.name,
//         timestamp: new Date().toISOString(),
//       }
//     );
//   } finally {
//     // ✅ ВСЕГДА УДАЛЯЕМ МАРКЕР
//     const startTime = outboundManager.recordingProcessing.get(callId);
//     const processingEndTime = Date.now();

//     if (outboundManager.recordingProcessing.has(callId)) {
//       outboundManager.recordingProcessing.delete(callId);
//       logger.info(`✅ Removed processing marker for call: ${callId}`);
//     }

//     // ✅ ПРАВИЛЬНЫЙ РАСЧЕТ ВРЕМЕНИ
//     const totalProcessingTime = startTime ? processingEndTime - startTime : 0;

//     logger.info(`📊 Enhanced processing completed for call ${callId}:`, {
//       success: !!processingResult,
//       totalTime: `${totalProcessingTime}ms`,
//       retryAttempts: retryCount,
//       classification: processingResult?.classification || 'failed',
//       nextStage: processingResult?.nextStage || 'error',
//       realSpeech: processingResult?.metadata?.realSpeech || false,
//       whisperQuality:
//         processingResult?.metadata?.whisperAnalysis?.confidence || 0,
//     });
//   }
// }

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
    const twimlResponse = outboundManager.generateTwiML(callId, 'continue');

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
