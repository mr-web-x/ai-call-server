import { responseGenerator } from '../../services/responseGenerator.js';
import { DebtCollectionScripts } from '../../scripts/debtCollection.js';
import { PROMPT_TEMPLATES } from '../../utils/promptTemplates.js';
import { logger } from '../../utils/logger.js';

/**
 * Интеграционные тесты для новой системы генерации ответов
 */

describe('Response Generation Integration Tests', () => {
  beforeEach(() => {
    // Очищаем кэш перед каждым тестом
    responseGenerator.responseCache.clear();
    responseGenerator.metrics = {
      gptUsage: 0,
      scriptUsage: 0,
      cacheHits: 0,
      failures: 0,
    };
  });

  describe('Выбор метода генерации ответа', () => {
    test('должен использовать скрипты для стандартных случаев', () => {
      const context = {
        callId: 'test-001',
        clientMessage: 'Да, согласен платить',
        classification: 'positive',
        conversationHistory: [],
        clientData: { name: 'Тест', amount: 10000 },
        currentStage: 'listening',
        repeatCount: 0,
      };

      const method = responseGenerator.selectResponseMethod(context);
      expect(method).toBe('script');
    });

    test('должен использовать GPT при многократных повторениях', () => {
      const context = {
        callId: 'test-002',
        clientMessage: 'Не знаю что сказать',
        classification: 'neutral',
        conversationHistory: ['previous', 'messages'],
        clientData: { name: 'Тест', amount: 10000 },
        currentStage: 'listening',
        repeatCount: 3, // Много повторений
      };

      const method = responseGenerator.selectResponseMethod(context);
      expect(method).toBe('gpt');
    });

    test('должен использовать GPT для попыток смены темы', () => {
      const context = {
        callId: 'test-003',
        clientMessage: 'А как дела у вас? Какая сегодня погода?',
        classification: 'neutral',
        conversationHistory: [],
        clientData: { name: 'Тест', amount: 10000 },
        currentStage: 'listening',
        repeatCount: 0,
      };

      const method = responseGenerator.selectResponseMethod(context);
      expect(method).toBe('gpt');
    });

    test('должен использовать скрипты для критических ситуаций', () => {
      const context = {
        callId: 'test-004',
        clientMessage: 'Я тебя в суд подам!',
        classification: 'aggressive',
        conversationHistory: [],
        clientData: { name: 'Тест', amount: 10000 },
        currentStage: 'listening',
        repeatCount: 0,
      };

      const method = responseGenerator.selectResponseMethod(context);
      expect(method).toBe('script');
    });
  });

  describe('Генерация ответов через скрипты', () => {
    test('должен генерировать персонализированный ответ', () => {
      const context = {
        callId: 'test-005',
        clientMessage: 'Да, готов обсуждать',
        classification: 'positive',
        conversationHistory: [],
        clientData: {
          name: 'Иван Петров',
          amount: 15000,
          company: 'Тест-Финанс',
        },
        currentStage: 'listening',
        repeatCount: 0,
      };

      const response = responseGenerator.generateScriptResponse(context);

      expect(response.text).toContain('Иван Петров');
      expect(response.text).toContain('15000');
      expect(response.nextStage).toBe('payment_discussion');
      expect(response.source).toBe('script');
    });

    test('должен выбирать разные варианты при повторениях', () => {
      const context = {
        callId: 'test-006',
        clientMessage: 'Не понимаю о чём речь',
        classification: 'neutral',
        conversationHistory: [],
        clientData: { name: 'Тест', amount: 10000 },
        currentStage: 'listening',
        repeatCount: 2,
      };

      const response1 = responseGenerator.generateScriptResponse({
        ...context,
        repeatCount: 0,
      });

      const response2 = responseGenerator.generateScriptResponse({
        ...context,
        repeatCount: 2,
      });

      // Ответы должны отличаться при разных repeatCount
      expect(response1.text).not.toBe(response2.text);
    });
  });

  describe('Валидация ответов', () => {
    test('должен отклонять слишком длинные ответы', () => {
      const response = {
        text: 'А'.repeat(300), // Слишком длинный ответ
        nextStage: 'listening',
        source: 'gpt',
      };

      const context = { callId: 'test-007', classification: 'neutral' };
      const result = responseGenerator.validateResponse(response, context);

      expect(result.isValid).toBe(false);
      expect(result.validationIssues).toContain('response_too_long');
    });

    test('должен отклонять ответы с запрещёнными словами', () => {
      const response = {
        text: 'Да пошёл ты блять!',
        nextStage: 'listening',
        source: 'gpt',
      };

      const context = { callId: 'test-008', classification: 'aggressive' };
      const result = responseGenerator.validateResponse(response, context);

      expect(result.isValid).toBe(false);
      expect(result.validationIssues).toContain('forbidden_words');
    });

    test('должен принимать корректные ответы', () => {
      const response = {
        text: 'Понимаю ваше положение. Давайте найдём решение.',
        nextStage: 'negotiation',
        source: 'script',
      };

      const context = { callId: 'test-009', classification: 'negative' };
      const result = responseGenerator.validateResponse(response, context);

      expect(result.isValid).toBe(true);
      expect(result.text).toBe(response.text);
    });
  });

  describe('Кэширование ответов', () => {
    test('должен кэшировать и использовать похожие ответы', () => {
      const context = {
        callId: 'test-010',
        clientMessage: 'Не понимаю',
        classification: 'neutral',
        conversationHistory: [],
        clientData: { name: 'Тест', amount: 10000 },
        currentStage: 'listening',
        repeatCount: 1,
      };

      // Первый запрос - кэшируем
      const cacheKey = responseGenerator.generateCacheKey(context);
      responseGenerator.cacheResponse(context, 'Тестовый кэшированный ответ');

      // Второй запрос - должен использовать кэш
      const method = responseGenerator.selectResponseMethod(context);
      expect(method).toBe('cache');

      const cachedResponse = responseGenerator.getCachedResponse(context);
      expect(cachedResponse.text).toBe('Тестовый кэшированный ответ');
      expect(cachedResponse.source).toBe('cache');
    });

    test('должен генерировать уникальные ключи кэша', () => {
      const context1 = {
        currentStage: 'listening',
        classification: 'neutral',
        repeatCount: 1,
      };

      const context2 = {
        currentStage: 'listening',
        classification: 'aggressive',
        repeatCount: 1,
      };

      const key1 = responseGenerator.generateCacheKey(context1);
      const key2 = responseGenerator.generateCacheKey(context2);

      expect(key1).not.toBe(key2);
      expect(key1).toBe('listening_neutral_1');
      expect(key2).toBe('listening_aggressive_1');
    });
  });

  describe('Обработка ошибок и фолбэки', () => {
    test('должен возвращать фолбэк при неизвестной классификации', () => {
      const context = {
        callId: 'test-011',
        clientMessage: 'Странный ответ',
        classification: 'unknown_classification',
        conversationHistory: [],
        clientData: {},
        currentStage: 'listening',
        repeatCount: 0,
      };

      const response = responseGenerator.generateScriptResponse(context);

      expect(response.text).toContain('Не совсем понял');
      expect(response.nextStage).toBe('listening');
    });

    test('должен обрабатывать отсутствие данных клиента', () => {
      const context = {
        callId: 'test-012',
        clientMessage: 'Да, согласен',
        classification: 'positive',
        conversationHistory: [],
        clientData: {}, // Пустые данные
        currentStage: 'listening',
        repeatCount: 0,
      };

      const response = responseGenerator.generateScriptResponse(context);

      expect(response.text).toContain('клиент'); // Заменяет {clientName}
      expect(response.text).toContain('указанную в договоре'); // Заменяет {amount}
    });
  });

  describe('Метрики и мониторинг', () => {
    test('должен отслеживать использование разных методов', async () => {
      const context = {
        callId: 'test-013',
        clientMessage: 'Тест',
        classification: 'neutral',
        conversationHistory: [],
        clientData: { name: 'Тест', amount: 10000 },
        currentStage: 'listening',
        repeatCount: 0,
      };

      // Симулируем несколько запросов
      responseGenerator.generateScriptResponse(context);
      responseGenerator.generateScriptResponse(context);

      const metrics = responseGenerator.getMetrics();

      expect(metrics.scriptUsage).toBe(2);
      expect(metrics.gptUsage).toBe(0);
      expect(typeof metrics.timestamp).toBe('number');
    });
  });
});

