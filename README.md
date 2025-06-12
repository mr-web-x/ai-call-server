# 🤖 Debt Collection AI System

Автоматическая система голосового взыскания долгов с использованием ИИ.

## 🚀 Возможности

- **Автоматические исходящие звонки** через Twilio
- **Распознавание речи** через OpenAI Whisper
- **Классификация намерений** с помощью GPT
- **Синтез речи** через ElevenLabs
- **Многопоточная обработка** с Bull Queue
- **WebSocket** для real-time коммуникации
- **MongoDB** для хранения данных
- **Twilio webhooks** для телефонии

## 📦 Установка

```bash
npm install
cp .env.example .env
# Настройте переменные окружения в .env
npm start
```

## 🔧 API Endpoints

### Звонки

- `POST /api/calls/client/:clientId` - Позвонить клиенту
- `POST /api/calls/bulk` - Массовые звонки
- `GET /api/calls/active` - Активные звонки

### Клиенты

- `GET /api/clients/for-calls` - Клиенты для звонков
- `POST /api/clients` - Создать клиента
- `GET /api/clients/:id` - Данные клиента

### Система

- `GET /api/health` - Статус системы
- `GET /api/health/metrics` - Метрики

## 🎯 Пример использования

```bash
# Позвонить клиенту
curl -X POST http://localhost:3000/api/calls/client/MONGO_ID \
  -H "X-API-Key: your_api_key"

# Получить клиентов для звонков
curl http://localhost:3000/api/clients/for-calls \
  -H "X-API-Key: your_api_key"
```

## 🏗️ Архитектура

```
Twilio → Webhook → AI Processing → Response → TTS → Twilio
                     ↓
              [STT → LLM → Script]
                     ↓
              Bull Queues (Redis)
```

## 📊 Мониторинг

- Health check: `GET /api/health`
- Logs: `./logs/`
- Queue dashboard: Bull Board (опционально)

## 🔒 Безопасность

- API Key аутентификация
- Rate limiting
- CORS настройки
- Helmet.js защита

## ⚙️ Переменные окружения

См. `.env.example` для полного списка.
