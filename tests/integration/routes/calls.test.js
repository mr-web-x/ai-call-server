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
import callRoutes from '../../../routes/calls.js';
import { Client } from '../../../models/Client.js';
import {
  setupTestDB,
  teardownTestDB,
  clearDB,
  mockExternalServices,
} from '../../setup.js';

const app = express();
app.use(express.json());

// Mock auth middleware
app.use((req, res, next) => {
  req.user = { id: 'test-user' };
  next();
});

app.use('/api/calls', callRoutes);

describe('Calls API', () => {
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

  describe('POST /api/calls/client/:clientId', () => {
    test('should initiate call to existing client', async () => {
      // Create test client
      const client = new Client({
        name: 'Тест Клиент',
        phone: '+79161234567',
        debt_amount: 50000,
        contract_number: 'DOG-2024-001',
      });
      await client.save();

      const response = await request(app)
        .post(`/api/calls/client/${client._id}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.callId).toBeDefined();
      expect(response.body.twilioCallSid).toBeDefined();
      expect(response.body.clientName).toBe('Тест Клиент');
    });

    test('should return 400 for invalid client ID', async () => {
      const response = await request(app)
        .post('/api/calls/client/invalid-id')
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/Invalid client ID/);
    });

    test('should return 500 for non-existent client', async () => {
      const fakeId = '507f1f77bcf86cd799439011';

      const response = await request(app)
        .post(`/api/calls/client/${fakeId}`)
        .expect(500);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/Client not found/);
    });
  });

  describe('POST /api/calls/bulk', () => {
    test('should initiate bulk calls', async () => {
      // Create test clients
      const clients = await Promise.all([
        new Client({
          name: 'Клиент 1',
          phone: '+79161234567',
          debt_amount: 30000,
          contract_number: 'DOG-2024-001',
        }).save(),
        new Client({
          name: 'Клиент 2',
          phone: '+79161234568',
          debt_amount: 40000,
          contract_number: 'DOG-2024-002',
        }).save(),
      ]);

      const clientIds = clients.map((c) => c._id.toString());

      const response = await request(app)
        .post('/api/calls/bulk')
        .send({
          clientIds,
          delay: 1000,
        })
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.results).toHaveLength(2);
      expect(response.body.results[0].success).toBe(true);
      expect(response.body.results[1].success).toBe(true);
    });

    test('should return 400 for invalid request body', async () => {
      const response = await request(app)
        .post('/api/calls/bulk')
        .send({
          clientIds: 'not-an-array',
        })
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/must be an array/);
    });
  });

  describe('GET /api/calls/active', () => {
    test('should return active calls', async () => {
      const response = await request(app).get('/api/calls/active').expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.count).toBeDefined();
      expect(response.body.calls).toBeDefined();
      expect(Array.isArray(response.body.calls)).toBe(true);
    });
  });
});
