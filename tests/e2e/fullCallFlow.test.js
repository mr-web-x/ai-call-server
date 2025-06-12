import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from '@jest/globals';
import request from 'supertest';
import {
  setupTestDB,
  teardownTestDB,
  clearDB,
  mockExternalServices,
} from '../setup.js';
import { Client } from '../../models/Client.js';
import { Call } from '../../models/Call.js';
import app from '../../server.js'; // Assuming you export app from server.js

describe('Full Call Flow E2E', () => {
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

  test('should complete full call flow', async () => {
    // 1. Create client
    const client = new Client({
      name: 'E2E Тест Клиент',
      phone: '+79161234567',
      debt_amount: 75000,
      contract_number: 'DOG-2024-E2E',
    });
    await client.save();

    // 2. Initiate call
    const callResponse = await request(app)
      .post(`/api/calls/client/${client._id}`)
      .set('X-API-Key', 'test-api-key')
      .expect(200);

    expect(callResponse.body.success).toBe(true);
    const { callId } = callResponse.body;

    // 3. Simulate Twilio TwiML request
    const twimlResponse = await request(app)
      .post(`/api/webhooks/twiml/${callId}`)
      .expect(200);

    expect(twimlResponse.text).toContain(
      '<?xml version="1.0" encoding="UTF-8"?>'
    );
    expect(twimlResponse.text).toContain('<Response>');
    expect(twimlResponse.text).toContain('<Say');

    // 4. Simulate call status update
    await request(app)
      .post(`/api/webhooks/status/${callId}`)
      .send({
        CallStatus: 'answered',
        CallSid: callResponse.body.twilioCallSid,
      })
      .expect(200);

    // 5. Simulate recording webhook
    const recordingResponse = await request(app)
      .post(`/api/webhooks/recording/${callId}`)
      .send({
        RecordingUrl: 'https://api.twilio.com/fake-recording.wav',
        RecordingDuration: '5',
      })
      .expect(200);

    expect(recordingResponse.text).toContain('<Response>');

    // 6. Verify call was saved to database
    const savedCall = await Call.findOne({ call_id: callId });
    expect(savedCall).toBeDefined();
    expect(savedCall.client_id.toString()).toBe(client._id.toString());

    // 7. Verify client call attempts updated
    const updatedClient = await Client.findById(client._id);
    expect(updatedClient.call_attempts).toBe(1);
    expect(updatedClient.last_call_date).toBeDefined();
  });

  test('should handle call failure gracefully', async () => {
    const client = new Client({
      name: 'Неудачный Звонок',
      phone: '+79161234567',
      debt_amount: 25000,
      contract_number: 'DOG-2024-FAIL',
    });
    await client.save();

    // Mock Twilio error
    const twilio = await import('twilio');
    twilio
      .default()
      .calls.create.mockRejectedValueOnce(new Error('Twilio API Error'));

    const response = await request(app)
      .post(`/api/calls/client/${client._id}`)
      .set('X-API-Key', 'test-api-key')
      .expect(500);

    expect(response.body.success).toBe(false);
    expect(response.body.error).toMatch(/Twilio API Error/);
  });
});
