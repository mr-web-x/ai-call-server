import { sttQueue, llmQueue, ttsQueue } from "./setup.js";
import { AIServices } from "../services/aiServices.js";
import { logger } from "../utils/logger.js";

// STT Queue Processor
sttQueue.process("transcribe", 5, async (job) => {
  const { audioBuffer, callId } = job.data;

  try {
    logger.info(`Processing STT for call: ${callId}`);
    const result = await AIServices.transcribeAudio(audioBuffer);

    return {
      callId,
      ...result,
    };
  } catch (error) {
    logger.error("STT Processing Error:", error);
    throw error;
  }
});

// LLM Classification Queue Processor
llmQueue.process("classify", 3, async (job) => {
  const { text, callId, currentStage, conversationHistory } = job.data;

  try {
    logger.info(`Processing LLM classification for call: ${callId}`);
    const result = await AIServices.classifyResponse(
      text,
      currentStage,
      conversationHistory
    );

    return {
      callId,
      originalText: text,
      ...result,
    };
  } catch (error) {
    logger.error("LLM Classification Error:", error);
    throw error;
  }
});

// TTS Queue Processor
ttsQueue.process("synthesize", 3, async (job) => {
  const { text, callId, priority } = job.data;

  try {
    logger.info(`Processing TTS for call: ${callId}, priority: ${priority}`);
    const result = await AIServices.synthesizeSpeech(text, priority);

    return {
      callId,
      ...result,
    };
  } catch (error) {
    logger.error("TTS Processing Error:", error);
    throw error;
  }
});

// Queue event listeners
sttQueue.on("completed", (job, result) => {
  logger.info(`STT job completed: ${job.id}`);
});

llmQueue.on("completed", (job, result) => {
  logger.info(`LLM job completed: ${job.id}`);
});

ttsQueue.on("completed", (job, result) => {
  logger.info(`TTS job completed: ${job.id}`);
});

sttQueue.on("failed", (job, err) => {
  logger.error(`STT job failed: ${job.id}`, err);
});

llmQueue.on("failed", (job, err) => {
  logger.error(`LLM job failed: ${job.id}`, err);
});

ttsQueue.on("failed", (job, err) => {
  logger.error(`TTS job failed: ${job.id}`, err);
});
