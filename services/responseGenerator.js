import { AIServices } from './aiServices.js';
import { DebtCollectionScripts } from '../scripts/debtCollection.js';
import { PROMPT_TEMPLATES } from '../utils/promptTemplates.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../config/index.js';

export class ResponseGenerator {
  constructor() {
    this.responseCache = new Map(); // Кэш для похожих ситуаций
    this.metrics = {
      gptUsage: 0,
      scriptUsage: 0,
      cacheHits: 0,
      failures: 0,
    };
  }

  /**
   * Главный метод генерации ответа
   */
  async generateResponse(context) {
    const {
      callId,
      clientMessage,
      classification,
      conversationHistory,
      clientData,
      currentStage,
      repeatCount = 0,
    } = context;

    logger.info(`🎯 Generating response for call ${callId}:`, {
      classification,
      repeatCount,
      method: 'analyzing...',
    });

    try {
      // 1. Анализ контекста и выбор метода
      const responseMethod = this.selectResponseMethod(context);

      logger.info(`🔄 Selected method: ${responseMethod} for call ${callId}`);

      // 2. Генерация ответа выбранным методом
      let response;

      if (responseMethod === 'gpt') {
        response = await this.generateGPTResponse(context);
        this.metrics.gptUsage++;
      } else if (responseMethod === 'cache') {
        response = this.getCachedResponse(context);
        this.metrics.cacheHits++;
      } else {
        response = this.generateScriptResponse(context);
        this.metrics.scriptUsage++;
      }

      // 3. Валидация и безопасность
      const validatedResponse = this.validateResponse(response, context);

      // 4. Кэширование для будущих похожих ситуаций
      if (responseMethod === 'gpt' && validatedResponse.isValid) {
        this.cacheResponse(context, validatedResponse.text);
      }

      logger.info(`✅ Response generated for call ${callId}:`, {
        method: responseMethod,
        length: validatedResponse.text.length,
        nextStage: validatedResponse.nextStage,
      });

      return {
        text: validatedResponse.text,
        nextStage: validatedResponse.nextStage,
        method: responseMethod,
        isValid: validatedResponse.isValid,
        metrics: this.getMetrics(),
      };
    } catch (error) {
      logger.error(`❌ Response generation failed for call ${callId}:`, error);
      this.metrics.failures++;

      // Фолбэк на простой скрипт
      return this.getFallbackResponse(context);
    }
  }

  /**
   * Анализ контекста и выбор метода ответа
   */
  selectResponseMethod(context) {
    const {
      classification,
      repeatCount,
      clientMessage,
      conversationHistory,
      currentStage,
    } = context;

    // Проверяем кэш для похожих ситуаций
    const cacheKey = this.generateCacheKey(context);
    if (this.responseCache.has(cacheKey)) {
      return 'cache';
    }

    // Критические ситуации - только скрипты
    if (this.isCriticalSituation(classification, clientMessage)) {
      return 'script';
    }

    // Повторения более 2 раз - используем GPT для разнообразия
    if (repeatCount >= 2) {
      return 'gpt';
    }

    // Попытки смены темы - GPT для контекстного ответа
    if (this.isOffTopicAttempt(clientMessage)) {
      return 'gpt';
    }

    // Нестандартные/сложные ответы - GPT
    if (this.isUnusualResponse(clientMessage, conversationHistory)) {
      return 'gpt';
    }

    // Агрессивные повторения - GPT для деэскалации
    if (classification === 'aggressive' && repeatCount >= 1) {
      return 'gpt';
    }

    // Стандартные случаи - скрипты (быстрее и надёжнее)
    return 'script';
  }

  /**
   * Генерация ответа через GPT
   */
  async generateGPTResponse(context) {
    const {
      callId,
      clientData,
      conversationHistory,
      classification,
      repeatCount,
    } = context;

    logger.info(`🤖 Generating GPT response for call ${callId}`);

    // Формируем контекст для GPT
    const prompt = PROMPT_TEMPLATES.buildResponsePrompt({
      ...context,
      systemRole: PROMPT_TEMPLATES.SYSTEM_ROLE,
      safetyRules: PROMPT_TEMPLATES.SAFETY_RULES,
    });

    // Вызываем GPT через AIServices
    const gptResponse = await AIServices.generateResponse(prompt, {
      maxTokens: CONFIG.GPT_MAX_RESPONSE_TOKENS || 100,
      temperature: 0.7,
    });

    return {
      text: gptResponse.text,
      nextStage: this.determineNextStage(classification, repeatCount),
      source: 'gpt',
      confidence: gptResponse.confidence || 0.8,
    };
  }

