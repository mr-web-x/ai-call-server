import { OpenAI } from "openai";
import axios from "axios";
import { CONFIG } from "../config/index.js";
import { logger } from "../utils/logger.js";

const openai = new OpenAI({ apiKey: CONFIG.OPENAI_API_KEY });

export class AIServices {
  // Speech-to-Text
  static async transcribeAudio(audioBuffer) {
    try {
      const response = await openai.audio.transcriptions.create({
        file: audioBuffer,
        model: "whisper-1",
        language: "ru",
        response_format: "json",
      });

      return {
        text: response.text,
        confidence: 0.95,
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error("STT Error:", error);
      throw new Error(`Speech recognition failed: ${error.message}`);
    }
  }

  // LLM Classification
  static async classifyResponse(text, currentStage, conversationHistory = []) {
    try {
      const prompt = `
Анализируй ответ должника в диалоге коллектора.

Текущий этап: ${currentStage}
Ответ должника: "${text}"
История разговора: ${conversationHistory.slice(-3).join(" | ") || "начало"}

Классифицируй ответ как один из:
- positive: согласие, готовность, "да", "хорошо", "договорились"
- negative: отказ, "нет", "не буду", "не могу"
- neutral: неопределенность, вопросы, "не знаю", "подумаю"
- aggressive: агрессия, мат, угрозы, повышение тона
- hang_up: "до свидания", "кладу трубку", завершение

Отвечай только одним словом из списка выше.
            `;

      const response = await openai.chat.completions.create({
        model: "gpt-3.5-turbo",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 10,
        temperature: 0.1,
      });

      const classification = response.choices[0].message.content
        .trim()
        .toLowerCase();

      return {
        classification,
        confidence: 0.9,
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error("LLM Classification Error:", error);
      // Fallback to simple keyword classification
      return {
        classification: this.simpleClassify(text),
        confidence: 0.6,
        timestamp: Date.now(),
      };
    }
  }

  // Simple keyword-based classification fallback
  static simpleClassify(text) {
    const lowerText = text.toLowerCase();

    // Aggressive keywords
    if (/блять|сука|пиздец|нахуй|отъебись/.test(lowerText)) {
      return "aggressive";
    }

    // Positive keywords
    if (/да|хорошо|согласен|договорились|заплачу|оплачу/.test(lowerText)) {
      return "positive";
    }

    // Negative keywords
    if (/нет|не буду|не могу|отказываюсь|денег нет/.test(lowerText)) {
      return "negative";
    }

    // Hang up keywords
    if (/до свидания|всего|кладу|отключаюсь/.test(lowerText)) {
      return "hang_up";
    }

    return "neutral";
  }

  // Text-to-Speech
  static async synthesizeSpeech(text, priority = "normal") {
    try {
      const response = await axios.post(
        `https://api.elevenlabs.io/v1/text-to-speech/${CONFIG.TTS_VOICE_ID}`,
        {
          text: text,
          model_id: "eleven_multilingual_v2",
          voice_settings: {
            stability: 0.5,
            similarity_boost: 0.5,
            style: 0.0,
            use_speaker_boost: true,
          },
        },
        {
          headers: {
            Accept: "audio/mpeg",
            "Content-Type": "application/json",
            "xi-api-key": CONFIG.ELEVENLABS_API_KEY,
          },
          responseType: "arraybuffer",
          timeout: 30000,
        }
      );

      return {
        audioBuffer: Buffer.from(response.data),
        text: text,
        timestamp: Date.now(),
      };
    } catch (error) {
      logger.error("TTS Error:", error);
      throw new Error(`Speech synthesis failed: ${error.message}`);
    }
  }
}
