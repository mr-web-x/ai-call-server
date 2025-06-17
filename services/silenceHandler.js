// services/silenceHandler.js
import { logger } from '../utils/logger.js';
import { ttsManager } from './ttsManager.js';
import { outboundManager } from './outboundManager.js';

/**
 * 🔇 ОБРАБОТЧИК МОЛЧАНИЯ И ТИШИНЫ
 * Специализированная логика для различных типов молчания
 */
export class SilenceHandler {
  constructor() {
    // 📊 СТАТИСТИКА МОЛЧАНИЯ
    this.silenceStats = new Map(); // callId -> silence events

    // 🎭 ТИПЫ МОЛЧАНИЯ
    this.SILENCE_TYPES = {
      WHISPER_HALLUCINATION: 'hallucination',
      REAL_SILENCE: 'silence',
      THINKING_PAUSE: 'thinking',
      TECHNICAL_ISSUE: 'technical',
      USER_LEFT: 'abandoned',
    };

    // ⏱️ ПОРОГИ ВРЕМЕНИ
    this.TIMING_THRESHOLDS = {
      SHORT_PAUSE: 3, // секунд - обычная пауза
      MEDIUM_PAUSE: 8, // секунд - размышления
      LONG_PAUSE: 15, // секунд - возможно ушел
      ABANDON_THRESHOLD: 25, // секунд - точно ушел
    };

    // 🗣️ ШАБЛОНЫ ОТВЕТОВ НА МОЛЧАНИЕ
    this.SILENCE_RESPONSES = {
      first_silence: [
        'Алло? Вы меня слышите?',
        'Не могу вас расслышать. Говорите пожалуйста громче.',
        'Связь прерывается. Повторите пожалуйста.',
      ],
      repeated_silence: [
        'Похоже, связь нестабильная. Я подожду немного.',
        'Если вы там, дайте знать любым способом.',
        'Возможно, стоит перезвонить позже для лучшей связи.',
      ],
      thinking_pause: [
        'Понимаю, что нужно время подумать. Я подожду.',
        'Не торопитесь с ответом, у нас есть время.',
        'Обдумайте варианты, это важное решение.',
      ],
      final_warning: [
        'Если не услышу ответа в ближайшие секунды, завершу звонок.',
        'Последний раз спрашиваю - вы готовы обсудить вопрос?',
        'Заканчиваю разговор через 10 секунд при отсутствии ответа.',
      ],
    };

    logger.info('🔇 SilenceHandler initialized');
  }

  /**
   * 🎯 ОСНОВНАЯ ФУНКЦИЯ ОБРАБОТКИ МОЛЧАНИЯ
   * @param {string} callId - ID звонка
   * @param {Object} context - контекст молчания
   * @returns {Object} результат обработки
   */
  async handleSilence(callId, context = {}) {
    const {
      transcription = '',
      audioSize = 0,
      duration = 0,
      currentStage = 'unknown',
      conversationHistory = [],
      silenceType = this.SILENCE_TYPES.REAL_SILENCE,
    } = context;

    // 📊 ОБНОВЛЯЕМ СТАТИСТИКУ
    this.updateSilenceStats(callId, silenceType, duration);

    // 🔍 АНАЛИЗИРУЕМ ТИП МОЛЧАНИЯ
    const silenceAnalysis = this.analyzeSilenceContext(callId, context);

    // 🎭 ВЫБИРАЕМ СТРАТЕГИЮ ОТВЕТА
    const responseStrategy = this.determineResponseStrategy(
      callId,
      silenceAnalysis
    );

    // 🗣️ ГЕНЕРИРУЕМ ОТВЕТ
    const response = await this.generateSilenceResponse(
      callId,
      responseStrategy,
      silenceAnalysis
    );

    // 📝 ЛОГИРУЕМ РЕЗУЛЬТАТ
    this.logSilenceHandling(
      callId,
      silenceAnalysis,
      responseStrategy,
      response
    );

    return {
      success: true,
      response: response.text,
      nextStage: response.nextStage,
      silenceType: silenceAnalysis.type,
      strategy: responseStrategy.name,
      shouldContinue: response.shouldContinue,
      metadata: {
        silenceCount: this.getSilenceCount(callId),
        totalSilenceDuration: this.getTotalSilenceDuration(callId),
        analysis: silenceAnalysis,
      },
    };
  }

