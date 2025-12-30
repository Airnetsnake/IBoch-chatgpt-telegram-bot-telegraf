import { Telegraf } from "telegraf";
import { MyContext } from './types';
import { TELEGRAM_BOT_TOKEN, CHAT_GPT_DEFAULT_TIMEOUT_MS } from './config';
import { setupDatabase } from './database/databaseInit';
import { initializeBotHandlers } from './botHandlers';
import express from "express";
import axios from 'axios';

const RETRY_DELAY_MS = 5000;
const MAX_RETRIES = 10;

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

interface FetchErrorLike {
  message?: string;
  code?: string;
  errno?: string;
  type?: string;
  cause?: unknown;
}

function getErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    const fetchError = error as FetchErrorLike;
    const parts: string[] = [error.message];
    
    if (fetchError.code) {
      parts.push(`code: ${fetchError.code}`);
    }
    if (fetchError.errno) {
      parts.push(`errno: ${fetchError.errno}`);
    }
    if (fetchError.type) {
      parts.push(`type: ${fetchError.type}`);
    }
    if (fetchError.cause) {
      parts.push(`cause: ${JSON.stringify(fetchError.cause)}`);
    }
    
    return parts.join(' | ');
  }
  return String(error);
}

async function connectToTelegram(bot: Telegraf<MyContext>): Promise<void> {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`Connecting to Telegram API (attempt ${attempt}/${MAX_RETRIES})...`);
      const botInfo = await bot.telegram.getMe();
      bot.context.botUsername = botInfo.username;
      console.log(`Connected to Telegram as @${botInfo.username}`);
      return;
    } catch (error: unknown) {
      const errorDetails = getErrorDetails(error);
      console.error(`Connection attempt ${attempt} failed:`, errorDetails);
      if (attempt < MAX_RETRIES) {
        console.log(`Retrying in ${RETRY_DELAY_MS / 1000} seconds...`);
        await sleep(RETRY_DELAY_MS);
      }
    }
  }
  throw new Error(`Failed to connect to Telegram API after ${MAX_RETRIES} attempts`);
}

let bot: Telegraf<MyContext> | undefined;

// Telegram bot
bot = new Telegraf<MyContext>(TELEGRAM_BOT_TOKEN, { handlerTimeout: CHAT_GPT_DEFAULT_TIMEOUT_MS * 6 });

// Global error handler for unhandled bot errors
bot.catch((err, ctx) => {
  console.error(`[ERROR] Bot error for ${ctx.updateType}:`, err);
});

// Global handler for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled Rejection at:', promise, 'reason:', reason);
});

async function clearPendingUpdates() {
  try {
    const response = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`);
    const updateIds = response.data.result.map((update: any) => update.update_id);
    if (updateIds.length > 0) {
      const lastUpdateId = Math.max(...updateIds);
      await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}`);
      console.log(`Cleared ${updateIds.length} pending updates.`);
    } else {
      console.log('No pending updates to clear.');
    }
  } catch (error) {
    console.error('Failed to clear pending updates:', error);
  }
}

bot.use(async (ctx: MyContext, next) => {
  const start = new Date();
  let isNextDone = false;
  const stopSignal = () => isNextDone;

  await next();
  isNextDone = true;

  const ms = new Date().getTime() - start.getTime();
  console.log(`message processed. Response time: ${ms / 1000} seconds.`);
});

// Attach handlers
initializeBotHandlers(bot);

const startBot = async () => {
  // Start health check server first so Railway sees the service as healthy
  const app = express();
  app.get("/health", (req, res) => {
    res.send("OK");
  });
  const PORT = process.env.PORT || 8080;
  app.listen(PORT, () => {
    console.log(`Health check server running on port ${PORT}`);
  });

  await setupDatabase();
  console.log('Database initialization complete. Starting bot...');

  // Connect to Telegram with retry logic
  await connectToTelegram(bot!);

  // DEBUG: Needed in case the bot was stopped while there were pending updates
  // await clearPendingUpdates();

  bot!.launch();
  console.log('Bot started');
};

startBot().catch(err => {
  console.error('Failed to start the bot', err);
});

export default bot;
