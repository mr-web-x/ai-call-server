import express from "express";
import { createServer } from "http";
import cors from "cors";
import helmet from "helmet";
import compression from "compression";
import rateLimit from "express-rate-limit";
import { CONFIG } from "./config/index.js";
import { connectDatabase } from "./config/database.js";
import { setupWebSocket } from "./websocket.js";
import { logger } from "./utils/logger.js";

// Import queue processors to initialize them
import "./queues/processors.js";

// Import routes
import callRoutes from "./routes/calls.js";
import clientRoutes from "./routes/clients.js";
import webhookRoutes from "./routes/webhooks.js";
import healthRoutes from "./routes/health.js";

// Middleware imports
import { authenticateApiKey } from "./middleware/auth.js";

const app = express();
const server = createServer(app);

// ==============================================
// MIDDLEWARE SETUP
// ==============================================

// Security middleware
app.use(
  helmet({
    contentSecurityPolicy: false, // Disable for development
  })
);

// CORS configuration
app.use(
  cors({
    origin: process.env.ALLOWED_ORIGINS?.split(",") || [
      "http://localhost:3000",
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
    error: "Too many requests, please try again later",
  },
  standardHeaders: true,
  legacyHeaders: false,
});

app.use("/api/", limiter);

// Body parsing middleware
app.use(compression());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// Request logging middleware
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.path}`, {
    ip: req.ip,
    userAgent: req.get("User-Agent"),
  });
  next();
});

// ==============================================
// ROUTES SETUP
// ==============================================

// Public routes (no authentication)
app.use("/api/health", healthRoutes);
app.use("/api/webhooks", webhookRoutes);

// Protected routes (require API key)
app.use("/api/calls", authenticateApiKey, callRoutes);
app.use("/api/clients", authenticateApiKey, clientRoutes);

// Root endpoint
app.get("/", (req, res) => {
  res.json({
    name: "Debt Collection AI System",
    version: "1.0.0",
    status: "running",
    timestamp: new Date().toISOString(),
    endpoints: {
      health: "/api/health",
      calls: "/api/calls",
      clients: "/api/clients",
      webhooks: "/api/webhooks",
    },
  });
});

// 404 handler
app.use("*", (req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
    path: req.originalUrl,
  });
});

// Global error handler
app.use((error, req, res, next) => {
  logger.error("Unhandled error:", error);

  res.status(error.status || 500).json({
    success: false,
    error:
      process.env.NODE_ENV === "production"
        ? "Internal server error"
        : error.message,
    ...(process.env.NODE_ENV !== "production" && { stack: error.stack }),
  });
});

// ==============================================
// SERVER STARTUP
// ==============================================

const startServer = async () => {
  try {
    // Connect to database
    await connectDatabase();

    // Setup WebSocket
    setupWebSocket(server);

    // Start server
    server.listen(CONFIG.PORT, () => {
      logger.info(
        `🚀 Debt Collection AI Server running on port ${CONFIG.PORT}`
      );
      logger.info(
        `📊 Health check: http://localhost:${CONFIG.PORT}/api/health`
      );
      logger.info(`🔗 WebSocket endpoint: ws://localhost:${CONFIG.PORT}/ws/`);
      logger.info(
        `📞 Twilio webhooks: http://localhost:${CONFIG.PORT}/api/webhooks/`
      );
      logger.info(`🔑 API endpoints protected with API key`);
    });
  } catch (error) {
    logger.error("Failed to start server:", error);
    process.exit(1);
  }
};

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  logger.info(`🛑 Received ${signal}, shutting down gracefully...`);

  server.close(async () => {
    try {
      // Close database connection
      await mongoose.connection.close();

      // Close queue connections
      await Promise.all([sttQueue.close(), llmQueue.close(), ttsQueue.close()]);

      logger.info("✅ Server closed gracefully");
      process.exit(0);
    } catch (error) {
      logger.error("Error during shutdown:", error);
      process.exit(1);
    }
  });

  // Force close after 30 seconds
  setTimeout(() => {
    logger.error("❌ Forced shutdown after timeout");
    process.exit(1);
  }, 30000);
};

// Handle shutdown signals
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Handle uncaught exceptions
process.on("uncaughtException", (error) => {
  logger.error("Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  logger.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// Start the server
startServer();
