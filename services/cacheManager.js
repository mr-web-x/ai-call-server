import crypto from 'crypto';
import { logger } from '../utils/logger.js';
import { audioManager } from './audioManager.js';

export class CacheManager {
  constructor() {
    // Predefined phrases for caching
    this.CACHEABLE_PHRASES = {
      greeting: [
        'Добрый день! Меня зовут Анна, я представляю компанию Финанс-Групп.',
        'Здравствуйте! Это Анна из компании Финанс-Групп.',
        'Добро пожаловать! Меня зовут Анна, звоню от компании Финанс-Групп.',
      ],
      farewell: [
        'Спасибо за сотрудничество. До свидания!',
        'Благодарю за понимание. Всего доброго!',
        'До свидания! Хорошего дня!',
        'Спасибо за разговор. До встречи!',
      ],
    };

    // Memory cache for quick access
    this.memoryCache = new Map();
    this.initializeCache();
  }

  /**
   * Generate cache key from text and voice
   */
  generateCacheKey(text, voiceId = 'default') {
    const content = `${text}-${voiceId}`;
    return crypto.createHash('md5').update(content).digest('hex');
  }

  /**
   * Check if phrase should be cached
   */
  shouldCache(text) {
    const normalizedText = text.trim().toLowerCase();

    // Check greeting phrases
    for (const phrase of this.CACHEABLE_PHRASES.greeting) {
      if (normalizedText.includes(phrase.toLowerCase().substring(0, 20))) {
        return 'greeting';
      }
    }

    // Check farewell phrases
    for (const phrase of this.CACHEABLE_PHRASES.farewell) {
      if (normalizedText.includes(phrase.toLowerCase().substring(0, 15))) {
        return 'farewell';
      }
    }

    return null;
  }

  /**
   * Get cached audio URL
   */
  async getCachedAudio(text, voiceId = 'default') {
    const cacheKey = this.generateCacheKey(text, voiceId);

    // Check memory cache first
    if (this.memoryCache.has(cacheKey)) {
      logger.info(`Memory cache HIT for: ${text.substring(0, 50)}...`);
      return this.memoryCache.get(cacheKey);
    }

    // Check file cache
    const audioUrl = await audioManager.getCachedAudioUrl(cacheKey);
    if (audioUrl) {
      // Store in memory cache for next time
      this.memoryCache.set(cacheKey, audioUrl);
      return audioUrl;
    }

    return null;
  }

  /**
   * Store audio in cache
   */
  async setCachedAudio(text, audioBuffer, voiceId = 'default') {
    const cacheKey = this.generateCacheKey(text, voiceId);
    const phraseType = this.shouldCache(text);

    if (!phraseType) {
      logger.warn(
        `Attempted to cache non-cacheable phrase: ${text.substring(0, 50)}...`
      );
      return null;
    }

    try {
      const result = await audioManager.saveCachedAudio(cacheKey, audioBuffer);

      // Store in memory cache
      this.memoryCache.set(cacheKey, result.publicUrl);

      logger.info(`Cached ${phraseType} phrase: ${text.substring(0, 50)}...`);
      return result.publicUrl;
    } catch (error) {
      logger.error('Failed to cache audio:', error);
      return null;
    }
  }

  /**
   * Preload common phrases into cache
   */
  async preloadCache(ttsFunction) {
    logger.info('Starting cache preload...');

    const allPhrases = [
      ...this.CACHEABLE_PHRASES.greeting,
      ...this.CACHEABLE_PHRASES.farewell,
    ];

    let preloadedCount = 0;

    for (const phrase of allPhrases) {
      try {
        // Check if already cached
        const existing = await this.getCachedAudio(phrase);
        if (existing) {
          logger.info(`Phrase already cached: ${phrase.substring(0, 30)}...`);
          continue;
        }

        // Generate and cache
        logger.info(`Preloading phrase: ${phrase.substring(0, 30)}...`);
        const audioBuffer = await ttsFunction(phrase);

        if (audioBuffer) {
          await this.setCachedAudio(phrase, audioBuffer);
          preloadedCount++;

          // Small delay to avoid rate limiting
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      } catch (error) {
        logger.error(
          `Failed to preload phrase: ${phrase.substring(0, 30)}...`,
          error
        );
      }
    }

    logger.info(`Cache preload completed: ${preloadedCount} phrases cached`);
  }

  /**
   * Get cache statistics
   */
  async getCacheStats() {
    const storageStats = await audioManager.getStorageStats();

    return {
      memoryCache: {
        size: this.memoryCache.size,
        phrases: Array.from(this.memoryCache.keys()),
      },
      fileCache: {
        files: storageStats.cachedFiles,
      },
      cacheablePhrases: {
        greeting: this.CACHEABLE_PHRASES.greeting.length,
        farewell: this.CACHEABLE_PHRASES.farewell.length,
        total:
          this.CACHEABLE_PHRASES.greeting.length +
          this.CACHEABLE_PHRASES.farewell.length,
      },
    };
  }

  /**
   * Clear memory cache
   */
  clearMemoryCache() {
    const size = this.memoryCache.size;
    this.memoryCache.clear();
    logger.info(`Memory cache cleared: ${size} entries removed`);
  }

  /**
   * Initialize cache on startup
   */
  async initializeCache() {
    logger.info('Cache manager initialized');

    // Get initial stats
    const stats = await this.getCacheStats();
    logger.info(
      `Cache status - Memory: ${stats.memoryCache.size}, Files: ${stats.fileCache.files}`
    );
  }
}

export const cacheManager = new CacheManager();
