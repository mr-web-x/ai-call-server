import { OpenAI } from 'openai';
import axios from 'axios';
import { CONFIG } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { File as FormDataFile } from 'formdata-node';

const openai = new OpenAI({
  apiKey: CONFIG.OPENAI_API_KEY,
  timeout: 60000,
  maxRetries: 3,
});

export class AIServices {
  // Speech-to-Text
  static async transcribeAudio(audioBuffer) {
    logger.info('🔍 Начало транскрипции аудио', {
      bufferSize: audioBuffer?.length || 0,
    });

    console.log(
      'OpenAI API Key:',
      CONFIG.OPENAI_API_KEY?.substring(0, 10) + '...'
    );

    if (!CONFIG.OPENAI_API_KEY) {
      logger.error('❌ OpenAI API ключ не указан');
      return {
        text: '[SYSTEM: OpenAI ключ не настроен]',
        confidence: 0.5,
        timestamp: Date.now(),
        fallback: true,
      };
    }

    try {
      const audioFile = new FormDataFile([audioBuffer], 'recording.wav', {
        type: 'audio/wav',
      });

      logger.info('📤 Отправка аудио в OpenAI Whisper', {
        sizeKB: `${(audioBuffer.length / 1024).toFixed(1)} KB`,
        type: 'audio/wav',
      });

      const startTime = Date.now();
      const response = await openai.audio.transcriptions.create({
        file: audioFile,
        model: 'whisper-1',
        language: 'ru',
        response_format: 'json',
      });

      const processingTime = Date.now() - startTime;

      logger.info('✅ Распознавание завершено', {
        text: response.text,
        length: response.text?.length || 0,
        processingTime: `${processingTime}ms`,
      });

      return {
        text: response.text,
        confidence: 0.95,
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error('❌ Ошибка транскрипции', {
        message: error.message,
        code: error.code,
        status: error.status,
        stack: error.stack?.split('\n')[0],
      });

      if (
        error.message?.includes('Connection error') ||
        error.message?.includes('timeout') ||
        error.message?.includes('ENOTFOUND') ||
        error.message?.includes('network')
      ) {
        logger.warn('🌐 Проблема с сетью — тест соединения...');

        try {
          await this.testNetworkConnectivity();
        } catch (netError) {
          logger.error('🚫 Тест сети не пройден', {
            message: netError.message,
          });
        }
      }

      logger.warn('🛠️ Используем fallback транскрипцию');
      return {
        text: '[SYSTEM: Ошибка OpenAI — fallback активирован]',
        confidence: 0.3,
        timestamp: Date.now(),
        fallback: true,
        error: error.message,
      };
    }
  }

  static async testNetworkConnectivity() {
    logger.info('🌐 Проверка подключения к OpenAI...');

    try {
      const response = await axios.get('https://api.openai.com/v1/models', {
        headers: {
          Authorization: `Bearer ${CONFIG.OPENAI_API_KEY}`,
          'User-Agent': 'AI-Call-Backend/1.0',
        },
        timeout: 10000,
      });

      logger.info('✅ Подключение успешно', {
        status: response.status,
        dataSample: JSON.stringify(response.data?.data?.[0] || {}),
      });
    } catch (error) {
      logger.error('❌ Ошибка сети при проверке', {
        message: error.message,
        code: error.code,
        response: error.response?.status,
      });
      throw error;
    }
  }

  static async classifyResponse(text, currentStage, conversationHistory = []) {
    logger.info('🧠 Начало классификации текста', {
      inputText: text,
      stage: currentStage,
      history: conversationHistory.slice(-3),
    });

    if (text.includes('[SYSTEM:')) {
      logger.warn('ℹ️ Классификация fallback текста');
      return {
        classification: 'positive',
        confidence: 0.7,
        timestamp: Date.now(),
        fallback: true,
      };
    }

    if (!CONFIG.OPENAI_API_KEY) {
      logger.warn('⚠️ Ключ OpenAI не настроен, используется simpleClassify');
      return {
        classification: this.simpleClassify(text),
        confidence: 0.7,
        timestamp: Date.now(),
        fallback: true,
      };
    }

    try {
      const prompt = `
Анализируй ответ должника в диалоге коллектора.

Текущий этап: ${currentStage}
Ответ должника: "${text}"
История разговора: ${conversationHistory.slice(-3).join(' | ') || 'начало'}

Классифицируй ответ как один из:
- positive
- negative
- neutral
- aggressive
- hang_up

Отвечай только одним словом.
`;

      const response = await openai.chat.completions.create({
        model: 'gpt-3.5-turbo',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 10,
        temperature: 0.1,
      });

      const rawResult = response.choices[0]?.message?.content
        ?.trim()
        .toLowerCase();
      const validated = this.validateClassification(rawResult);

      logger.info('✅ Классификация завершена', {
        raw: rawResult,
        validated,
      });

      return {
        classification: validated,
        confidence: 0.9,
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error('❌ Ошибка LLM классификации', {
        message: error.message,
      });

      return {
        classification: this.simpleClassify(text),
        confidence: 0.7,
        timestamp: Date.now(),
        fallback: true,
      };
    }
  }

  static validateClassification(classification) {
    const valid = ['positive', 'negative', 'neutral', 'aggressive', 'hang_up'];
    return valid.includes(classification) ? classification : 'neutral';
  }

  static simpleClassify(text) {
    const lowerText = text.toLowerCase();

    const rules = [
      {
        type: 'positive',
        pattern:
          /\b(да|хорошо|согласен|договорились|ладно|окей|понятно|буду|заплачу|оплачу)\b/,
      },
      {
        type: 'negative',
        pattern: /\b(нет|не буду|не могу|отказываюсь|невозможно|денег нет)\b/,
      },
      {
        type: 'aggressive',
        pattern: /\b(сука|блять|хуй|пиздец|отъебись|иди нахуй|урод|мудак)\b/,
      },
      {
        type: 'hang_up',
        pattern:
          /\b(до свидания|пока|кладу трубку|до встречи|всего доброго|отключаюсь)\b/,
      },
    ];

    for (const rule of rules) {
      if (lowerText.match(rule.pattern)) {
        logger.debug(`🧩 simpleClassify: совпадение с ${rule.type}`);
        return rule.type;
      }
    }

    logger.debug('🧩 simpleClassify: классификация по умолчанию — neutral');
    return 'neutral';
  }

  static async synthesizeSpeech(text, options = {}) {
    logger.info('🗣️ Синтез речи', {
      text,
      options,
    });

    try {
      const ttsManager = (await import('../services/ttsManager.js')).ttsManager;
      return await ttsManager.synthesizeSpeech(text, options);
    } catch (error) {
      logger.error('❌ Ошибка синтеза речи', {
        message: error.message,
        stack: error.stack?.split('\n')[0],
      });
      throw new Error(`Speech synthesis failed: ${error.message}`);
    }
  }

  /**
   * Генерация ответа через GPT
   */
  static async generateResponse(prompt, options = {}) {
    logger.info('🤖 Начало генерации ответа через GPT', {
      promptLength: prompt.length,
      options,
    });

    if (!CONFIG.OPENAI_API_KEY) {
      logger.error('❌ OpenAI API ключ не указан для генерации ответов');
      throw new Error('OpenAI API key not configured');
    }

    if (!CONFIG.ENABLE_GPT_RESPONSES) {
      logger.warn('⚠️ GPT генерация ответов отключена в настройках');
      throw new Error('GPT response generation disabled');
    }

    try {
      const {
        maxTokens = CONFIG.GPT_MAX_RESPONSE_TOKENS || 100,
        temperature = CONFIG.GPT_TEMPERATURE_RESPONSE || 0.7,
        model = CONFIG.GPT_MODEL_RESPONSE || 'gpt-3.5-turbo',
      } = options;

      const startTime = Date.now();

      const response = await openai.chat.completions.create({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: maxTokens,
        temperature,
        timeout: CONFIG.GPT_TIMEOUT_RESPONSE || 15000,
        stop: ['\n\n', 'Клиент:', 'Ростик:'], // Остановочные токены
      });

      const processingTime = Date.now() - startTime;
      const generatedText = response.choices[0]?.message?.content?.trim();

      logger.info('✅ GPT ответ сгенерирован', {
        text: generatedText,
        length: generatedText?.length || 0,
        processingTime: `${processingTime}ms`,
        model,
        tokensUsed: response.usage?.total_tokens || 0,
      });

      // Дополнительная валидация
      const validationResult = this.validateGPTResponse(generatedText);

      if (!validationResult.isValid) {
        logger.warn('⚠️ GPT ответ не прошёл валидацию', validationResult);
        throw new Error(
          `GPT response validation failed: ${validationResult.reason}`
        );
      }

      return {
        text: generatedText,
        confidence: 0.85,
        processingTime,
        tokensUsed: response.usage?.total_tokens || 0,
        model,
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error('❌ Ошибка генерации GPT ответа', {
        message: error.message,
        code: error.code,
        status: error.status,
        stack: error.stack?.split('\n')[0],
      });

      // Ретрай при сетевых ошибках
      if (
        this.shouldRetryGPTRequest(error) &&
        (options.retryCount || 0) < CONFIG.GPT_RETRY_ATTEMPTS
      ) {
        logger.info(
          `🔄 Повторная попытка GPT генерации (${(options.retryCount || 0) + 1}/${CONFIG.GPT_RETRY_ATTEMPTS})`
        );

        await this.delay(1000 * Math.pow(2, options.retryCount || 0)); // Exponential backoff

        return this.generateResponse(prompt, {
          ...options,
          retryCount: (options.retryCount || 0) + 1,
        });
      }

      throw new Error(`GPT response generation failed: ${error.message}`);
    }
  }

  /**
   * Валидация GPT ответа
   */
  static validateGPTResponse(text) {
    if (!text || typeof text !== 'string') {
      return {
        isValid: false,
        reason: 'Empty or invalid response',
      };
    }

    // Проверка длины
    if (
      text.length < CONFIG.MIN_RESPONSE_LENGTH ||
      text.length > CONFIG.MAX_RESPONSE_LENGTH
    ) {
      return {
        isValid: false,
        reason: `Invalid length: ${text.length} (min: ${CONFIG.MIN_RESPONSE_LENGTH}, max: ${CONFIG.MAX_RESPONSE_LENGTH})`,
      };
    }

    // Проверка на системные сообщения
    if (
      text.includes('[SYSTEM') ||
      text.includes('AI:') ||
      text.includes('GPT:')
    ) {
      return {
        isValid: false,
        reason: 'Contains system messages',
      };
    }

    // Проверка на запрещённые слова
    const forbiddenWords = [
      'блять',
      'сука',
      'хуй',
      'пизда',
      'ебать',
      'убью',
      'убить',
      'найду тебя',
      'приеду к тебе',
    ];

    const hasForbiddenWords = forbiddenWords.some((word) =>
      text.toLowerCase().includes(word)
    );

    if (hasForbiddenWords) {
      return {
        isValid: false,
        reason: 'Contains forbidden words',
      };
    }

    // Проверка на нарушение роли
    const offTopicKeywords = [
      'погода',
      'спорт',
      'футбол',
      'политика',
      'новости',
      'рецепт',
      'фильм',
      'музыка',
      'игра',
    ];

    const isOffTopic = offTopicKeywords.some((keyword) =>
      text.toLowerCase().includes(keyword)
    );

    if (isOffTopic) {
      return {
        isValid: false,
        reason: 'Off-topic content detected',
      };
    }

    // Проверка структуры (не должно быть диалогов)
    if (/Клиент:|Ростик:|AI:|GPT:/.test(text)) {
      return {
        isValid: false,
        reason: 'Contains dialogue structure',
      };
    }

    return {
      isValid: true,
      length: text.length,
    };
  }

  /**
   * Определение необходимости ретрая для GPT запроса
   */
  static shouldRetryGPTRequest(error) {
    const retryableErrors = [
      'timeout',
      'network',
      'ECONNRESET',
      'ENOTFOUND',
      'rate_limit_exceeded',
      'server_error',
    ];

    return retryableErrors.some(
      (errorType) =>
        error.message?.toLowerCase().includes(errorType) ||
        error.code?.toLowerCase().includes(errorType)
    );
  }

  /**
   * Задержка для ретраев
   */
  static delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Получение статистики использования GPT
   */
  static getGPTUsageStats() {
    // В продакшене можно подключить к внешней системе мониторинга
    return {
      totalRequests: this.gptStats?.totalRequests || 0,
      successfulRequests: this.gptStats?.successfulRequests || 0,
      failedRequests: this.gptStats?.failedRequests || 0,
      averageResponseTime: this.gptStats?.averageResponseTime || 0,
      totalTokensUsed: this.gptStats?.totalTokensUsed || 0,
      lastRequestTime: this.gptStats?.lastRequestTime || null,
    };
  }

  /**
   * Инициализация статистики GPT (добавить в конструктор класса если нужно)
   */
  static initGPTStats() {
    this.gptStats = {
      totalRequests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      totalResponseTime: 0,
      totalTokensUsed: 0,
      lastRequestTime: null,
    };
  }

  /**
   * Обновление статистики GPT
   */
  static updateGPTStats(success, responseTime, tokensUsed) {
    if (!this.gptStats) this.initGPTStats();

    this.gptStats.totalRequests++;
    this.gptStats.lastRequestTime = Date.now();

    if (success) {
      this.gptStats.successfulRequests++;
      this.gptStats.totalResponseTime += responseTime;
      this.gptStats.totalTokensUsed += tokensUsed || 0;
      this.gptStats.averageResponseTime =
        this.gptStats.totalResponseTime / this.gptStats.successfulRequests;
    } else {
      this.gptStats.failedRequests++;
    }
  }
}
