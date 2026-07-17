export type Role = 'admin' | 'member';

export interface PendingRegistrationDoc {
  _id: string;
  name: string;
  email: string;
  otpHash: string;
  otpAttempts: number;
  expiresAt: string;
  verified: boolean;
  challenge?: string;
}

export interface UserDoc {
  _id: string;
  name: string;
  email: string;
  role: Role;
  credential: { id: string; publicKey: string; counter: number; transports?: string[] };
  createdAt: string;
}

export interface SessionDoc {
  _id: string;
  userId: string;
  createdAt: string;
  expiresAt: string;
}
