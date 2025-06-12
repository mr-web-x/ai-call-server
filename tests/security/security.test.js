import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import { setupTestDB, teardownTestDB } from '../setup.js';
import { createTestClient } from '../utils/testHelpers.js';
import app from '../../server.js';

describe('Security Tests', () => {
  beforeAll(async () => {
    await setupTestDB();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  describe('Authentication', () => {
    test('should reject requests without API key', async () => {
      const response = await request(app)
        .get('/api/clients/for-calls')
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/API key required/i);
    });

    test('should reject requests with invalid API key', async () => {
      const response = await request(app)
        .get('/api/clients/for-calls')
        .set('X-API-Key', 'invalid-key')
        .expect(401);

      expect(response.body.success).toBe(false);
      expect(response.body.error).toMatch(/Valid API key required/i);
    });

    test('should accept requests with valid API key', async () => {
      const response = await request(app)
        .get('/api/clients/for-calls')
        .set('X-API-Key', process.env.API_KEY || 'test-api-key')
        .expect(200);

      expect(response.body.success).toBe(true);
    });
  });

  describe('Input Validation', () => {
    test('should validate client ID format', async () => {
      const response = await request(app)
        .post('/api/calls/client/invalid-id-format')
        .set('X-API-Key', 'test-api-key')
        .expect(400);

      expect(response.body.error).toMatch(/Invalid client ID/i);
    });

    test('should validate phone number format', async () => {
      const response = await request(app)
        .post('/api/clients')
        .set('X-API-Key', 'test-api-key')
        .send({
          name: 'Test Client',
          phone: 'invalid-phone',
          debt_amount: 50000,
          contract_number: 'TEST-001',
        })
        .expect(400);

      expect(response.body.errors || response.body.error).toBeDefined();
    });

    test('should prevent SQL injection attempts', async () => {
      const maliciousInput = "'; DROP TABLE clients; --";

      const response = await request(app)
        .post('/api/clients')
        .set('X-API-Key', 'test-api-key')
        .send({
          name: maliciousInput,
          phone: '+79161234567',
          debt_amount: 50000,
          contract_number: 'TEST-001',
        })
        .expect(201); // Should create client with escaped input

      expect(response.body.client.name).toBe(maliciousInput);
    });
  });

  describe('Rate Limiting', () => {
    test('should enforce rate limits', async () => {
      const requests = Array.from({ length: 120 }, () =>
        request(app).get('/api/health').set('X-API-Key', 'test-api-key')
      );

      const responses = await Promise.all(requests);

      const rateLimitedResponses = responses.filter(
        (res) => res.status === 429
      );
      expect(rateLimitedResponses.length).toBeGreaterThan(0);
    });
  });

  describe('CORS', () => {
    test('should handle CORS headers correctly', async () => {
      const response = await request(app)
        .options('/api/health')
        .set('Origin', 'http://localhost:3000')
        .expect(204);

      expect(response.headers['access-control-allow-origin']).toBeDefined();
    });

    test('should reject requests from unauthorized origins', async () => {
      const response = await request(app)
        .get('/api/health')
        .set('Origin', 'http://malicious-site.com');

      // Should not include CORS headers for unauthorized origin
      expect(response.headers['access-control-allow-origin']).not.toBe(
        'http://malicious-site.com'
      );
    });
  });

  describe('Security Headers', () => {
    test('should include security headers', async () => {
      const response = await request(app).get('/').expect(200);

      expect(response.headers['x-frame-options']).toBeDefined();
      expect(response.headers['x-content-type-options']).toBeDefined();
      expect(response.headers['x-xss-protection']).toBeDefined();
    });
  });
});