  /**
   * Генерация ответа из скриптов
   */
  generateScriptResponse(context) {
    const { classification, currentStage, clientData, repeatCount } = context;

    logger.info(
      `📜 Generating script response: ${classification} (attempt ${repeatCount + 1})`
    );

    // Получаем варианты ответов для данной классификации
    const responseVariants = DebtCollectionScripts.getResponseVariants(
      currentStage,
      classification,
      clientData
    );

    // Выбираем вариант на основе количества повторений
    const selectedResponse = this.selectResponseVariant(
      responseVariants,
      repeatCount
    );

    return {
      text: selectedResponse.text,
      nextStage: selectedResponse.nextStage,
      source: 'script',
      priority: selectedResponse.priority || 'normal',
    };
  }

  /**
   * Валидация ответа на безопасность и соответствие
   */
  validateResponse(response, context) {
    const text = response.text || '';
    const { callId } = context;

    // Проверки безопасности
    const validationResults = {
      isValid: true,
      issues: [],
    };

    // 1. Проверка длины
    if (text.length > CONFIG.MAX_RESPONSE_LENGTH || 200) {
      validationResults.isValid = false;
      validationResults.issues.push('response_too_long');
    }

    // 2. Проверка на запрещённые слова/темы
    const forbiddenWords = ['блять', 'сука', 'хуй', 'пизда', 'убью', 'угрожаю'];
    const hasForbiddenWords = forbiddenWords.some((word) =>
      text.toLowerCase().includes(word)
    );

    if (hasForbiddenWords) {
      validationResults.isValid = false;
      validationResults.issues.push('forbidden_words');
    }

    // 3. Проверка на соответствие роли коллектора
    const offTopicKeywords = ['погода', 'спорт', 'политика', 'новости'];
    const isOffTopic = offTopicKeywords.some((keyword) =>
      text.toLowerCase().includes(keyword)
    );

    if (isOffTopic) {
      validationResults.isValid = false;
      validationResults.issues.push('off_topic');
    }

    // 4. Проверка на наличие информации о долге/компании
    const hasDebtContext =
      /долг|задолженность|погашение|оплата|финанс|займ/.test(
        text.toLowerCase()
      );

    if (!hasDebtContext && text.length > 50) {
      validationResults.issues.push('lacks_debt_context');
      // Не критично, но отмечаем
    }

    if (!validationResults.isValid) {
      logger.warn(`⚠️ Response validation failed for call ${callId}:`, {
        issues: validationResults.issues,
        text: text.substring(0, 100),
      });

      // Возвращаем фолбэк
      return {
        text: this.getFallbackPhrase(context.classification),
        nextStage: response.nextStage,
        isValid: false,
        validationIssues: validationResults.issues,
      };
    }

    return {
      text: response.text,
      nextStage: response.nextStage,
      isValid: true,
      source: response.source,
    };
  }

  /**
   * Определение следующего этапа разговора
   */
  determineNextStage(classification, repeatCount = 0) {
    // Логика эскалации на основе повторений
    if (repeatCount >= 3) {
      return classification === 'aggressive' ? 'final_warning' : 'escalation';
    }

    switch (classification) {
      case 'positive':
        return 'payment_discussion';
      case 'hang_up':
        return 'completed';
      case 'aggressive':
        return repeatCount >= 2 ? 'de_escalation' : 'listening';
      case 'negative':
        return 'negotiation';
      default:
        return 'listening';
    }
  }

  /**
   * Проверка критических ситуаций (только скрипты)
   */
  isCriticalSituation(classification, message) {
    const criticalKeywords = [
      'суд',
      'полиция',
      'прокуратура',
      'юрист',
      'адвокат',
      'угрожаю',
      'убью',
      'найду',
      'приеду',
    ];

    return (
      criticalKeywords.some((keyword) =>
        message.toLowerCase().includes(keyword)
      ) || classification === 'threat'
    );
  }

