// Добавь этот класс в новый файл utils/conversationLogger.js

import fs from 'fs/promises';
import path from 'path';

export class ConversationLogger {
  constructor() {
    this.conversationDir = './logs/conversations';
    this.ensureConversationDir();
  }

  async ensureConversationDir() {
    try {
      await fs.mkdir(this.conversationDir, { recursive: true });
    } catch (error) {
      console.error('Failed to create conversation logs directory:', error);
    }
  }

  /**
   * Логирует отдельную реплику в разговоре
   */
  async logConversationTurn(callId, speaker, text, metadata = {}) {
    const timestamp = new Date();
    const logEntry = {
      callId,
      speaker, // 'USER' или 'AI'
      text,
      timestamp: timestamp.toISOString(),
      localTime: timestamp.toLocaleString('ru-RU'),
      metadata,
    };

    // Красивый вывод в консоль
    const speakerIcon = speaker === 'USER' ? '🗣️👤' : '🤖💬';
    const speakerLabel = speaker === 'USER' ? 'ПОЛЬЗОВАТЕЛЬ' : 'AI АССИСТЕНТ';

    console.log('\n' + '='.repeat(80));
    console.log(`${speakerIcon} ${speakerLabel} (${callId})`);
    console.log(`🕐 ${timestamp.toLocaleString('ru-RU')}`);
    console.log(`💬 "${text}"`);

    if (metadata.classification) {
      console.log(`🏷️  Классификация: ${metadata.classification}`);
    }

    if (metadata.duration) {
      console.log(`⏱️  Длительность аудио: ${metadata.duration}s`);
    }

    if (metadata.audioSize) {
      console.log(
        `📁 Размер аудио: ${(metadata.audioSize / 1024).toFixed(1)} KB`
      );
    }

    console.log('='.repeat(80));

    // Сохранение в файл
    await this.saveToFile(callId, logEntry);
  }

  /**
   * Сохраняет лог в файл для конкретного звонка
   */
  async saveToFile(callId, logEntry) {
    try {
      const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const filename = `${date}_${callId}.jsonl`;
      const filepath = path.join(this.conversationDir, filename);

      const logLine = JSON.stringify(logEntry) + '\n';
      await fs.appendFile(filepath, logLine);
    } catch (error) {
      console.error('Failed to save conversation log:', error);
    }
  }

  /**
   * Создает сводку разговора
   */
  async logConversationSummary(callId, conversation, result) {
    const summary = {
      callId,
      timestamp: new Date().toISOString(),
      totalTurns: conversation.length,
      userMessages: conversation.filter((msg) => msg.role === 'user').length,
      aiMessages: conversation.filter((msg) => msg.role === 'assistant').length,
      finalResult: result,
      conversation: conversation.map((msg) => ({
        role: msg.role,
        content:
          msg.content.substring(0, 100) +
          (msg.content.length > 100 ? '...' : ''),
        timestamp: msg.timestamp,
      })),
    };

    console.log('\n' + '📊'.repeat(20));
    console.log(`📋 СВОДКА РАЗГОВОРА (${callId})`);
    console.log(`👥 Всего реплик: ${summary.totalTurns}`);
    console.log(`🗣️  Пользователь: ${summary.userMessages} реплик`);
    console.log(`🤖 AI: ${summary.aiMessages} реплик`);
    console.log(`🎯 Результат: ${result}`);
    console.log('📊'.repeat(20));

    await this.saveToFile(callId, { type: 'SUMMARY', ...summary });
  }
}

// В outboundManager.js добавь:
import { ConversationLogger } from '../utils/conversationLogger.js';

// В конструкторе:
this.conversationLogger = new ConversationLogger();

// В processAudioBuffer после получения транскрипции:
await this.conversationLogger.logConversationTurn(
  callId,
  'USER',
  transcription,
  {
    classification,
    duration: recordingDuration,
    audioSize: audioBuffer.length,
    transcriptionTime,
  }
);

// После генерации AI ответа:
await this.conversationLogger.logConversationTurn(
  callId,
  'AI',
  aiResponse.text,
  {
    classification,
    nextStage: aiResponse.nextStage,
  }
);

// В конце звонка (в endCall методе):
await this.conversationLogger.logConversationSummary(
  callId,
  callData.conversation,
  result
);
