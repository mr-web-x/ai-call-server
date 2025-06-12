import express from "express";
import { sttQueue, llmQueue, ttsQueue } from "../queues/setup.js";
import { outboundManager } from "../services/outboundManager.js";
import { Client } from "../models/Client.js";
import redis from "../config/redis.js";
import mongoose from "mongoose";
import { logger } from "../utils/logger.js";

const router = express.Router();

// Main health check
router.get("/", async (req, res) => {
  try {
    const [sttWaiting, llmWaiting, ttsWaiting] = await Promise.all([
      sttQueue.waiting(),
      llmQueue.waiting(),
      ttsQueue.waiting(),
    ]);

    const activeCalls = outboundManager.getAllActiveCalls();

    res.json({
      status: "healthy",
      timestamp: new Date().toISOString(),
      services: {
        database:
          mongoose.connection.readyState === 1 ? "connected" : "disconnected",
        redis: redis.status === "ready" ? "connected" : "disconnected",
        queues: {
          stt: {
            waiting: sttWaiting.length,
            active: await sttQueue.getActive(),
          },
          llm: {
            waiting: llmWaiting.length,
            active: await llmQueue.getActive(),
          },
          tts: {
            waiting: ttsWaiting.length,
            active: await ttsQueue.getActive(),
          },
        },
        calls: {
          active: activeCalls.length,
          details: activeCalls,
        },
      },
    });
  } catch (error) {
    logger.error("Health check error:", error);
    res.status(500).json({
      status: "unhealthy",
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Detailed system metrics
router.get("/metrics", async (req, res) => {
  try {
    const clientStats = await Client.aggregate([
      {
        $group: {
          _id: "$status",
          count: { $sum: 1 },
          totalDebt: { $sum: "$debt_amount" },
        },
      },
    ]);

    const queueStats = {
      stt: await sttQueue.getJobCounts(),
      llm: await llmQueue.getJobCounts(),
      tts: await ttsQueue.getJobCounts(),
    };

    res.json({
      timestamp: new Date().toISOString(),
      clients: clientStats,
      queues: queueStats,
      memory: process.memoryUsage(),
      uptime: process.uptime(),
    });
  } catch (error) {
    logger.error("Metrics error:", error);
    res.status(500).json({
      error: error.message,
      timestamp: new Date().toISOString(),
    });
  }
});

// Queue management
router.post("/queues/:queueName/clean", async (req, res) => {
  try {
    const { queueName } = req.params;
    const { grace = 5000 } = req.body;

    let queue;
    switch (queueName) {
      case "stt":
        queue = sttQueue;
        break;
      case "llm":
        queue = llmQueue;
        break;
      case "tts":
        queue = ttsQueue;
        break;
      default:
        return res.status(400).json({ error: "Invalid queue name" });
    }

    await queue.clean(grace, "completed");
    await queue.clean(grace, "failed");

    res.json({
      success: true,
      message: `Queue ${queueName} cleaned`,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logger.error("Queue clean error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

export default router;
