import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from '@jest/globals';
import request from 'supertest';
import express from 'express';
import webhookRoutes from '../../routes/webhooks.js';
import { Client } from '../../models/Client.js';
import { Call } from '../../models/Call.js';
import { outboundManager } from '../../services/outboundManager.js';
import {
  setupTestDB,
  teardownTestDB,
  clearDB,
  mockExternalServices,
} from '../setup.js';
import { createTestClient, mockTwilioResponse } from '../utils/testHelpers.js';

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use('/api/webhooks', webhookRoutes);

describe('Twilio Webhooks Integration', () => {
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

  describe('POST /api/webhooks/twiml/:callId', () => {
    test('should generate TwiML for active call', async () => {
      const client = await createTestClient();
      const callId = 'test-call-123';

      // Mock active call in outbound manager
      const mockSession = {
        clientData: {
          name: client.name,
          amount: client.debt_amount,
          contract: client.contract_number,
          company: 'Тест Компания',
        },
      };

      outboundManager.activeCalls.set(callId, {
        session: mockSession,
        clientId: client._id,
        phone: client.phone,
        startTime: new Date(),
        status: 'calling',
      });

      const response = await request(app)
        .post(`/api/webhooks/twiml/${callId}`)
        .expect(200);

      expect(response.headers['content-type']).toMatch(/xml/);
      expect(response.text).toContain('<?xml version="1.0" encoding="UTF-8"?>');
      expect(response.text).toContain('<Response>');
      expect(response.text).toContain('<Say voice="alice" language="ru-RU">');
      expect(response.text).toContain('<Record');
      expect(response.text).toContain(
        `action="${process.env.SERVER_URL}/api/webhooks/recording/${callId}"`
      );
    });

    test('should handle missing call data gracefully', async () => {
      const callId = 'non-existent-call';

      const response = await request(app)
        .post(`/api/webhooks/twiml/${callId}`)
        .expect(200);

      expect(response.text).toContain('техническая ошибка');
      expect(response.text).toContain('<Hangup/>');
    });
  });

  describe('POST /api/webhooks/status/:callId', () => {
    test('should update call status', async () => {
      const client = await createTestClient();
      const callId = 'status-test-call';

      // Create call record
      await Call.create({
        call_id: callId,
        client_id: client._id,
        status: 'initiated',
      });

      const twilioResponse = mockTwilioResponse('answered');

      const response = await request(app)
        .post(`/api/webhooks/status/${callId}`)
        .send(twilioResponse)
        .expect(200);

      expect(response.text).toBe('OK');

      // Verify call status updated
      const updatedCall = await Call.findOne({ call_id: callId });
      expect(updatedCall.status).toBe('answered');
    });

    test('should handle call completion', async () => {
      const client = await createTestClient();
      const callId = 'completion-test-call';

      // Mock active call
      outboundManager.activeCalls.set(callId, {
        session: {},
        clientId: client._id,
        phone: client.phone,
        startTime: new Date(),
        status: 'answered',
      });

      await Call.create({
        call_id: callId,
        client_id: client._id,
        status: 'answered',
      });

      const twilioResponse = {
        ...mockTwilioResponse('completed'),
        CallDuration: '180',
      };

      await request(app)
        .post(`/api/webhooks/status/${callId}`)
        .send(twilioResponse)
        .expect(200);

      // Verify call ended
      expect(outboundManager.activeCalls.has(callId)).toBe(false);

      const updatedCall = await Call.findOne({ call_id: callId });
      expect(updatedCall.status).toBe('completed');
      expect(updatedCall.duration).toBe(180000); // Converted to milliseconds
    });
  });

  describe('POST /api/webhooks/recording/:callId', () => {
    test('should process recording and generate response', async () => {
      const client = await createTestClient();
      const callId = 'recording-test-call';

      const mockSession = {
        processAudioChunk: jest.fn().mockResolvedValue({
          transcription: 'Да, я согласен',
          classification: 'positive',
          response: 'Отлично! Когда планируете оплату?',
          nextStage: 'payment_confirmation',
        }),
      };

      outboundManager.activeCalls.set(callId, {
        session: mockSession,
        clientId: client._id,
        phone: client.phone,
        startTime: new Date(),
        status: 'answered',
      });

      await Call.create({
        call_id: callId,
        client_id: client._id,
        status: 'answered',
      });

      const recordingData = {
        RecordingUrl: 'https://api.twilio.com/fake-recording.wav',
        RecordingDuration: '5',
      };

      const response = await request(app)
        .post(`/api/webhooks/recording/${callId}`)
        .send(recordingData)
        .expect(200);

      expect(response.text).toContain('<Response>');
      expect(response.text).toContain('<Say voice="alice" language="ru-RU">');
      expect(response.text).toContain('Отлично! Когда планируете оплату?');
      expect(response.text).toContain('<Record');

      // Verify recording saved
      const updatedCall = await Call.findOne({ call_id: callId });
      expect(updatedCall.recordings).toHaveLength(1);
      expect(updatedCall.recordings[0].url).toBe(recordingData.RecordingUrl);
    });

    test('should end conversation when appropriate', async () => {
      const client = await createTestClient();
      const callId = 'end-conversation-call';

      const mockSession = {
        processAudioChunk: jest.fn().mockResolvedValue({
          transcription: 'До свидания',
          classification: 'hang_up',
          response: 'До свидания',
          nextStage: 'completed',
        }),
      };

      outboundManager.activeCalls.set(callId, {
        session: mockSession,
        clientId: client._id,
        phone: client.phone,
        startTime: new Date(),
        status: 'answered',
      });

      const recordingData = {
        RecordingUrl: 'https://api.twilio.com/goodbye-recording.wav',
        RecordingDuration: '2',
      };

      const response = await request(app)
        .post(`/api/webhooks/recording/${callId}`)
        .send(recordingData)
        .expect(200);

      expect(response.text).toContain(
        '<Say voice="alice" language="ru-RU">Спасибо за разговор. До свидания.</Say>'
      );
      expect(response.text).toContain('<Hangup/>');
    });

    test('should handle processing errors gracefully', async () => {
      const client = await createTestClient();
      const callId = 'error-processing-call';

      const mockSession = {
        processAudioChunk: jest
          .fn()
          .mockRejectedValue(new Error('Processing failed')),
      };

      outboundManager.activeCalls.set(callId, {
        session: mockSession,
        clientId: client._id,
        phone: client.phone,
        startTime: new Date(),
        status: 'answered',
      });

      const recordingData = {
        RecordingUrl: 'https://api.twilio.com/error-recording.wav',
        RecordingDuration: '3',
      };

      const response = await request(app)
        .post(`/api/webhooks/recording/${callId}`)
        .send(recordingData)
        .expect(200);

      expect(response.text).toContain(
        '<Say voice="alice" language="ru-RU">Произошла ошибка. До свидания.</Say>'
      );
      expect(response.text).toContain('<Hangup/>');
    });
  });

  describe('POST /api/webhooks/recording-status/:callId', () => {
    test('should handle recording status updates', async () => {
      const callId = 'recording-status-call';

      const statusData = {
        RecordingStatus: 'completed',
        RecordingSid: 'RE1234567890abcdef',
      };

      const response = await request(app)
        .post(`/api/webhooks/recording-status/${callId}`)
        .send(statusData)
        .expect(200);

      expect(response.text).toBe('OK');
    });
  });
});
