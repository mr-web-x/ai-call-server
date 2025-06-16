export const CONVERSATION_STAGES = {
  START: 'start', // Начало звонка
  GREETING_SENT: 'greeting_sent', // Приветствие отправлено
  WAITING_RESPONSE: 'waiting_response', // Ждем ответа клиента
  PROCESSING: 'processing', // Обрабатываем запись
  NEED_RESPONSE: 'need_response', // Нужно сгенерировать ответ
  RESPONSE_SENT: 'response_sent', // Ответ отправлен
  COMPLETED: 'completed', // Звонок завершен
  ERROR: 'error', // Ошибка
};

export const STAGE_TIMEOUTS = {
  GREETING_SENT: 30000, // 30 сек на ответ
  RESPONSE_SENT: 30000, // 30 сек на ответ
  PROCESSING: 10000, // 10 сек на обработку
  WAITING_RESPONSE: 5000, // 5 сек ожидания
};