  /**
   * 🔍 АНАЛИЗ КОНТЕКСТА МОЛЧАНИЯ
   */
  analyzeSilenceContext(callId, context) {
    const { duration, currentStage, conversationHistory, silenceType } =
      context;
    const silenceCount = this.getSilenceCount(callId);
    const totalSilenceDuration = this.getTotalSilenceDuration(callId);

    const analysis = {
      type: silenceType,
      severity: 'low',
      duration,
      count: silenceCount,
      totalDuration: totalSilenceDuration,
      stage: currentStage,
      conversationLength: conversationHistory.length,
      indicators: [],
    };

    // 📏 ОПРЕДЕЛЯЕМ СЕРЬЕЗНОСТЬ
    if (duration <= this.TIMING_THRESHOLDS.SHORT_PAUSE) {
      analysis.severity = 'low';
      analysis.indicators.push('Short pause - normal');
    } else if (duration <= this.TIMING_THRESHOLDS.MEDIUM_PAUSE) {
      analysis.severity = 'medium';
      analysis.indicators.push('Medium pause - might be thinking');
    } else if (duration <= this.TIMING_THRESHOLDS.LONG_PAUSE) {
      analysis.severity = 'high';
      analysis.indicators.push('Long pause - possible issue');
    } else {
      analysis.severity = 'critical';
      analysis.indicators.push('Very long pause - likely abandoned');
    }

    // 🔢 АНАЛИЗ КОЛИЧЕСТВА МОЛЧАНИЙ
    if (silenceCount >= 3) {
      analysis.severity = 'high';
      analysis.indicators.push(`Multiple silences: ${silenceCount}`);
    }

    // ⏱️ АНАЛИЗ ОБЩЕГО ВРЕМЕНИ МОЛЧАНИЯ
    if (totalSilenceDuration > 30) {
      analysis.severity = 'critical';
      analysis.indicators.push(`Total silence time: ${totalSilenceDuration}s`);
    }

    // 🎭 АНАЛИЗ СТАДИИ РАЗГОВОРА
    if (currentStage === 'greeting_sent' && silenceCount === 1) {
      analysis.indicators.push('First interaction silence');
    } else if (currentStage === 'negotiation' && silenceCount >= 2) {
      analysis.indicators.push('Negotiation resistance silence');
    }

    return analysis;
  }

  /**
   * 🎯 ОПРЕДЕЛЕНИЕ СТРАТЕГИИ ОТВЕТА
   */
  determineResponseStrategy(callId, analysis) {
    const { severity, count, type, stage, duration } = analysis;

    // 🎭 СТРАТЕГИЯ ДЛЯ ГАЛЛЮЦИНАЦИЙ WHISPER
    if (type === this.SILENCE_TYPES.WHISPER_HALLUCINATION) {
      return {
        name: 'ignore_hallucination',
        action: 'continue_waiting',
        priority: 'low',
        timeout: 10,
        explanation: 'Whisper hallucination detected, continue normal flow',
      };
    }

    // ⚡ СТРАТЕГИЯ ДЛЯ КОРОТКИХ ПАУЗ
    if (severity === 'low' && count <= 2) {
      return {
        name: 'gentle_prompt',
        action: 'soft_reminder',
        priority: 'low',
        timeout: 8,
        explanation: 'Normal pause, gentle prompting',
      };
    }

    // 🤔 СТРАТЕГИЯ ДЛЯ РАЗМЫШЛЕНИЙ
    if (severity === 'medium' && stage === 'negotiation') {
      return {
        name: 'thinking_patience',
        action: 'patient_waiting',
        priority: 'medium',
        timeout: 12,
        explanation: 'Client might be considering options',
      };
    }

    // 🚨 СТРАТЕГИЯ ДЛЯ ПОВТОРНЫХ МОЛЧАНИЙ
    if (count >= 3 || severity === 'high') {
      return {
        name: 'escalated_attention',
        action: 'demand_response',
        priority: 'high',
        timeout: 15,
        explanation: 'Multiple silences, need active response',
      };
    }

    // ⏰ СТРАТЕГИЯ ДЛЯ КРИТИЧЕСКИХ СЛУЧАЕВ
    if (
      severity === 'critical' ||
      duration > this.TIMING_THRESHOLDS.ABANDON_THRESHOLD
    ) {
      return {
        name: 'final_attempt',
        action: 'prepare_hangup',
        priority: 'critical',
        timeout: 10,
        explanation: 'Likely abandoned call, final attempt',
      };
    }

    // 🔄 ДЕФОЛТНАЯ СТРАТЕГИЯ
    return {
      name: 'standard_prompt',
      action: 'normal_prompt',
      priority: 'medium',
      timeout: 10,
      explanation: 'Standard silence handling',
    };
  }

