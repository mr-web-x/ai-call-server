import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from '@jest/globals';
import { sttQueue, llmQueue, ttsQueue } from '../../queues/setup.js';
import {
  setupTestDB,
  teardownTestDB,
  clearDB,
  mockExternalServices,
} from '../setup.js';
import { generateTestAudioChunk, waitForAsync } from '../utils/testHelpers.js';

describe('Queue Performance Tests', () => {
  beforeAll(async () => {
    await setupTestDB();
    mockExternalServices();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearDB();
    // Clean queues
    await Promise.all([
      sttQueue.clean(0, 'completed'),
      sttQueue.clean(0, 'failed'),
      llmQueue.clean(0, 'completed'),
      llmQueue.clean(0, 'failed'),
      ttsQueue.clean(0, 'completed'),
      ttsQueue.clean(0, 'failed'),
    ]);
  });

  test('should handle concurrent STT jobs', async () => {
    const jobCount = 10;
    const audioBuffer = generateTestAudioChunk();
    const startTime = Date.now();

    // Add multiple STT jobs concurrently
    const jobPromises = Array.from({ length: jobCount }, (_, i) =>
      sttQueue.add('transcribe', {
        audioBuffer,
        callId: `perf-test-${i}`,
      })
    );

    const jobs = await Promise.all(jobPromises);

    // Wait for all jobs to complete
    const results = await Promise.all(jobs.map((job) => job.finished()));

    const endTime = Date.now();
    const totalTime = endTime - startTime;

    expect(results).toHaveLength(jobCount);
    expect(totalTime).toBeLessThan(10000); // Should complete within 10 seconds

    // All results should be successful
    results.forEach((result) => {
      expect(result.text).toBeDefined();
      expect(result.callId).toMatch(/perf-test-\d+/);
    });

    console.log(
      `STT Performance: ${jobCount} jobs completed in ${totalTime}ms`
    );
  });

  test('should handle queue backpressure', async () => {
    const jobCount = 50;
    const audioBuffer = generateTestAudioChunk();

    // Add jobs faster than they can be processed
    const jobs = [];
    for (let i = 0; i < jobCount; i++) {
      const job = await sttQueue.add('transcribe', {
        audioBuffer,
        callId: `backpressure-test-${i}`,
      });
      jobs.push(job);
    }

    // Check queue stats
    const waiting = await sttQueue.waiting();
    const active = await sttQueue.getActive();

    expect(waiting.length + active.length).toBeGreaterThan(0);

    // Wait for some jobs to complete
    await waitForAsync(2000);

    const waitingAfter = await sttQueue.waiting();
    expect(waitingAfter.length).toBeLessThan(waiting.length);

    console.log(
      `Backpressure Test: ${waiting.length} waiting, ${active.length} active`
    );
  });

  test('should process LLM classification efficiently', async () => {
    const testCases = [
      { text: 'Да, я согласен заплатить', expected: 'positive' },
      { text: 'Нет, не буду платить', expected: 'negative' },
      { text: 'Не знаю что сказать', expected: 'neutral' },
      { text: 'Отъебись от меня!', expected: 'aggressive' },
      { text: 'До свидания, кладу трубку', expected: 'hang_up' },
    ];

    const startTime = Date.now();

    const jobs = await Promise.all(
      testCases.map((testCase, i) =>
        llmQueue.add('classify', {
          text: testCase.text,
          callId: `llm-perf-${i}`,
          currentStage: 'payment_offer',
          conversationHistory: [],
        })
      )
    );

    const results = await Promise.all(jobs.map((job) => job.finished()));

    const endTime = Date.now();
    const totalTime = endTime - startTime;

    expect(results).toHaveLength(testCases.length);
    expect(totalTime).toBeLessThan(5000); // Should complete within 5 seconds

    console.log(
      `LLM Performance: ${testCases.length} classifications in ${totalTime}ms`
    );
  });

  test('should handle TTS generation load', async () => {
    const texts = [
      'Добрый день! Меня зовут Анна.',
      'Понимаю ваше беспокойство.',
      'Предлагаю обсудить варианты погашения.',
      'Спасибо за сотрудничество.',
      'До свидания!',
    ];

    const startTime = Date.now();

    const jobs = await Promise.all(
      texts.map((text, i) =>
        ttsQueue.add('synthesize', {
          text,
          callId: `tts-perf-${i}`,
          priority: 'normal',
        })
      )
    );

    const results = await Promise.all(jobs.map((job) => job.finished()));

    const endTime = Date.now();
    const totalTime = endTime - startTime;

    expect(results).toHaveLength(texts.length);
    expect(totalTime).toBeLessThan(15000); // Should complete within 15 seconds

    results.forEach((result) => {
      expect(result.audioBuffer).toBeInstanceOf(Buffer);
      expect(result.audioBuffer.length).toBeGreaterThan(0);
    });

    console.log(`TTS Performance: ${texts.length} syntheses in ${totalTime}ms`);
  });
});
