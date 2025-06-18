import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import { CONFIG } from './config/index.js';
import { connectDatabase } from './config/database.js';
import { setupWebSocket } from './websocket.js';
import { logger } from './utils/logger.js';
import { mediaStreamManager } from './services/mediaStreamManager.js';

// Import queue processors to initialize them
import './queues/processors.js';

// Import services for initialization
import { audioManager } from './services/audioManager.js';
import { ttsManager } from './services/ttsManager.js';
import { cacheManager } from './services/cacheManager.js';
import { outboundManager } from './services/outboundManager.js';

// Import routes
import callRoutes from './routes/calls.js';
import clientRoutes from './routes/clients.js';
import webhookRoutes from './routes/webhooks.js';
import healthRoutes from './routes/health.js';

// Middleware imports
import { authenticateApiKey } from './middleware/auth.js';

const app = express();
const server = createServer(app);

// ==============================================
// MIDDLEWARE SETUP
// ==============================================
app.set('trust proxy', ['loopback', 'linklocal', 'uniquelocal']);

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: false, // Disable for development
  })
);

// CORS configuration
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(',') || [
      'http://localhost:3000',
    ],
    credentials: true,
  })
);

// Rate limiting
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: {
    success: false,
    error: 'Too many requests, please try again later',
  },
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => {
    // Пропускаем webhooks от Twilio
    return (
      req.path.startsWith('/api/webhooks') ||
      req.headers['user-agent']?.includes('TwilioProxy')
    );
  },
});

app.use('/api/', limiter);

// Body parsing middleware
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get('User-Agent'),
  });
  next();
});

// ==============================================
// STATIC FILE SERVING
// ==============================================

app.use('*', (req, res, next) => {
  console.log('=================================');
  console.log(`📡 INCOMING REQUEST: ${req.method} ${req.originalUrl}`);
  // console.log(`📍 IP: ${req.ip}`);
  // console.log(`🌐 User-Agent: ${req.get('User-Agent')}`);
  // console.log(`📋 Headers:`, Object.keys(req.headers));
  // console.log(`📦 Body:`, req.method === 'POST' ? req.body : 'N/A');
  console.log('=================================');
  next();
});

// Serve audio files (critical for ElevenLabs integration)
app.use(
  '/audio',
  express.static('./public/audio', {
    maxAge: '1h', // Cache for 1 hour
    setHeaders: (res, path) => {
      // Set proper headers for audio files
      if (path.endsWith('.mp3')) {
        res.setHeader('Content-Type', 'audio/mpeg');
      }
      res.setHeader('Access-Control-Allow-Origin', '*');
    },
  })
);

// Serve cache files separately with longer cache
app.use(
  '/audio/cache',
  express.static('./public/audio/cache', {
    maxAge: '7d', // Cache for 7 days (cached phrases don't change)
    immutable: true,
  })
);

// ==============================================
// ROUTES SETUP
// ==============================================

// Public routes (no authentication)
app.use('/api/health', healthRoutes);
app.use('/api/webhooks', webhookRoutes);

// Protected routes (require API key)
app.use('/api/calls', authenticateApiKey, callRoutes);
app.use('/api/clients', authenticateApiKey, clientRoutes);

// Root endpoint with enhanced system info
app.get('/', (req, res) => {
  res.json({
    name: 'Debt Collection AI System',
    version: '2.0.0',
    status: 'running',
    timestamp: new Date().toISOString(),
    features: [
      'ElevenLabs TTS Integration',
      'Intelligent Audio Caching',
      'Twilio TTS Fallback',
      'Real-time Call Management',
      'AI-Powered Conversations',
    ],
    endpoints: {
      health: '/api/health',
      calls: '/api/calls',
      clients: '/api/clients',
      webhooks: '/api/webhooks',
      audio: '/audio',
    },
  });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    success: false,
    error: 'Endpoint not found',
    path: req.originalUrl,
  });
});

// Global error handler
app.use((error, req, res, next) => {
  logger.error('Unhandled error:', error);

  res.status(error.status || 500).json({
    success: false,
    error:
      process.env.NODE_ENV === 'production'
        ? 'Internal server error'
        : error.message,
  });
});

// ==============================================
// SERVER STARTUP
// ==============================================

