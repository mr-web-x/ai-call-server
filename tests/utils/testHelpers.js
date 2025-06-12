import { Client } from '../../models/Client.js';
import { Call } from '../../models/Call.js';

export const createTestClient = async (overrides = {}) => {
  const defaultData = {
    name: 'Тест Клиент',
    phone: `+7916${Math.floor(Math.random() * 10000000)
      .toString()
      .padStart(7, '0')}`,
    debt_amount: 50000,
    contract_number: `DOG-2024-${Math.random().toString(36).substr(2, 9).toUpperCase()}`,
  };

  const client = new Client({ ...defaultData, ...overrides });
  return await client.save();
};

export const createTestCall = async (clientId, overrides = {}) => {
  const defaultData = {
    call_id: `test-call-${Date.now()}`,
    client_id: clientId,
    status: 'completed',
  };

  const call = new Call({ ...defaultData, ...overrides });
  return await call.save();
};

export const createMultipleTestClients = async (count = 5) => {
  const clients = [];
  for (let i = 0; i < count; i++) {
    const client = await createTestClient({
      name: `Тест Клиент ${i + 1}`,
      debt_amount: Math.floor(Math.random() * 100000) + 10000,
      call_attempts: Math.floor(Math.random() * 3),
    });
    clients.push(client);
  }
  return clients;
};

export const simulateAudioBuffer = (text = 'test audio') => {
  return Buffer.from(`fake-audio-data-${text}`);
};

export const mockTwilioResponse = (status = 'answered') => {
  return {
    CallStatus: status,
    CallSid: 'CA1234567890abcdef',
    CallDuration: '120',
    From: '+79161234567',
    To: '+78001234567',
  };
};

export const waitForAsync = (ms = 100) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

export const generateTestAudioChunk = (duration = 1000) => {
  // Generate fake PCM audio data
  const sampleRate = 16000;
  const samples = Math.floor((sampleRate * duration) / 1000);
  const buffer = Buffer.alloc(samples * 2); // 16-bit samples

  for (let i = 0; i < samples; i++) {
    const sample = Math.floor(
      Math.sin((i * 440 * 2 * Math.PI) / sampleRate) * 32767
    );
    buffer.writeInt16LE(sample, i * 2);
  }

  return buffer;
};
