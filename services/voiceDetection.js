import VAD from "node-vad";
import { CONFIG } from "../config/index.js";
import { logger } from "../utils/logger.js";

export class VoiceActivityDetector {
  constructor(options = {}) {
    this.threshold = options.threshold || CONFIG.VAD_THRESHOLD;
    this.silenceTimeout = options.silenceTimeout || CONFIG.SILENCE_TIMEOUT;
    this.audioBuffer = [];
    this.isRecording = false;
    this.silenceTimer = null;
    this.vad = new VAD(VAD.Mode.AGGRESSIVE);
  }

  processChunk(audioChunk, callback) {
    try {
      const hasVoice = this.vad.processAudio(audioChunk, 16000);

      if (hasVoice) {
        this.isRecording = true;
        this.audioBuffer.push(audioChunk);

        // Clear silence timer
        if (this.silenceTimer) {
          clearTimeout(this.silenceTimer);
          this.silenceTimer = null;
        }
      } else if (this.isRecording) {
        // Start silence timer
        if (!this.silenceTimer) {
          this.silenceTimer = setTimeout(() => {
            // Silence detected, send accumulated audio
            if (this.audioBuffer.length > 0) {
              const completeAudio = Buffer.concat(this.audioBuffer);
              callback(completeAudio);
              this.audioBuffer = [];
            }
            this.isRecording = false;
            this.silenceTimer = null;
          }, this.silenceTimeout);
        }
      }
    } catch (error) {
      logger.error("VAD processing error:", error);
    }
  }

  reset() {
    this.audioBuffer = [];
    this.isRecording = false;
    if (this.silenceTimer) {
      clearTimeout(this.silenceTimer);
      this.silenceTimer = null;
    }
  }
}
