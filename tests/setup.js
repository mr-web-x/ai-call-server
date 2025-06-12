import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import { jest } from '@jest/globals';

let mongod;

// Setup test database
export const setupTestDB = async () => {
  mongod = await MongoMemoryServer.create();
  const uri = mongod.getUri();
  await mongoose.connect(uri);
};

// Cleanup test database
export const teardownTestDB = async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close();
  await mongod.stop();
};

// Clear all collections
export const clearDB = async () => {
  const collections = mongoose.connection.collections;
  for (const key in collections) {
    const collection = collections[key];
    await collection.deleteMany({});
  }
};

// Mock external services
export const mockExternalServices = () => {
  // Mock OpenAI
  jest.mock('openai', () => ({
    OpenAI: jest.fn().mockImplementation(() => ({
      audio: {
        transcriptions: {
          create: jest.fn().mockResolvedValue({
            text: 'Да, я согласен',
          }),
        },
      },
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            choices: [
              {
                message: {
                  content: 'positive',
                },
              },
            ],
          }),
        },
      },
    })),
  }));

  // Mock Twilio
  jest.mock('twilio', () => ({
    __esModule: true,
    default: jest.fn().mockImplementation(() => ({
      calls: {
        create: jest.fn().mockResolvedValue({
          sid: 'CA1234567890abcdef',
          status: 'queued',
        }),
      },
    })),
  }));

  // Mock Axios for ElevenLabs
  jest.mock('axios', () => ({
    post: jest.fn().mockResolvedValue({
      data: Buffer.from('fake-audio-data'),
    }),
    get: jest.fn().mockResolvedValue({
      data: Buffer.from('fake-audio-data'),
    }),
  }));

  // Mock Redis
  jest.mock('ioredis', () => {
    return jest.fn().mockImplementation(() => ({
      status: 'ready',
      on: jest.fn(),
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn(),
    }));
  });
};
