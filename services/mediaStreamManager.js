// =================================================================
// 🚀 TWILIO MEDIA STREAMS INTEGRATION - ПОЛНАЯ АРХИТЕКТУРА
// =================================================================

import { WebSocketServer } from 'ws';
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
      energyThreshold: 0.03, // порог энергии звука
    };

    logger.info('🎙️ MediaStreamManager initialized');
  }

  /**
   * 🎯 СОЗДАНИЕ WEBSOCKET СЕРВЕРА для Media Streams
   */
  // setupWebSocketServer(server) {
  //   this.wss = new WebSocketServer({
  //     server,
  //     path: '/media-stream',
  //     verifyClient: (info) => {
  //       // Проверяем что это запрос от Twilio
  //       const userAgent = info.req.headers['user-agent'];
  //       return userAgent && userAgent.includes('TwilioProxy');
  //     },
  //   });

  //   this.wss.on('connection', (ws, req) => {
  //     logger.info('🔌 New Media Stream connection from Twilio');

  //     let callId = null;
  //     let streamSid = null;
  //     let streamData = null;

  //     ws.on('message', async (message) => {
  //       try {
  //         const data = JSON.parse(message);

  //         switch (data.event) {
  //           case 'start':
  //             // Извлекаем callId из custom parameters
  //             callId = data.start.customParameters?.callId;
  //             streamSid = data.start.streamSid;

  //             if (!callId) {
  //               logger.error('❌ No callId in stream start event');
  //               ws.close();
  //               return;
  //             }

  //             streamData = this.initializeStream(callId, ws, streamSid);
  //             logger.info(
  //               `🎙️ Stream started for call ${callId}, streamSid: ${streamSid}`
  //             );

  //             // Уведомляем outboundManager
  //             outboundManager.linkMediaStream(callId, streamSid);
  //             break;

  //           case 'media':
  //             if (callId && streamData) {
  //               await this.handleAudioChunk(callId, data.media);
  //             }
  //             break;

  //           case 'stop':
  //             logger.info(`🎙️ Stream stopped for call: ${callId}`);
  //             this.cleanupStream(callId);
  //             break;

  //           default:
  //             logger.debug(`Unknown stream event: ${data.event}`);
  //         }
  //       } catch (error) {
  //         logger.error('❌ Stream message error:', error);
  //       }
  //     });

  //     ws.on('close', () => {
  //       if (callId) {
  //         logger.info(`🔌 Media Stream closed for call: ${callId}`);
  //         this.cleanupStream(callId);
  //       }
  //     });

  //     ws.on('error', (error) => {
  //       logger.error('❌ WebSocket error:', error);
  //     });
  //   });

  //   logger.info('🎙️ Media Stream WebSocket server setup complete');
  // }

  // Замените метод setupWebSocketServer в mediaStreamManager.js на этот:

  setupWebSocketServer(server) {
    this.wss = new WebSocketServer({
      server,
      path: '/media-stream',
      verifyClient: (info) => {
        // Проверяем что это запрос от Twilio
        // const userAgent = info.req.headers['user-agent'];
        // const isTwilio = userAgent && userAgent.includes('TwilioProxy');

        // if (!isTwilio) {
        //   logger.warn('⚠️ WebSocket connection rejected - not from Twilio');
        //   return false;
        // }

        // Извлекаем callId из URL параметров
        // const url = new URL(info.req.url, `http://${info.req.headers.host}`);
        // logger.info(`URL - ${url}`);
        // const callId = url.searchParams.get('callId');

        // if (!callId) {
        //   logger.warn('⚠️ WebSocket connection rejected - no callId in URL');
        //   return false;
        // }

        // // Проверяем что звонок существует
        // const callExists = outboundManager.hasActiveCall(callId);
        // if (!callExists) {
        //   logger.warn(
        //     `⚠️ WebSocket connection rejected - call not found: ${callId}`
        //   );
        //   return false;
        // }

        // logger.info(`✅ WebSocket connection accepted for call: ${callId}`);
        return true;
      },
    });

    this.wss.on('connection', (ws, req) => {
      logger.info('🔌 New Media Stream connection from Twilio');

      let callId = null;
      let streamSid = null;
      let streamData = null;

      ws.on('message', async (message) => {
        try {
          const data = JSON.parse(message);

          switch (data.event) {
            case 'start':
              // Извлекаем callId из custom parameters
              callId = data.start.customParameters?.callId;
              streamSid = data.start.streamSid;

              // Если callId не в customParameters, пробуем из URL
              if (!callId && data.start.mediaFormat) {
                const url = new URL(req.url, `http://${req.headers.host}`);
                callId = url.searchParams.get('callId');
              }

              if (!callId) {
                logger.error('❌ No callId in stream start event');
                ws.close();
                return;
              }

              streamData = this.initializeStream(callId, ws, streamSid);
              logger.info(
                `🎙️ Stream started for call ${callId}, streamSid: ${streamSid}`
              );

              // Уведомляем outboundManager
              outboundManager.linkMediaStream(callId, streamSid);
              break;

            case 'media':
              if (callId && streamData && !streamData.isPaused) {
                await this.handleAudioChunk(callId, data.media);
              }
              break;

            case 'stop':
              logger.info(`🎙️ Stream stopped for call: ${callId}`);
              this.cleanupStream(callId);
              break;

            default:
              logger.debug(`Unknown stream event: ${data.event}`);
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
  initializeStream(callId, ws, streamSid) {
    const streamData = {
      callId,
      ws,
      streamSid,
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
  async handleAudioChunk(callId, mediaData) {
    const streamData = this.activeStreams.get(callId);
    if (!streamData) return;

    const timestamp = Date.now();
    const sequenceNumber = parseInt(
      mediaData.sequenceNumber || mediaData.chunk || -1
    );

    if (sequenceNumber === -1) {
      logger.warn(
        `[handleAudioChunk] ❌ sequenceNumber отсутствует! payload:`,
        mediaData
      );
    }
    // Декодируем μ-law аудио
    const audioBuffer = this.decodeULawAudio(mediaData.payload);

    // Сохраняем чанк
    const chunk = {
      buffer: audioBuffer,
      timestamp,
      sequenceNumber,
    };

    // Обновляем буфер
    const buffer = this.audioBuffers.get(callId) || [];
    buffer.push(chunk);

    logger.debug(
      `[handleAudioChunk] callId=${callId}, seq=${sequenceNumber}, bufferLen=${audioBuffer.length}`
    );

    // Voice Activity Detection
    const hasVoice = this.detectVoiceActivity(callId, audioBuffer);

    logger.debug(`[detectVoiceActivity] hasVoice=${hasVoice}`);

    if (hasVoice) {
      streamData.lastAudioTime = timestamp;

      if (!streamData.isCollectingAudio) {
        // Начало новой фразы
        streamData.isCollectingAudio = true;
        streamData.currentPhrase = [chunk];
        streamData.silenceStart = null;
        logger.info(`🗣️ Начало фразы: ${callId}`);
      } else {
        logger.debug(
          `🗣️ Продолжение фразы: ${callId}, chunks=${streamData.currentPhrase.length}`
        );
        // Продолжение фразы
        streamData.currentPhrase.push(chunk);
        streamData.silenceStart = null;
      }
    } else {
      // Тишина
      if (streamData.isCollectingAudio) {
        if (!streamData.silenceStart) {
          streamData.silenceStart = timestamp;
        } else if (
          timestamp - streamData.silenceStart >
          this.vadThresholds.silenceDuration
        ) {
          // Конец фразы
          logger.info(`🔇 End of speech detected for call: ${callId}`);
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

      // Запускаем обработку
      await this.processStreamingAudio(callId, audioBuffer, duration);
    } catch (error) {
      logger.error(`❌ Phrase processing error for ${callId}:`, error);
    }

    this.resetPhraseCollection(callId);
  }

  /**
   * 🎯 ОБРАБОТКА ПОТОКОВОГО АУДИО
   */
  async processStreamingAudio(callId, audioBuffer, duration) {
    const startTime = Date.now();

    try {
      logger.info(
        `🎤 Processing streaming audio for call: ${callId}, duration: ${duration}s`
      );

      // Конвертируем аудио в WAV формат для STT
      const wavBuffer = this.convertToWav(audioBuffer);

      // Передаем в outboundManager для полной обработки
      const result = await outboundManager.processStreamingAudio(
        callId,
        wavBuffer
      );

      if (!result || !result.success) {
        logger.error(`❌ Streaming processing failed for ${callId}`);
        return;
      }

      const totalTime = Date.now() - startTime;
      logger.info(
        `⚡ Streaming pipeline completed in ${totalTime}ms for ${callId}`
      );

      // Эмитим событие для мониторинга
      this.emit('phrase-processed', {
        callId,
        duration,
        processingTime: totalTime,
        transcription: result.transcription,
        response: result.response,
      });
    } catch (error) {
      logger.error(`❌ Streaming processing error for ${callId}:`, error);

      // Эмитим событие ошибки
      this.emit('processing-error', {
        callId,
        error: error.message,
      });
    }
  }

  /**
   * 🎯 Voice Activity Detection
   */
  // detectVoiceActivity(audioBuffer) {
  //   if (!audioBuffer || audioBuffer.length === 0) return false;

  //   // Рассчитываем RMS (Root Mean Square) энергию
  //   let sum = 0;
  //   for (let i = 0; i < audioBuffer.length; i += 2) {
  //     if (i + 1 < audioBuffer.length) {
  //       const sample = audioBuffer.readInt16LE(i);
  //       sum += sample * sample;
  //     }
  //   }

  //   const rms = Math.sqrt(sum / (audioBuffer.length / 2));
  //   const normalized = rms / 32768; // Нормализуем для 16-bit audio

  //   return normalized > this.vadThresholds.energyThreshold;
  // }

  /**
   * 🎯 Voice Activity Detection с логированием RMS и энергии
   */
  detectVoiceActivity(callId, audioBuffer) {
    if (!audioBuffer || audioBuffer.length === 0) {
      logger.debug(`[VAD] call=${callId} | пустой буфер`);
      return false;
    }

    let sum = 0;
    for (let i = 0; i < audioBuffer.length; i += 2) {
      if (i + 1 < audioBuffer.length) {
        const sample = audioBuffer.readInt16LE(i);
        sum += sample * sample;
      }
    }

    const rms = Math.sqrt(sum / (audioBuffer.length / 2));
    const normalized = rms / 32768; // Нормализация под 16-bit PCM
    const threshold = this.vadThresholds.energyThreshold;
    const hasVoice = normalized > threshold;

    logger.debug(
      `[VAD] call=${callId} | RMS=${rms.toFixed(2)} | norm=${normalized.toFixed(5)} | threshold=${threshold} | hasVoice=${hasVoice}`
    );

    return hasVoice;
  }

  /**
   * 🎯 ОБЪЕДИНЕНИЕ АУДИО ЧАНКОВ
   */
  combineAudioChunks(chunks) {
    const totalLength = chunks.reduce(
      (sum, chunk) => sum + chunk.buffer.length,
      0
    );
    const combinedBuffer = Buffer.alloc(totalLength);

    let offset = 0;
    for (const chunk of chunks) {
      chunk.buffer.copy(combinedBuffer, offset);
      offset += chunk.buffer.length;
    }

    return combinedBuffer;
  }

  /**
   * 🎯 КОНВЕРТАЦИЯ В WAV ФОРМАТ
   */
  convertToWav(audioBuffer) {
    try {
      const sampleRate = 8000;
      const numChannels = 1;
      const bitsPerSample = 16;
      const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
      const blockAlign = numChannels * (bitsPerSample / 8);
      const dataSize = audioBuffer.length;
      const fileSize = 44 + dataSize;

      // Создаем WAV буфер
      const wavBuffer = Buffer.alloc(fileSize);
      let offset = 0;

      // RIFF header
      wavBuffer.write('RIFF', offset);
      offset += 4;
      wavBuffer.writeUInt32LE(fileSize - 8, offset);
      offset += 4;
      wavBuffer.write('WAVE', offset);
      offset += 4;

      // fmt подчанк
      wavBuffer.write('fmt ', offset);
      offset += 4;
      wavBuffer.writeUInt32LE(16, offset); // размер подчанка
      offset += 4;
      wavBuffer.writeUInt16LE(1, offset); // PCM
      offset += 2;
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
   * 🎯 ДЕКОДИРОВАНИЕ μ-law в LINEAR PCM
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

  /**
   * Проверка активности потока
   */
  hasActiveStream(callId) {
    return this.activeStreams.has(callId);
  }

  /**
   * Получить информацию о потоке
   */
  getStreamInfo(callId) {
    const streamData = this.activeStreams.get(callId);
    if (!streamData) return null;

    return {
      callId: streamData.callId,
      streamSid: streamData.streamSid,
      isActive: true,
      uptime: Date.now() - streamData.startTime,
    };
  }

  /**
   * Получить количество активных потоков
   */
  getActiveStreamsCount() {
    return this.activeStreams.size;
  }

  /**
   * Сброс сбора фразы
   */
  resetPhraseCollection(callId) {
    const streamData = this.activeStreams.get(callId);
    if (streamData) {
      streamData.isCollectingAudio = false;
      streamData.silenceStart = null;
      streamData.currentPhrase = [];
    }
  }

  /**
   * Очистка ресурсов потока
   */
  cleanupStream(callId) {
    const streamData = this.activeStreams.get(callId);
    if (streamData && streamData.ws) {
      try {
        streamData.ws.close();
      } catch (error) {
        logger.error(`Error closing WebSocket for ${callId}:`, error);
      }
    }

    this.activeStreams.delete(callId);
    this.audioBuffers.delete(callId);
    logger.info(`🧹 Stream cleanup complete for call: ${callId}`);
  }
}

// Создаем синглтон для экспорта
export const mediaStreamManager = new MediaStreamManager();
