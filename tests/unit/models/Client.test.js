import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from '@jest/globals';
import { Client } from '../../../models/Client.js';
import { setupTestDB, teardownTestDB, clearDB } from '../../setup.js';

describe('Client Model', () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  beforeEach(async () => {
    await clearDB();
  });

  test('should create a valid client', async () => {
    const clientData = {
      name: 'Иван Петров',
      phone: '+79161234567',
      debt_amount: 50000,
      contract_number: 'DOG-2024-001',
    };

    const client = new Client(clientData);
    const savedClient = await client.save();

    expect(savedClient._id).toBeDefined();
    expect(savedClient.name).toBe(clientData.name);
    expect(savedClient.phone).toBe(clientData.phone);
    expect(savedClient.debt_amount).toBe(clientData.debt_amount);
    expect(savedClient.status).toBe('active');
    expect(savedClient.call_attempts).toBe(0);
    expect(savedClient.created_at).toBeDefined();
  });

  test('should not allow duplicate phone numbers', async () => {
    const clientData = {
      name: 'Иван Петров',
      phone: '+79161234567',
      debt_amount: 50000,
      contract_number: 'DOG-2024-001',
    };

    await new Client(clientData).save();

    const duplicateClient = new Client({
      ...clientData,
      name: 'Петр Иванов',
    });

    await expect(duplicateClient.save()).rejects.toThrow();
  });

  test('should validate required fields', async () => {
    const client = new Client({});

    await expect(client.save()).rejects.toThrow();
  });

  test('should update updated_at on save', async () => {
    const client = new Client({
      name: 'Тест Тестов',
      phone: '+79161234568',
      debt_amount: 25000,
      contract_number: 'DOG-2024-002',
    });

    const savedClient = await client.save();
    const originalUpdatedAt = savedClient.updated_at;

    // Wait a bit to ensure different timestamps
    await new Promise((resolve) => setTimeout(resolve, 10));

    savedClient.debt_amount = 30000;
    await savedClient.save();

    expect(savedClient.updated_at.getTime()).toBeGreaterThan(
      originalUpdatedAt.getTime()
    );
  });

  test('should add call history', async () => {
    const client = new Client({
      name: 'История Звонков',
      phone: '+79161234569',
      debt_amount: 15000,
      contract_number: 'DOG-2024-003',
    });

    await client.save();

    client.call_history.push({
      result: 'answered',
      notes: 'Клиент согласился на рассрочку',
      duration: 120000,
    });

    const savedClient = await client.save();

    expect(savedClient.call_history).toHaveLength(1);
    expect(savedClient.call_history[0].result).toBe('answered');
    expect(savedClient.call_history[0].date).toBeDefined();
  });
});
