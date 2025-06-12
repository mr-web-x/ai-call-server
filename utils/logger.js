import fs from "fs";
import path from "path";

class Logger {
  constructor() {
    this.logDir = "./logs";
    this.ensureLogDir();
  }

  ensureLogDir() {
    if (!fs.existsSync(this.logDir)) {
      fs.mkdirSync(this.logDir, { recursive: true });
    }
  }

  getTimestamp() {
    return new Date().toISOString();
  }

  formatMessage(level, message, data = null) {
    const timestamp = this.getTimestamp();
    const logEntry = {
      timestamp,
      level,
      message,
      ...(data && { data }),
    };

    return JSON.stringify(logEntry);
  }

  writeToFile(level, message, data = null) {
    const logEntry = this.formatMessage(level, message, data);
    const filename = `${new Date().toISOString().split("T")[0]}.log`;
    const filepath = path.join(this.logDir, filename);

    fs.appendFileSync(filepath, logEntry + "\n");
  }

  info(message, data = null) {
    console.log(`ℹ️  ${message}`, data || "");
    this.writeToFile("INFO", message, data);
  }

  warn(message, data = null) {
    console.warn(`⚠️  ${message}`, data || "");
    this.writeToFile("WARN", message, data);
  }

  error(message, data = null) {
    console.error(`❌ ${message}`, data || "");
    this.writeToFile("ERROR", message, data);
  }

  debug(message, data = null) {
    if (process.env.NODE_ENV === "development") {
      console.log(`🐛 ${message}`, data || "");
      this.writeToFile("DEBUG", message, data);
    }
  }
}

export const logger = new Logger();
