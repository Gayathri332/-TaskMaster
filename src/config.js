require('dotenv').config();

const isProd = process.env.NODE_ENV === 'production';

if (isProd && !process.env.JWT_SECRET) {
  throw new Error('JWT_SECRET must be set in production');
}

module.exports = {
  isProd,
  port: Number(process.env.PORT) || 3000,
  jwtSecret: process.env.JWT_SECRET || 'dev-only-insecure-secret',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN || '2h',
  dbPath: process.env.DB_PATH || './data/taskmaster.db',
  uploadDir: process.env.UPLOAD_DIR || './uploads',
  maxUploadBytes: (Number(process.env.MAX_UPLOAD_MB) || 5) * 1024 * 1024,
  // AI provider: 'openrouter' | 'cohere' | 'anthropic'. If unset, auto-detected from whichever key is present.
  ai: {
    provider: (process.env.AI_PROVIDER || '').toLowerCase(),
    openrouterKey: process.env.OPENROUTER_API_KEY || '',
    openrouterModel: process.env.OPENROUTER_MODEL || 'meta-llama/llama-3.3-70b-instruct:free,openai/gpt-oss-20b:free,google/gemma-3-27b-it:free',
    cohereKey: process.env.COHERE_API_KEY || '',
    cohereModel: process.env.COHERE_MODEL || 'command-r-08-2024',
    anthropicKey: process.env.ANTHROPIC_API_KEY || '',
    anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  },
};
