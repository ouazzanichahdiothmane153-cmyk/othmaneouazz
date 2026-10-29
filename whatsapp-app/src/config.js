const num = (value, fallback) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && value !== undefined && value !== '' ? parsed : fallback;
};

export const config = {
  port: num(process.env.PORT, 3000),
  adminToken: process.env.ADMIN_TOKEN || '',
  dbFile: process.env.DB_FILE || './data/app.sqlite',
  defaultCountryCode: (process.env.DEFAULT_COUNTRY_CODE || '').replace(/\D/g, ''),
  whatsapp: {
    token: process.env.WHATSAPP_TOKEN || '',
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
    apiVersion: process.env.WHATSAPP_API_VERSION || 'v21.0',
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
    appSecret: process.env.WHATSAPP_APP_SECRET || '',
  },
  workerIntervalMs: num(process.env.WORKER_INTERVAL_MS, 5000),
  sendDelayMs: num(process.env.SEND_DELAY_MS, 1000),
  maxAttempts: num(process.env.MAX_ATTEMPTS, 3),
};

export const isDryRun = () => !config.whatsapp.token;
