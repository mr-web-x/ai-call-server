import { v4 as uuidv4 } from "uuid";
import { VoiceActivityDetector } from "./voiceDetection.js";
import { DebtCollectionScripts } from "../scripts/debtCollection.js";
import { sttQueue, llmQueue, ttsQueue } from "../queues/setup.js";
import { Call } from "../models/Call.js";
import { logger } from "../utils/logger.js";

export class CallSession {
  constructor(callId, clientData = {}) {
    this.callId = callId;
    this.clientData = clientData;
    this.currentStage = "start";
    this.conversationHistory = [];
    this.vad = new VoiceActivityDetector();
    this.isProcessing = false;
    this.startTime = new Date();

    // Pre-generate initial greeting
    this.preGenerateGreeting();
  }

  async preGenerateGreeting() {
    try {
      const script = DebtCollectionScripts.getScript(
        "start",
        "positive",
        this.clientData
      );
      await ttsQueue.add(
        "synthesize",
        {
          text: script.text,
          callId: this.callId,
          priority: "urgent",
        },
        { priority: 1 }
      );

      logger.info(`Greeting pre-generated for call: ${this.callId}`);
    } catch (error) {
      logger.error("Error pre-generating greeting:", error);
    }
  }

  async processAudioChunk(audioBuffer) {
    if (this.isProcessing) {
      logger.warn(`Call ${this.callId} already processing audio`);
      return;
    }

    this.isProcessing = true;

    try {
      // Add STT job
      const sttJob = await sttQueue.add(
        "transcribe",
        {
          audioBuffer,
          callId: this.callId,
        },
        { priority: 2 }
      );

      // Wait for STT result
      const sttResult = await sttJob.finished();

      if (sttResult.text.length > 0) {
        this.conversationHistory.push(`CLIENT: ${sttResult.text}`);

        // Add LLM classification job
        const llmJob = await llmQueue.add(
          "classify",
          {
            text: sttResult.text,
            callId: this.callId,
            currentStage: this.currentStage,
            conversationHistory: this.conversationHistory,
          },
          { priority: 1 }
        );

        // Wait for classification
        const classificationResult = await llmJob.finished();

        // Generate response
        const script = DebtCollectionScripts.getScript(
          this.currentStage,
          classificationResult.classification,
          this.clientData
        );

        this.currentStage = script.nextStage;
        this.conversationHistory.push(`AI: ${script.text}`);

        // Save to database
        await this.saveConversationStep(
          sttResult.text,
          classificationResult.classification,
          script.text
        );

        // Add TTS job
        const ttsJob = await ttsQueue.add(
          "synthesize",
          {
            text: script.text,
            callId: this.callId,
            priority: script.priority,
          },
          { priority: script.priority === "urgent" ? 1 : 3 }
        );

        return {
          transcription: sttResult.text,
          classification: classificationResult.classification,
          response: script.text,
          nextStage: script.nextStage,
          ttsJobId: ttsJob.id,
        };
      }
    } catch (error) {
      logger.error("Processing error:", error);
      throw error;
    } finally {
      this.isProcessing = false;
    }
  }

  async saveConversationStep(clientText, classification, aiResponse) {
    try {
      await Call.findOneAndUpdate(
        { call_id: this.callId },
        {
          $push: {
            conversation_history: [
              {
                timestamp: new Date(),
                speaker: "client",
                text: clientText,
                classification: classification,
              },
              {
                timestamp: new Date(),
                speaker: "ai",
                text: aiResponse,
              },
            ],
          },
        },
        { upsert: true }
      );
    } catch (error) {
      logger.error("Error saving conversation:", error);
    }
  }
}
