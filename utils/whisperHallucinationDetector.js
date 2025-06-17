// utils/whisperHallucinationDetector.js
import { logger } from './logger.js';

/**
 * 🎯 ДЕТЕКТОР ГАЛЛЮЦИНАЦИЙ WHISPER
 * Решает проблему с YouTube-фразами при обработке тишины
 */
export class WhisperHallucinationDetector {
  constructor() {
    // 🔍 ПАТТЕРНЫ ПОПУЛЯРНЫХ ГАЛЛЮЦИНАЦИЙ
    this.HALLUCINATION_PATTERNS = [
      // YouTube специфичные фразы
      /продолжение следует/i,
      /субтитры делал/i,
      /подписывайтесь/i,
      /лайк/i,
      /комментари/i,
      /спасибо за просмотр/i,
      /не забудьте/i,
      /колокольчик/i,
      /уведомления/i,
      /редактор субтитров/i,
      /корректор/i,
      /а\.семкин/i,
      /а\.егорова/i,

      // Типичные концовки видео
      /до свидания/i,
      /увидимся/i,
      /до встречи/i,
      /всем пока/i,

      // Технические фразы
      /начало записи/i,
      /конец записи/i,
      /тестовая запись/i,
      /проверка звука/i,

      // Музыкальные/медиа фразы
      /музыка играет/i,
      /инструментальная/i,
      /мелодия/i,
      /саундтрек/i,

      // Странные повторения
      /(.)\1{4,}/i, // 4+ одинаковых символа подряд
      /^[а-яё\s]{1,3}$/i, // Очень короткие фразы
    ];

    // 🎵 МУЗЫКАЛЬНЫЕ/МЕДИА ИНДИКАТОРЫ
    this.MEDIA_INDICATORS = [
      /\[музыка\]/i,
      /\[аплодисменты\]/i,
      /\[смех\]/i,
      /\[звук\]/i,
      /♪/,
      /♫/,
      /🎵/,
      /🎶/,
    ];

    // 📊 ПОРОГОВЫЕ ЗНАЧЕНИЯ
    this.THRESHOLDS = {
      MIN_AUDIO_DENSITY: 5, // KB/сек минимум для реальной речи
      MAX_SILENT_DURATION: 15, // секунд максимум для "тишины"
      MIN_MEANINGFUL_LENGTH: 5, // символов минимум для осмысленного текста
      MAX_REPEAT_RATIO: 0.7, // максимальная доля повторяющихся символов
    };

    // 📈 СТАТИСТИКА
    this.stats = {
      totalProcessed: 0,
      hallucinationsDetected: 0,
      silenceDetected: 0,
      realSpeechDetected: 0,
    };

    logger.info('🎯 WhisperHallucinationDetector initialized');
  }

  /**
   * 🔍 ОСНОВНАЯ ФУНКЦИЯ АНАЛИЗА
   * @param {string} transcription - текст от Whisper
   * @param {number} audioSize - размер аудио в байтах
   * @param {number} duration - длительность в секундах
   * @returns {Object} результат анализа
   */
  analyzeTranscription(transcription, audioSize, duration) {
    this.stats.totalProcessed++;

    const analysis = {
      isHallucination: false,
      isSilence: false,
      isRealSpeech: false,
      confidence: 0,
      reasons: [],
      recommendation: 'process',
      metrics: {},
    };

    // 📏 БАЗОВЫЕ МЕТРИКИ
    const audioSizeKB = audioSize / 1024;
    const audioDensity = audioSizeKB / duration;
    const textLength = transcription.trim().length;
    const wordCount = transcription
      .trim()
      .split(/\s+/)
      .filter((w) => w.length > 0).length;

    analysis.metrics = {
      audioSizeKB: Math.round(audioSizeKB * 10) / 10,
      duration,
      audioDensity: Math.round(audioDensity * 10) / 10,
      textLength,
      wordCount,
      avgWordLength: wordCount > 0 ? textLength / wordCount : 0,
    };

    // 🔍 ПРОВЕРКА 1: ПАТТЕРНЫ ГАЛЛЮЦИНАЦИЙ
    const hallucinationMatch = this.detectHallucinationPatterns(transcription);
    if (hallucinationMatch) {
      analysis.isHallucination = true;
      analysis.confidence = 0.95;
      analysis.reasons.push(
        `Detected hallucination pattern: "${hallucinationMatch}"`
      );
      analysis.recommendation = 'treat_as_silence';
      this.stats.hallucinationsDetected++;
    }

    // 🔍 ПРОВЕРКА 2: ПЛОТНОСТЬ АУДИО
    const silenceAnalysis = this.analyzeSilence(
      audioDensity,
      duration,
      textLength
    );
    if (silenceAnalysis.isSilence) {
      analysis.isSilence = true;
      analysis.confidence = Math.max(
        analysis.confidence,
        silenceAnalysis.confidence
      );
      analysis.reasons.push(...silenceAnalysis.reasons);
      analysis.recommendation = 'treat_as_silence';
      this.stats.silenceDetected++;
    }

    // 🔍 ПРОВЕРКА 3: КАЧЕСТВО ТЕКСТА
    const textQuality = this.analyzeTextQuality(transcription);
    if (textQuality.isSuspicious) {
      analysis.isHallucination = true;
      analysis.confidence = Math.max(
        analysis.confidence,
        textQuality.confidence
      );
      analysis.reasons.push(...textQuality.reasons);
      analysis.recommendation = 'treat_as_silence';
    }

    // ✅ ПРОВЕРКА 4: РЕАЛЬНАЯ РЕЧЬ
    if (!analysis.isHallucination && !analysis.isSilence) {
      const realSpeechAnalysis = this.validateRealSpeech(
        transcription,
        audioDensity,
        duration
      );
      if (realSpeechAnalysis.isReal) {
        analysis.isRealSpeech = true;
        analysis.confidence = realSpeechAnalysis.confidence;
        analysis.reasons.push(...realSpeechAnalysis.reasons);
        analysis.recommendation = 'process_normally';
        this.stats.realSpeechDetected++;
      }
    }

    // 📊 ЛОГИРОВАНИЕ РЕЗУЛЬТАТА
    this.logAnalysisResult(transcription, analysis);

    return analysis;
  }

