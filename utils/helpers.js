export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const formatPhoneNumber = (phone) => {
  // Remove all non-digit characters
  const cleaned = phone.replace(/\D/g, "");

  // Add country code if missing
  if (cleaned.length === 10) {
    return `+7${cleaned}`;
  }

  if (cleaned.length === 11 && cleaned.startsWith("8")) {
    return `+7${cleaned.slice(1)}`;
  }

  if (cleaned.length === 11 && cleaned.startsWith("7")) {
    return `+${cleaned}`;
  }

  return `+${cleaned}`;
};

export const formatCurrency = (amount) => {
  return new Intl.NumberFormat("ru-RU", {
    style: "currency",
    currency: "RUB",
  }).format(amount);
};

export const generateCallId = () => {
  const timestamp = Date.now().toString(36);
  const randomStr = Math.random().toString(36).substr(2, 5);
  return `call_${timestamp}_${randomStr}`;
};

export const calculateCallDuration = (startTime, endTime = new Date()) => {
  const duration = endTime.getTime() - startTime.getTime();
  const seconds = Math.floor(duration / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    return `${hours}h ${minutes % 60}m ${seconds % 60}s`;
  } else if (minutes > 0) {
    return `${minutes}m ${seconds % 60}s`;
  } else {
    return `${seconds}s`;
  }
};

export const sanitizeAudioBuffer = (buffer) => {
  if (!Buffer.isBuffer(buffer)) {
    throw new Error("Invalid audio buffer");
  }

  // Basic validation
  if (buffer.length === 0) {
    throw new Error("Empty audio buffer");
  }

  if (buffer.length > 50 * 1024 * 1024) {
    // 50MB limit
    throw new Error("Audio buffer too large");
  }

  return buffer;
};

export const retryAsync = async (fn, maxRetries = 3, delay = 1000) => {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error) {
      if (i === maxRetries - 1) throw error;
      await sleep(delay * Math.pow(2, i)); // Exponential backoff
    }
  }
};
