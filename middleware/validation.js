import mongoose from "mongoose";
import { logger } from "../utils/logger.js";

export const validateClientId = (req, res, next) => {
  const { clientId } = req.params;

  if (!mongoose.Types.ObjectId.isValid(clientId)) {
    logger.warn(`Invalid client ID format: ${clientId}`);
    return res.status(400).json({
      success: false,
      error: "Invalid client ID format",
    });
  }

  next();
};

export const validatePhoneNumber = (req, res, next) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({
      success: false,
      error: "Phone number is required",
    });
  }

  // Basic phone validation (adjust regex as needed)
  const phoneRegex = /^\+?[1-9]\d{1,14}$/;
  if (!phoneRegex.test(phone)) {
    return res.status(400).json({
      success: false,
      error: "Invalid phone number format",
    });
  }

  next();
};

export const validateClientData = (req, res, next) => {
  const { name, phone, debt_amount, contract_number } = req.body;
  const errors = [];

  if (!name || name.trim().length < 2) {
    errors.push("Name must be at least 2 characters");
  }

  if (!phone) {
    errors.push("Phone number is required");
  }

  if (!debt_amount || debt_amount <= 0) {
    errors.push("Debt amount must be greater than 0");
  }

  if (!contract_number || contract_number.trim().length < 3) {
    errors.push("Contract number must be at least 3 characters");
  }

  if (errors.length > 0) {
    return res.status(400).json({
      success: false,
      errors,
    });
  }

  next();
};
