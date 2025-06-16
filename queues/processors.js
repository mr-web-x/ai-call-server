import { sttQueue, llmQueue, ttsQueue } from './setup.js';
import { AIServices } from '../services/aiServices.js';
import { responseGenerator } from '../services/responseGenerator.js';
import { ttsManager } from '../services/ttsManager.js';
import { audioManager } from '../services/audioManager.js';
import { outboundManager } from '../services/outboundManager.js';
import { logger } from '../utils/logger.js';
import { cacheManager } from '../services/cacheManager.js';

// STT Queue Processor (без изменений)
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

// LLM Classification Queue Processor - ОБНОВЛЕНО для новой системы
llmQueue.process('classify', 3, async (job) => {
  const { text, callId, currentStage, conversationHistory } = job.data;

  try {
    logger.info(`Processing LLM classification for call: ${callId}`);

    // Используем обновленный метод классификации
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

// НОВЫЙ: Response Generation Queue Processor
llmQueue.process('generateResponse', 2, async (job) => {
  const { responseContext } = job.data;
  const { callId } = responseContext;

  try {
    logger.info(`🤖 Processing response generation for call: ${callId}`);

    const result = await responseGenerator.generateResponse(responseContext);

    logger.info(`✅ Response generated for call ${callId}:`, {
      method: result.method,
      length: result.text?.length || 0,
      nextStage: result.nextStage,
    });

    return {
      callId,
      ...result,
    };
  } catch (error) {
    logger.error(`❌ Response generation error for call ${callId}:`, error);

    // Фолбэк на простой ответ
    const fallbackResponse =
      responseGenerator.getFallbackResponse(responseContext);

    return {
      callId,
      ...fallbackResponse,
      error: error.message,
    };
  }
});

// TTS Queue Processor - ОБНОВЛЕНО с поддержкой новых типов
ttsQueue.process('synthesize', 3, async (job) => {
  const { text, callId, priority, type, useCache, voiceId } = job.data;

  try {
    logger.info(
      `🎤 Processing TTS for call: ${callId}, priority: ${priority}, type: ${type}`
    );

    // Используем TTS Manager
    const result = await ttsManager.synthesizeSpeech(text, {
      voiceId: voiceId,
      priority: priority,
      useCache: useCache,
    });

    logger.info(
      `🎯 TTS result for call ${callId}: source=${result.source}, hasAudio=${!!result.audioBuffer}`
    );

    // Кэшируем ТОЛЬКО новые ElevenLabs результаты
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

    // Если есть audio buffer - сохраняем как файл
    if (result.audioBuffer) {
      const audioFile = await audioManager.saveAudioFile(
        callId,
        result.audioBuffer,
        type || 'response'
      );

      // Уведомляем OutboundManager о готовности аудио
      if (outboundManager.onTTSCompleted) {
        outboundManager.onTTSCompleted(callId, {
          audioUrl: audioFile.publicUrl,
          audioBuffer: result.audioBuffer,
          source: result.source,
          type: type,
        });
      }

      logger.info(`✅ TTS job completed: ${job.id} for call: ${callId}`);

      logger.info(`🎯 TTS Result Details:`, {
        callId,
        source: result.source,
        twilioTTS: false,
        hasAudioUrl: true,
        type: type,
      });

      logger.info(`🎯 TTS COMPLETED for call ${callId}:`, {
        source: result.source,
        hasAudioUrl: false,
        hasAudioBuffer: true,
        twilioTTS: false,
        type: type,
        voiceId: result.voiceId,
      });

      logger.info(
        `✅ TTS completed for call ${callId}, audio ready: ${result.source}`
      );

      // Если это приветствие, особое уведомление
      if (type === 'greeting') {
        logger.info(
          `🎉 Greeting ready for call ${callId} - ${result.source} audio prepared!`
        );
      }

      logger.info(
        `📢 TTS completion notified to OutboundManager for call: ${callId}`
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

    // Cache hit - возвращаем URL кэша
    if (result.audioUrl) {
      logger.info(`✅ Using cached ElevenLabs audio: ${result.audioUrl}`);

      if (outboundManager.onTTSCompleted) {
        outboundManager.onTTSCompleted(callId, {
          audioUrl: result.audioUrl,
          source: result.source,
          type: type,
        });
      }

      return {
        callId,
        text,
        type,
        audioUrl: result.audioUrl,
        source: result.source,
        voiceId: result.voiceId,
        twilioTTS: false,
        cached: true,
      };
    }

    // Фолбэк на Twilio TTS
    logger.warn(
      `⚠️ No audio generated, using Twilio TTS fallback for call: ${callId}`
    );

    return {
      callId,
      text,
      type,
      source: 'twilio',
      twilioTTS: true,
      fallback: true,
    };
  } catch (error) {
    logger.error(`❌ TTS processing failed for call ${callId}:`, error);

    // Возвращаем fallback
    return {
      callId,
      text,
      type,
      source: 'twilio',
      twilioTTS: true,
      error: error.message,
      fallback: true,
    };
  }
});

// === НАСТРОЙКА ОБРАБОТЧИКОВ ЗАВЕРШЕНИЯ ЗАДАЧ ===

// TTS completion handler - уведомляет OutboundManager
ttsQueue.on('completed', (job, result) => {
  const { callId, type } = result;

  if (result.audioUrl || result.audioBuffer) {
    logger.info(
      `🎵 TTS audio ready for call ${callId} (${type}): ${result.source}`
    );

    // Уведомляем OutboundManager
    if (outboundManager.pendingAudio) {
      outboundManager.pendingAudio.set(callId, {
        audioUrl: result.audioUrl,
        audioBuffer: result.audioBuffer,
        source: result.source,
        type: type,
        timestamp: Date.now(),
        consumed: false,
      });
    }
  }
});

// Response generation completion handler
llmQueue.on('completed', (job, result) => {
  if (job.name === 'generateResponse') {
    const { callId, method } = result;
    logger.info(
      `🎯 Response generation completed for call ${callId} using ${method}`
    );
  }
});

// Error handlers
sttQueue.on('failed', (job, error) => {
  logger.error(`❌ STT job failed:`, {
    jobId: job.id,
    callId: job.data?.callId,
    error: error.message,
  });
});

llmQueue.on('failed', (job, error) => {
  logger.error(`❌ LLM job failed:`, {
    jobId: job.id,
    jobName: job.name,
    callId: job.data?.callId || job.data?.responseContext?.callId,
    error: error.message,
  });
});

ttsQueue.on('failed', (job, error) => {
  logger.error(`❌ TTS job failed:`, {
    jobId: job.id,
    callId: job.data?.callId,
    error: error.message,
  });
});

logger.info('🚀 Queue processors initialized with TTS completion handlers');
