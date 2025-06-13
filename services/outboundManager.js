import fs from 'fs/promises'; // ⬅️ ДОБАВЛЕН ИМПОРТ fs
import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import { twilioClient, TWILIO_CONFIG } from '../config/twilio.js';
import { Client } from '../models/Client.js';
import { Call } from '../models/Call.js';
import { CallSession } from './callSession.js';
import { DebtCollectionScripts } from '../scripts/debtCollection.js';
import { AIServices } from './aiServices.js'; // ⬅️ ИСПРАВЛЕН ИМПОРТ
import { ttsQueue } from '../queues/setup.js';
import { audioManager } from './audioManager.js';
import { ttsManager } from './ttsManager.js';
import { logger } from '../utils/logger.js';

export class OutboundCallManager {
  constructor() {
    this.activeCalls = new Map();
    this.callQueue = [];
    this.pendingAudio = new Map(); // callId -> audioData
    logger.info('🏗️ OutboundCallManager initialized');
  }

  /**
   * Initiate a new outbound call
   */
  async initiateCall(clientId) {
    try {
      // Validate ObjectId
      if (!mongoose.Types.ObjectId.isValid(clientId)) {
        throw new Error('Invalid client ID');
      }

      // Get client from MongoDB
      const client = await Client.findById(clientId);
      if (!client) {
        throw new Error('Client not found');
      }

      logger.info(
        `📞 Starting call initiation for client: ${clientId} (${client.name})`
      );
      logger.info(`📞 Initiating call to ${client.name} (${client.phone})`);

      // Create call session
      const callId = uuidv4();
      const session = new CallSession(callId, {
        name: client.name,
        amount: client.debt_amount,
        contract: client.contract_number,
        company: 'Финанс-Групп',
      });

      // Store active call data
      this.activeCalls.set(callId, {
        session,
        clientId: client._id,
        phone: client.phone,
        startTime: new Date(),
        status: 'calling',
        currentStage: 'initial_greeting',
        twilioCallSid: null,
        greetingJobId: null,
        conversation: [], // ⬅️ ДОБАВЛЕНО для хранения истории разговора
      });

      // Generate greeting first
      const greetingScript = DebtCollectionScripts.getScript(
        'start',
        'positive',
        session.clientData
      );

      logger.info(`Greeting pre-generated for call: ${callId}`);

      // Start TTS generation for greeting (urgent priority)
      const greetingJob = await ttsQueue.add(
        'synthesize',
        {
          text: greetingScript.text,
          callId: callId,
          priority: 'urgent',
          type: 'greeting',
          useCache: true,
        },
        {
          priority: 1,
          attempts: 3,
        }
      );

      // Store greeting job ID
      this.activeCalls.get(callId).greetingJobId = greetingJob.id;

      // Create database record
      const callRecord = new Call({
        call_id: callId,
        client_id: client._id,
        phone: client.phone,
        status: 'initiated',
        start_time: new Date(),
        greeting_script: greetingScript.text,
        current_stage: 'initial_greeting',
      });

      await callRecord.save();
      logger.info(
        `✅ Call record created in DB: ${callId} for client: ${clientId}`
      );

      // Generate TwiML URL
      const twimlUrl = `${process.env.SERVER_URL}/api/webhooks/twiml`;
      logger.info(
        `Generating greeting for call ${callId}: ${greetingScript.text.substring(0, 50)}...`
      );

      // Log base URL being used
      logger.info(`🔧 Using base URL: ${process.env.SERVER_URL}`);

      // Initiate Twilio call
      const call = await twilioClient.calls.create({
        from: TWILIO_CONFIG.phoneNumber,
        to: client.phone,
        url: twimlUrl,
        statusCallback: `${process.env.SERVER_URL}/api/webhooks/status/${callId}`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        statusCallbackMethod: 'POST',
        timeout: TWILIO_CONFIG.timeout,
        record: TWILIO_CONFIG.recordCalls,
      });

      // Update call data with Twilio SID
      this.activeCalls.get(callId).twilioCallSid = call.sid;

      // Update database with Twilio SID
      await Call.findOneAndUpdate(
        { call_id: callId },
        { twilio_call_sid: call.sid }
      );

      logger.info(`✅ Call initiated: ${callId} -> Twilio SID: ${call.sid}`);
      logger.info(`📞 TwiML URL will be handled by Console settings`);

      return {
        callId,
        twilioCallSid: call.sid,
        clientName: client.name,
        phone: client.phone,
        status: 'initiated',
      };
    } catch (error) {
      logger.error(`❌ Failed to initiate call for client ${clientId}:`, error);
      throw error;
    }
  }

