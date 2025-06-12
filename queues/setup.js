import Bull from "bull";
import { CONFIG } from "../config/index.js";
import { logger } from "../utils/logger.js";

// Create job queues with different priorities
export const sttQueue = new Bull("STT Processing", CONFIG.REDIS_URL, {
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 5,
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
  },
});

export const llmQueue = new Bull("LLM Classification", CONFIG.REDIS_URL, {
  defaultJobOptions: {
    removeOnComplete: 10,
    removeOnFail: 5,
    attempts: 2,
    backoff: { type: "exponential", delay: 500 },
  },
});

export const ttsQueue = new Bull("TTS Generation", CONFIG.REDIS_URL, {
  defaultJobOptions: {
    removeOnComplete: 5,
    removeOnFail: 3,
    attempts: 2,
  },
});

logger.info("Bull queues initialized");
