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
  }

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

      this.activeCalls.set(callId, {
        session,
        clientId: client._id,
        phone: client.phone,
        startTime: new Date(),
        status: 'calling',
        currentStage: 'initial_greeting',
      });

      // Create database record
      await Call.create({
        call_id: callId,
        client_id: client._id,
        status: 'calling',
        start_time: new Date(),
      });

      // Generate greeting with high priority
      await this.generateGreeting(callId);

      // Make call via Twilio
      const call = await twilioClient.calls.create({
        to: client.phone,
        from: TWILIO_CONFIG.phoneNumber,
        url: `${TWILIO_CONFIG.serverUrl}/api/webhooks/twiml/${callId}`,
        statusCallback: `${TWILIO_CONFIG.serverUrl}/api/webhooks/status/${callId}`,
        statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
        timeout: 60,
        record: false,
      });

      // Update call data with Twilio SID
      const callData = this.activeCalls.get(callId);
      callData.twilioCallSid = call.sid;

      logger.info(`✅ Call initiated: ${callId} -> Twilio SID: ${call.sid}`);

      return {
        callId,
        twilioCallSid: call.sid,
        clientName: client.name,
        phone: client.phone,
        status: 'calling',
      };
    } catch (error) {
      logger.error('Failed to initiate call:', error);
      throw error;
    }
  }

  /**
   * Generate greeting audio with high priority
   */
  async generateGreeting(callId) {
    const callData = this.activeCalls.get(callId);
    if (!callData) return;

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
   * Handle TTS completion
   */
  async handleTTSCompleted(callId, audioData) {
    const callData = this.activeCalls.get(callId);
    if (!callData) {
      logger.warn(`TTS completed for unknown call: ${callId}`);
      return;
    }

    // Store audio data for webhook
    this.pendingAudio.set(callId, {
      ...audioData,
      timestamp: Date.now(),
      consumed: false,
    });

    logger.info(
      `TTS completed for call ${callId}, audio ready: ${audioData.source}`
    );

    // If this is a greeting and call is still in calling state, we're ready
    if (audioData.type === 'greeting' && callData.status === 'calling') {
      logger.info(`Greeting ready for call ${callId}`);
    }
  }

  /**
   * Generate TwiML response for webhook
   */
  async generateTwiMLResponse(callId, context = 'initial') {
    const callData = this.activeCalls.get(callId);
    if (!callData) {
      logger.warn(`TwiML requested for unknown call: ${callId}`);
      return this.generateErrorTwiML();
    }

    // Check for pending audio
    const audioData = this.pendingAudio.get(callId);

    if (audioData && !audioData.consumed) {
      // Mark as consumed
      audioData.consumed = true;
      this.pendingAudio.set(callId, audioData);

      logger.info(`Using ${audioData.source} audio for call ${callId}`);

      if (audioData.audioUrl) {
        // Use ElevenLabs or cached audio
        return this.generatePlayTwiML(callId, audioData.audioUrl);
      } else if (audioData.twilioTTS) {
        // Use Twilio TTS fallback
        return this.generateSayTwiML(callId, audioData.text, audioData.voiceId);
      }
    }

    // Fallback: generate basic TwiML while waiting for audio
    if (context === 'initial') {
      // First call - might be waiting for greeting
      const script = DebtCollectionScripts.getScript(
        'start',
        'positive',
        callData.session.clientData
      );

      return this.generateSayTwiML(callId, script.text, 'alice');
    }

    // Default fallback
    return this.generateSayTwiML(callId, 'Пожалуйста, подождите...', 'alice');
  }

  /**
   * Generate TwiML with Play tag (for ElevenLabs/cached audio)
   */
  generatePlayTwiML(callId, audioUrl) {
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
  generateSayTwiML(callId, text, voice = 'alice') {
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
    return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say voice="alice" language="ru-RU">Извините, произошла техническая ошибка. До свидания.</Say>
    <Hangup/>
</Response>`;
  }

  /**
   * Generate response TTS for conversation
   */
  async generateResponseTTS(callId, responseText, priority = 'normal') {
    const callData = this.activeCalls.get(callId);
    if (!callData) return;

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
   * Handle call answered
   */
  async handleCallAnswered(callId) {
    const callData = this.activeCalls.get(callId);
    if (!callData) {
      throw new Error(`Call data not found: ${callId}`);
    }

    // Update status
    callData.status = 'answered';

    // Update database
    await Call.findOneAndUpdate(
      { call_id: callId },
      { status: 'answered', answer_time: new Date() }
    );

    logger.info(`📞 Call answered: ${callId}`);

    // Check if greeting is ready
    const audioData = this.pendingAudio.get(callId);
    if (audioData) {
      logger.info(`Greeting audio ready for call ${callId}`);
      return { ready: true, audioType: audioData.source };
    }

    // Fallback script
    const script = DebtCollectionScripts.getScript(
      'start',
      'positive',
      callData.session.clientData
    );

    return { ready: false, script: script.text };
  }

  /**
   * Process recording and generate response
   */
  async processRecording(callId, recordingUrl, recordingDuration) {
    const callData = this.activeCalls.get(callId);
    if (!callData) {
      throw new Error(`Call data not found: ${callId}`);
    }

    logger.info(`Processing recording for call ${callId}: ${recordingUrl}`);

    try {
      // Download and process audio
      const response = await fetch(recordingUrl);
      const audioBuffer = Buffer.from(await response.arrayBuffer());

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

      // If conversation should continue, generate response TTS
      if (result.response && result.nextStage !== 'completed') {
        await this.generateResponseTTS(callId, result.response, 'normal');
      }

      return result;
    } catch (error) {
      logger.error(`Failed to process recording for call ${callId}:`, error);
      throw error;
    }
  }

  /**
   * End call
   */
  async endCall(callId, result = 'completed') {
    const callData = this.activeCalls.get(callId);
    if (!callData) return;

    const endTime = new Date();
    const duration = endTime.getTime() - callData.startTime.getTime();

    logger.info(
      `📞 Ending call: ${callId}, result: ${result}, duration: ${duration}ms`
    );

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

    // Cleanup
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
   * Get all active calls
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
    }));
  }

  /**
   * Get call metrics
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
   * Force cleanup of stale calls
   */
  async cleanupStaleCalls(maxAgeMs = 30 * 60 * 1000) {
    // 30 minutes
    const now = Date.now();
    const staleCalls = [];

    for (const [callId, callData] of this.activeCalls.entries()) {
      const age = now - callData.startTime.getTime();
      if (age > maxAgeMs) {
        staleCalls.push(callId);
      }
    }

    for (const callId of staleCalls) {
      logger.warn(`Cleaning up stale call: ${callId}`);
      await this.endCall(callId, 'timeout');
    }

    if (staleCalls.length > 0) {
      logger.info(`Cleaned up ${staleCalls.length} stale calls`);
    }

    return staleCalls.length;
  }
}

export const outboundManager = new OutboundCallManager();
