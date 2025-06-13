import { sttQueue, llmQueue, ttsQueue } from './setup.js';
import { AIServices } from '../services/aiServices.js';
import { ttsManager } from '../services/ttsManager.js';
import { audioManager } from '../services/audioManager.js';
import { outboundManager } from '../services/outboundManager.js';
import { logger } from '../utils/logger.js';
import { cacheManager } from '../services/cacheManager.js';

// STT Queue Processor
sttQueue.process('transcribe', 5, async (job) => {
  const { audioBuffer, callId } = job.data;

  try {
    logger.info(`Processing STT for call: ${callId}`);
    const result = await AIServices.transcribeAudio(audioBuffer);

    return {
      callId,
      ...result,
    };
  } catch (error) {
    logger.error('STT Processing Error:', error);
    throw error;
  }
});

// LLM Classification Queue Processor
llmQueue.process('classify', 3, async (job) => {
  const { text, callId, currentStage, conversationHistory } = job.data;

  try {
    logger.info(`Processing LLM classification for call: ${callId}`);
    const result = await AIServices.classifyResponse(
      text,
      currentStage,
      conversationHistory
    );

    return {
      callId,
      originalText: text,
      ...result,
    };
  } catch (error) {
    logger.error('LLM Classification Error:', error);
    throw error;
  }
});

// TTS Queue Processor - UPDATED WITH MODERN TTS MANAGER
ttsQueue.process('synthesize', 3, async (job) => {
  const { text, callId, priority, type, useCache, voiceId } = job.data;

  try {
    logger.info(
      `🎤 Processing TTS for call: ${callId}, priority: ${priority}, type: ${type}`
    );

    // Use TTS Manager
    const result = await ttsManager.synthesizeSpeech(text, {
      voiceId: voiceId,
      priority: priority,
      useCache: useCache,
    });

    logger.info(
      `🎯 TTS result for call ${callId}: source=${result.source}, hasAudio=${!!result.audioBuffer}`
    );

    // ВАЖНО: Кэшировать ТОЛЬКО если это новый ElevenLabs результат (не кэш!)
    if (
      result.source === 'elevenlabs' &&
      result.audioBuffer &&
      useCache &&
      cacheManager.shouldCache(text)
    ) {
      logger.info(
        `💾 Caching new ElevenLabs audio for: ${text.substring(0, 30)}...`
      );
      await cacheManager.setCachedAudio(text, result.audioBuffer, voiceId);
    }

    // If we have an audio buffer (ElevenLabs), save it as a file
    if (result.audioBuffer) {
      const audioFile = await audioManager.saveAudioFile(
        callId,
        result.audioBuffer,
        type || 'response'
      );

      return {
        callId,
        text,
        type,
        audioUrl: audioFile.publicUrl,
        audioBuffer: result.audioBuffer,
        source: result.source,
        voiceId: result.voiceId,
        twilioTTS: false,
      };
    }

    // Cache hit - return cached URL (НЕ КЭШИРОВАТЬ ПОВТОРНО!)
    if (result.source === 'cache' && result.audioUrl) {
      logger.info(`✅ Using cached ElevenLabs audio: ${result.audioUrl}`);
      return {
        callId,
        text,
        type,
        audioUrl: result.audioUrl,
        audioBuffer: null,
        source: result.source,
        voiceId: result.voiceId,
        twilioTTS: false,
      };
    }

    // Twilio TTS fallback
    return {
      callId,
      text,
      type,
      audioUrl: null,
      audioBuffer: null,
      source: result.source,
      voiceId: result.voiceId || 'Polly.Tatyana', // Русский голос
      twilioTTS: true,
    };
  } catch (error) {
    logger.error(`❌ TTS Processing Error for call ${callId}:`, error);

    // Ultimate fallback - return Twilio TTS instruction
    return {
      callId,
      text,
      type,
      audioUrl: null,
      audioBuffer: null,
      source: 'error_fallback',
      voiceId: 'Polly.Tatyana', // РУССКИЙ голос для fallback
      twilioTTS: true,
      error: error.message,
    };
  }
});

// =====================================================
// QUEUE EVENT LISTENERS
// =====================================================

// STT Events
sttQueue.on('completed', (job, result) => {
  logger.info(`✅ STT job completed: ${job.id} for call: ${result.callId}`);
});

