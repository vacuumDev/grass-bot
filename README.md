# 🤖 Grass Farm Bot (Account Tracker & Token Claimer)

Автоматизированный бот для управления готовыми аккаунтами Grass: логин, обновление токенов, трекинг активности, парсинг данных устройства, сбор информации об IP и автоматическое получение токенов.

## 🧠 Основной функционал

- Загружает аккаунты из файла ready_accounts.txt
- Логинится на getgrass.io по refreshToken
- Получает deviceId, accessToken и userId
- Проверяет статус подключения прокси
- Сохраняет и обновляет данные в PostgreSQL через Prisma
- Запускается через очередь (Redis queue + worker)

## 🚀 Запуск

1. Установи зависимости:

npm install

2. Настрой `data/config.json` по примеру `config.example.json`. Там указываются:

- proxylist path
- путь к файлу с аккаунтами
- заголовки, user-agent, задержки

3. Создай базу и примени Prisma:

npx prisma migrate dev --name init

4. Запусти Docker (Redis + PostgreSQL):

docker-compose up -d

5. Запусти основной трекер:

npm run start

или

npm run worker

## 📁 Структура

- `src/index.ts` — основная логика авторизации и обработки
- `src/worker.ts` — воркер, работающий с очередью
- `src/lib/grass.ts` — логика авторизации и API Grass
- `src/lib/config.ts` — парсинг и валидация конфигурации
- `prisma/schema.prisma` — база данных

## 📦 Зависимости

- axios  
- dotenv  
- ioredis  
- prisma + @prisma/client  
- node-fetch  
- typescript  
- tsx (dev)

## 💡 Для чего это

- 📊 Контроль за работоспособностью зарегистрированных аккаунтов  
- ♻️ Обновление токенов и данных устройств  
- 🪙 Подготовка к массовому фарму токенов на Grass

## ⚠️ Внимание

Инструмент разработан в исследовательских целях. Использование на практике — на твой страх и риск.
