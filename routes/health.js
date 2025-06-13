import express from 'express';
import { sttQueue, llmQueue, ttsQueue } from '../queues/setup.js';
import { outboundManager } from '../services/outboundManager.js';
import { ttsManager } from '../services/ttsManager.js';
import { cacheManager } from '../services/cacheManager.js';
import { audioManager } from '../services/audioManager.js';
import { Client } from '../models/Client.js';
import redis from '../config/redis.js';
import mongoose from 'mongoose';
import { logger } from '../utils/logger.js';

const router = express.Router();

// ==============================================
// MAIN HEALTH CHECK
// ==============================================

router.get('/', async (req, res) => {
  try {
    const [sttWaiting, llmWaiting, ttsWaiting] = await Promise.all([
      sttQueue.getWaiting(),
      llmQueue.getWaiting(),
      ttsQueue.getWaiting(),
    ]);

    const activeCalls = outboundManager.getAllActiveCalls();
    const callMetrics = outboundManager.getCallMetrics();
    const ttsHealth = await ttsManager.checkElevenLabsHealth();

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      version: '2.0.0',
      services: {
        database:
          mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
        redis: redis.status === 'ready' ? 'connected' : 'disconnected',
        elevenlabs: ttsHealth.available ? 'available' : 'unavailable',
        twilio: 'available', // Always available as fallback
      },
      queues: {
        stt: { waiting: sttWaiting.length },
        llm: { waiting: llmWaiting.length },
        tts: { waiting: ttsWaiting.length },
      },
      calls: {
        active: activeCalls.length,
        metrics: callMetrics,
      },
      uptime: process.uptime(),
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
      },
    });
  } catch (error) {
    logger.error('Health check error:', error);
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ==============================================
// DETAILED SYSTEM STATUS
// ==============================================

router.get('/detailed', async (req, res) => {
  try {
    const [
      sttStats,
      llmStats,
      ttsStats,
      storageStats,
      cacheStats,
      ttsMetrics,
      callMetrics,
      ttsHealth,
    ] = await Promise.all([
      getQueueStats(sttQueue),
      getQueueStats(llmQueue),
      getQueueStats(ttsQueue),
      audioManager.getStorageStats(),
      cacheManager.getCacheStats(),
      ttsManager.getMetrics(),
      Promise.resolve(outboundManager.getCallMetrics()),
      ttsManager.checkElevenLabsHealth(),
    ]);

    res.json({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      system: {
        version: '2.0.0',
        nodeVersion: process.version,
        platform: process.platform,
        uptime: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
      },
      services: {
        database: {
          status:
            mongoose.connection.readyState === 1 ? 'connected' : 'disconnected',
          host: mongoose.connection.host,
          name: mongoose.connection.name,
        },
        redis: {
          status: redis.status,
          host: redis.options?.host,
          port: redis.options?.port,
        },
        elevenlabs: {
          ...ttsHealth,
          metrics: ttsMetrics,
        },
      },
      queues: {
        stt: sttStats,
        llm: llmStats,
        tts: ttsStats,
      },
      calls: {
        ...callMetrics,
        activeCalls: outboundManager.getAllActiveCalls(),
      },
      audio: {
        storage: storageStats,
        cache: cacheStats,
      },
    });
  } catch (error) {
    logger.error('Detailed health check error:', error);
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ==============================================
// TTS SERVICE HEALTH
// ==============================================

router.get('/tts', async (req, res) => {
  try {
    const health = await ttsManager.checkElevenLabsHealth();
    const metrics = ttsManager.getMetrics();

    res.json({
      status: health.available ? 'healthy' : 'degraded',
      elevenlabs: health,
      metrics: metrics,
      fallback: 'twilio_tts_available',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ==============================================
// CACHE STATUS
// ==============================================

router.get('/cache', async (req, res) => {
  try {
    const stats = await cacheManager.getCacheStats();
    const storageStats = await audioManager.getStorageStats();

    res.json({
      status: 'healthy',
      cache: stats,
      storage: storageStats,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ==============================================
// QUEUE STATUS
// ==============================================

router.get('/queues', async (req, res) => {
  try {
    const [sttStats, llmStats, ttsStats] = await Promise.all([
      getQueueStats(sttQueue),
      getQueueStats(llmQueue),
      getQueueStats(ttsQueue),
    ]);

    res.json({
      status: 'healthy',
      queues: {
        stt: sttStats,
        llm: llmStats,
        tts: ttsStats,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ==============================================
// ACTIVE CALLS STATUS
// ==============================================

router.get('/calls', async (req, res) => {
  try {
    const activeCalls = outboundManager.getAllActiveCalls();
    const metrics = outboundManager.getCallMetrics();

    res.json({
      status: 'healthy',
      calls: {
        active: activeCalls,
        metrics: metrics,
        count: activeCalls.length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ==============================================
// SYSTEM METRICS RESET
// ==============================================

router.post('/reset-metrics', async (req, res) => {
  try {
    // Reset TTS metrics
    ttsManager.resetMetrics();

    // Clear memory cache
    cacheManager.clearMemoryCache();

    logger.info('System metrics reset via health endpoint');

    res.json({
      status: 'success',
      message: 'Metrics reset successfully',
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// ==============================================
// HELPER FUNCTIONS
// ==============================================

async function getQueueStats(queue) {
  try {
    const [waiting, active, completed, failed, delayed] = await Promise.all([
      queue.getWaiting(),
      queue.getActive(),
      queue.getCompleted(),
      queue.getFailed(),
      queue.getDelayed(),
    ]);

    return {
      waiting: waiting.length,
      active: active.length,
      completed: completed.length,
      failed: failed.length,
      delayed: delayed.length,
      total:
        waiting.length +
        active.length +
        completed.length +
        failed.length +
        delayed.length,
    };
  } catch (error) {
    return {
      error: error.message,
      waiting: 0,
      active: 0,
      completed: 0,
      failed: 0,
      delayed: 0,
      total: 0,
    };
  }
}

export default router;
