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
}
