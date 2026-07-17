import { createHash, randomInt, timingSafeEqual } from 'node:crypto';

export function generateOtp(rand: () => number = () => randomInt(0, 1_000_000)): string {
  return String(rand()).padStart(6, '0');
}

export function hashOtp(otp: string): string {
  return createHash('sha256').update(otp).digest('hex');
}

export function verifyOtp(otp: string, hash: string): boolean {
  const candidate = Buffer.from(hashOtp(otp), 'hex');
  let stored: Buffer;
  try {
    stored = Buffer.from(hash, 'hex');
  } catch {
    return false;
  }
  if (candidate.length !== stored.length) return false;
  return timingSafeEqual(candidate, stored);
}