  /**
   * Handle TTS completion and store audio data
   */
  onTTSCompleted(callId, audioData) {
    logger.info(`🎯 TTS COMPLETED for call ${callId}:`, {
      source: audioData.source,
      hasAudioUrl: !audioData.audioUrl,
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
   * Check if TTS is still in progress for a call
   */
  checkTTSInProgress(callId) {
    const callData = this.activeCalls.get(callId);
    if (!callData) return false;

    // Check if greeting job exists but audio is not ready yet
    return callData.greetingJobId && !this.pendingAudio.has(callId);
  }

  /**
   * Find callId by Twilio CallSid (for requests without callId)
   */
  findCallIdByTwilioSid(twilioCallSid) {
    for (const [callId, callData] of this.activeCalls.entries()) {
      if (callData.twilioCallSid === twilioCallSid) {
        return callId;
      }
    }
    return null;
  }

  /**
   * Generate TwiML response for Twilio webhook
   */
  async generateTwiMLResponse(callId, context = 'initial') {
    const callData = this.activeCalls.get(callId);

    // Handle unknown calls
    if (!callData) {
      logger.warn(`TwiML requested for unknown call: ${callId}`);
      return this.generateErrorTwiML();
    }

    logger.info(`🎯 Generating TwiML for call: ${callId}, context: ${context}`);

    // Check for ready audio first
    const audioData = this.pendingAudio.get(callId);
    if (audioData && !audioData.consumed) {
      logger.info(`🎵 Using ready audio for call: ${callId}`);

      // Mark as consumed
      audioData.consumed = true;
      this.pendingAudio.set(callId, audioData);

      // Generate appropriate TwiML based on audio type
      if (audioData.audioUrl) {
        logger.info(`🎵 Sending ElevenLabs PLAY TwiML for call: ${callId}`);
        logger.info(`🎵 Audio URL: ${audioData.audioUrl}`);
        return this.generatePlayTwiML(callId, audioData.audioUrl);
      } else if (audioData.audioBuffer) {
        // Should not happen as audioManager creates URLs
        logger.warn(`⚠️ Audio buffer without URL for call: ${callId}`);
        return this.generateSayTwiML(callId, 'Произошла ошибка со звуком');
      }
    }

    // Check if TTS is still processing
    if (this.checkTTSInProgress(callId)) {
      logger.info(`⏳ TTS still in progress for call: ${callId}, redirecting`);
      return this.generateRedirectTwiML(callId);
    }

    // Generate fallback TwiML
    const script = DebtCollectionScripts.getScript(
      callData.currentStage || 'start',
      'positive',
      callData.session.clientData
    );

    logger.warn(`⚠️ No audio ready for call: ${callId}, using fallback TTS`);
    return this.generateSayTwiML(callId, script.text, 'Polly.Tatyana');
  }

  /**
   * Generate TwiML with Play tag (for ElevenLabs/cached audio)
   */
  generatePlayTwiML(callId, audioUrl) {
    logger.info(`🎵 Generating Play TwiML for ElevenLabs audio: ${audioUrl}`);

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Play>${audioUrl}</Play>
    <Record 
        action="${process.env.SERVER_URL}/api/webhooks/recording/${callId}"
        method="POST"
        maxLength="300"
        playBeep="false"
        timeout="10"
        finishOnKey="#"
        recordingStatusCallback="${process.env.SERVER_URL}/api/webhooks/recording-status/${callId}"
    />
</Response>`;
  }

  /**
   * Generate TwiML with Say tag (for Twilio TTS fallback)
   */
  generateSayTwiML(callId, text, voice = 'Polly.Tatyana') {
    logger.warn(`🔊 Generating Say TwiML fallback with voice: ${voice}`);

    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="${voice}" language="ru-RU">${text}</Say>
    <Record 
        action="${process.env.SERVER_URL}/api/webhooks/recording/${callId}"
        method="POST"
        maxLength="300"
        playBeep="false"
        timeout="10"
        finishOnKey="#"
        recordingStatusCallback="${process.env.SERVER_URL}/api/webhooks/recording-status/${callId}"
    />
</Response>`;
  }

  /**
   * Generate redirect TwiML (for waiting on TTS)
   */
  generateRedirectTwiML(callId) {
    logger.info(`🔄 Generating redirect TwiML for call: ${callId}`);
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Pause length="2"/>
    <Redirect method="POST">${process.env.SERVER_URL}/api/webhooks/twiml</Redirect>
</Response>`;
  }

  /**
   * Generate error TwiML
   */
  generateErrorTwiML() {
    logger.warn(`⚠️ Generating error TwiML`);
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="Polly.Tatyana" language="ru-RU">Извините, произошла техническая ошибка. До свидания.</Say>
    <Hangup/>
</Response>`;
  }

  /**
   * Generate response TTS for conversation continuation
   */
  async generateResponseTTS(callId, responseText, priority = 'normal') {
    const callData = this.activeCalls.get(callId);
    if (!callData) {
      logger.warn(
        `Cannot generate response TTS: call data not found for ${callId}`
      );
      return;
    }

    logger.info(
      `Generating response TTS for call ${callId}: ${responseText.substring(0, 50)}...`
    );

    // Determine if this is a final response (higher priority)
    const isFinal =
      responseText.toLowerCase().includes('свидания') ||
      responseText.toLowerCase().includes('спасибо') ||
      priority === 'urgent';

    const ttsJob = await ttsQueue.add(
      'synthesize',
      {
        text: responseText,
        callId: callId,
        priority: isFinal ? 'urgent' : 'normal',
        type: 'response',
        useCache: isFinal, // Cache farewells
      },
      {
        priority: isFinal ? 1 : 5,
        attempts: 2,
      }
    );

    return { ttsJobId: ttsJob.id, responseText };
  }

  /**
   * Handle call answered event
   */
  async handleCallAnswered(callId) {
    const callData = this.activeCalls.get(callId);
    if (!callData) {
      logger.error(`Call answered but data not found: ${callId}`);
      return { ready: false };
    }

    // Update status
    callData.status = 'answered';

    // Update database
    await Call.findOneAndUpdate(
      { call_id: callId },
      {
        status: 'answered',
        answer_time: new Date(),
      }
    );

    logger.info(`📞 Call answered: ${callId}`);

    // Check if greeting is ready
    const audioData = this.pendingAudio.get(callId);
    if (audioData) {
      logger.info(
        `🎵 Greeting audio ready for call ${callId}: ${audioData.source}`
      );
      return { ready: true, audioType: audioData.source };
    }

    // Return fallback script if audio not ready
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
   * Process recording and generate AI response
   */
  async processRecording(callId, recordingUrl, recordingDuration) {
    const callData = this.activeCalls.get(callId);
    if (!callData) {
      logger.error(
        `Cannot process recording: call data not found for ${callId}`
      );
      throw new Error(`Call data not found: ${callId}`);
    }

    logger.info(`🎤 Processing recording for call ${callId}: ${recordingUrl}`);

    try {
      // Wait a bit for Twilio to fully process the recording
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Download and process audio with proper Twilio auth
      const twilioAuth = Buffer.from(
        `${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`
      ).toString('base64');

      const response = await fetch(recordingUrl, {
        method: 'GET',
        headers: {
          Authorization: `Basic ${twilioAuth}`,
          'User-Agent': 'AI-Call-Backend/1.0',
          Accept: 'audio/wav,audio/mpeg,audio/*',
        },
      });

      if (!response.ok) {
        // If still 404, try to wait a bit more and retry once
        if (response.status === 404) {
          logger.warn(`⏰ Recording not ready yet, waiting 3 more seconds...`);
          await new Promise((resolve) => setTimeout(resolve, 3000));

          const retryResponse = await fetch(recordingUrl, {
            method: 'GET',
            headers: {
              Authorization: `Basic ${twilioAuth}`,
              'User-Agent': 'AI-Call-Backend/1.0',
              Accept: 'audio/wav,audio/mpeg,audio/*',
            },
          });

          if (!retryResponse.ok) {
            throw new Error(
              `Failed to fetch recording after retry: ${retryResponse.status} ${retryResponse.statusText}`
            );
          }

          const audioBuffer = Buffer.from(await retryResponse.arrayBuffer());
          logger.info(
            `✅ Recording downloaded on retry: ${audioBuffer.length} bytes`
          );
          return await this.processAudioBuffer(
            callId,
            audioBuffer,
            recordingDuration
          );
        }

        throw new Error(
          `Failed to fetch recording: ${response.status} ${response.statusText}`
        );
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      logger.info(`✅ Recording downloaded: ${audioBuffer.length} bytes`);

      return await this.processAudioBuffer(
        callId,
        audioBuffer,
        recordingDuration
      );
    } catch (error) {
      logger.error(`❌ Recording processing failed for call ${callId}:`, error);

      // Fallback: try to continue conversation without transcription
      return this.handleRecordingError(callId, error);
    }
  }

  /**
   * Process audio buffer and generate AI response (с улучшенным логированием)
   */
  async processAudioBuffer(callId, audioBuffer, recordingDuration) {
    const callData = this.activeCalls.get(callId);

    try {
      // Ensure recordings directory exists
      const recordingsDir = './public/audio/recordings';
      await fs.mkdir(recordingsDir, { recursive: true });

      // Save audio for debugging with more info
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const audioPath = `${recordingsDir}/${callId}_${timestamp}.wav`;
      await fs.writeFile(audioPath, audioBuffer);

      logger.info(`🎵 Audio saved for debugging: ${audioPath}`, {
        callId,
        audioSize: `${(audioBuffer.length / 1024).toFixed(1)} KB`,
        duration: `${recordingDuration}s`,
        timestamp,
      });

      // Transcribe with AIServices (исправлено!)
      logger.info(`🎧 Starting transcription for call ${callId}...`);
      const transcriptionStart = Date.now();

      // Используем AIServices вместо openaiManager
      const transcriptionResult = await AIServices.transcribeAudio(audioBuffer);
      const transcription = transcriptionResult.text; // Извлекаем текст из результата

      const transcriptionTime = Date.now() - transcriptionStart;

      // 🔥 ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ ТРАНСКРИПЦИИ
      logger.info(`🎯 TRANSCRIPTION RESULT for call ${callId}:`, {
        text: transcription,
        audioSize: `${(audioBuffer.length / 1024).toFixed(1)} KB`,
        duration: `${recordingDuration}s`,
        transcriptionTime: `${transcriptionTime}ms`,
        charCount: transcription?.length || 0,
        wordCount: transcription?.split(' ').length || 0,
        timestamp: new Date().toISOString(),
      });

      // Дополнительный лог для консоли (хорошо видно)
      console.log('='.repeat(60));
      console.log(`🗣️  СОБЕСЕДНИК СКАЗАЛ (${callId}):`);
      console.log(`📝  "${transcription}"`);
      console.log(
        `⏱️  Длительность: ${recordingDuration}s | Размер: ${(audioBuffer.length / 1024).toFixed(1)} KB`
      );
      console.log(`🕐  ${new Date().toLocaleString('ru-RU')}`);
      console.log('='.repeat(60));

      if (!transcription || transcription.trim().length === 0) {
        logger.warn(`⚠️ Empty transcription for call ${callId}`, {
          audioSize: audioBuffer.length,
          duration: recordingDuration,
          audioPath,
        });
        return this.handleEmptyTranscription(callId);
      }

      // Проверка на подозрительную транскрипцию
      if (transcription.length < 3) {
        logger.warn(
          `⚠️ Very short transcription for call ${callId}: "${transcription}"`,
          {
            charCount: transcription.length,
            possibleIssue: 'Low audio quality or silence',
          }
        );
      }

      // Update call data with transcription
      callData.conversation.push({
        role: 'user',
        content: transcription,
        timestamp: new Date(),
        duration: recordingDuration,
        audioInfo: {
          size: audioBuffer.length,
          path: audioPath,
          transcriptionTime,
        },
      });

      // Classify user response and generate AI reply
      logger.info(
        `🔍 Classifying response for call ${callId}: "${transcription.substring(0, 50)}..."`
      );

      const classification =
        DebtCollectionScripts.classifyResponse(transcription);

      logger.info(`📊 Classification result for call ${callId}:`, {
        text: transcription,
        classification,
        confidence: 'high', // можно добавить confidence из classifier
      });

      // Generate simple AI response (вместо openaiManager)
      const aiResponse = {
        text: this.generateSimpleResponse(classification, transcription),
        nextStage: this.determineNextStage(classification),
      };

      // 🔥 ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ AI ОТВЕТА
      logger.info(`🤖 AI RESPONSE for call ${callId}:`, {
        userInput: transcription,
        classification,
        aiResponse: aiResponse.text,
        nextStage: aiResponse.nextStage,
        timestamp: new Date().toISOString(),
      });

      // Дополнительный лог для консоли AI ответа
      console.log('🤖 AI ОТВЕЧАЕТ:');
      console.log(`💬 "${aiResponse.text}"`);
      console.log(
        `🏷️  Классификация: ${classification} | Следующий этап: ${aiResponse.nextStage}`
      );
      console.log('-'.repeat(60));

      // Add AI response to conversation
      callData.conversation.push({
        role: 'assistant',
        content: aiResponse.text,
        timestamp: new Date(),
        classification: classification,
        nextStage: aiResponse.nextStage,
      });

      // Generate TTS for response
      if (aiResponse.text && aiResponse.nextStage !== 'completed') {
        logger.info(
          `🎤 Generating TTS for AI response: "${aiResponse.text.substring(0, 30)}..."`
        );
        await this.generateResponseTTS(callId, aiResponse.text, 'normal');
      }

      // Update database with detailed conversation log
      await Call.findOneAndUpdate(
        { call_id: callId },
        {
          $push: {
            conversation: {
              user_message: transcription,
              ai_response: aiResponse.text,
              classification: classification,
              timestamp: new Date(),
              metadata: {
                audio_size: audioBuffer.length,
                audio_duration: recordingDuration,
                transcription_time: transcriptionTime,
                audio_path: audioPath,
              },
            },
          },
          current_stage: aiResponse.nextStage || callData.session.currentStage,
          last_transcription: transcription,
          last_classification: classification,
        }
      );

      return {
        transcription,
        classification,
        response: aiResponse.text,
        nextStage: aiResponse.nextStage,
      };
    } catch (error) {
      logger.error(`❌ Audio processing failed for call ${callId}:`, {
        error: error.message,
        stack: error.stack,
        audioSize: audioBuffer?.length || 'unknown',
        duration: recordingDuration,
      });
      return this.handleRecordingError(callId, error);
    }
  }

  /**
   * Генерирует простой ответ на основе классификации
   */
  generateSimpleResponse(classification, userInput) {
    const responses = {
      positive: 'Отлично! Давайте обсудим детали погашения долга.',
      negative: 'Понимаю ваше положение. Давайте найдем компромиссное решение.',
      neutral:
        'Не могли бы вы уточнить свою позицию по погашению задолженности?',
      aggressive:
        'Прошу вас сохранять спокойствие. Мы можем решить этот вопрос мирно.',
      hang_up: 'Спасибо за разговор. До свидания.',
    };

    return (
      responses[classification] ||
      'Не могли бы вы повторить? Я не совсем понял.'
    );
  }

  /**
   * Определяет следующий этап разговора
   */
  determineNextStage(classification) {
    switch (classification) {
      case 'positive':
        return 'agreement';
      case 'hang_up':
        return 'completed';
      case 'aggressive':
        return 'de-escalation';
      default:
        return 'listening';
    }
  }

  /**
   * Handle recording processing errors gracefully
   */
  handleRecordingError(callId, error) {
    logger.warn(
      `⚠️ Using fallback response for call ${callId} due to error:`,
      error.message
    );

    // Return a generic continuation response
    const fallbackResponse =
      'Извините, я не расслышал. Не могли бы вы повторить?';

    // Generate TTS for fallback
    this.generateResponseTTS(callId, fallbackResponse, 'urgent');

    return {
      transcription: '[ERROR: Could not process audio]',
      classification: 'unclear',
      response: fallbackResponse,
      nextStage: 'listening',
      error: true,
    };
  }

  /**
   * Handle empty transcriptions
   */
  handleEmptyTranscription(callId) {
    logger.warn(
      `⚠️ Empty transcription for call ${callId}, prompting for repeat`
    );

    const promptResponse = 'Я вас не слышу. Говорите пожалуйста громче.';

    // Generate TTS for prompt
    this.generateResponseTTS(callId, promptResponse, 'urgent');

    return {
      transcription: '[EMPTY]',
      classification: 'silence',
      response: promptResponse,
      nextStage: 'listening',
    };
  }

  /**
   * End call and cleanup
   */
  async endCall(callId, result = 'completed') {
    const callData = this.activeCalls.get(callId);
    if (!callData) {
      logger.warn(`Attempt to end unknown call: ${callId}`);
      return;
    }

    const endTime = new Date();
    const duration = endTime.getTime() - callData.startTime.getTime();

    logger.info(
      `📞 Ending call: ${callId}, result: ${result}, duration: ${duration}ms`
    );

    try {
      // Save result to database
      await Promise.all([
        Client.findByIdAndUpdate(callData.clientId, {
          $push: {
            call_history: {
              date: endTime,
              result: result,
              duration: duration,
              notes: `Call ended: ${result}`,
            },
          },
          $inc: { call_attempts: 1 },
          last_call_date: endTime,
        }),
        Call.findOneAndUpdate(
          { call_id: callId },
          {
            status: 'completed',
            end_time: endTime,
            duration: duration,
            result: result,
          }
        ),
      ]);

      logger.info(`✅ Call data saved to database for ${callId}`);
    } catch (error) {
      logger.error(`❌ Error saving call end data for ${callId}:`, error);
    }

    // Cleanup memory
    this.activeCalls.delete(callId);
    this.pendingAudio.delete(callId);

    logger.info(`✅ Call cleanup completed: ${callId}`);
  }

  /**
   * Get active call data
   */
  getActiveCall(callId) {
    return this.activeCalls.get(callId);
  }

  /**
   * Get all active calls summary
   */
  getAllActiveCalls() {
    return Array.from(this.activeCalls.entries()).map(([callId, data]) => ({
      callId,
      clientId: data.clientId,
      phone: data.phone,
      status: data.status,
      currentStage: data.currentStage,
      startTime: data.startTime,
      duration: Date.now() - data.startTime.getTime(),
      hasAudio: this.pendingAudio.has(callId),
      twilioCallSid: data.twilioCallSid,
    }));
  }

  /**
   * Get call metrics and statistics
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
   * Force cleanup of stale calls (older than maxAgeMs)
   */
  async cleanupStaleCalls(maxAgeMs = 30 * 60 * 1000) {
    // 30 minutes default
    const now = Date.now();
    const staleCalls = [];

    for (const [callId, callData] of this.activeCalls.entries()) {
      const age = now - callData.startTime.getTime();
      if (age > maxAgeMs) {
        staleCalls.push(callId);
      }
    }

    for (const callId of staleCalls) {
      logger.warn(`🧹 Cleaning up stale call: ${callId}`);
      await this.endCall(callId, 'timeout');
    }

    if (staleCalls.length > 0) {
      logger.info(`🧹 Cleaned up ${staleCalls.length} stale calls`);
    }

    return staleCalls.length;
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

// Export singleton instance
export const outboundManager = new OutboundCallManager();
logger.info('✅ OutboundManager instance created and exported');