  /**
   * 🗣️ ГЕНЕРАЦИЯ ОТВЕТА НА МОЛЧАНИЕ
   */
  async generateSilenceResponse(callId, strategy, analysis) {
    const { name, action, priority, timeout } = strategy;
    const { count, type, severity } = analysis;

    let responseText = '';
    let nextStage = 'listening';
    let shouldContinue = true;

    // 🎭 ИГНОРИРОВАНИЕ ГАЛЛЮЦИНАЦИЙ
    if (name === 'ignore_hallucination') {
      // Не генерируем аудио ответ, просто продолжаем ждать
      return {
        text: null,
        nextStage: 'listening',
        shouldContinue: true,
        audioGenerated: false,
      };
    }

    // 🗣️ ВЫБОР ТЕКСТА ОТВЕТА
    switch (action) {
      case 'soft_reminder':
        responseText = this.getRandomResponse('first_silence');
        nextStage = 'listening';
        break;

      case 'patient_waiting':
        responseText = this.getRandomResponse('thinking_pause');
        nextStage = 'waiting';
        break;

      case 'demand_response':
        responseText = this.getRandomResponse('repeated_silence');
        nextStage = 'demanding_response';
        break;

      case 'prepare_hangup':
        responseText = this.getRandomResponse('final_warning');
        nextStage = 'final_warning';
        shouldContinue = false;
        break;

      default:
        responseText = 'Алло? Вы меня слышите?';
        nextStage = 'listening';
    }

    // 🎵 ГЕНЕРИРУЕМ АУДИО (ТОЛЬКО ЕСЛИ ЕСТЬ ТЕКСТ)
    let audioGenerated = false;
    if (responseText) {
      try {
        const result = await ttsManager.synthesizeSpeech(responseText, {
          priority: priority === 'critical' ? 'urgent' : 'normal',
          voiceId: process.env.TTS_VOICE_ID,
          useCache: true,
        });

        if (result && (result.audioUrl || result.audioBuffer)) {
          let audioUrl = result.audioUrl;

          // 🔥 ИСПРАВЛЕНИЕ: Если нет URL, сохраняем buffer как файл
          if (result.audioBuffer && !audioUrl) {
            const audioManager = (await import('./audioManager.js'))
              .audioManager;
            const audioFile = await audioManager.saveAudioFile(
              callId,
              result.audioBuffer,
              'silence_response'
            );
            audioUrl = audioFile.publicUrl;
          }

          outboundManager.pendingAudio.set(callId, {
            audioUrl: audioUrl,
            audioBuffer: result.audioBuffer,
            source: result.source,
            type: 'silence_response',
            timestamp: Date.now(),
            consumed: false,
          });

          logger.info(`🎵 Silence audio saved: ${audioUrl}`);
        }

        audioGenerated = true;
        logger.info(
          `🔇 Generated silence response for ${callId}: "${responseText}"`
        );
      } catch (ttsError) {
        logger.warn(
          `⚠️ Failed to generate TTS for silence response ${callId}:`,
          ttsError.message
        );
        audioGenerated = false;
      }
    }

    return {
      text: responseText,
      nextStage,
      shouldContinue,
      audioGenerated,
      strategy: name,
      timeout,
    };
  }

  /**
   * 🎲 ПОЛУЧЕНИЕ СЛУЧАЙНОГО ОТВЕТА
   */
  getRandomResponse(category) {
    const responses = this.SILENCE_RESPONSES[category];
    if (!responses || responses.length === 0) {
      return 'Алло? Вы меня слышите?';
    }

    const randomIndex = Math.floor(Math.random() * responses.length);
    return responses[randomIndex];
  }

  /**
   * 📊 УПРАВЛЕНИЕ СТАТИСТИКОЙ
   */
  updateSilenceStats(callId, silenceType, duration) {
    if (!this.silenceStats.has(callId)) {
      this.silenceStats.set(callId, {
        events: [],
        totalDuration: 0,
        count: 0,
        types: {},
      });
    }

    const stats = this.silenceStats.get(callId);
    stats.events.push({
      type: silenceType,
      duration,
      timestamp: Date.now(),
    });
    stats.totalDuration += duration;
    stats.count++;
    stats.types[silenceType] = (stats.types[silenceType] || 0) + 1;
  }

  getSilenceCount(callId) {
    return this.silenceStats.get(callId)?.count || 0;
  }

  getTotalSilenceDuration(callId) {
    return this.silenceStats.get(callId)?.totalDuration || 0;
  }

  /**
   * 📝 ЛОГИРОВАНИЕ ОБРАБОТКИ МОЛЧАНИЯ
   */
  logSilenceHandling(callId, analysis, strategy, response) {
    const emoji =
      {
        low: '🔇',
        medium: '🤔',
        high: '⚠️',
        critical: '🚨',
      }[analysis.severity] || '🔇';

    logger.info(`${emoji} Silence handled for call ${callId}:`, {
      silenceType: analysis.type,
      severity: analysis.severity,
      duration: `${analysis.duration}s`,
      count: analysis.count,
      strategy: strategy.name,
      action: strategy.action,
      response: response.text
        ? response.text.substring(0, 50) + '...'
        : 'No audio response',
      shouldContinue: response.shouldContinue,
      audioGenerated: response.audioGenerated,
      nextStage: response.nextStage,
    });
  }

