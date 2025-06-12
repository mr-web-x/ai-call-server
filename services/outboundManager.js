import { v4 as uuidv4 } from "uuid";
import mongoose from "mongoose";
import { twilioClient, TWILIO_CONFIG } from "../config/twilio.js";
import { Client } from "../models/Client.js";
import { Call } from "../models/Call.js";
import { CallSession } from "./callSession.js";
import { DebtCollectionScripts } from "../scripts/debtCollection.js";
import { ttsQueue } from "../queues/setup.js";
import { logger } from "../utils/logger.js";

export class OutboundCallManager {
  constructor() {
    this.activeCalls = new Map();
    this.callQueue = [];
  }

  async initiateCall(clientId) {
    try {
      // Validate ObjectId
      if (!mongoose.Types.ObjectId.isValid(clientId)) {
        throw new Error("Invalid client ID");
      }

      // Get client from MongoDB
      const client = await Client.findById(clientId);
      if (!client) {
        throw new Error("Client not found");
      }

      logger.info(`📞 Initiating call to ${client.name} (${client.phone})`);

      // Create call session
      const callId = uuidv4();
      const session = new CallSession(callId, {
        name: client.name,
        amount: client.debt_amount,
        contract: client.contract_number,
        company: "Финанс-Групп",
      });

      this.activeCalls.set(callId, {
        session,
        clientId: client._id,
        phone: client.phone,
        startTime: new Date(),
        status: "calling",
      });

      // Make call via Twilio
      const call = await twilioClient.calls.create({
        to: client.phone,
        from: TWILIO_CONFIG.phoneNumber,
        url: `${TWILIO_CONFIG.serverUrl}/api/twilio/twiml/${callId}`,
        statusCallback: `${TWILIO_CONFIG.serverUrl}/api/twilio/status/${callId}`,
        statusCallbackEvent: ["initiated", "answered", "completed"],
        record: TWILIO_CONFIG.recordCalls,
        timeout: TWILIO_CONFIG.timeout,
      });

      // Update client in database
      await Client.findByIdAndUpdate(clientId, {
        $inc: { call_attempts: 1 },
        last_call_date: new Date(),
        $push: {
          call_history: {
            date: new Date(),
            result: "initiated",
            notes: `Call SID: ${call.sid}`,
          },
        },
      });

      // Create call record
      await Call.create({
        call_id: callId,
        client_id: clientId,
        twilio_call_sid: call.sid,
        status: "initiated",
      });

      return {
        callId,
        twilioCallSid: call.sid,
        status: "initiated",
        clientName: client.name,
        phone: client.phone,
      };
    } catch (error) {
      logger.error("Call initiation error:", error);
      throw error;
    }
  }

  async handleCallAnswered(callId) {
    const callData = this.activeCalls.get(callId);
    if (!callData) return;

    callData.status = "answered";
    logger.info(`✅ Call answered: ${callId}`);

    // Update call status in database
    await Call.findOneAndUpdate({ call_id: callId }, { status: "answered" });

    // Start AI dialogue with greeting
    const script = DebtCollectionScripts.getScript(
      "start",
      "positive",
      callData.session.clientData
    );

    // Generate first phrase
    const ttsJob = await ttsQueue.add(
      "synthesize",
      {
        text: script.text,
        callId: callId,
        priority: "urgent",
      },
      { priority: 1 }
    );

    return { ttsJobId: ttsJob.id, script: script.text };
  }

  async endCall(callId, result = "completed") {
    const callData = this.activeCalls.get(callId);
    if (!callData) return;

    const endTime = new Date();
    const duration = endTime.getTime() - callData.startTime.getTime();

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
          status: "completed",
          end_time: endTime,
          duration: duration,
        }
      ),
    ]);

    this.activeCalls.delete(callId);
    logger.info(
      `📞 Call ended: ${callId}, result: ${result}, duration: ${duration}ms`
    );
  }

  getActiveCall(callId) {
    return this.activeCalls.get(callId);
  }

  getAllActiveCalls() {
    return Array.from(this.activeCalls.entries()).map(([callId, data]) => ({
      callId,
      clientId: data.clientId,
      phone: data.phone,
      status: data.status,
      startTime: data.startTime,
      duration: Date.now() - data.startTime.getTime(),
    }));
  }
}

export const outboundManager = new OutboundCallManager();
