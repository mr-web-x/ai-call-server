import mongoose from "mongoose";
import { logger } from "../utils/logger.js";

export const connectDatabase = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URL, {
      useNewUrlParser: true,
      useUnifiedTopology: true,
    });

    logger.info(`MongoDB Connected: ${conn.connection.host}`);
  } catch (error) {
    logger.error("Database connection error:", error);
    process.exit(1);
  }
};