  /**
   * Определение попытки смены темы
   */
  isOffTopicAttempt(message) {
    const offTopicPatterns = [
      /как дела|как жизнь|что нового/i,
      /погода|дождь|солнце|снег/i,
      /футбол|хоккей|спорт/i,
      /политика|выборы|президент/i,
      /меня зовут|я работаю|у меня/i,
    ];

    return offTopicPatterns.some((pattern) => pattern.test(message));
  }

  /**
   * Определение нестандартного ответа
   */
  isUnusualResponse(message, conversationHistory) {
    // Очень короткие или очень длинные ответы
    if (message.length < 5 || message.length > 100) {
      return true;
    }

    // Повторение фраз из истории
    const isRepeating = conversationHistory
      .slice(-3)
      .some((turn) => turn.includes(message.substring(0, 20)));

    return isRepeating;
  }

  /**
   * Генерация ключа для кэширования
   */
  generateCacheKey(context) {
    const { classification, repeatCount, currentStage } = context;
    return `${currentStage}_${classification}_${Math.min(repeatCount, 3)}`;
  }

  /**
   * Кэширование ответа
   */
  cacheResponse(context, responseText) {
    const cacheKey = this.generateCacheKey(context);
    this.responseCache.set(cacheKey, {
      text: responseText,
      timestamp: Date.now(),
      usageCount: 0,
    });

    // Ограничиваем размер кэша
    if (this.responseCache.size > 100) {
      const oldestKey = this.responseCache.keys().next().value;
      this.responseCache.delete(oldestKey);
    }
  }

  /**
   * Получение кэшированного ответа
   */
  getCachedResponse(context) {
    const cacheKey = this.generateCacheKey(context);
    const cached = this.responseCache.get(cacheKey);

    if (cached) {
      cached.usageCount++;
      logger.info(`💾 Using cached response for key: ${cacheKey}`);

      return {
        text: cached.text,
        nextStage: this.determineNextStage(
          context.classification,
          context.repeatCount
        ),
        source: 'cache',
      };
    }

    return null;
  }

  /**
   * Выбор варианта ответа из скриптов
   */
  selectResponseVariant(variants, repeatCount) {
    if (!variants || variants.length === 0) {
      return {
        text: 'Не могли бы вы повторить? Я не совсем понял.',
        nextStage: 'listening',
        priority: 'normal',
      };
    }

    // Выбираем вариант на основе повторений (ротация)
    const index = Math.min(repeatCount, variants.length - 1);
    return variants[index];
  }

  /**
   * Фолбэк ответ при ошибках
   */
  getFallbackResponse(context) {
    const { classification } = context;

    return {
      text: this.getFallbackPhrase(classification),
      nextStage: 'listening',
      method: 'fallback',
      isValid: true,
      metrics: this.getMetrics(),
    };
  }

  /**
   * Простые фолбэк фразы
   */
  getFallbackPhrase(classification) {
    const fallbacks = {
      positive: ['Отлично! Давайте обсудим детали погашения.'],
      negative: ['Понимаю ваше положение. Найдём решение.'],
      aggressive: ['Прошу сохранять спокойствие. Решим вопрос мирно.'],
      neutral: [
        'Уточните, пожалуйста, вашу позицию по долгу.',
        'Как планируете решать вопрос с задолженностью?',
        'Что можете предложить для погашения?',
        'Давайте найдём взаимовыгодное решение.',
        'Расскажите о ваших возможностях по выплате.',
      ],
      hang_up: ['Спасибо за разговор. До свидания.'],
    };

    const phrases = fallbacks[classification] || ['Не могли бы вы повторить?'];

    // Ротация на основе времени
    const index = Math.floor(Date.now() / 30000) % phrases.length;
    return phrases[index];
  }

  /**
   * Получение метрик использования
   */
  getMetrics() {
    return {
      ...this.metrics,
      cacheSize: this.responseCache.size,
      timestamp: Date.now(),
    };
  }

  /**
   * Очистка старого кэша
   */
  cleanupCache() {
    const now = Date.now();
    const maxAge = 24 * 60 * 60 * 1000; // 24 часа

    for (const [key, value] of this.responseCache.entries()) {
      if (now - value.timestamp > maxAge) {
        this.responseCache.delete(key);
      }
    }
  }
}

// Экспорт singleton instance
export const responseGenerator = new ResponseGenerator();
