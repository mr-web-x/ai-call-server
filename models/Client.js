import mongoose from "mongoose";

const ClientSchema = new mongoose.Schema({
  name: { type: String, required: true },
  phone: { type: String, required: true, unique: true },
  debt_amount: { type: Number, required: true },
  contract_number: { type: String, required: true },
  last_call_date: Date,
  call_attempts: { type: Number, default: 0 },
  status: {
    type: String,
    enum: ["active", "paid", "legal", "blacklist"],
    default: "active",
  },
  call_history: [
    {
      date: { type: Date, default: Date.now },
      result: String, // answered, no_answer, busy, agreement, refusal
      notes: String,
      duration: Number,
      classification: String,
    },
  ],
  created_at: { type: Date, default: Date.now },
  updated_at: { type: Date, default: Date.now },
});

// Middleware to update updated_at
ClientSchema.pre("save", function (next) {
  this.updated_at = Date.now();
  next();
});

export const Client = mongoose.model("Client", ClientSchema);
