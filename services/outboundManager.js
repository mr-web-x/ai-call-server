import { CallSession } from './callSession.js';
import { AIServices } from './aiServices.js';
import { responseGenerator } from './responseGenerator.js';
import { DebtCollectionScripts } from '../scripts/debtCollection.js';
import { ttsManager } from './ttsManager.js';
import { audioManager } from './audioManager.js';
import { Call } from '../models/Call.js';
import { Client } from '../models/Client.js';
import { logger } from '../utils/logger.js';
import { CONFIG } from '../config/index.js';
import { whisperDetector } from '../utils/whisperHallucinationDetector.js';
import { silenceHandler } from './silenceHandler.js';
import { mediaStreamManager } from './mediaStreamManager.js';
import { sttQueue, llmQueue, ttsQueue } from '../queues/setup.js';

// 🔧 ИСПРАВЛЕНИЕ: Используем ваш существующий Twilio конфиг
import { twilioClient, TWILIO_CONFIG } from '../config/twilio.js';

import axios from 'axios';

export class OutboundManager {
  // super();
  constructor() {
    this.activeCalls = new Map(); // callId -> callData
    this.pendingAudio = new Map(); // callId -> audioData
    this.recordingProcessing = new Map(); // callId -> boolean
    this.classificationTracker = new Map(); // callId -> { classification -> count }
    this.gptFailureCounter = new Map(); // callId -> failureCount
    this.conversationStages = new Map(); // callId -> stage info Отслеживание стадий разговора

    // 🔧 ИСПРАВЛЕНИЕ: Используем уже созданный twilioClient
    this.twilioClient = twilioClient;

    this.pendingTwiml = new Map(); // callId -> pending TwiML
    this.streamingMetrics = new Map(); // callId -> latency metrics
    this.isStreamingEnabled = process.env.ENABLE_MEDIA_STREAMS === 'true';

    logger.info('🏗️ OutboundCallManager initialized');
  }

  /**
   *  Управление стадиями разговора
   */
  setConversationStage(callId, stage, audioInfo = null) {
    const stageData = {
      stage: stage,
      timestamp: Date.now(),
      audioInfo: audioInfo,
      lastTwiMLRequest: null,
    };

    this.conversationStages.set(callId, stageData);
    logger.info(`🎭 Stage changed for ${callId}: ${stage}`);
  }

  getConversationStage(callId) {
    return this.conversationStages.get(callId);
  }

  /**
   * Инициировать исходящий звонок
   */
  async initiateCall(clientId) {
    try {
      // 🔍 ОТЛАДКА: Логируем настройки из вашего конфига
      logger.info('🔍 Twilio Configuration Debug:', {
        TWILIO_PHONE_NUMBER: TWILIO_CONFIG.phoneNumber
          ? TWILIO_CONFIG.phoneNumber
          : 'UNDEFINED',
        SERVER_URL: TWILIO_CONFIG.serverUrl || CONFIG.SERVER_URL,
        TIMEOUT: TWILIO_CONFIG.timeout,
      });

      // 🔧 ИСПРАВЛЕНИЕ: Проверяем настройки из TWILIO_CONFIG
      if (!TWILIO_CONFIG.phoneNumber) {
        throw new Error(
          'TWILIO_PHONE_NUMBER is missing in TWILIO_CONFIG - проверьте .env файл!'
        );
      }

      // Получаем данные клиента
      const client = await Client.findById(clientId);
      if (!client) {
        throw new Error(`Client not found: ${clientId}`);
      }

      const callId = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      logger.info(
        `📞 Starting call initiation for client: ${clientId} (${client.name})`
      );

      // Создаём сессию звонка
      const session = new CallSession(callId, {
        name: client.name,
        phone: client.phone,
        amount: client.debt_amount,
        contract: client.contract_number,
        company: client.company || 'Финанс-Сервис',
      });

      // Инициализируем данные звонка
      const callData = {
        callId,
        twilioSid: null,
        status: 'initiating',
        clientId,
        session,
        conversation: [],
        currentStage: 'start',
        startTime: Date.now(),
        recordingCount: 0,
        lastActivity: Date.now(),
        // 🔧 ДОБАВЛЯЕМ: Для совместимости с первым файлом
        twilioCallSid: null,
        phone: client.phone,
        greetingJobId: null,
        processingRecording: false,
      };

      this.activeCalls.set(callId, callData);

      // Инициализируем трекер классификаций
      this.classificationTracker.set(callId, {});
      this.gptFailureCounter.set(callId, 0);

      // Предгенерируем приветствие
      await this.preGenerateGreeting(callId);

      // Создаём запись в БД
      await this.createCallRecord(callId, client);

      // 🔧 ИСПРАВЛЕНИЕ: Используем правильные настройки
      const baseUrl =
        TWILIO_CONFIG.serverUrl ||
        CONFIG.SERVER_URL ||
        `http://localhost:${CONFIG.PORT || 3000}`;

      const callParams = {
        to: client.phone,
        from: TWILIO_CONFIG.phoneNumber,
        url: `${baseUrl}/api/webhooks/twiml`,
        statusCallback: `${baseUrl}/api/webhooks/status/${callId}`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        method: 'POST',
        record: false,
        timeout: TWILIO_CONFIG.timeout || 30,
      };

      logger.info('🔍 Call parameters before Twilio API call:', {
        to: callParams.to,
        from: callParams.from,
        fromType: typeof callParams.from,
        fromLength: callParams.from ? callParams.from.length : 0,
        url: callParams.url,
        statusCallback: callParams.statusCallback,
      });

      // Инициируем звонок через Twilio
      const call = await this.twilioClient.calls.create(callParams);

      callData.twilioSid = call.sid;
      callData.twilioCallSid = call.sid; // 🔧 ДОБАВЛЯЕМ: Для совместимости

      logger.info(`✅ Call initiated: ${callId} -> Twilio SID: ${call.sid}`);
      logger.info('📞 TwiML URL will be handled by Console settings');

      return {
        success: true,
        callId,
        twilioSid: call.sid,
        twilioCallSid: call.sid, // 🔧 ДОБАВЛЯЕМ: Для совместимости
        clientName: client.name,
        phone: client.phone,
        status: 'initiated',
      };
    } catch (error) {
      logger.error('❌ Call initiation failed:', error);
      logger.error('❌ Error details:', {
        message: error.message,
        code: error.code,
        status: error.status,
      });
      throw error;
    }
  }

  /**
   * Get active call data
   */
  getActiveCall(callId) {
    return this.activeCalls.get(callId);
  }