// Вспомогательная функция для запуска тестов
export async function runResponseGenerationTests() {
  console.log('🧪 Running Response Generation Integration Tests...');

  const testCases = [
    {
      name: 'Standard Positive Response',
      context: {
        callId: 'manual-test-001',
        clientMessage: 'Да, готов платить',
        classification: 'positive',
        conversationHistory: [],
        clientData: { name: 'Дмитрий', amount: 15000, company: 'ТестФинанс' },
        currentStage: 'listening',
        repeatCount: 0,
      },
    },
    {
      name: 'Repeated Neutral Response',
      context: {
        callId: 'manual-test-002',
        clientMessage: 'Не знаю что сказать',
        classification: 'neutral',
        conversationHistory: ['История', 'разговора'],
        clientData: { name: 'Дмитрий', amount: 15000 },
        currentStage: 'listening',
        repeatCount: 3,
      },
    },
    {
      name: 'Off-topic Attempt',
      context: {
        callId: 'manual-test-003',
        clientMessage: 'Как дела? Какая сегодня погода?',
        classification: 'neutral',
        conversationHistory: [],
        clientData: { name: 'Дмитрий', amount: 15000 },
        currentStage: 'listening',
        repeatCount: 0,
      },
    },
    {
      name: 'Aggressive Response',
      context: {
        callId: 'manual-test-004',
        clientMessage: 'Отстань от меня!',
        classification: 'aggressive',
        conversationHistory: [],
        clientData: { name: 'Дмитрий', amount: 15000 },
        currentStage: 'listening',
        repeatCount: 1,
      },
    },
  ];

  for (const testCase of testCases) {
    try {
      console.log(`\n📋 Test: ${testCase.name}`);
      console.log(`Input: "${testCase.context.clientMessage}"`);
      console.log(`Classification: ${testCase.context.classification}`);
      console.log(`Repeat Count: ${testCase.context.repeatCount}`);

      const result = await responseGenerator.generateResponse(testCase.context);

      console.log(`✅ Method: ${result.method}`);
      console.log(`✅ Response: "${result.text}"`);
      console.log(`✅ Next Stage: ${result.nextStage}`);
      console.log(`✅ Valid: ${result.isValid}`);
    } catch (error) {
      console.error(`❌ Test failed: ${testCase.name}`, error.message);
    }
  }

  const finalMetrics = responseGenerator.getMetrics();
  console.log('\n📊 Final Metrics:', finalMetrics);

  console.log('🎯 Response Generation Tests Completed!');
}
