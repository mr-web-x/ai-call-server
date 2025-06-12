import { describe, test, expect, beforeAll, afterAll } from '@jest/globals';
import request from 'supertest';
import { setupTestDB, teardownTestDB, mockExternalServices } from '../setup.js';
import {
  createMultipleTestClients,
  waitForAsync,
} from '../utils/testHelpers.js';
import app from '../../server.js';

describe('Load Testing', () => {
  beforeAll(async () => {
    await setupTestDB();
    mockExternalServices();
  });

  afterAll(async () => {
    await teardownTestDB();
  });

  test('should handle multiple concurrent calls', async () => {
    const clientCount = 20;
    const clients = await createMultipleTestClients(clientCount);

    const startTime = Date.now();

    // Initiate concurrent calls
    const callPromises = clients.map((client) =>
      request(app)
        .post(`/api/calls/client/${client._id}`)
        .set('X-API-Key', 'test-api-key')
    );

    const responses = await Promise.allSettled(callPromises);

    const endTime = Date.now();
    const totalTime = endTime - startTime;

    // Check success rate
    const successfulCalls = responses.filter(
      (result) => result.status === 'fulfilled' && result.value.status === 200
    );

    const successRate = (successfulCalls.length / clientCount) * 100;

    expect(successRate).toBeGreaterThan(80); // At least 80% success rate
    expect(totalTime).toBeLessThan(30000); // Complete within 30 seconds

    console.log(`Load Test Results:`);
    console.log(`- Clients: ${clientCount}`);
    console.log(`- Success Rate: ${successRate.toFixed(1)}%`);
    console.log(`- Total Time: ${totalTime}ms`);
    console.log(
      `- Average Time per Call: ${(totalTime / clientCount).toFixed(1)}ms`
    );
  });

  test('should maintain system stability under load', async () => {
    const batchSize = 5;
    const batches = 4;
    const clients = await createMultipleTestClients(batchSize * batches);

    let totalSuccessful = 0;
    const batchTimes = [];

    // Process in batches to simulate realistic load
    for (let i = 0; i < batches; i++) {
      const batchClients = clients.slice(i * batchSize, (i + 1) * batchSize);
      const batchStart = Date.now();

      const batchPromises = batchClients.map((client) =>
        request(app)
          .post(`/api/calls/client/${client._id}`)
          .set('X-API-Key', 'test-api-key')
      );

      const batchResults = await Promise.allSettled(batchPromises);

      const batchEnd = Date.now();
      const batchTime = batchEnd - batchStart;
      batchTimes.push(batchTime);

      const batchSuccessful = batchResults.filter(
        (result) => result.status === 'fulfilled' && result.value.status === 200
      ).length;

      totalSuccessful += batchSuccessful;

      // Small delay between batches
      await waitForAsync(1000);

      console.log(
        `Batch ${i + 1}: ${batchSuccessful}/${batchSize} successful in ${batchTime}ms`
      );
    }

    const overallSuccessRate = (totalSuccessful / (batchSize * batches)) * 100;
    const avgBatchTime = batchTimes.reduce((a, b) => a + b, 0) / batches;

    expect(overallSuccessRate).toBeGreaterThan(85);
    expect(avgBatchTime).toBeLessThan(10000); // Average batch time under 10 seconds

    console.log(`Stability Test Results:`);
    console.log(`- Overall Success Rate: ${overallSuccessRate.toFixed(1)}%`);
    console.log(`- Average Batch Time: ${avgBatchTime.toFixed(1)}ms`);
  });

  test('should handle API rate limiting gracefully', async () => {
    const requestCount = 150; // Exceed rate limit
    const client = (await createMultipleTestClients(1))[0];

    const promises = Array.from({ length: requestCount }, () =>
      request(app).get('/api/health').set('X-API-Key', 'test-api-key')
    );

    const results = await Promise.allSettled(promises);

    const successful = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 200
    ).length;

    const rateLimited = results.filter(
      (r) => r.status === 'fulfilled' && r.value.status === 429
    ).length;

    expect(rateLimited).toBeGreaterThan(0); // Should hit rate limit
    expect(successful).toBeGreaterThan(0); // But some should succeed

    console.log(`Rate Limiting Test:`);
    console.log(`- Successful: ${successful}`);
    console.log(`- Rate Limited: ${rateLimited}`);
    console.log(
      `- Success Rate: ${((successful / requestCount) * 100).toFixed(1)}%`
    );
  });
});
