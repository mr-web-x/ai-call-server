import { v4 as uuidv4 } from 'uuid';
import mongoose from 'mongoose';
import { twilioClient, TWILIO_CONFIG } from '../config/twilio.js';
import { Client } from '../models/Client.js';
import { Call } from '../models/Call.js';
import { CallSession } from './callSession.js';
import { DebtCollectionScripts } from '../scripts/debtCollection.js';
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
      });

      // Create database record
      const callRecord = new Call({
        call_id: callId,
        client_id: client._id,
        status: 'initiated',
        start_time: new Date(),
      });

      await callRecord.save();
      logger.info(
        `✅ Call record created in DB: ${callId} for client: ${client._id}`
      );

      // Generate greeting BEFORE making the Twilio call
      await this.generateGreeting(callId);

      // Prepare Twilio call configuration
      const baseUrl = TWILIO_CONFIG.serverUrl.replace(/\/$/, '');
      logger.info(`🔧 Using base URL: ${baseUrl}`);

      // ИСПРАВЛЕННЫЙ Twilio call с правильными statusCallbackEvent
      const call = await twilioClient.calls.create({
        to: client.phone,
        from: TWILIO_CONFIG.phoneNumber,
        // URL берется из настроек номера в Twilio Console
        // НО мы все равно передаем для fallback
        url: `${baseUrl}/api/webhooks/twiml`,
        method: 'POST',
        // Status callback для отслеживания статуса
        statusCallback: `${baseUrl}/api/webhooks/status/${callId}`,
        statusCallbackMethod: 'POST',
        // ИСПРАВЛЕНИЕ: только поддерживаемые события
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        // Увеличиваем timeout до 60 секунд
        timeout: 60,
        // Отключаем автоматическую запись на уровне звонка
        record: false,
        // Fallback URL на случай ошибок
        fallbackUrl: `${baseUrl}/api/webhooks/twiml`,
        fallbackMethod: 'POST',
      });

      // Update call data with Twilio SID
      const callData = this.activeCalls.get(callId);
      callData.twilioCallSid = call.sid;

      // Update database record with Twilio SID
      await Call.findOneAndUpdate(
        { call_id: callId },
        {
          twilio_call_sid: call.sid,
          status: 'calling',
        }
      );

      logger.info(`✅ Call initiated: ${callId} -> Twilio SID: ${call.sid}`);
      logger.info(`📞 TwiML URL will be handled by Console settings`);

      return {
        callId,
        twilioCallSid: call.sid,
        clientName: client.name,
        phone: client.phone,
        status: 'calling',
        twimlUrl: `${baseUrl}/api/webhooks/twiml`,
      };
    } catch (error) {
      logger.error('❌ Failed to initiate call:', error);
      throw error;
    }
  }

  /**
   * Generate greeting audio with high priority
   */
  async generateGreeting(callId) {
    const callData = this.activeCalls.get(callId);
    if (!callData) {
      logger.warn(
        `Cannot generate greeting: call data not found for ${callId}`
      );
      return;
    }

    // Get greeting script
    const script = DebtCollectionScripts.getScript(
      'start',
      'positive',
      callData.session.clientData
    );

    logger.info(
      `Generating greeting for call ${callId}: ${script.text.substring(0, 50)}...`
    );

    // Add high priority TTS job
    const ttsJob = await ttsQueue.add(
      'synthesize',
      {
        text: script.text,
        callId: callId,
        priority: 'urgent',
        type: 'greeting',
        useCache: true,
      },
      {
        priority: 1, // Highest priority
        attempts: 3,
      }
    );

    // Store job reference
    callData.greetingJobId = ttsJob.id;

    return { ttsJobId: ttsJob.id, script: script.text };
  }

  /**
   * Handle TTS completion notification from queue processor
   */
  async handleTTSCompleted(callId, audioData) {
    const callData = this.activeCalls.get(callId);
    if (!callData) {
      logger.warn(`TTS completed for unknown call: ${callId}`);
      return;
    }

    // ДЕТАЛЬНОЕ ЛОГИРОВАНИЕ
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
    if (audioData.type === 'greeting' && callData.status === 'calling') {
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

    // Check for ready audio
    const audioData = this.pendingAudio.get(callId);

    if (audioData && !audioData.consumed) {
      logger.info(`🎵 Using ready audio for call: ${callId}`);

      // Mark as consumed to prevent reuse
      audioData.consumed = true;
      this.pendingAudio.set(callId, audioData);

      if (audioData.audioUrl) {
        // Use ElevenLabs audio
        logger.info(`🎵 Sending ElevenLabs PLAY TwiML for call: ${callId}`);
        logger.info(`🎵 Audio URL: ${audioData.audioUrl}`);
        return this.generatePlayTwiML(callId, audioData.audioUrl);
      } else if (audioData.twilioTTS) {
        // Use Twilio TTS as fallback
        logger.warn(`🔊 Using Twilio SAY TwiML fallback for call: ${callId}`);
        return this.generateSayTwiML(callId, audioData.text, audioData.voiceId);
      }
    }

    // If TTS is still processing, redirect with pause
    if (this.checkTTSInProgress(callId)) {
      logger.info(`⏳ TTS in progress for call: ${callId}, redirecting...`);
      return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Pause length="2"/>
    <Redirect method="POST">${process.env.SERVER_URL}/api/webhooks/twiml</Redirect>
</Response>`;
    }

    // Fallback: generate simple greeting using Twilio TTS
    logger.warn(
      `🔄 No ready audio for call: ${callId}, using fallback greeting`
    );
    const script = DebtCollectionScripts.getScript(
      'start',
      'positive',
      callData.session.clientData || {}
    );

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
      // Download and process audio with Twilio auth
      const response = await fetch(recordingUrl, {
        headers: {
          Authorization: `Basic ${Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
        },
      });

      if (!response.ok) {
        throw new Error(
          `Failed to fetch recording: ${response.status} ${response.statusText}`
        );
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());
      logger.info(`✅ Recording downloaded: ${audioBuffer.length} bytes`);

      // Process through AI pipeline
      const result = await callData.session.processAudioChunk(audioBuffer);

      // Save recording to database
      await Call.findOneAndUpdate(
        { call_id: callId },
        {
          $push: {
            recordings: {
              url: recordingUrl,
              duration: parseInt(recordingDuration) || 0,
              transcription: result.transcription,
              classification: result.classification,
            },
          },
        }
      );

      logger.info(
        `✅ Recording processed for call ${callId}: ${result.classification}`
      );

      // If conversation should continue, generate response TTS
      if (result.response && result.nextStage !== 'completed') {
        await this.generateResponseTTS(callId, result.response, 'normal');
      }

      return result;
    } catch (error) {
      logger.error(`❌ Failed to process recording for call ${callId}:`, error);

      // Return graceful error response
      return {
        transcription: '',
        classification: 'error',
        response: 'Извините, произошла ошибка при обработке. До свидания.',
        nextStage: 'completed',
        error: error.message,
      };
    }
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