sttQueue.on('failed', (job, err) => {
  logger.error(`❌ STT job failed: ${job.id}`, err);
});

// LLM Events
llmQueue.on('completed', (job, result) => {
  logger.info(`✅ LLM job completed: ${job.id} for call: ${result.callId}`);
});

llmQueue.on('failed', (job, err) => {
  logger.error(`❌ LLM job failed: ${job.id}`, err);
});

// TTS Events - CRITICAL TTS COMPLETION HANDLER
ttsQueue.on('completed', (job, result) => {
  logger.info(`✅ TTS job completed: ${job.id} for call: ${result.callId}`);

  // ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ РЕЗУЛЬТАТА
  logger.info(`🎯 TTS Result Details:`, {
    callId: result.callId,
    source: result.source,
    twilioTTS: result.twilioTTS,
    hasAudioUrl: !!result.audioUrl,
    type: result.type,
  });

  // Notify OutboundManager
  if (result.callId) {
    outboundManager.handleTTSCompleted(result.callId, result);
    logger.info(
      `📢 TTS completion notified to OutboundManager for call: ${result.callId}`
    );
  }
});

ttsQueue.on('failed', (job, err) => {
  const { callId } = job.data;
  logger.error(`❌ TTS job failed: ${job.id} for call: ${callId}`, err);

  // Notify manager about failure - will use Twilio TTS fallback
  try {
    outboundManager.handleTTSCompleted(callId, {
      audioUrl: null,
      text: job.data.text,
      type: job.data.type,
      source: 'tts_failed',
      twilioTTS: true,
      voiceId: 'alice',
      error: err.message,
    });
  } catch (error) {
    logger.error(`Failed to handle TTS failure notification:`, error);
  }
});

// =====================================================
// QUEUE HEALTH MONITORING
// =====================================================

// Monitor queue health every 30 seconds
setInterval(async () => {
  try {
    const [
      sttWaiting,
      sttActive,
      llmWaiting,
      llmActive,
      ttsWaiting,
      ttsActive,
    ] = await Promise.all([
      sttQueue.getWaiting(),
      sttQueue.getActive(),
      llmQueue.getWaiting(),
      llmQueue.getActive(),
      ttsQueue.getWaiting(),
      ttsQueue.getActive(),
    ]);

    const stats = {
      stt: { waiting: sttWaiting.length, active: sttActive.length },
      llm: { waiting: llmWaiting.length, active: llmActive.length },
      tts: { waiting: ttsWaiting.length, active: ttsActive.length },
    };

    // Log if any queues are backed up
    const totalWaiting =
      stats.stt.waiting + stats.llm.waiting + stats.tts.waiting;
    if (totalWaiting > 10) {
      logger.warn(`Queue backlog detected:`, stats);
    }

    // Log TTS metrics periodically
    if (Math.random() < 0.1) {
      // 10% chance = ~every 5 minutes
      const ttsMetrics = ttsManager.getMetrics();
      logger.info(`TTS Metrics:`, ttsMetrics.performance);
    }
  } catch (error) {
    logger.error('Queue health check failed:', error);
  }
}, 30000);

// =====================================================
// QUEUE CLEANUP
// =====================================================

// Clean completed jobs every hour
setInterval(
  async () => {
    try {
      const [sttCleaned, llmCleaned, ttsCleaned] = await Promise.all([
        sttQueue.clean(24 * 60 * 60 * 1000, 'completed'), // 24 hours
        llmQueue.clean(24 * 60 * 60 * 1000, 'completed'),
        ttsQueue.clean(6 * 60 * 60 * 1000, 'completed'), // 6 hours (TTS files get cleaned separately)
      ]);

      if (sttCleaned + llmCleaned + ttsCleaned > 0) {
        logger.info(
          `Queue cleanup: ${sttCleaned.length || sttCleaned} STT, ${llmCleaned.length || llmCleaned} LLM, ${ttsCleaned.length || ttsCleaned} TTS jobs removed`
        );
      }
    } catch (error) {
      logger.error('Queue cleanup failed:', error);
    }
  },
  60 * 60 * 1000
);

logger.info('🚀 Queue processors initialized with TTS completion handlers');