async function startServer() {
  try {
    // Connect to database
    await connectDatabase();
    logger.info('✅ Database connected successfully');

    // Initialize WebSocket
    setupWebSocket(server);
    logger.info('✅ WebSocket server initialized');

    // Media Stream Manager init
    mediaStreamManager.setupWebSocketServer(server);
    logger.info('✅ Media Stream Manager initialized');

    // Initialize audio directories
    await audioManager.ensureDirectories();
    logger.info('✅ Audio directories initialized');

    // Check TTS service health
    const ttsHealth = await ttsManager.checkElevenLabsHealth();
    if (ttsHealth.available) {
      logger.info(
        `✅ ElevenLabs TTS available: ${ttsHealth.voiceCount} voices`
      );

      // Preload cache in background
      setTimeout(() => {
        ttsManager.preloadCommonPhrases().catch((error) => {
          logger.warn('Cache preload failed:', error);
        });
      }, 5000); // Wait 5 seconds after startup
    } else {
      logger.warn(`⚠️  ElevenLabs TTS unavailable: ${ttsHealth.reason}`);
      logger.info('📢 System will use Twilio TTS fallback');
    }

    // Start periodic cleanup tasks
    setupPeriodicTasks();

    // Start server
    const PORT = CONFIG.PORT || 4002;
    server.listen(PORT, () => {
      logger.info(`🚀 Server running on port ${PORT}`);
      logger.info(
        `🌐 Server URL: ${process.env.SERVER_URL || `http://localhost:${PORT}`}`
      );
      logger.info('='.repeat(50));
      logger.info('🎯 DEBT COLLECTION AI SYSTEM v2.0');
      logger.info('📞 ElevenLabs TTS + Twilio Integration');
      logger.info('🤖 AI-Powered Conversation Engine');
      logger.info('='.repeat(50));
    });
  } catch (error) {
    logger.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// ==============================================
// PERIODIC TASKS
// ==============================================

function setupPeriodicTasks() {
  // Cleanup old audio files every hour
  setInterval(
    async () => {
      try {
        await audioManager.cleanupOldFiles();
        logger.info('🧹 Audio cleanup completed');
      } catch (error) {
        logger.error('Audio cleanup failed:', error);
      }
    },
    60 * 60 * 1000
  ); // 1 hour

  // Cleanup stale calls every 10 minutes
  setInterval(
    async () => {
      try {
        const cleaned = await outboundManager.cleanupStaleCalls();
        if (cleaned > 0) {
          logger.info(`🧹 Cleaned up ${cleaned} stale calls`);
        }
      } catch (error) {
        logger.error('Stale call cleanup failed:', error);
      }
    },
    10 * 60 * 1000
  ); // 10 minutes

  // Log system metrics every 30 minutes
  setInterval(
    async () => {
      try {
        const callMetrics = outboundManager.getCallMetrics();
        const ttsMetrics = ttsManager.getMetrics();
        const cacheStats = await cacheManager.getCacheStats();
        const storageStats = await audioManager.getStorageStats();

        logger.info('📊 System Metrics:', {
          activeCalls: callMetrics.total,
          ttsSuccessRate: ttsMetrics.performance.elevenLabsSuccessRate,
          cacheHitRate: ttsMetrics.performance.cacheHitRate,
          fallbackRate: ttsMetrics.performance.fallbackRate,
          audioFiles: storageStats.totalFiles,
          cachedPhrases: cacheStats.fileCache.files,
        });
      } catch (error) {
        logger.error('Metrics logging failed:', error);
      }
    },
    30 * 60 * 1000
  ); // 30 minutes

  logger.info('✅ Periodic tasks scheduled');
}

// ==============================================
// GRACEFUL SHUTDOWN
// ==============================================

process.on('SIGTERM', async () => {
  logger.info('📴 SIGTERM received, shutting down gracefully...');

  server.close(async () => {
    try {
      // End all active calls
      const activeCalls = outboundManager.getAllActiveCalls();
      for (const call of activeCalls) {
        await outboundManager.endCall(call.callId, 'server_shutdown');
      }

      logger.info('✅ Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  });
});

process.on('SIGINT', async () => {
  logger.info('📴 SIGINT received, shutting down gracefully...');

  server.close(async () => {
    try {
      // End all active calls
      const activeCalls = outboundManager.getAllActiveCalls();
      for (const call of activeCalls) {
        await outboundManager.endCall(call.callId, 'server_shutdown');
      }

      logger.info('✅ Graceful shutdown completed');
      process.exit(0);
    } catch (error) {
      logger.error('❌ Error during shutdown:', error);
      process.exit(1);
    }
  });
});

// Start the server
startServer();
