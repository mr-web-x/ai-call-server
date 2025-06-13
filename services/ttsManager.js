import axios from 'axios';
import { logger } from '../utils/logger.js';
import { cacheManager } from './cacheManager.js';

export class TTSManager {
  constructor() {
    this.elevenLabsApiKey = process.env.ELEVENLABS_API_KEY;
    this.defaultVoiceId = process.env.TTS_VOICE_ID || 'pNInz6obpgDQGcFmaJgB';

    // Metrics
    this.metrics = {
      elevenLabsRequests: 0,
      elevenLabsErrors: 0,
      twilioFallbacks: 0,
      cacheHits: 0,
      cacheMisses: 0,
      totalRequests: 0,
    };

    this.initializeService();
  }

  /**
   * Main TTS synthesis method with fallback strategy
   */
  async synthesizeSpeech(text, options = {}) {
    const {
      voiceId = this.defaultVoiceId,
      priority = 'normal',
      useCache = true,
      maxRetries = 2,
    } = options;

    this.metrics.totalRequests++;

    logger.info(
      `TTS Request: "${text.substring(0, 50)}..." (priority: ${priority})`
    );

    try {
      // Check cache first (if enabled)
      if (useCache) {
        const cachedUrl = await cacheManager.getCachedAudio(text, voiceId);
        if (cachedUrl) {
          this.metrics.cacheHits++;
          logger.info(`Using cached audio for: ${text.substring(0, 30)}...`);
          return {
            audioBuffer: null, // No buffer needed for cached URLs
            audioUrl: cachedUrl,
            source: 'cache',
            text: text,
            voiceId: voiceId,
          };
        }
        this.metrics.cacheMisses++;
      }

      // Try ElevenLabs first
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const result = await this.synthesizeWithElevenLabs(text, voiceId);

          // Cache if it's a cacheable phrase
          if (useCache && cacheManager.shouldCache(text)) {
            await cacheManager.setCachedAudio(
              text,
              result.audioBuffer,
              voiceId
            );
          }

          this.metrics.elevenLabsRequests++;
          logger.info(
            `ElevenLabs TTS success (attempt ${attempt}): ${text.substring(0, 30)}...`
          );

          return {
            ...result,
            source: 'elevenlabs',
            attempt: attempt,
          };
        } catch (error) {
          logger.warn(`ElevenLabs attempt ${attempt} failed:`, error.message);

          if (attempt === maxRetries) {
            this.metrics.elevenLabsErrors++;
            throw error;
          }

          // Wait before retry (exponential backoff)
          await new Promise((resolve) =>
            setTimeout(resolve, Math.pow(2, attempt) * 1000)
          );
        }
      }
    } catch (error) {
      logger.error(
        'ElevenLabs TTS failed, using Twilio fallback:',
        error.message
      );
      this.metrics.twilioFallbacks++;

      return {
        audioBuffer: null,
        audioUrl: null,
        twilioTTS: true,
        source: 'twilio_fallback',
        text: text,
        voiceId: 'alice', // Twilio voice
        error: error.message,
      };
    }
  }

  /**
   * ElevenLabs TTS synthesis
   */
  async synthesizeWithElevenLabs(text, voiceId) {
    if (!this.elevenLabsApiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    const url = `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;

    const requestData = {
      text: text,
      model_id: 'eleven_multilingual_v2',
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.8,
        style: 0.2,
        use_speaker_boost: true,
      },
    };

    logger.info(`Requesting ElevenLabs TTS for voice: ${voiceId}`);

    const response = await axios.post(url, requestData, {
      headers: {
        Accept: 'audio/mpeg',
        'Content-Type': 'application/json',
        'xi-api-key': this.elevenLabsApiKey,
      },
      responseType: 'arraybuffer',
      timeout: 15000, // 15 second timeout
    });

    if (response.status !== 200) {
      throw new Error(`ElevenLabs API error: ${response.status}`);
    }

    const audioBuffer = Buffer.from(response.data);

    if (audioBuffer.length === 0) {
      throw new Error('ElevenLabs returned empty audio buffer');
    }

    logger.info(`ElevenLabs TTS success: ${audioBuffer.length} bytes`);

    return {
      audioBuffer: audioBuffer,
      audioUrl: null,
      text: text,
      voiceId: voiceId,
    };
  }

  /**
   * Check if ElevenLabs is available
   */
  async checkElevenLabsHealth() {
    if (!this.elevenLabsApiKey) {
      return { available: false, reason: 'API key not configured' };
    }

    try {
      const response = await axios.get('https://api.elevenlabs.io/v1/voices', {
        headers: {
          'xi-api-key': this.elevenLabsApiKey,
        },
        timeout: 5000,
      });

      return {
        available: response.status === 200,
        voiceCount: response.data?.voices?.length || 0,
      };
    } catch (error) {
      return {
        available: false,
        reason: error.message,
      };
    }
  }

  /**
   * Get available voices from ElevenLabs
   */
  async getAvailableVoices() {
    if (!this.elevenLabsApiKey) {
      throw new Error('ElevenLabs API key not configured');
    }

    try {
      const response = await axios.get('https://api.elevenlabs.io/v1/voices', {
        headers: {
          'xi-api-key': this.elevenLabsApiKey,
        },
        timeout: 10000,
      });

      return response.data.voices.map((voice) => ({
        id: voice.voice_id,
        name: voice.name,
        category: voice.category,
        language: voice.labels?.language || 'unknown',
      }));
    } catch (error) {
      logger.error('Failed to get ElevenLabs voices:', error);
      throw error;
    }
  }

  /**
   * Get TTS metrics
   */
  getMetrics() {
    const total = this.metrics.totalRequests;

    return {
      ...this.metrics,
      performance: {
        elevenLabsSuccessRate:
          total > 0
            ? ((this.metrics.elevenLabsRequests / total) * 100).toFixed(2) + '%'
            : '0%',
        cacheHitRate:
          total > 0
            ? ((this.metrics.cacheHits / total) * 100).toFixed(2) + '%'
            : '0%',
        fallbackRate:
          total > 0
            ? ((this.metrics.twilioFallbacks / total) * 100).toFixed(2) + '%'
            : '0%',
      },
    };
  }

  /**
   * Reset metrics
   */
  resetMetrics() {
    Object.keys(this.metrics).forEach((key) => {
      this.metrics[key] = 0;
    });
    logger.info('TTS metrics reset');
  }

  /**
   * Initialize service
   */
  async initializeService() {
    logger.info('TTS Manager initialized');

    // Check ElevenLabs health
    const health = await this.checkElevenLabsHealth();
    if (health.available) {
      logger.info(`ElevenLabs available: ${health.voiceCount} voices`);
    } else {
      logger.warn(`ElevenLabs unavailable: ${health.reason}`);
    }
  }

  /**
   * Preload cache with common phrases
   */
  async preloadCommonPhrases() {
    logger.info('Starting TTS cache preload...');

    const elevenLabsTTSFunction = async (text) => {
      try {
        const result = await this.synthesizeWithElevenLabs(
          text,
          this.defaultVoiceId
        );
        return result.audioBuffer;
      } catch (error) {
        logger.error(`Failed to preload phrase: ${text}`, error);
        return null;
      }
    };

    await cacheManager.preloadCache(elevenLabsTTSFunction);
  }
}

export const ttsManager = new TTSManager();
