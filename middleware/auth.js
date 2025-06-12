import jwt from "jsonwebtoken";
import { logger } from "../utils/logger.js";

export const authenticateToken = (req, res, next) => {
  const authHeader = req.headers["authorization"];
  const token = authHeader && authHeader.split(" ")[1];

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Access token required",
    });
  }

  jwt.verify(
    token,
    process.env.JWT_SECRET || "fallback-secret",
    (err, user) => {
      if (err) {
        logger.warn("Invalid token attempt:", err.message);
        return res.status(403).json({
          success: false,
          error: "Invalid token",
        });
      }

      req.user = user;
      next();
    }
  );
};

export const generateToken = (payload) => {
  return jwt.sign(payload, process.env.JWT_SECRET || "fallback-secret", {
    expiresIn: process.env.JWT_EXPIRES_IN || "24h",
  });
};

// API Key authentication (simpler alternative)
export const authenticateApiKey = (req, res, next) => {
  const apiKey = req.headers["x-api-key"];

  if (!apiKey || apiKey !== process.env.API_KEY) {
    return res.status(401).json({
      success: false,
      error: "Valid API key required",
    });
  }

  next();
};
