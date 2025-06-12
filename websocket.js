import { WebSocketServer } from "ws";
import { logger } from "./utils/logger.js";
import { outboundManager } from "./services/outboundManager.js";
import { ttsQueue } from "./queues/setup.js";

export const setupWebSocket = (server) => {
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws, req) => {
    const callId = req.url?.split("/").pop();
    const callData = outboundManager.getActiveCall(callId);

    if (!callData) {
      logger.warn(`WebSocket connection rejected - call not found: ${callId}`);
      ws.close(1000, "Call session not found");
      return;
    }

    logger.info(`WebSocket connected for call: ${callId}`);

    ws.on("message", async (data) => {
      try {
        const message = JSON.parse(data.toString());

        switch (message.type) {
          case "audio_chunk":
            const audioBuffer = Buffer.from(message.data, "base64");

            // Use VAD to detect complete phrases
            callData.session.vad.processChunk(
              audioBuffer,
              async (completeAudio) => {
                try {
                  const result = await callData.session.processAudioChunk(
                    completeAudio
                  );

                  // Send processing result
                  ws.send(
                    JSON.stringify({
                      type: "processing_result",
                      callId,
                      ...result,
                    })
                  );
                } catch (error) {
                  logger.error("Audio processing error:", error);
                  ws.send(
                    JSON.stringify({
                      type: "error",
                      message: error.message,
                    })
                  );
                }
              }
            );
            break;

          case "get_tts_audio":
            const job = await ttsQueue.getJob(message.jobId);
            if (job && job.finishedOn) {
              const result = job.returnvalue;
              ws.send(
                JSON.stringify({
                  type: "tts_audio",
                  audioData: result.audioBuffer.toString("base64"),
                  text: result.text,
                  callId,
                })
              );
            } else {
              ws.send(
                JSON.stringify({
                  type: "tts_pending",
                  jobId: message.jobId,
                  callId,
                })
              );
            }
            break;

          case "ping":
            ws.send(
              JSON.stringify({
                type: "pong",
                timestamp: Date.now(),
              })
            );
            break;

          default:
            logger.warn(`Unknown WebSocket message type: ${message.type}`);
        }
      } catch (error) {
        logger.error("WebSocket message error:", error);
        ws.send(
          JSON.stringify({
            type: "error",
            message: "Invalid message format",
          })
        );
      }
    });

    ws.on("close", (code, reason) => {
      logger.info(
        `WebSocket disconnected for call: ${callId}, code: ${code}, reason: ${reason}`
      );
    });

    ws.on("error", (error) => {
      logger.error(`WebSocket error for call: ${callId}`, error);
    });

    // Send initial connection confirmation
    ws.send(
      JSON.stringify({
        type: "connected",
        callId,
        timestamp: Date.now(),
      })
    );
  });

  logger.info("WebSocket server initialized");
  return wss;
};
