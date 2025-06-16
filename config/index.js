import dotenv from 'dotenv';
dotenv.config();

export const CONFIG = {
  PORT: process.env.PORT || 3000,
  MONGODB_URL:
    process.env.MONGODB_URL || 'mongodb://localhost:27017/debt_collection',
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',
  OPENAI_API_KEY: process.env.OPENAI_API_KEY,
  ELEVENLABS_API_KEY: process.env.ELEVENLABS_API_KEY,
  VAD_THRESHOLD: 0.5,
  SILENCE_TIMEOUT: 1500,
  TTS_VOICE_ID: 'pNInz6obpgDQGcFmaJgB',
};
