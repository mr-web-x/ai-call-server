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
import clientRoutes from '../../../routes/clients.js';
import { Client } from '../../../models/Client.js';
import { setupTestDB, teardownTestDB, clearDB } from '../../setup.js';

const app = express();
app.use(express.json());

// Mock auth middleware
app.use((req, res, next) => {
  req.user = { id: 'test-user' };
  next();
});

app.use('/api/clients', clientRoutes);

describe('Clients API', () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearDB();
  });

  describe('GET /api/clients/for-calls', () => {
    test('should return clients ready for calls', async () => {
      // Create test clients
      await Promise.all([
        new Client({
          name: 'Активный Клиент',
          phone: '+79161234567',
          debt_amount: 50000,
          contract_number: 'DOG-2024-001',
          status: 'active',
          call_attempts: 2,
        }).save(),
        new Client({
          name: 'Превышен лимит',
          phone: '+79161234568',
          debt_amount: 30000,
          contract_number: 'DOG-2024-002',
          status: 'active',
          call_attempts: 6, // Превышает лимит
        }).save(),
        new Client({
          name: 'Неактивный',
          phone: '+79161234569',
          debt_amount: 20000,
          contract_number: 'DOG-2024-003',
          status: 'paid', // Не активный
        }).save(),
      ]);

      const response = await request(app)
        .get('/api/clients/for-calls')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.count).toBe(1);
      expect(response.body.clients[0].name).toBe('Активный Клиент');
    });

    test('should filter by debt amount', async () => {
      await Promise.all([
        new Client({
          name: 'Большой Долг',
          phone: '+79161234567',
          debt_amount: 100000,
          contract_number: 'DOG-2024-001',
        }).save(),
        new Client({
          name: 'Маленький Долг',
          phone: '+79161234568',
          debt_amount: 5000,
          contract_number: 'DOG-2024-002',
        }).save(),
      ]);

      const response = await request(app)
        .get('/api/clients/for-calls?minDebtAmount=50000')
        .expect(200);

      expect(response.body.count).toBe(1);
      expect(response.body.clients[0].name).toBe('Большой Долг');
    });
  });

  describe('POST /api/clients', () => {
    test('should create new client', async () => {
      const clientData = {
        name: 'Новый Клиент',
        phone: '+79161234567',
        debt_amount: 75000,
        contract_number: 'DOG-2024-NEW',
      };

      const response = await request(app)
        .post('/api/clients')
        .send(clientData)
        .expect(201);

      expect(response.body.success).toBe(true);
      expect(response.body.client.name).toBe(clientData.name);
      expect(response.body.client._id).toBeDefined();
    });

    test('should not create duplicate phone number', async () => {
      const clientData = {
        name: 'Первый Клиент',
        phone: '+79161234567',
        debt_amount: 50000,
        contract_number: 'DOG-2024-001',
      };

      // Create first client
      await request(app).post('/api/clients').send(clientData).expect(201);

      // Try to create duplicate
      const duplicateData = {
        ...clientData,
        name: 'Дубликат',
        contract_number: 'DOG-2024-002',
      };

      const response = await request(app)
        .post('/api/clients')
        .send(duplicateData)
        .expect(400);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/already exists/);
    });
  });

  describe('GET /api/clients/:clientId', () => {
    test('should return client details', async () => {
      const client = new Client({
        name: 'Детальный Клиент',
        phone: '+79161234567',
        debt_amount: 60000,
        contract_number: 'DOG-2024-DETAIL',
      });
      await client.save();

      const response = await request(app)
        .get(`/api/clients/${client._id}`)
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.client.name).toBe('Детальный Клиент');
      expect(response.body.client.recent_calls).toBeDefined();
    });

    test('should return 404 for non-existent client', async () => {
      const fakeId = '507f1f77bcf86cd799439011';

      const response = await request(app)
        .get(`/api/clients/${fakeId}`)
        .expect(404);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/not found/);
    });
  });

  describe('GET /api/clients/stats/overview', () => {
    test('should return client statistics', async () => {
      await Promise.all([
        new Client({
          name: 'Активный 1',
          phone: '+79161234567',
          debt_amount: 50000,
          contract_number: 'DOG-2024-001',
          status: 'active',
        }).save(),
        new Client({
          name: 'Активный 2',
          phone: '+79161234568',
          debt_amount: 30000,
          contract_number: 'DOG-2024-002',
          status: 'active',
        }).save(),
        new Client({
          name: 'Оплачено',
          phone: '+79161234569',
          debt_amount: 20000,
          contract_number: 'DOG-2024-003',
          status: 'paid',
        }).save(),
      ]);

      const response = await request(app)
        .get('/api/clients/stats/overview')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.stats.total_clients).toBe(3);
      expect(response.body.stats.total_debt).toBe(100000);
      expect(response.body.stats.by_status).toBeDefined();
    });
  });
});