  /**
   * 🎭 ДЕТЕКЦИЯ ПАТТЕРНОВ ГАЛЛЮЦИНАЦИЙ
   */
  detectHallucinationPatterns(text) {
    const normalizedText = text.toLowerCase().trim();

    for (const pattern of this.HALLUCINATION_PATTERNS) {
      const match = normalizedText.match(pattern);
      if (match) {
        return match[0];
      }
    }

    // Проверка медиа индикаторов
    for (const pattern of this.MEDIA_INDICATORS) {
      const match = text.match(pattern);
      if (match) {
        return match[0];
      }
    }

    return null;
  }

  /**
   * 🔇 АНАЛИЗ ТИШИНЫ
   */
  analyzeSilence(audioDensity, duration, textLength) {
    const analysis = {
      isSilence: false,
      confidence: 0,
      reasons: [],
    };

    // Очень низкая плотность аудио
    if (audioDensity < this.THRESHOLDS.MIN_AUDIO_DENSITY) {
      analysis.isSilence = true;
      analysis.confidence += 0.4;
      analysis.reasons.push(
        `Low audio density: ${audioDensity} KB/s (threshold: ${this.THRESHOLDS.MIN_AUDIO_DENSITY})`
      );
    }

    // Длинная запись с коротким текстом
    if (duration > 8 && textLength < 20) {
      analysis.isSilence = true;
      analysis.confidence += 0.3;
      analysis.reasons.push(
        `Long audio (${duration}s) with short text (${textLength} chars)`
      );
    }

    // Очень длинная "тишина"
    if (duration > this.THRESHOLDS.MAX_SILENT_DURATION) {
      analysis.confidence += 0.2;
      analysis.reasons.push(`Very long recording: ${duration}s`);
    }

    // Соотношение размер/текст подозрительное
    const sizeToTextRatio = (audioDensity * duration) / Math.max(textLength, 1);
    if (sizeToTextRatio > 15) {
      analysis.isSilence = true;
      analysis.confidence += 0.2;
      analysis.reasons.push(
        `High size-to-text ratio: ${Math.round(sizeToTextRatio)}`
      );
    }

    return analysis;
  }

  /**
   * ✏️ АНАЛИЗ КАЧЕСТВА ТЕКСТА
   */
  analyzeTextQuality(text) {
    const analysis = {
      isSuspicious: false,
      confidence: 0,
      reasons: [],
    };

    const trimmedText = text.trim();
    const length = trimmedText.length;

    // Слишком короткий текст
    if (length < this.THRESHOLDS.MIN_MEANINGFUL_LENGTH) {
      analysis.isSuspicious = true;
      analysis.confidence += 0.3;
      analysis.reasons.push(`Text too short: ${length} chars`);
    }

    // Анализ повторяющихся символов
    const repeatRatio = this.calculateRepeatRatio(trimmedText);
    if (repeatRatio > this.THRESHOLDS.MAX_REPEAT_RATIO) {
      analysis.isSuspicious = true;
      analysis.confidence += 0.4;
      analysis.reasons.push(
        `High repeat ratio: ${Math.round(repeatRatio * 100)}%`
      );
    }

    // Проверка на бессмысленные последовательности
    if (this.containsNonsenseSequences(trimmedText)) {
      analysis.isSuspicious = true;
      analysis.confidence += 0.3;
      analysis.reasons.push('Contains nonsense sequences');
    }

    // Только знаки препинания или спец символы
    if (/^[^\w\u0400-\u04FF]+$/.test(trimmedText)) {
      analysis.isSuspicious = true;
      analysis.confidence += 0.5;
      analysis.reasons.push('Only punctuation or special characters');
    }

    return analysis;
  }

