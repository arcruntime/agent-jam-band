import 'dotenv/config';

export function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}. Set it in .env (see .env.example).`);
  }
  return value;
}

export const config = {
  get baseURL() { return requireEnv('AIAND_BASE_URL'); },
  get apiKey() { return requireEnv('AIAND_API_KEY'); },
  get model() { return requireEnv('AIAND_MODEL'); },
  /** From AIAND_REASONING_EFFORT; defaults to "low"; "off" returns null so the parameter is omitted. */
  get reasoningEffort(): string | null {
    const value = process.env.AIAND_REASONING_EFFORT?.trim().toLowerCase() || 'low';
    return value === 'off' ? null : value;
  },
  port: Number(process.env.PORT ?? 8787),
};
