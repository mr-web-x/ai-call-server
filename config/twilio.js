import Twilio from "twilio";
import { logger } from "../utils/logger.js";

const accountSid = process.env.TWILIO_ACCOUNT_SID;
const authToken = process.env.TWILIO_AUTH_TOKEN;

export const twilioClient = new Twilio(accountSid, authToken);

export const TWILIO_CONFIG = {
  phoneNumber: process.env.TWILIO_PHONE_NUMBER,
  serverUrl: process.env.SERVER_URL,
  timeout: 30,
  recordCalls: true,
};

logger.info("Twilio client initialized");