  /**
   * ✅ ВАЛИДАЦИЯ РЕАЛЬНОЙ РЕЧИ
   */
  validateRealSpeech(text, audioDensity, duration) {
    const analysis = {
      isReal: false,
      confidence: 0,
      reasons: [],
    };

    const trimmedText = text.trim();
    const wordCount = trimmedText
      .split(/\s+/)
      .filter((w) => w.length > 0).length;

    // Нормальная плотность аудио
    if (audioDensity >= this.THRESHOLDS.MIN_AUDIO_DENSITY) {
      analysis.confidence += 0.3;
      analysis.reasons.push(`Good audio density: ${audioDensity} KB/s`);
    }

    // Адекватное соотношение слов к времени
    const wordsPerSecond = wordCount / duration;
    if (wordsPerSecond >= 0.5 && wordsPerSecond <= 4) {
      analysis.confidence += 0.3;
      analysis.reasons.push(
        `Natural speech rate: ${Math.round(wordsPerSecond * 10) / 10} words/s`
      );
    }

    // Содержит осмысленные русские слова
    if (this.containsMeaningfulRussianWords(trimmedText)) {
      analysis.confidence += 0.2;
      analysis.reasons.push('Contains meaningful Russian words');
    }

    // Нормальная длина
    if (trimmedText.length >= 10 && trimmedText.length <= 200) {
      analysis.confidence += 0.2;
      analysis.reasons.push(`Normal text length: ${trimmedText.length} chars`);
    }

    analysis.isReal = analysis.confidence >= 0.6;

    return analysis;
  }

  /**
   * 🔢 ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
   */
  calculateRepeatRatio(text) {
    if (text.length < 3) return 0;

    const charCount = {};
    for (const char of text.toLowerCase()) {
      charCount[char] = (charCount[char] || 0) + 1;
    }

    const maxRepeats = Math.max(...Object.values(charCount));
    return maxRepeats / text.length;
  }

  containsNonsenseSequences(text) {
    // Проверка на повторяющиеся последовательности
    const repeatingPatterns = [
      /(.{2,})\1{2,}/i, // повторяющиеся паттерны
      /^[аеиоуыэюя\s]+$/i, // только гласные
      /^[бвгджзйклмнпрстфхцчшщ\s]+$/i, // только согласные
    ];

    return repeatingPatterns.some((pattern) => pattern.test(text));
  }

  containsMeaningfulRussianWords(text) {
    // Базовые русские слова которые указывают на реальную речь
    const meaningfulWords = [
      'нет',
      'да',
      'не',
      'хочу',
      'буду',
      'могу',
      'деньги',
      'рубл',
      'платить',
      'договор',
      'банк',
      'долг',
      'кредит',
      'сумма',
      'оплата',
      'звонок',
      'понимаю',
      'слышу',
      'говорю',
      'знаю',
      'думаю',
      'работаю',
      'время',
      'день',
      'неделя',
      'месяц',
      'год',
      'сегодня',
      'завтра',
    ];

    const lowerText = text.toLowerCase();
    return meaningfulWords.some((word) => lowerText.includes(word));
  }

  /**
   * 📊 ЛОГИРОВАНИЕ РЕЗУЛЬТАТОВ
   */
  logAnalysisResult(transcription, analysis) {
    const emoji = analysis.isHallucination
      ? '🎭'
      : analysis.isSilence
        ? '🔇'
        : analysis.isRealSpeech
          ? '🗣️'
          : '❓';

    logger.info(`${emoji} Whisper Analysis Result:`, {
      text:
        transcription.substring(0, 50) +
        (transcription.length > 50 ? '...' : ''),
      isHallucination: analysis.isHallucination,
      isSilence: analysis.isSilence,
      isRealSpeech: analysis.isRealSpeech,
      confidence: Math.round(analysis.confidence * 100) + '%',
      recommendation: analysis.recommendation,
      metrics: analysis.metrics,
      reasons: analysis.reasons,
    });
  }

  /**
   * 📈 ПОЛУЧИТЬ СТАТИСТИКУ
   */
  getStats() {
    const total = this.stats.totalProcessed;
    return {
      ...this.stats,
      hallucinationRate:
        total > 0
          ? Math.round((this.stats.hallucinationsDetected / total) * 100)
          : 0,
      silenceRate:
        total > 0 ? Math.round((this.stats.silenceDetected / total) * 100) : 0,
      realSpeechRate:
        total > 0
          ? Math.round((this.stats.realSpeechDetected / total) * 100)
          : 0,
    };
  }

  /**
   * 🔄 СБРОС СТАТИСТИКИ
   */
  resetStats() {
    this.stats = {
      totalProcessed: 0,
      hallucinationsDetected: 0,
      silenceDetected: 0,
      realSpeechDetected: 0,
    };
    logger.info('📊 Whisper hallucination detector stats reset');
  }

  /**
   * 🎯 БЫСТРАЯ ПРОВЕРКА (для использования в pipeline)
   */
  quickCheck(transcription, audioSize, duration) {
    const analysis = this.analyzeTranscription(
      transcription,
      audioSize,
      duration
    );

    return {
      shouldProcess: analysis.isRealSpeech,
      treatAsSilence: analysis.isHallucination || analysis.isSilence,
      confidence: analysis.confidence,
      reason: analysis.reasons[0] || 'Unknown',
    };
  }
}

// Создаем глобальный экземпляр
export const whisperDetector = new WhisperHallucinationDetector();
