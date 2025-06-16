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
  // === GPT RESPONSE GENERATION ===
  GPT_MODEL_RESPONSE: process.env.GPT_MODEL_RESPONSE || 'gpt-3.5-turbo',
  GPT_MAX_RESPONSE_TOKENS: parseInt(process.env.GPT_MAX_RESPONSE_TOKENS) || 80,
  GPT_TEMPERATURE_RESPONSE:
    parseFloat(process.env.GPT_TEMPERATURE_RESPONSE) || 0.7,
  GPT_TIMEOUT_RESPONSE: parseInt(process.env.GPT_TIMEOUT_RESPONSE) || 15000,

  // === RESPONSE VALIDATION ===
  MAX_RESPONSE_LENGTH: parseInt(process.env.MAX_RESPONSE_LENGTH) || 280,
  MIN_RESPONSE_LENGTH: parseInt(process.env.MIN_RESPONSE_LENGTH) || 10,

  // === CACHING SETTINGS ===
  CACHE_SIMILAR_RESPONSES: process.env.CACHE_SIMILAR_RESPONSES === 'true',
  RESPONSE_CACHE_TTL: parseInt(process.env.RESPONSE_CACHE_TTL) || 86400000, // 24 hours
  MAX_CACHE_SIZE: parseInt(process.env.MAX_CACHE_SIZE) || 100,

  // === RESPONSE METHOD SELECTION ===
  GPT_REPEAT_THRESHOLD: parseInt(process.env.GPT_REPEAT_THRESHOLD) || 2, // После скольких повторений использовать GPT
  ENABLE_GPT_RESPONSES: process.env.ENABLE_GPT_RESPONSES !== 'false', // По умолчанию включено
  FALLBACK_TO_SCRIPTS: process.env.FALLBACK_TO_SCRIPTS !== 'false', // Фолбэк на скрипты

  // === SAFETY AND MONITORING ===
  LOG_GPT_RESPONSES: process.env.LOG_GPT_RESPONSES !== 'false', // Логировать все GPT ответы
  VALIDATE_RESPONSES: process.env.VALIDATE_RESPONSES !== 'false', // Валидировать ответы

  // === PERFORMANCE ===
  PARALLEL_GPT_PROCESSING: process.env.PARALLEL_GPT_PROCESSING === 'true',
  GPT_RETRY_ATTEMPTS: parseInt(process.env.GPT_RETRY_ATTEMPTS) || 2,

  // === A/B TESTING (для будущего) ===
  AB_TEST_GPT_RATIO: parseFloat(process.env.AB_TEST_GPT_RATIO) || 0.5, // 50% GPT, 50% скрипты
  ENABLE_AB_TESTING: process.env.ENABLE_AB_TESTING === 'true',

  // === EMERGENCY SETTINGS ===
  EMERGENCY_FALLBACK_ENABLED:
    process.env.EMERGENCY_FALLBACK_ENABLED !== 'false',
  MAX_GPT_FAILURES_BEFORE_FALLBACK:
    parseInt(process.env.MAX_GPT_FAILURES_BEFORE_FALLBACK) || 3,
};
