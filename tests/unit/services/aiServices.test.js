import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  jest,
} from '@jest/globals';
import { AIServices } from '../../../services/aiServices.js';
import { mockExternalServices } from '../../setup.js';

describe('AI Services', () => {
  beforeAll(() => {
    mockExternalServices();
  });

  describe('transcribeAudio', () => {
    test('should transcribe audio successfully', async () => {
      const mockAudioBuffer = Buffer.from('fake-audio-data');

      const result = await AIServices.transcribeAudio(mockAudioBuffer);

      expect(result).toEqual({
        text: 'Да, я согласен',
        confidence: 0.95,
        timestamp: expect.any(Number),
      });
    });

    test('should handle transcription errors', async () => {
      const mockAudioBuffer = Buffer.from('invalid-audio');

      // Mock error
      const mockCreate = jest.fn().mockRejectedValue(new Error('API Error'));
      jest.doMock('openai', () => ({
        OpenAI: jest.fn().mockImplementation(() => ({
          audio: {
            transcriptions: {
              create: mockCreate,
            },
          },
        })),
      }));

      await expect(AIServices.transcribeAudio(mockAudioBuffer)).rejects.toThrow(
        'Speech recognition failed'
      );
    });
  });

  describe('classifyResponse', () => {
    test('should classify positive response', async () => {
      const result = await AIServices.classifyResponse(
        'Да, я согласен заплатить',
        'payment_offer',
        ['CLIENT: Здравствуйте']
      );

      expect(result.classification).toBe('positive');
      expect(result.confidence).toBe(0.9);
      expect(result.timestamp).toBeDefined();
    });

    test('should use simple classification fallback', () => {
      const result = AIServices.simpleClassify('да, хорошо, согласен');
      expect(result).toBe('positive');

      const negativeResult = AIServices.simpleClassify('нет, не буду платить');
      expect(negativeResult).toBe('negative');

      const aggressiveResult = AIServices.simpleClassify('отъебись от меня');
      expect(aggressiveResult).toBe('aggressive');

      const hangUpResult = AIServices.simpleClassify(
        'до свидания, кладу трубку'
      );
      expect(hangUpResult).toBe('hang_up');

      const neutralResult = AIServices.simpleClassify('не знаю что сказать');
      expect(neutralResult).toBe('neutral');
    });
  });

  describe('synthesizeSpeech', () => {
    test('should synthesize speech successfully', async () => {
      const text = 'Добрый день! Это тестовое сообщение.';

      const result = await AIServices.synthesizeSpeech(text, 'normal');

      expect(result).toEqual({
        audioBuffer: expect.any(Buffer),
        text: text,
        timestamp: expect.any(Number),
      });
    });

    test('should handle synthesis errors', async () => {
      // Mock axios error
      const axios = await import('axios');
      axios.post.mockRejectedValueOnce(new Error('TTS API Error'));

      await expect(AIServices.synthesizeSpeech('test text')).rejects.toThrow(
        'Speech synthesis failed'
      );
    });
  });
});
