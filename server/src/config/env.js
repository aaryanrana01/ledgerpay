import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

/**
 * Fail fast on boot rather than at 2am on the first bad request.
 * Every value the app reads from the environment is declared and coerced here.
 */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  CLIENT_ORIGIN: z.string().default('http://localhost:5173'),

  MONGO_URI: z.string().min(1, 'MONGO_URI is required'),

  JWT_ACCESS_SECRET: z.string().min(24, 'JWT_ACCESS_SECRET must be at least 24 chars'),
  JWT_REFRESH_SECRET: z.string().min(24, 'JWT_REFRESH_SECRET must be at least 24 chars'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().positive().default(30),

  CURRENCY: z.string().length(3).default('INR'),
  MIN_TRANSFER_MINOR: z.coerce.number().int().positive().default(100),
  MAX_TRANSFER_MINOR: z.coerce.number().int().positive().default(20_000_000),
  DAILY_TRANSFER_LIMIT_MINOR: z.coerce.number().int().positive().default(50_000_000),
  TRANSFER_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(0),
  REVERSAL_WINDOW_MINUTES: z.coerce.number().int().positive().default(60),

  // ---- Razorpay (optional) ----
  // Deliberately optional so the app still boots without keys. Payment routes
  // return a clear 503 rather than crashing at startup, which means a
  // reviewer can clone the repo and explore everything else immediately.
  RAZORPAY_KEY_ID: z.string().optional(),
  RAZORPAY_KEY_SECRET: z.string().optional(),
  RAZORPAY_WEBHOOK_SECRET: z.string().optional(),

  // Withdrawals. 'simulated' runs the full payout lifecycle locally;
  // 'razorpayx' calls the real Payouts API, which needs a RazorpayX account
  // with completed business KYC.
  PAYOUT_PROVIDER: z.enum(['simulated', 'razorpayx']).default('simulated'),
  RAZORPAYX_ACCOUNT_NUMBER: z.string().optional(),
  SIMULATED_PAYOUT_DELAY_MS: z.coerce.number().int().min(0).default(6000),
  MIN_WITHDRAWAL_MINOR: z.coerce.number().int().positive().default(10_000),
});

const parsed = schema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  // eslint-disable-next-line no-console
  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';

/** Deposits need both keys. Without them the payment routes return 503. */
export const paymentsEnabled = Boolean(env.RAZORPAY_KEY_ID && env.RAZORPAY_KEY_SECRET);

/** Webhooks additionally need the (separate) webhook secret. */
export const webhooksEnabled = Boolean(env.RAZORPAY_WEBHOOK_SECRET);