  /**
   * 🧹 ОЧИСТКА СТАТИСТИКИ ЗАВЕРШЕННОГО ЗВОНКА
   */
  cleanupCallStats(callId) {
    const stats = this.silenceStats.get(callId);
    if (stats) {
      logger.info(`📊 Final silence stats for call ${callId}:`, {
        totalEvents: stats.count,
        totalDuration: `${stats.totalDuration}s`,
        typeBreakdown: stats.types,
      });
      this.silenceStats.delete(callId);
    }
  }

  /**
   * 📈 ГЛОБАЛЬНАЯ СТАТИСТИКА
   */
  getGlobalStats() {
    const allStats = Array.from(this.silenceStats.values());
    const totalCalls = allStats.length;

    if (totalCalls === 0) {
      return {
        activeCalls: 0,
        totalSilenceEvents: 0,
        averageSilencePerCall: 0,
        mostCommonType: 'none',
      };
    }

    const totalEvents = allStats.reduce((sum, stats) => sum + stats.count, 0);
    const allTypes = {};

    allStats.forEach((stats) => {
      Object.entries(stats.types).forEach(([type, count]) => {
        allTypes[type] = (allTypes[type] || 0) + count;
      });
    });

    const mostCommonType =
      Object.entries(allTypes).sort(([, a], [, b]) => b - a)[0]?.[0] || 'none';

    return {
      activeCalls: totalCalls,
      totalSilenceEvents: totalEvents,
      averageSilencePerCall: Math.round((totalEvents / totalCalls) * 10) / 10,
      mostCommonType,
      typeBreakdown: allTypes,
    };
  }

  /**
   * 🎯 БЫСТРАЯ ПРОВЕРКА - НУЖНО ЛИ РЕАГИРОВАТЬ НА МОЛЧАНИЕ
   */
  shouldRespondToSilence(callId, silenceType, duration) {
    // Галлюцинации Whisper - игнорируем
    if (silenceType === this.SILENCE_TYPES.WHISPER_HALLUCINATION) {
      return {
        should: false,
        reason: 'Whisper hallucination - ignore',
      };
    }

    // Очень короткие паузы - игнорируем
    if (duration < 2) {
      return {
        should: false,
        reason: 'Too short to be meaningful silence',
      };
    }

    // Первая нормальная пауза - мягко реагируем
    const silenceCount = this.getSilenceCount(callId);
    if (silenceCount === 0 && duration < this.TIMING_THRESHOLDS.MEDIUM_PAUSE) {
      return {
        should: true,
        reason: 'First normal silence - gentle response needed',
      };
    }

    // Повторные или длинные молчания - обязательно реагируем
    if (silenceCount > 0 || duration >= this.TIMING_THRESHOLDS.MEDIUM_PAUSE) {
      return {
        should: true,
        reason: 'Repeated or long silence - response required',
      };
    }

    return {
      should: true,
      reason: 'Default - better to respond',
    };
  }

  /**
   * 🔄 ИНТЕГРАЦИЯ С ОСНОВНЫМ PIPELINE
   */
  async integrateWithPipeline(callId, whisperResult, audioSize, duration) {
    const { isHallucination, isSilence, transcription } = whisperResult;

    // Определяем тип молчания
    let silenceType;
    if (isHallucination) {
      silenceType = this.SILENCE_TYPES.WHISPER_HALLUCINATION;
    } else if (isSilence) {
      silenceType = this.SILENCE_TYPES.REAL_SILENCE;
    } else {
      // Не молчание - возвращаем null
      return null;
    }

    // Проверяем нужность реакции
    const shouldRespond = this.shouldRespondToSilence(
      callId,
      silenceType,
      duration
    );

    if (!shouldRespond.should) {
      logger.info(`🔇 Ignoring silence for ${callId}: ${shouldRespond.reason}`);
      this.updateSilenceStats(callId, silenceType, duration);
      return {
        action: 'ignore',
        reason: shouldRespond.reason,
        silenceType,
      };
    }

    // Обрабатываем молчание
    const context = {
      transcription,
      audioSize,
      duration,
      silenceType,
      // Эти данные должны приходить из основного pipeline
      currentStage: 'unknown', // TODO: передавать реальную стадию
      conversationHistory: [], // TODO: передавать реальную историю
    };

    const result = await this.handleSilence(callId, context);

    return {
      action: 'respond',
      ...result,
    };
  }
}

// Создаем глобальный экземпляр
export const silenceHandler = new SilenceHandler();