  /**
   * Generate error TwiML (совместимость с первым файлом)
   */
  generateErrorTwiML() {
    logger.warn(`⚠️ Generating error TwiML`);
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Polly.Maxim" language="ru-RU">Извините, произошла техническая ошибка. До свидания.</Say>
    <Hangup/>
</Response>`;
  }

  /**
   * Get all active calls summary (совместимость с первым файлом)
   */
  getAllActiveCalls() {
    return Array.from(this.activeCalls.entries()).map(([callId, data]) => ({
      callId,
      clientId: data.clientId,
      phone: data.phone,
      status: data.status,
      currentStage: data.currentStage,
      startTime: new Date(data.startTime),
      duration: Date.now() - data.startTime,
      hasAudio: this.pendingAudio.has(callId),
      twilioCallSid: data.twilioCallSid || data.twilioSid,
    }));
  }

  /**
   * Get call metrics and statistics (совместимость с первым файлом)
   */
  getCallMetrics() {
    const activeCalls = this.getAllActiveCalls();
    const byStatus = activeCalls.reduce((acc, call) => {
      acc[call.status] = (acc[call.status] || 0) + 1;
      return acc;
    }, {});

    return {
      total: activeCalls.length,
      byStatus,
      pendingAudio: this.pendingAudio.size,
      longestCall:
        activeCalls.length > 0
          ? Math.max(...activeCalls.map((call) => call.duration))
          : 0,
    };
  }

  /**
   * Handle TTS completion and store audio data (совместимость с первым файлом)
   */
  handleTTSCompleted(callId, audioData) {
    logger.info(`🎯 TTS COMPLETED for call ${callId}:`, {
      source: audioData.source,
      hasAudioUrl: !!audioData.audioUrl,
      hasAudioBuffer: !!audioData.audioBuffer,
      twilioTTS: audioData.twilioTTS,
      type: audioData.type,
      voiceId: audioData.voiceId,
    });

    // Store audio data for webhook
    this.pendingAudio.set(callId, {
      ...audioData,
      timestamp: Date.now(),
      consumed: false,
    });

    logger.info(
      `✅ TTS completed for call ${callId}, audio ready: ${audioData.source}`
    );

    // Notify when greeting is ready
    if (
      audioData.type === 'greeting' &&
      this.activeCalls.get(callId)?.status === 'calling'
    ) {
      logger.info(
        `🎉 Greeting ready for call ${callId} - ${audioData.source} audio prepared!`
      );
    }
  }

  /**
   * Check if TTS is still in progress for a call (совместимость с первым файлом)
   */
  checkTTSInProgress(callId) {
    const callData = this.activeCalls.get(callId);
    if (!callData) return false;

    // Check if greeting job exists but audio is not ready yet
    return callData.greetingJobId && !this.pendingAudio.has(callId);
  }

  /**
   * Предгенерация приветствия
   */
  async preGenerateGreeting(callId) {
    try {
      const callData = this.activeCalls.get(callId);
      if (!callData) return;

      const greetingScript = DebtCollectionScripts.getScript(
        'start',
        'positive',
        callData.session.clientData
      );

      logger.info(`Greeting pre-generated for call: ${callId}`);

      // Генерируем TTS для приветствия
      await this.generateResponseTTS(
        callId,
        greetingScript.text,
        'urgent',
        'greeting'
      );

      logger.info(`🎉 Greeting ready for call ${callId} - audio prepared!`);
    } catch (error) {
      logger.error(`Error pre-generating greeting for ${callId}:`, error);
    }
  }

  /**
   * Создание записи звонка в БД
   */
  async createCallRecord(callId, client) {
    try {
      const callRecord = new Call({
        call_id: callId,
        client_id: client._id,
        client_name: client.name,
        client_phone: client.phone,
        debt_amount: client.debt_amount,
        status: 'initiated',
        start_time: new Date(),
        conversation: [],
        current_stage: 'start',
      });

      await callRecord.save();
      logger.info(
        `✅ Call record created in DB: ${callId} for client: ${client._id}`
      );
    } catch (error) {
      logger.error(`❌ Failed to create call record for ${callId}:`, error);
    }
  }

  /**
   * Генерация TTS для ответа
   */
  async generateResponseTTS(
    callId,
    text,
    priority = 'normal',
    type = 'response'
  ) {
    try {
      logger.info(
        `Generating ${type} TTS for call ${callId}: ${text.substring(0, 50)}...`
      );

      const result = await ttsManager.synthesizeSpeech(text, {
        priority,
        voiceId: CONFIG.ELEVENLABS_VOICE_ID,
        useCache: type === 'greeting' || priority === 'urgent',
      });

      if (result.audioBuffer || result.audioUrl) {
        let audioUrl = result.audioUrl;

        // Если есть buffer, сохраняем как файл
        if (result.audioBuffer && !audioUrl) {
          const audioFile = await audioManager.saveAudioFile(
            callId,
            result.audioBuffer,
            type
          );
          audioUrl = audioFile.publicUrl;
        }

        // Сохраняем готовое аудио
        this.pendingAudio.set(callId, {
          audioUrl,
          audioBuffer: result.audioBuffer,
          source: result.source,
          type,
          timestamp: Date.now(),
          consumed: false,
        });

        logger.info(`Audio saved for call ${callId} (${type}): ${audioUrl}`);
        return { success: true, audioUrl, source: result.source };
      }

      throw new Error('No audio generated');
    } catch (error) {
      logger.error(`❌ TTS generation failed for call ${callId}:`, error);
      return { success: false, error: error.message };
    }
  }

  /**
   * Обработка записи разговора
   */
  async processRecording(callId, recordingUrl, recordingDuration) {
    const callData = this.activeCalls.get(callId);
    if (!callData) {
      logger.error(
        `Cannot process recording: call data not found for ${callId}`
      );
      return null;
    }

    let audioBuffer = null;

    try {
      logger.info(`🧠 Starting enhanced AI processing for call: ${callId}`);
      logger.info(`🎤 Processing recording: ${recordingUrl}`);

      // 📥 СКАЧИВАЕМ АУДИО
      audioBuffer = await this.downloadRecording(recordingUrl);
      if (!audioBuffer || audioBuffer.length === 0) {
        throw new Error('Failed to download or empty audio buffer');
      }

      // 💾 СОХРАНЯЕМ ДЛЯ ОТЛАДКИ
      let audioPath = null;
      try {
        if (audioManager.saveRecordingForDebug) {
          audioPath = await audioManager.saveRecordingForDebug(
            callId,
            audioBuffer,
            recordingDuration
          );
        } else {
          const audioFile = await audioManager.saveAudioFile(
            callId,
            audioBuffer,
            'recording'
          );
          audioPath = audioFile.filepath;
        }
        logger.info(`💾 Audio saved for debug: ${audioPath}`);
      } catch (saveError) {
        logger.warn(`⚠️ Failed to save audio for debug: ${saveError.message}`);
      }

      // 🗣️ ТРАНСКРИПЦИЯ ЧЕРЕЗ WHISPER
      const transcriptionStart = Date.now();
      const transcriptionResult = await AIServices.transcribeAudio(audioBuffer);
      const transcriptionTime = Date.now() - transcriptionStart;

      const transcription = transcriptionResult.text?.trim() || '';

      logger.info(`🎯 TRANSCRIPTION RESULT for call ${callId}:`, {
        text: transcription,
        audioSize: `${(audioBuffer.length / 1024).toFixed(1)} KB`,
        duration: `${recordingDuration}s`,
        transcriptionTime: `${transcriptionTime}ms`,
        charCount: transcription.length,
        wordCount: transcription.split(' ').filter((w) => w.length > 0).length,
      });

      // 🎭 АНАЛИЗ ГАЛЛЮЦИНАЦИЙ WHISPER
      const whisperAnalysis = whisperDetector.analyzeTranscription(
        transcription,
        audioBuffer.length,
        recordingDuration
      );

      // 🔇 ОБРАБОТКА МОЛЧАНИЯ/ГАЛЛЮЦИНАЦИЙ
      if (whisperAnalysis.isHallucination || whisperAnalysis.isSilence) {
        logger.info(`🔇 Detected silence/hallucination for call ${callId}:`, {
          type: whisperAnalysis.isHallucination ? 'hallucination' : 'silence',
          confidence: `${Math.round(whisperAnalysis.confidence * 100)}%`,
          reasons: whisperAnalysis.reasons,
          recommendation: whisperAnalysis.recommendation,
        });

        // Обрабатываем через SilenceHandler
        const silenceResult = await silenceHandler.integrateWithPipeline(
          callId,
          {
            isHallucination: whisperAnalysis.isHallucination,
            isSilence: whisperAnalysis.isSilence,
            transcription: transcription,
          },
          audioBuffer.length,
          recordingDuration
        );

        if (silenceResult && silenceResult.action === 'respond') {
          // Генерируем TTS ответ на молчание
          return {
            success: true,
            classification: 'silence',
            response: silenceResult.response,
            nextStage: silenceResult.nextStage,
            shouldContinue: silenceResult.shouldContinue,
            metadata: {
              silenceType: silenceResult.silenceType,
              whisperAnalysis,
              silenceMetadata: silenceResult.metadata,
            },
          };
        } else {
          // Игнорируем и продолжаем ждать
          return {
            success: true,
            classification: 'ignored_silence',
            response: null,
            nextStage: 'listening',
            shouldContinue: true,
            metadata: {
              silenceType: silenceResult?.silenceType || 'unknown',
              whisperAnalysis,
              ignored: true,
              reason: silenceResult?.reason || 'Whisper hallucination',
            },
          };
        }
      }

      // ✅ РЕАЛЬНАЯ РЕЧЬ - ПРОДОЛЖАЕМ НОРМАЛЬНУЮ ОБРАБОТКУ
      logger.info(
        `🗣️ Real speech detected for call ${callId}, proceeding with normal pipeline`
      );

      // Получаем контекст разговора
      const conversationHistory = callData.conversationHistory || [];
      const currentStage = callData.currentStage || 'listening';

      // Классифицируем ответ пользователя
      logger.info(
        `🔍 Classifying response for call ${callId}: "${transcription.substring(0, 50)}..."`
      );

      const classificationResult = await AIServices.classifyResponse(
        transcription,
        currentStage,
        conversationHistory
      );

      const classification = classificationResult.classification || 'neutral';
      logger.info(`🏷️ Classification result: ${classification}`);

      // Обновляем счетчик повторений классификации
      const repeatCount = this.updateClassificationTracker(
        callId,
        classification
      );

      // Обновляем историю разговора
      conversationHistory.push(transcription);
      callData.conversationHistory = conversationHistory;

      // Генерируем ответ
      logger.info(`🧠 Generating AI response for ${callId}`);
      const responseResult = await responseGenerator.generateResponse({
        callId,
        clientData: callData.clientData,
        clientMessage: transcription,
        classification,
        conversationHistory,
        currentStage,
        repeatCount,
      });

      if (!responseResult.success) {
        throw new Error(`Response generation failed: ${responseResult.error}`);
      }

      // Добавляем ответ AI в историю
      conversationHistory.push(responseResult.response);
      callData.conversationHistory = conversationHistory;

      // Обновляем стадию разговора
      callData.currentStage = responseResult.nextStage;

      // Генерируем TTS
      logger.info(
        `🎵 Generating TTS for response: "${responseResult.response}"`
      );

      const ttsJob = await ttsQueue.add('synthesize', {
        text: responseResult.response,
        callId: callId,
        priority: 'normal',
        type: 'conversation',
        voiceId: process.env.TTS_VOICE_ID,
        useCache: true,
      });

      const ttsResult = await ttsJob.finished();

      if (ttsResult && (ttsResult.audioUrl || ttsResult.audioBuffer)) {
        this.pendingAudio.set(callId, {
          audioUrl: ttsResult.audioUrl,
          audioBuffer: ttsResult.audioBuffer,
          source: ttsResult.source,
          type: 'conversation',
          timestamp: Date.now(),
          consumed: false,
        });

        logger.info(
          `🎵 TTS audio ready for call ${callId}: ${ttsResult.source}`
        );
      } else {
        logger.warn(`⚠️ TTS generation failed for call ${callId}`);
      }

      return {
        success: true,
        classification,
        response: responseResult.response,
        nextStage: responseResult.nextStage,
        shouldContinue: responseResult.nextStage !== 'completed',
        metadata: {
          transcription,
          repeatCount,
          whisperAnalysis,
          realSpeech: true,
          processingTime: {
            transcription: transcriptionTime,
            total: Date.now() - transcriptionStart,
          },
        },
      };
    } catch (error) {
      logger.error(
        `❌ Enhanced recording processing error for call ${callId}:`,
        {
          error: error.message,
          stack: error.stack?.split('\n')[0],
          audioSize: audioBuffer?.length || 0,
          duration: recordingDuration,
        }
      );

      // Fallback в случае ошибки
      return this.handleRecordingError(callId, error);
    }
  }

  /**
   * Генерация ответа через новую систему
   */
  async generateAdvancedResponse(responseContext) {
    const { callId } = responseContext;

    try {
      // Проверяем количество неудач GPT для этого звонка
      const gptFailures = this.gptFailureCounter.get(callId) || 0;

      if (gptFailures >= CONFIG.MAX_GPT_FAILURES_BEFORE_FALLBACK) {
        logger.warn(
          `⚠️ Too many GPT failures for call ${callId}, forcing script mode`
        );
        return this.generateScriptResponse(responseContext);
      }

      // Пытаемся использовать responseGenerator
      const response =
        await responseGenerator.generateResponse(responseContext);

      // Сбрасываем счётчик при успехе
      this.gptFailureCounter.set(callId, 0);

      return response;
    } catch (error) {
      logger.error(
        `❌ Advanced response generation failed for call ${callId}:`,
        error
      );

      // Увеличиваем счётчик неудач
      const currentFailures = this.gptFailureCounter.get(callId) || 0;
      this.gptFailureCounter.set(callId, currentFailures + 1);

      // Фолбэк на простые скрипты
      return this.generateScriptResponse(responseContext);
    }
  }

  /**
   * Фолбэк генерация через скрипты
   */
  generateScriptResponse(responseContext) {
    const { classification, currentStage, clientData, repeatCount } =
      responseContext;

    logger.info(
      `📜 Using script fallback for classification: ${classification}`
    );

    // Получаем варианты ответов
    const responseVariants = DebtCollectionScripts.getResponseVariants(
      currentStage,
      classification,
      clientData
    );

    // Выбираем вариант на основе повторений
    const variantIndex = Math.min(repeatCount, responseVariants.length - 1);
    const selectedResponse =
      responseVariants[variantIndex] || responseVariants[0];

    return {
      text: selectedResponse.text,
      nextStage: selectedResponse.nextStage,
      method: 'script',
      isValid: true,
    };
  }

  /**
   * Трекинг повторений классификаций
   */
  updateClassificationTracker(callId, classification) {
    if (!this.classificationTracker.has(callId)) {
      this.classificationTracker.set(callId, {});
    }

    const callTracker = this.classificationTracker.get(callId);
    const currentCount = callTracker[classification] || 0;
    const newCount = currentCount + 1;

    callTracker[classification] = newCount;

    logger.info(`📊 Classification tracking for call ${callId}:`, {
      classification,
      count: newCount,
      allClassifications: callTracker,
    });

    return newCount - 1; // Возвращаем количество предыдущих повторений
  }

  /**
   * Скачивание записи
   */
  async downloadRecording(recordingUrl) {
    try {
      const maxRetries = 3;
      let lastError;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          if (attempt > 1) {
            logger.warn(
              `⏰ Recording not ready yet, waiting 3 more seconds...`
            );
            await new Promise((resolve) => setTimeout(resolve, 1000));
          }

          const response = await axios.get(recordingUrl, {
            responseType: 'arraybuffer',
            headers: {
              'User-Agent': 'DebtCollection-AI/1.0',
            },
            timeout: 30000,
            auth: {
              username: process.env.TWILIO_ACCOUNT_SID,
              password: process.env.TWILIO_AUTH_TOKEN,
            },
          });

          if (response.data && response.data.byteLength > 1000) {
            const message =
              attempt > 1
                ? `✅ Recording downloaded on retry: ${response.data.byteLength} bytes`
                : `✅ Recording downloaded: ${response.data.byteLength} bytes`;
            logger.info(message);

            return Buffer.from(response.data);
          }

          throw new Error(
            `Recording too small: ${response.data?.byteLength || 0} bytes`
          );
        } catch (error) {
          lastError = error;
          if (attempt === maxRetries) {
            throw error;
          }
          logger.warn(
            `⚠️ Download attempt ${attempt} failed: ${error.message}`
          );
        }
      }

      throw lastError;
    } catch (error) {
      logger.error('❌ Failed to download recording:', error);
      throw error;
    }
  }

  /**
   * Обработка ошибок записи
   */
  handleRecordingError(callId, error) {
    logger.warn(
      `⚠️ Using enhanced fallback for call ${callId} due to error:`,
      error.message
    );

    const fallbackResponse =
      'Извините, я не расслышал. Не могли бы вы повторить?';

    // Генерируем TTS для фолбэка
    this.generateResponseTTS(callId, fallbackResponse, 'urgent');

    return {
      transcription: '[ERROR: Could not process audio]',
      classification: 'unclear',
      response: fallbackResponse,
      nextStage: 'listening',
      method: 'fallback',
      error: true,
    };
  }

  /**
   * Получить pending audio для звонка
   */
  getPendingAudio(callId) {
    return this.pendingAudio.get(callId);
  }

  /**
   * Проверить есть ли pending audio
   */
  hasPendingAudio(callId) {
    const audio = this.pendingAudio.get(callId);
    return audio && !audio.consumed;
  }

  /**
   * Связать Media Stream с звонком
   */
  linkMediaStream(callId, streamSid) {
    const callData = this.activeCalls.get(callId);
    if (callData) {
      callData.streamSid = streamSid;
      logger.info(`🔗 Linked media stream ${streamSid} to call ${callId}`);
    }
  }

  hasActiveCall(callId) {
    return this.activeCalls.has(callId);
  }

  /**
   * ОБНОВЛЕННЫЙ generateTwiML для правильной передачи callId в Stream
   */
  generateTwiML(callId, type = 'initial') {
    const callData = this.activeCalls.get(callId);
    if (!callData) {
      logger.error(`No call data for TwiML generation: ${callId}`);
      return this.generateErrorTwiML();
    }

    const webhookUrl = `${process.env.SERVER_URL}/api/webhooks`;
    const voice = 'Polly.Tatyana';

    // Проверяем включен ли streaming
    const isStreamingEnabled = process.env.ENABLE_MEDIA_STREAMS === 'true';

    let twiml = '<?xml version="1.0" encoding="UTF-8"?><Response>';

    // Включаем Media Streams если включено
    if (isStreamingEnabled && type === 'initial') {
      const streamUrl =
        process.env.SERVER_URL.replace('https://', 'wss://') + '/media-stream';

      // ВАЖНО: передаем callId через customParameters
      twiml += `<Start>
      <Stream url="${streamUrl}" track="outbound">
        <Parameter name="callId" value="${callId}" />
        <Parameter name="twilioSid" value="${callData.twilioSid || callData.twilioCallSid}" />
      </Stream>
    </Start>`;
    }

    // Проверяем pending audio
    const pendingAudio = this.pendingAudio.get(callId);

    if (pendingAudio && !pendingAudio.consumed) {
      // Воспроизводим аудио
      if (pendingAudio.audioUrl) {
        twiml += `<Play>${pendingAudio.audioUrl}</Play>`;
        logger.info(`🎵 Playing audio: ${pendingAudio.audioUrl}`);
      } else {
        const text = pendingAudio.text || 'Здравствуйте';
        twiml += `<Say voice="${voice}" language="ru-RU">${text}</Say>`;
      }

      pendingAudio.consumed = true;
    }

    // Для streaming используем Pause вместо Record
    if (isStreamingEnabled) {
      twiml += `<Pause length="30"/>`;
      twiml += `<Redirect>${webhookUrl}/continue/${callId}</Redirect>`;
    } else {
      // Fallback на старый Record API
      twiml += `<Record
      action="${webhookUrl}/recording/${callId}"
      recordingStatusCallback="${webhookUrl}/recording-status/${callId}"
      timeout="3"
      maxLength="30"
      finishOnKey="#"
      playBeep="false"
      trim="trim-silence"
    />`;
      twiml += `<Redirect>${webhookUrl}/continue/${callId}</Redirect>`;
    }

    twiml += '</Response>';

    logger.info(
      `📋 Generated ${isStreamingEnabled ? 'STREAMING' : 'RECORDING'} TwiML for ${callId}`
    );
    return twiml;
  }

  /**
   * Генерация TwiML ответа
   */
  // generateTwiML(callId, type = 'initial') {
  //   const callData = this.activeCalls.get(callId);
  //   if (!callData) {
  //     logger.error(`No call data for TwiML generation: ${callId}`);
  //     return this.generateErrorTwiML();
  //   }

  //   const webhookUrl = `${process.env.SERVER_URL}/api/webhooks`;
  //   const voice = 'Polly.Tatyana';

  //   let twiml = '<?xml version="1.0" encoding="UTF-8"?><Response>';

  //   // Включаем Media Streams если включено
  //   if (this.isStreamingEnabled && type === 'initial') {
  //     const streamUrl =
  //       process.env.SERVER_URL.replace('https://', 'wss://') + '/media-stream';

  //     twiml += `<Start>
  //       <Stream url="${streamUrl}">
  //         <Parameter name="callId" value="${callId}" />
  //         <Parameter name="twilioSid" value="${callData.twilioSid}" />
  //       </Stream>
  //     </Start>`;
  //   }

  //   // Проверяем pending audio
  //   const pendingAudio = this.pendingAudio.get(callId);

  //   if (pendingAudio && !pendingAudio.consumed) {
  //     // Воспроизводим аудио
  //     if (pendingAudio.audioUrl) {
  //       twiml += `<Play>${pendingAudio.audioUrl}</Play>`;
  //     } else {
  //       const text = pendingAudio.text || 'Здравствуйте';
  //       twiml += `<Say voice="${voice}" language="ru-RU">${text}</Say>`;
  //     }

  //     pendingAudio.consumed = true;
  //   }

  //   // Для streaming используем Pause вместо Record
  //   if (this.isStreamingEnabled) {
  //     twiml += `<Pause length="30"/>`;
  //     twiml += `<Redirect>${webhookUrl}/continue/${callId}</Redirect>`;
  //   } else {
  //     // Fallback на старый Record API
  //     twiml += `<Record
  //       action="${webhookUrl}/recording/${callId}"
  //       recordingStatusCallback="${webhookUrl}/recording-status/${callId}"
  //       timeout="3"
  //       maxLength="30"
  //       finishOnKey="#"
  //       playBeep="false"
  //       trim="trim-silence"
  //     />`;
  //     twiml += `<Redirect>${webhookUrl}/continue/${callId}</Redirect>`;
  //   }

  //   twiml += '</Response>';

  //   logger.info(
  //     `📋 Generated ${this.isStreamingEnabled ? 'STREAMING' : 'RECORDING'} TwiML for ${callId}`
  //   );
  //   return twiml;
  // }

  // generateTwiML(callId, context = 'initial') {
  //   const callData = this.activeCalls.get(callId);
  //   if (!callData) {
  //     logger.error(`Call data not found for TwiML generation: ${callId}`);
  //     return this.generateErrorTwiML(); // ✅ ЭТО УЖЕ ЕСТЬ!
  //   }

  //   // 🎯 ПОЛУЧАЕМ ТЕКУЩУЮ СТАДИЮ
  //   const stageData = this.getConversationStage(callId);
  //   const currentStage = stageData?.stage || 'start';

  //   logger.info(`🎭 TwiML for ${callId}, stage: ${currentStage}`);

  //   // Проверяем готовое аудио
  //   const audioData = this.pendingAudio.get(callId);
  //   logger.info(`🔍 Checking pendingAudio for ${callId}:`, {
  //     hasAudioData: !!audioData,
  //     audioType: audioData?.type || 'none',
  //     consumed: audioData?.consumed || false,
  //     audioUrl: audioData?.audioUrl ? 'present' : 'missing',
  //   });

  //   if (audioData && !audioData.consumed) {
  //     logger.info(`🎵 Using ready audio for call: ${callId}`);

  //     // Помечаем как использованное
  //     audioData.consumed = true;
  //     this.pendingAudio.set(callId, audioData);

  //     // 🎯 УСТАНАВЛИВАЕМ СТАДИЮ
  //     if (currentStage === 'start') {
  //       this.setConversationStage(callId, 'greeting_sent', {
  //         audioUrl: audioData.audioUrl,
  //         source: audioData.source,
  //       });
  //     } else {
  //       // silence_response, conversation, response - все как обычный ответ
  //       this.setConversationStage(callId, 'response_sent', {
  //         audioUrl: audioData.audioUrl,
  //         source: audioData.source,
  //       });
  //     }

  //     if (audioData.audioUrl) {
  //       logger.info(`🎵 Sending ElevenLabs PLAY TwiML for call: ${callId}`);
  //       logger.info(`🎵 Audio URL: ${audioData.audioUrl}`);
  //       return this.generatePlayTwiML(callId, audioData.audioUrl); // ✅ ЭТО УЖЕ ЕСТЬ!
  //     }
  //   }

  //   // 🎯 ОБНОВЛЕННЫЙ FALLBACK (существующая логика)
  //   const script = DebtCollectionScripts.getScript(
  //     callData.currentStage || 'start',
  //     'positive',
  //     callData.session.clientData
  //   );

  //   logger.warn(`⚠️ No audio ready for call: ${callId}, using fallback TTS`);

  //   // 🎯 УСТАНАВЛИВАЕМ СТАДИЮ ДЛЯ FALLBACK
  //   if (currentStage === 'start') {
  //     this.setConversationStage(callId, 'greeting_sent', {
  //       source: 'twilio_fallback',
  //     });
  //   }

  //   return this.generateSayTwiML(callId, script.text, 'Polly.Maxim'); // ✅ Изменили голос на мужской
  // }

  /**
   * Генерация Play TwiML для ElevenLabs
   */
  generatePlayTwiML(callId, audioUrl) {
    logger.info(`🎵 Generating Play TwiML for ElevenLabs audio: ${audioUrl}`);
    logger.info(`🎵 Sending PLAY TwiML (ElevenLabs) for call: ${callId}`);
    logger.info(`🎵 Audio URL: ${audioUrl}`);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Play>${audioUrl}</Play>
<Record 
    action="${TWILIO_CONFIG.serverUrl}/api/webhooks/recording/${callId}"
    method="POST"
    maxLength="60"       
    playBeep="false"
    timeout="3"          
    finishOnKey="#"
    trim="trim-silence"  
    recordingStatusCallback="${TWILIO_CONFIG.serverUrl}/api/webhooks/recording-status/${callId}"
/>
</Response>`;

    logger.info(`📋 Full TwiML response for call ${callId}:`);
    logger.info(twiml);

    return twiml;
  }

  async processTranscriptionStreaming(callId, transcription) {
    const callData = this.activeCalls.get(callId);
    if (!callData) {
      logger.error(
        `Cannot process transcription: call data not found for ${callId}`
      );
      return null;
    }

    try {
      logger.info(`📝 Processing streaming transcription: "${transcription}"`);

      // Получаем текущее состояние
      const currentStage = callData.currentStage || 'initial';
      const conversationHistory = callData.conversationHistory || [];

      // Классификация
      const classificationResult = await classificationService.classifyMessage(
        transcription,
        callData.clientData,
        currentStage,
        conversationHistory
      );

      const classification = classificationResult.classification || 'neutral';
      const repeatCount = this.updateClassificationTracker(
        callId,
        classification
      );

      // Обновляем историю
      conversationHistory.push(transcription);
      callData.conversationHistory = conversationHistory;

      // Генерация ответа
      const responseResult = await responseGenerator.generateResponse({
        callId,
        clientData: callData.clientData,
        clientMessage: transcription,
        classification,
        conversationHistory,
        currentStage,
        repeatCount,
      });

      if (!responseResult.success) {
        throw new Error(`Response generation failed: ${responseResult.error}`);
      }

      // Обновляем историю и стадию
      conversationHistory.push(responseResult.response);
      callData.conversationHistory = conversationHistory;
      callData.currentStage = responseResult.nextStage;

      return {
        text: responseResult.response,
        classification,
        nextStage: responseResult.nextStage,
        emotion: responseResult.emotion || 'neutral',
      };
    } catch (error) {
      logger.error(`❌ Transcription processing error for ${callId}:`, error);
      return {
        text: 'Извините, не могу обработать ваше сообщение. Повторите пожалуйста.',
        classification: 'error',
        emotion: 'apologetic',
      };
    }
  }

  /**
   * Вспомогательный метод для сохранения хода разговора
   */
  async saveConversationTurn(callId, turnData) {
    try {
      await Call.findOneAndUpdate(
        { call_id: callId },
        {
          $push: {
            conversation_turns: {
              timestamp: new Date(),
              user_message: turnData.userMessage,
              classification: turnData.classification,
              ai_response: turnData.aiResponse,
              next_stage: turnData.nextStage,
              processing_time: turnData.processingTime,
              is_streaming: turnData.isStreaming,
            },
          },
          current_stage: turnData.nextStage,
          updated_at: new Date(),
        }
      );
    } catch (error) {
      logger.error(`Failed to save conversation turn for ${callId}:`, error);
    }
  }

  async processStreamingAudio(callId, audioBuffer) {
    const startTime = Date.now();
    this.streamingMetrics.set(callId, { startTime });

    const callData = this.activeCalls.get(callId);
    if (!callData) {
      logger.error(`No call data for streaming audio: ${callId}`);
      return;
    }

    try {
      // 1. Speech-to-Text
      const sttStart = Date.now();
      const transcription = await sttService.transcribe({
        audioBuffer,
        language: 'ru-RU',
        format: 'wav',
      });

      const sttDuration = Date.now() - sttStart;
      logger.info(`🎤 STT completed in ${sttDuration}ms: "${transcription}"`);

      if (!transcription || transcription.trim().length < 3) {
        logger.info(`🤫 Empty transcription, ignoring`);
        return;
      }

      // 2. Обработка через AI
      const aiStart = Date.now();
      const aiResponse = await this.processTranscriptionStreaming(
        callId,
        transcription
      );

      const aiDuration = Date.now() - aiStart;
      logger.info(`🧠 AI response in ${aiDuration}ms: "${aiResponse.text}"`);

      // 3. Обновляем историю разговора
      callData.session.turns.push({
        user: transcription,
        assistant: aiResponse.text,
        classification: aiResponse.classification,
        timestamp: new Date(),
      });

      // 4. Генерация TTS
      const ttsStart = Date.now();
      await this.generateResponseTTS(
        callId,
        aiResponse.text,
        aiResponse.priority || 'normal',
        aiResponse.type
      );

      const ttsDuration = Date.now() - ttsStart;
      const totalDuration = Date.now() - startTime;

      // 5. Логируем метрики
      logger.info(`⏱️ Streaming processing metrics for ${callId}:`, {
        stt: `${sttDuration}ms`,
        ai: `${aiDuration}ms`,
        tts: `${ttsDuration}ms`,
        total: `${totalDuration}ms`,
      });

      // 6. Триггерим webhook update если нужно воспроизвести аудио
      this.triggerPlayback(callId);
    } catch (error) {
      logger.error(`❌ Streaming processing error for ${callId}:`, error);

      // Fallback ответ при ошибке
      await this.generateResponseTTS(
        callId,
        'Извините, произошла техническая ошибка. Повторите пожалуйста.',
        'urgent'
      );
    }
  }

  /**
   *  Триггер воспроизведения через webhook
   */
  triggerPlayback(callId) {
    const callData = this.activeCalls.get(callId);
    if (!callData || !callData.twilioSid) return;

    // Отправляем сигнал Twilio для обновления звонка
    // Это вызовет webhook /continue/:callId где мы вернем TwiML с audio
    this.emit('playback-ready', { callId, twilioSid: callData.twilioSid });
  }

  /**
   * Генерация Say TwiML для фолбэка
   */
  generateSayTwiML(callId, text, voice = 'Polly.Maxim') {
    logger.warn(`🔊 Generating Say TwiML fallback with voice: ${voice}`);

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="${voice}" language="ru-RU">${text}</Say>
    <Record 
        action="${TWILIO_CONFIG.serverUrl}/api/webhooks/recording/${callId}"
        method="POST"
        maxLength="60"
        playBeep="false"
        timeout="3"
        trim="trim-silence"  
        finishOnKey="#"
        recordingStatusCallback="${TWILIO_CONFIG.serverUrl}/api/webhooks/recording-status/${callId}"
    />
</Response>`;

    return twiml;
  }

  /**
   * Обработка ответа на звонок
   */
  async handleCallAnswered(callId) {
    const callData = this.activeCalls.get(callId);
    if (!callData) {
      logger.error(`Call answered but data not found: ${callId}`);
      return { ready: false };
    }

    callData.status = 'answered';

    await Call.findOneAndUpdate(
      { call_id: callId },
      {
        status: 'answered',
        answer_time: new Date(),
      }
    );

    logger.info(`📞 Call answered: ${callId}`);

    const audioData = this.pendingAudio.get(callId);
    if (audioData) {
      logger.info(
        `🎵 Greeting audio ready for call ${callId}: ${audioData.source}`
      );
      return { ready: true, audioType: audioData.source };
    }

    const script = DebtCollectionScripts.getScript(
      'start',
      'positive',
      callData.session.clientData
    );

    logger.warn(
      `⚠️ No greeting audio ready for call ${callId}, using fallback script`
    );
    return { ready: false, script: script.text };
  }

  /**
   * Обновление статуса звонка
   */
  async updateCallStatus(callId, status, data = {}) {
    const callData = this.activeCalls.get(callId);
    if (callData) {
      callData.status = status;
      callData.lastActivity = Date.now();
    }

    try {
      const updateData = { status, [`${status}_time`]: new Date(), ...data };
      await Call.findOneAndUpdate({ call_id: callId }, updateData);

      logger.info(`📞 Call ${status}: ${callId}`);
    } catch (error) {
      logger.error(`❌ Failed to update call status for ${callId}:`, error);
    }
  }

  /**
   * Завершение звонка
   */
  async endCall(callId, result = 'completed', error = null) {
    const callData = this.activeCalls.get(callId);
    if (!callData) {
      logger.warn(`Call data not found for ending call: ${callId}`);
      return;
    }

    const duration = Date.now() - callData.startTime;

    logger.info(
      `📞 Ending call: ${callId}, result: ${result}, duration: ${duration}ms`
    );

    // Очищаем трекеры
    this.cleanupCallTrackers(callId);

    this.cleanupCallDetectionResources(callId);

    // Очищаем ресурсы
    this.activeCalls.delete(callId);
    this.pendingAudio.delete(callId);
    this.conversationStages.delete(callId);

    if (this.isStreamingEnabled) {
      mediaStreamManager.cleanupStream(callId);
      this.streamingMetrics.delete(callId);
      this.pendingTwiml.delete(callId);
    }

    // Сохраняем финальные данные
    try {
      await Call.findOneAndUpdate(
        { call_id: callId },
        {
          status: result,
          end_time: new Date(),
          duration_ms: duration,
          final_stage: callData.currentStage,
          error_message: error?.message || null,
        }
      );

      logger.info(`✅ Call data saved to database for ${callId}`);
    } catch (dbError) {
      logger.error(`❌ Failed to save call data for ${callId}:`, dbError);
    }

    logger.info(`✅ Call cleanup completed: ${callId}`);
  }

  cleanupCallDetectionResources(callId) {
    // Очищаем статистику молчания
    silenceHandler.cleanupCallStats(callId);

    // Очищаем трекинг классификаций (существующий код)
    this.classificationTracker.delete(callId);

    // Очищаем маркеры обработки (существующий код)
    this.recordingProcessing.delete(callId);

    logger.info(`🧹 Cleaned up detection resources for call: ${callId}`);
  }

  /**
   * Очистка трекеров звонка
   */
  cleanupCallTrackers(callId) {
    if (this.classificationTracker.has(callId)) {
      const finalStats = this.classificationTracker.get(callId);
      logger.info(
        `📊 Final classification stats for call ${callId}:`,
        finalStats
      );
      this.classificationTracker.delete(callId);
    }

    this.gptFailureCounter.delete(callId);
  }

  /**
   * Очистка просроченных звонков
   */
  async cleanupStaleCalls() {
    const now = Date.now();
    const maxCallDuration = 10 * 60 * 1000; // 10 минут
    let cleanedCount = 0;

    for (const [callId, callData] of this.activeCalls.entries()) {
      if (now - callData.startTime > maxCallDuration) {
        logger.warn(`🧹 Cleaning up stale call: ${callId}`);
        await this.endCall(callId, 'timeout');
        cleanedCount++;
      }
    }

    return cleanedCount;
  }

  /**
   * Найти callId по Twilio SID
   */
  findCallIdByTwilioSid(twilioSid) {
    for (const [callId, callData] of this.activeCalls.entries()) {
      if (
        callData.twilioSid === twilioSid ||
        callData.twilioCallSid === twilioSid
      ) {
        logger.info(`✅ Found callId from CallSid: ${callId} -> ${twilioSid}`);
        return callId;
      }
    }

    logger.warn(`⚠️ CallId not found for Twilio SID: ${twilioSid}`);
    return null;
  }

  /**
   * Обработка streaming аудио (аналог processRecording для потоков)
   */
  async processStreamingAudio(callId, audioBuffer) {
    const callData = this.activeCalls.get(callId);
    if (!callData) {
      logger.error(
        `Cannot process streaming audio: call data not found for ${callId}`
      );
      return null;
    }

    // Устанавливаем флаг обработки
    this.setRecordingProcessing(callId, true);

    try {
      const startTime = Date.now();
      logger.info(`🎤 Starting streaming audio processing for call: ${callId}`);

      // 1️⃣ SPEECH-TO-TEXT
      const sttStart = Date.now();

      // Создаем job для STT
      const sttJob = await sttQueue.add('transcribe', {
        audioBuffer,
        callId,
        format: 'wav',
        language: 'ru-RU',
      });

      const sttResult = await sttJob.finished();

      if (!sttResult || !sttResult.transcription) {
        throw new Error('STT failed or returned empty result');
      }

      const transcription = sttResult.transcription.trim();
      const sttDuration = Date.now() - sttStart;

      logger.info(`📝 STT completed in ${sttDuration}ms: "${transcription}"`);

      // Проверяем на пустую транскрипцию
      if (transcription.length < 3) {
        logger.info(`🤫 Empty or too short transcription, ignoring`);
        return null;
      }

      // 2️⃣ КЛАССИФИКАЦИЯ И ГЕНЕРАЦИЯ ОТВЕТА
      const llmStart = Date.now();

      // Получаем историю разговора
      const currentStage = callData.currentStage || 'initial';
      const conversationHistory = callData.conversationHistory || [];

      // Классифицируем сообщение
      const classificationJob = await llmQueue.add('classifyMessage', {
        message: transcription,
        callId,
        clientData: callData.clientData,
        currentStage,
        conversationHistory,
      });

      const classificationResult = await classificationJob.finished();
      const classification = classificationResult.classification || 'neutral';

      logger.info(`🏷️ Classification: ${classification}`);

      // Обновляем счетчик классификаций
      const repeatCount = this.updateClassificationTracker(
        callId,
        classification
      );

      // Обновляем историю разговора
      conversationHistory.push(transcription);
      callData.conversationHistory = conversationHistory;

      // 3️⃣ ГЕНЕРАЦИЯ ОТВЕТА
      const responseJob = await llmQueue.add('generateResponse', {
        responseContext: {
          callId,
          clientData: callData.clientData,
          clientMessage: transcription,
          classification,
          conversationHistory,
          currentStage,
          repeatCount,
        },
      });

      const responseResult = await responseJob.finished();

      if (!responseResult || !responseResult.success) {
        throw new Error(
          `Response generation failed: ${responseResult?.error || 'Unknown error'}`
        );
      }

      const llmDuration = Date.now() - llmStart;
      logger.info(`🧠 LLM processing completed in ${llmDuration}ms`);

      // Добавляем ответ в историю
      conversationHistory.push(responseResult.response);
      callData.conversationHistory = conversationHistory;

      // Обновляем стадию разговора
      if (responseResult.nextStage) {
        callData.currentStage = responseResult.nextStage;
      }

      // 4️⃣ ГЕНЕРАЦИЯ TTS
      const ttsStart = Date.now();

      await this.generateResponseTTS(
        callId,
        responseResult.response,
        'urgent', // Для streaming используем urgent приоритет
        'streaming'
      );

      const ttsDuration = Date.now() - ttsStart;
      const totalDuration = Date.now() - startTime;

      // 5️⃣ ЛОГИРОВАНИЕ МЕТРИК
      logger.info(`⏱️ Streaming processing metrics for ${callId}:`, {
        stt: `${sttDuration}ms`,
        llm: `${llmDuration}ms`,
        tts: `${ttsDuration}ms`,
        total: `${totalDuration}ms`,
        transcription: transcription.substring(0, 50) + '...',
        response: responseResult.response.substring(0, 50) + '...',
      });

      // 6️⃣ СОХРАНЕНИЕ В БД (асинхронно)
      this.saveConversationTurn(callId, {
        userMessage: transcription,
        classification,
        aiResponse: responseResult.response,
        nextStage: responseResult.nextStage,
        processingTime: totalDuration,
        isStreaming: true,
      }).catch((error) => {
        logger.error(`Failed to save conversation turn: ${error}`);
      });

      return {
        success: true,
        transcription,
        classification,
        response: responseResult.response,
        nextStage: responseResult.nextStage,
        metrics: {
          stt: sttDuration,
          llm: llmDuration,
          tts: ttsDuration,
          total: totalDuration,
        },
      };
    } catch (error) {
      logger.error(`❌ Streaming audio processing error for ${callId}:`, error);

      // Генерируем fallback ответ
      try {
        await this.generateResponseTTS(
          callId,
          'Извините, произошла техническая ошибка. Повторите пожалуйста.',
          'urgent',
          'error'
        );
      } catch (ttsError) {
        logger.error(`Failed to generate error TTS: ${ttsError}`);
      }

      return {
        success: false,
        error: error.message,
      };
    } finally {
      // Снимаем флаг обработки
      this.setRecordingProcessing(callId, false);
    }
  }

  /**
   * Получить данные звонка по callId
   */
  getCallData(callId) {
    return this.activeCalls.get(callId);
  }

  /**
   * Получить данные звонка по Twilio SID
   */
  getCallDataByTwilioSid(twilioSid) {
    const callId = this.findCallIdByTwilioSid(twilioSid);
    return callId ? this.activeCalls.get(callId) : null;
  }

  /**
   * Генерация Redirect TwiML (для ожидания TTS)
   */
  generateRedirectTwiML(callId) {
    const baseUrl =
      TWILIO_CONFIG.serverUrl ||
      CONFIG.SERVER_URL ||
      `http://localhost:${CONFIG.PORT || 3000}`;

    const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Pause length="2"/>
    <Redirect method="POST">${baseUrl}/api/webhooks/twiml</Redirect>
</Response>`;

    logger.info(`🔄 Generating Redirect TwiML for call: ${callId}`);
    return twiml;
  }

  /**
   * Обработка статуса звонка (для webhooks)
   */
  async handleCallStatus(callId, status, data = {}) {
    const callData = this.activeCalls.get(callId);

    if (!callData) {
      logger.warn(`Call data not found for status update: ${callId}`);
      return;
    }

    switch (status) {
      case 'initiated':
        await this.updateCallStatus(callId, 'initiated');
        logger.info(`📞 Call initiated: ${callId}`);
        break;

      case 'ringing':
        await this.updateCallStatus(callId, 'ringing');
        logger.info(`📞 Call ringing: ${callId}`);
        break;

      case 'in-progress':
      case 'answered':
        await this.updateCallStatus(callId, 'answered');
        logger.info(`📞 Call in progress: ${callId}`);
        break;

      case 'completed':
        const duration = data.duration || 0;
        const sipCode = data.sipCode || '200';

        logger.info(`📞 Call status update: ${callId} - ${status}`, {
          callSid: data.callSid,
          duration,
          sipCode,
        });

        await this.endCall(callId, 'completed');
        logger.info(`📞 Call ended: ${callId} with status: ${status}`);
        break;

      default:
        logger.info(`📞 Call status update: ${callId} - ${status}`);
        await this.updateCallStatus(callId, status, data);
    }
  }

  /**
   * Обработка записи из webhook
   */
  async handleRecordingReceived(
    callId,
    recordingUrl,
    recordingDuration,
    digits = null
  ) {
    logger.info(`🎤 Recording received for call: ${callId}`, {
      url: recordingUrl,
      duration: recordingDuration,
    });

    // Проверяем на hang up
    if (digits === 'hangup') {
      logger.info(`📞 Call hung up during recording: ${callId}`);
      await this.endCall(callId, 'completed');
      return;
    }

    // Обрабатываем запись
    return await this.processRecording(callId, recordingUrl, recordingDuration);
  }

  /**
   * Обработка статуса записи
   */
  async handleRecordingStatus(callId, status, data = {}) {
    logger.info(`🎤 Recording status update: ${callId} - ${status}`, {
      recordingSid: data.recordingSid,
      url: data.url,
    });

    // Здесь можно добавить дополнительную логику обработки статусов записи
    // Например, очистка временных файлов при завершении записи
  }

  /**
   * Получить активные звонки
   */
  getActiveCalls() {
    const calls = [];
    for (const [callId, callData] of this.activeCalls.entries()) {
      calls.push({
        callId,
        twilioSid: callData.twilioSid || callData.twilioCallSid,
        status: callData.status,
        clientId: callData.clientId,
        currentStage: callData.currentStage,
        startTime: callData.startTime,
        duration: Date.now() - callData.startTime,
      });
    }
    return calls;
  }

  /**
   * Получить статистику звонков
   */
  getCallStatistics() {
    const stats = {
      active: this.activeCalls.size,
      processing: this.recordingProcessing.size,
      pendingAudio: this.pendingAudio.size,
      classifications: {},
      stages: {},
    };

    // Подсчитываем статистику по этапам и классификациям
    for (const [callId, callData] of this.activeCalls.entries()) {
      const stage = callData.currentStage || 'unknown';
      stats.stages[stage] = (stats.stages[stage] || 0) + 1;
    }

    for (const [callId, tracker] of this.classificationTracker.entries()) {
      for (const [classification, count] of Object.entries(tracker)) {
        stats.classifications[classification] =
          (stats.classifications[classification] || 0) + count;
      }
    }

    return stats;
  }

  isRecordingProcessing(callId) {
    return this.recordingProcessing.has(callId);
  }

  // Установить маркер обработки записи
  setRecordingProcessing(callId, processing = true) {
    if (processing) {
      this.recordingProcessing.set(callId, Date.now()); // ✅ Сохраняем время начала
      logger.info(`🎤 Marked recording as processing for call: ${callId}`);
    } else {
      this.recordingProcessing.delete(callId);
      logger.info(`✅ Removed processing marker for call: ${callId}`);
    }
  }

  /**
   * НОВЫЙ: Получить pending TwiML для continue webhook
   */
  getPendingTwiml(callId) {
    const twiml = this.pendingTwiml.get(callId);
    if (twiml) {
      this.pendingTwiml.delete(callId);
      return twiml;
    }
    return null;
  }

  /**
   * НОВЫЙ: Метод для связи с mediaStreamManager
   */
  linkMediaStream(callId, streamSid) {
    const callData = this.activeCalls.get(callId);
    if (callData) {
      callData.streamSid = streamSid;
      logger.info(`🔗 Linked media stream ${streamSid} to call ${callId}`);
    }
  }

  /**
   * Test method to verify the manager is working
   */
  test() {
    logger.info('✅ OutboundManager test method called');
    return {
      status: 'working',
      activeCalls: this.activeCalls.size,
      pendingAudio: this.pendingAudio.size,
      timestamp: new Date().toISOString(),
    };
  }
}

// Экспорт singleton instance
export const outboundManager = new OutboundManager();

logger.info('✅ OutboundManager instance created and exported');
