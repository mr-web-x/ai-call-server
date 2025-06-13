import fs from 'fs/promises';
import path from 'path';
import { logger } from '../utils/logger.js';

export class AudioManager {
  constructor() {
    this.audioDir = './public/audio';
    this.cacheDir = './public/audio/cache';
    this.ensureDirectories();
  }

  async ensureDirectories() {
    try {
      await fs.mkdir(this.audioDir, { recursive: true });
      await fs.mkdir(this.cacheDir, { recursive: true });
      logger.info('Audio directories created successfully');
    } catch (error) {
      logger.error('Failed to create audio directories:', error);
    }
  }

  /**
   * Save audio file for specific call
   */
  async saveAudioFile(callId, audioBuffer, type = 'response') {
    const filename = `${callId}-${type}-${Date.now()}.mp3`;
    const filepath = path.join(this.audioDir, filename);

    await fs.writeFile(filepath, audioBuffer);

    const publicUrl = `${process.env.SERVER_URL}/audio/${filename}`;

    logger.info(`Audio saved for call ${callId} (${type}): ${publicUrl}`);

    return {
      filepath,
      publicUrl,
      filename,
      type,
    };
  }

  /**
   * Save cached audio file (for reusable phrases)
   */
  async saveCachedAudio(cacheKey, audioBuffer) {
    const filename = `${cacheKey}.mp3`;
    const filepath = path.join(this.cacheDir, filename);

    await fs.writeFile(filepath, audioBuffer);

    const publicUrl = `${process.env.SERVER_URL}/audio/cache/${filename}`;

    logger.info(`Cached audio saved: ${cacheKey} -> ${publicUrl}`);

    return {
      filepath,
      publicUrl,
      filename,
      cacheKey,
    };
  }

  /**
   * Get cached audio URL if exists
   */
  async getCachedAudioUrl(cacheKey) {
    const filename = `${cacheKey}.mp3`;
    const filepath = path.join(this.cacheDir, filename);

    try {
      await fs.access(filepath);
      const publicUrl = `${process.env.SERVER_URL}/audio/cache/${filename}`;
      logger.info(`Cache HIT for: ${cacheKey}`);
      return publicUrl;
    } catch (error) {
      logger.info(`Cache MISS for: ${cacheKey}`);
      return null;
    }
  }

  /**
   * Cleanup old temporary audio files (not cache)
   */
  async cleanupOldFiles(maxAgeMs = 24 * 60 * 60 * 1000) {
    try {
      const files = await fs.readdir(this.audioDir);
      const now = Date.now();
      let cleanedCount = 0;

      for (const file of files) {
        // Skip cache directory
        if (file === 'cache') continue;

        const filepath = path.join(this.audioDir, file);
        const stats = await fs.stat(filepath);

        if (now - stats.mtime.getTime() > maxAgeMs) {
          await fs.unlink(filepath);
          cleanedCount++;
          logger.info(`Cleaned up old audio file: ${file}`);
        }
      }

      if (cleanedCount > 0) {
        logger.info(`Cleanup completed: ${cleanedCount} files removed`);
      }
    } catch (error) {
      logger.error('Failed to cleanup audio files:', error);
    }
  }

  /**
   * Get storage statistics
   */
  async getStorageStats() {
    try {
      const [audioFiles, cacheFiles] = await Promise.all([
        fs.readdir(this.audioDir),
        fs.readdir(this.cacheDir),
      ]);

      // Filter out cache directory from audio files count
      const tempFiles = audioFiles.filter((file) => file !== 'cache');

      return {
        temporaryFiles: tempFiles.length,
        cachedFiles: cacheFiles.length,
        totalFiles: tempFiles.length + cacheFiles.length,
      };
    } catch (error) {
      logger.error('Failed to get storage stats:', error);
      return { temporaryFiles: 0, cachedFiles: 0, totalFiles: 0 };
    }
  }
}

export const audioManager = new AudioManager();
