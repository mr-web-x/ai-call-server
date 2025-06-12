import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  jest,
} from '@jest/globals';
import { CallSession } from '../../../services/callSession.js';
import {
  setupTestDB,
  teardownTestDB,
  clearDB,
  mockExternalServices,
} from '../../setup.js';

describe('Call Session', () => {
  beforeAll(async () => {
    await setupTestDB();
    mockExternalServices();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearDB();
  });

  test('should create call session with client data', () => {
    const clientData = {
      name: 'Тест Клиент',
      amount: 50000,
      contract: 'DOG-2024-001',
      company: 'Тест Компания',
    };

    const session = new CallSession('test-call-id', clientData);

    expect(session.callId).toBe('test-call-id');
    expect(session.clientData).toEqual(clientData);
    expect(session.currentStage).toBe('start');
    expect(session.conversationHistory).toEqual([]);
    expect(session.isProcessing).toBe(false);
  });

  test('should process audio chunk and update conversation', async () => {
    const clientData = {
      name: 'Тест Клиент',
      amount: 50000,
      contract: 'DOG-2024-001',
    };

    const session = new CallSession('test-call-id', clientData);
    const mockAudioBuffer = Buffer.from('fake-audio-data');

    // Mock queue operations
    const mockSttJob = {
      finished: jest.fn().mockResolvedValue({
        callId: 'test-call-id',
        text: 'Да, я согласен',
        confidence: 0.95,
        timestamp: Date.now(),
      }),
    };

    const mockLlmJob = {
      finished: jest.fn().mockResolvedValue({
        callId: 'test-call-id',
        classification: 'positive',
        confidence: 0.9,
        timestamp: Date.now(),
      }),
    };

    const mockTtsJob = {
      id: 'tts-job-123',
    };

    // Mock queue methods
    const sttQueue = await import('../../../queues/setup.js');
    sttQueue.sttQueue.add = jest.fn().mockResolvedValue(mockSttJob);

    const llmQueue = await import('../../../queues/setup.js');
    llmQueue.llmQueue.add = jest.fn().mockResolvedValue(mockLlmJob);

    const ttsQueue = await import('../../../queues/setup.js');
    ttsQueue.ttsQueue.add = jest.fn().mockResolvedValue(mockTtsJob);

    const result = await session.processAudioChunk(mockAudioBuffer);

    expect(result).toEqual({
      transcription: 'Да, я согласен',
      classification: 'positive',
      response: expect.any(String),
      nextStage: expect.any(String),
      ttsJobId: 'tts-job-123',
    });

    expect(session.conversationHistory).toHaveLength(2);
    expect(session.conversationHistory[0]).toMatch(/CLIENT: Да, я согласен/);
    expect(session.conversationHistory[1]).toMatch(/AI: /);
  });

  test('should prevent concurrent processing', async () => {
    const session = new CallSession('test-call-id', {});
    const mockAudioBuffer = Buffer.from('fake-audio-data');

    session.isProcessing = true;

    const result = await session.processAudioChunk(mockAudioBuffer);

    expect(result).toBeUndefined();
  });
});
