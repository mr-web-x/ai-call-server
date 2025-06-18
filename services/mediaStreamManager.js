// =================================================================
// 🚀 TWILIO MEDIA STREAMS INTEGRATION - ПОЛНАЯ АРХИТЕКТУРА
// =================================================================

// ✅ 1. НОВЫЙ СЕРВИС: services/mediaStreamManager.js
// =================================================================

import WebSocket from 'ws';
import { logger } from '../utils/logger.js';
import { EventEmitter } from 'events';
import { outboundManager } from './outboundManager.js';

export class MediaStreamManager extends EventEmitter {
  constructor() {
    super();
    this.activeStreams = new Map(); // callId -> streamData
    this.audioBuffers = new Map(); // callId -> buffer chunks
    this.vadThresholds = {
      silenceDuration: 1500, // 1.5 секунды тишины = конец фразы
      minSpeechDuration: 500, // минимум 0.5 сек для валидной речи
      energyThreshold: 0.01, // порог энергии звука
    };

    logger.info('🎙️ MediaStreamManager initialized');
  }

  /**
   * 🎯 СОЗДАНИЕ WEBSOCKET СЕРВЕРА для Media Streams
   */
  setupWebSocketServer(server) {
    this.wss = new WebSocket.Server({
      server,
      path: '/media-stream',
      verifyClient: (info) => {
        // Проверяем что это запрос от Twilio
        const userAgent = info.req.headers['user-agent'];
        return userAgent && userAgent.includes('TwilioProxy');
      },
    });

    this.wss.on('connection', (ws, req) => {
      logger.info('🔌 New Media Stream connection from Twilio');

      let callId = null;
      let streamData = null;

      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message);
          await this.handleStreamMessage(callId, data, ws);

          // Сохраняем callId при первом сообщении
          if (!callId && data.event === 'start') {
            callId = data.streamSid; // или извлекаем из customParameters
            streamData = this.initializeStream(callId, ws);
          }
        } catch (error) {
          logger.error('❌ Stream message error:', error);
        }
      });

      ws.on('close', () => {
        if (callId) {
          logger.info(`🔌 Media Stream closed for call: ${callId}`);
          this.cleanupStream(callId);
        }
      });

      ws.on('error', (error) => {
        logger.error('❌ WebSocket error:', error);
      });
    });

    logger.info('🎙️ Media Stream WebSocket server setup complete');
  }

  /**
   * 🎯 ИНИЦИАЛИЗАЦИЯ ПОТОКА для звонка
   */
  initializeStream(callId, ws) {
    const streamData = {
      callId,
      ws,
      startTime: Date.now(),
      lastAudioTime: Date.now(),
      silenceStart: null,
      isCollectingAudio: false,
      currentPhrase: [],
      sequenceNumber: 0,
    };

    this.activeStreams.set(callId, streamData);
    this.audioBuffers.set(callId, []);

    logger.info(`🎙️ Stream initialized for call: ${callId}`);
    return streamData;
  }

  /**
   * 🎯 ОБРАБОТКА СООБЩЕНИЙ от Twilio Media Stream
   */
  async handleStreamMessage(callId, data, ws) {
    switch (data.event) {
      case 'start':
        logger.info('🎙️ Stream started:', data.start);
        // Twilio начал стрим
        break;

      case 'media':
        await this.handleAudioChunk(callId, data.media);
        break;

      case 'stop':
        logger.info('🎙️ Stream stopped for call:', callId);
        this.cleanupStream(callId);
        break;
    }
  }

  /**
   * 🎯 ОБРАБОТКА АУДИО CHUNK в реальном времени
   */
  async handleAudioChunk(callId, mediaData) {
    const streamData = this.activeStreams.get(callId);
    if (!streamData) return;

    // Декодируем μ-law аудио
    const audioChunk = this.decodeULawAudio(mediaData.payload);

    // Добавляем в буфер
    const buffer = this.audioBuffers.get(callId) || [];
    buffer.push({
      chunk: audioChunk,
      timestamp: Date.now(),
      sequence: mediaData.sequenceNumber,
    });

    // 🎯 VAD - ДЕТЕКЦИЯ АКТИВНОСТИ ГОЛОСА
    const energy = this.calculateAudioEnergy(audioChunk);
    const isSpeech = energy > this.vadThresholds.energyThreshold;

    if (isSpeech) {
      // Речь активна
      streamData.lastAudioTime = Date.now();
      streamData.silenceStart = null;

      if (!streamData.isCollectingAudio) {
        logger.info(`🗣️ Speech started for call: ${callId}`);
        streamData.isCollectingAudio = true;
        streamData.currentPhrase = [];
      }

      streamData.currentPhrase.push({
        chunk: audioChunk,
        timestamp: Date.now(),
      });
    } else {
      // Тишина
      if (streamData.isCollectingAudio && !streamData.silenceStart) {
        streamData.silenceStart = Date.now();
      }

      // Проверяем на конец фразы
      if (streamData.isCollectingAudio && streamData.silenceStart) {
        const silenceDuration = Date.now() - streamData.silenceStart;

        if (silenceDuration > this.vadThresholds.silenceDuration) {
          // Конец фразы!
          await this.processPhraseComplete(callId);
        }
      }
    }

    // Ограничиваем размер буфера
    if (buffer.length > 1000) {
      buffer.splice(0, buffer.length - 1000);
    }
    this.audioBuffers.set(callId, buffer);
  }

  /**
   * 🎯 ОБРАБОТКА ЗАВЕРШЕННОЙ ФРАЗЫ
   */
  async processPhraseComplete(callId) {
    const streamData = this.activeStreams.get(callId);
    if (!streamData || !streamData.currentPhrase.length) return;

    const phraseAudio = streamData.currentPhrase;
    const duration =
      (phraseAudio[phraseAudio.length - 1].timestamp -
        phraseAudio[0].timestamp) /
      1000;

    logger.info(`🎤 Phrase complete for call: ${callId}`, {
      chunks: phraseAudio.length,
      duration: `${duration.toFixed(2)}s`,
    });

    // Проверяем минимальную длительность
    if (duration < this.vadThresholds.minSpeechDuration / 1000) {
      logger.info(`⚠️ Phrase too short, ignoring: ${duration}s`);
      this.resetPhraseCollection(callId);
      return;
    }

    // 🚀 ОБРАБАТЫВАЕМ ФРАЗУ НЕМЕДЛЕННО
    try {
      // Конвертируем chunks в единый аудио файл
      const audioBuffer = this.combineAudioChunks(phraseAudio);

      // Запускаем STT + LLM + TTS пайплайн
      await this.processStreamingAudio(callId, audioBuffer, duration);
    } catch (error) {
      logger.error(`❌ Phrase processing error for ${callId}:`, error);
    }

    this.resetPhraseCollection(callId);
  }

  /**
   * 🎯 ОБРАБОТКА ПОТОКОВОГО АУДИО (замена processRecording)
   */
  async processStreamingAudio(callId, audioBuffer, duration) {
    const startTime = Date.now();

    try {
      // 1. STT - Whisper в реальном времени
      const transcription = await this.streamingSTT(audioBuffer);

      if (!transcription || transcription.trim().length < 3) {
        logger.info(`🤫 Empty transcription for call: ${callId}`);
        return;
      }

      logger.info(
        `🎤 Transcribed (${Date.now() - startTime}ms): "${transcription}"`
      );

      // 2. LLM - классификация и ответ
      const llmStart = Date.now();
      const response = await outboundManager.processTranscriptionStreaming(
        callId,
        transcription
      );

      logger.info(
        `🧠 LLM response (${Date.now() - llmStart}ms): "${response.text}"`
      );

      // 3. TTS - параллельно с LLM если возможно
      if (response.text) {
        const ttsStart = Date.now();
        await outboundManager.generateResponseTTS(
          callId,
          response.text,
          response.emotion || 'neutral'
        );

        logger.info(`🔊 TTS generated (${Date.now() - ttsStart}ms)`);
      }

      const totalTime = Date.now() - startTime;
      logger.info(`⚡ Total streaming processing: ${totalTime}ms`);

      // Отправляем аудио-ответ через Twilio
      await this.sendStreamingResponse(callId);
    } catch (error) {
      logger.error(`❌ Streaming processing error for ${callId}:`, error);
    }
  }

  /**
   * 🎯 ПОТОКОВЫЙ STT через Whisper
   */
  async streamingSTT(audioBuffer) {
    try {
      // Конвертируем в формат для Whisper
      const wavBuffer = this.convertToWav(audioBuffer);

      // Отправляем в Whisper API
      const transcription = await outboundManager.transcribeAudio(wavBuffer);
      return transcription;
    } catch (error) {
      logger.error('❌ Streaming STT error:', error);
      return null;
    }
  }

  /**
   * 🎯 ОТПРАВКА ОТВЕТА через Media Stream
   */
  async sendStreamingResponse(callId) {
    const streamData = this.activeStreams.get(callId);
    if (!streamData) return;

    // Проверяем готовое аудио
    const audioData = outboundManager.pendingAudio.get(callId);
    if (audioData && audioData.audioUrl && !audioData.consumed) {
      // Помечаем как использованное
      audioData.consumed = true;
      outboundManager.pendingAudio.set(callId, audioData);

      // Отправляем команду Twilio Play через WebSocket
      const playCommand = {
        event: 'play',
        media: {
          url: audioData.audioUrl,
        },
      };

      streamData.ws.send(JSON.stringify(playCommand));
      logger.info(`🎵 Sent streaming audio response for call: ${callId}`);
    }
  }

  // =================================================================
  // 🛠️ УТИЛИТЫ для обработки аудио
  // =================================================================

  calculateAudioEnergy(audioChunk) {
    if (!audioChunk || audioChunk.length === 0) return 0;

    let sum = 0;
    for (let i = 0; i < audioChunk.length; i++) {
      sum += Math.abs(audioChunk[i]);
    }
    return sum / audioChunk.length / 32768; // нормализация для 16-bit
  }

  combineAudioChunks(phraseAudio) {
    const totalLength = phraseAudio.reduce(
      (sum, item) => sum + item.chunk.length,
      0
    );
    const combined = Buffer.alloc(totalLength);

    let offset = 0;
    phraseAudio.forEach((item) => {
      item.chunk.copy(combined, offset);
      offset += item.chunk.length;
    });

    return combined;
  }

  convertToWav(audioBuffer) {
    try {
      // 🎯 КОНВЕРТАЦИЯ μ-law PCM в WAV для Whisper

      // Параметры аудио от Twilio Media Streams
      const sampleRate = 8000; // 8 kHz
      const numChannels = 1; // моно
      const bitsPerSample = 16; // 16-bit после декодирования μ-law

      // Размеры для WAV заголовка
      const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
      const blockAlign = (numChannels * bitsPerSample) / 8;
      const dataSize = audioBuffer.length;
      const fileSize = 36 + dataSize;

      // Создаем WAV буфер с заголовком
      const wavBuffer = Buffer.alloc(44 + dataSize);
      let offset = 0;

      // 🎵 WAV ЗАГОЛОВОК (44 байта)

      // RIFF заголовок
      wavBuffer.write('RIFF', offset);
      offset += 4;
      wavBuffer.writeUInt32LE(fileSize, offset);
      offset += 4;
      wavBuffer.write('WAVE', offset);
      offset += 4;

      // fmt подчанк
      wavBuffer.write('fmt ', offset);
      offset += 4;
      wavBuffer.writeUInt32LE(16, offset);
      offset += 4; // размер fmt chunk
      wavBuffer.writeUInt16LE(1, offset);
      offset += 2; // аудио формат (1 = PCM)
      wavBuffer.writeUInt16LE(numChannels, offset);
      offset += 2;
      wavBuffer.writeUInt32LE(sampleRate, offset);
      offset += 4;
      wavBuffer.writeUInt32LE(byteRate, offset);
      offset += 4;
      wavBuffer.writeUInt16LE(blockAlign, offset);
      offset += 2;
      wavBuffer.writeUInt16LE(bitsPerSample, offset);
      offset += 2;

      // data подчанк
      wavBuffer.write('data', offset);
      offset += 4;
      wavBuffer.writeUInt32LE(dataSize, offset);
      offset += 4;

      // 🎵 КОПИРУЕМ АУДИО ДАННЫЕ
      audioBuffer.copy(wavBuffer, offset);

      logger.debug(`📦 WAV conversion complete: ${wavBuffer.length} bytes`);
      return wavBuffer;
    } catch (error) {
      logger.error('❌ WAV conversion error:', error);
      // Fallback - возвращаем исходный буфер
      return audioBuffer;
    }
  }

  /**
   * 🎯 УЛУЧШЕННОЕ ДЕКОДИРОВАНИЕ μ-law в LINEAR PCM
   */
  decodeULawAudio(base64Payload) {
    try {
      const ulawBuffer = Buffer.from(base64Payload, 'base64');

      // Создаем буфер для 16-bit linear PCM (в 2 раза больше)
      const linearBuffer = Buffer.alloc(ulawBuffer.length * 2);

      // 🎵 μ-law LOOKUP TABLE для быстрого декодирования
      const ULAW_DECODE_TABLE = this.buildULawDecodeTable();

      // Декодируем каждый μ-law семпл в 16-bit linear
      for (let i = 0; i < ulawBuffer.length; i++) {
        const ulawByte = ulawBuffer[i];
        const linearValue = ULAW_DECODE_TABLE[ulawByte];

        // Записываем как 16-bit little-endian
        linearBuffer.writeInt16LE(linearValue, i * 2);
      }

      logger.debug(
        `🎵 μ-law decoded: ${ulawBuffer.length} -> ${linearBuffer.length} bytes`
      );
      return linearBuffer;
    } catch (error) {
      logger.error('❌ μ-law decoding error:', error);
      return Buffer.from(base64Payload, 'base64'); // fallback
    }
  }

  /**
   * 🎯 ПОСТРОЕНИЕ LOOKUP TABLE для μ-law декодирования
   */
  buildULawDecodeTable() {
    const table = new Array(256);

    for (let i = 0; i < 256; i++) {
      // μ-law декодирование по стандарту ITU-T G.711
      let sign = i & 0x80 ? -1 : 1;
      let exponent = (i & 0x70) >> 4;
      let mantissa = i & 0x0f;

      let sample;
      if (exponent === 0) {
        sample = (mantissa << 2) + 33;
      } else {
        sample = ((mantissa << 1) + 33) << (exponent + 1);
      }

      table[i] = sign * (sample - 33);
    }

    return table;
  }

  resetPhraseCollection(callId) {
    const streamData = this.activeStreams.get(callId);
    if (streamData) {
      streamData.isCollectingAudio = false;
      streamData.silenceStart = null;
      streamData.currentPhrase = [];
    }
  }

  cleanupStream(callId) {
    this.activeStreams.delete(callId);
    this.audioBuffers.delete(callId);
    logger.info(`🧹 Stream cleanup complete for call: ${callId}`);
  }
}

// Создаем синглтон для экспорта
export const mediaStreamManager = new MediaStreamManager();
