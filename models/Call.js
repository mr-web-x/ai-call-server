import mongoose from "mongoose";

const CallSchema = new mongoose.Schema({
  call_id: { type: String, required: true, unique: true },
  client_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Client",
    required: true,
  },
  twilio_call_sid: String,
  status: {
    type: String,
    enum: [
      "initiated",
      "calling",
      "answered",
      "completed",
      "failed",
      "busy",
      "no-answer",
    ],
    default: "initiated",
  },
  start_time: { type: Date, default: Date.now },
  end_time: Date,
  duration: Number,
  conversation_history: [
    {
      timestamp: Date,
      speaker: { type: String, enum: ["ai", "client"] },
      text: String,
      classification: String,
    },
  ],
  result: {
    agreement: Boolean,
    payment_promised: Boolean,
    next_contact_date: Date,
    notes: String,
  },
  recordings: [
    {
      url: String,
      duration: Number,
    },
  ],
});

export const Call = mongoose.model("Call", CallSchema);
