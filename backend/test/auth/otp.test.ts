import { describe, expect, it } from 'vitest';
import { generateOtp, hashOtp, verifyOtp } from '../../src/auth/otp.js';

describe('otp', () => {
  it('generateOtp zero-pads to 6 digits', () => {
    expect(generateOtp(() => 0)).toBe('000000');
    expect(generateOtp(() => 42)).toBe('000042');
    expect(generateOtp(() => 999999)).toBe('999999');
  });

  it('hashOtp is deterministic and distinguishes different inputs', () => {
    expect(hashOtp('123456')).toBe(hashOtp('123456'));
    expect(hashOtp('123456')).not.toBe(hashOtp('654321'));
  });

  it('verifyOtp accepts the correct code and rejects a wrong one', () => {
    const hash = hashOtp('482913');
    expect(verifyOtp('482913', hash)).toBe(true);
    expect(verifyOtp('482914', hash)).toBe(false);
  });

  it('verifyOtp rejects malformed hashes without throwing', () => {
    expect(verifyOtp('482913', 'not-a-valid-hex-hash')).toBe(false);
  });
});
