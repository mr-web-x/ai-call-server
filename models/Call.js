import mongoose from 'mongoose';

const CallSchema = new mongoose.Schema({
  call_id: { type: String, required: true, unique: true },
  client_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Client',
    required: true,
  },
  twilio_call_sid: String,
  status: {
    type: String,
    enum: [
      'initiated',
      'calling',
      'ringing',
      'answered',
      'in-progress', // Добавить этот статус
      'completed',
      'failed',
      'busy',
      'no-answer',
      'canceled', // Добавить этот статус
    ],
    default: 'initiated',
  },
  start_time: { type: Date, default: Date.now },
  answer_time: Date, // Добавить время ответа
  end_time: Date,
  duration: Number,
  conversation_history: [
    {
      timestamp: Date,
      speaker: { type: String, enum: ['ai', 'client'] },
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
      transcription: String, // Добавить расшифровку
      classification: String, // Добавить классификацию
    },
  ],
  recording_events: [
    {
      // Добавить события записи
      status: String,
      recording_sid: String,
      url: String,
      timestamp: Date,
    },
  ],
});

export const Call = mongoose.model('Call', CallSchema);
