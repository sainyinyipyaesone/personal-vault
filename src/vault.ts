import type { Category, CustomField, VaultItem } from "./types";
import { categories } from "./types";

const FORMAT_VERSION = 2;
const LEGACY_FORMAT_VERSION = 1;
const KDF_ITERATIONS = 600_000;
const KDF_NAME = "PBKDF2-HKDF-SHA-256";
const LEGACY_KDF_NAME = "PBKDF2-SHA-256";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export interface LegacyEncryptedVault {
  version: 1;
  kdf: typeof LEGACY_KDF_NAME;
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
}

export interface EncryptedVaultV2 {
  version: 2;
  kdf: typeof KDF_NAME;
  iterations: number;
  vaultId: string;
  salt: string;
  iv: string;
  ciphertext: string;
}

export type EncryptedVault = LegacyEncryptedVault | EncryptedVaultV2;

export interface UnlockFactors {
  vaultId: string;
  deviceKey: string;
  totpSecret: string;
}

export interface VaultSession {
  key: CryptoKey;
  salt: Uint8Array;
  iterations: number;
  vaultId: string;
  deviceKey: Uint8Array | null;
  version: 1 | 2;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
      value &= (1 << bits) - 1;
    }
  }
  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function decodeBase32(secret: string): Uint8Array {
  const normalized = secret.toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = 0;
  let value = 0;
  const output: number[] = [];
  for (const character of normalized) {
    const digit = BASE32_ALPHABET.indexOf(character);
    if (digit < 0) throw new Error("The authenticator secret is invalid.");
    value = (value << 5) | digit;
    bits += 5;
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 255);
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  return Uint8Array.from(output);
}

async function deriveLegacyKey(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const passwordBytes = new TextEncoder().encode(password);
  const material = await crypto.subtle.importKey("raw", toArrayBuffer(passwordBytes), "PBKDF2", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: toArrayBuffer(salt),
      iterations,
      hash: "SHA-256",
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function deriveVaultKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
  deviceKey: Uint8Array,
  vaultId: string,
): Promise<CryptoKey> {
  const passwordBytes = new TextEncoder().encode(password);
  const passwordMaterial = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(passwordBytes),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const passwordBits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: toArrayBuffer(salt), iterations, hash: "SHA-256" },
    passwordMaterial,
    256,
  );
  const combinedMaterial = await crypto.subtle.importKey("raw", passwordBits, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: toArrayBuffer(deviceKey),
      info: toArrayBuffer(new TextEncoder().encode(`Personal Vault:${vaultId}`)),
    },
    combinedMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

function isCategory(value: unknown): value is Category {
  return typeof value === "string" && categories.some((category) => category === value);
}

function isCustomField(value: unknown): value is CustomField {
  if (!value || typeof value !== "object") return false;
  const field = value as Record<string, unknown>;
  return (
    typeof field.id === "string" &&
    typeof field.label === "string" &&
    typeof field.value === "string" &&
    typeof field.secret === "boolean"
  );
}

function isVaultItem(value: unknown): value is VaultItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.title === "string" &&
    isCategory(item.category) &&
    typeof item.username === "string" &&
    typeof item.secret === "string" &&
    typeof item.url === "string" &&
    typeof item.notes === "string" &&
    Array.isArray(item.tags) &&
    item.tags.every((tag) => typeof tag === "string") &&
    typeof item.favorite === "boolean" &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string" &&
    Array.isArray(item.customFields) &&
    item.customFields.every(isCustomField)
  );
}

export function parseEncryptedVault(serialized: string): EncryptedVault {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    throw new Error("This backup is not a valid Personal Vault file.");
  }

  if (!parsed || typeof parsed !== "object") {
    throw new Error("This backup is not a valid Personal Vault file.");
  }
  const envelope = parsed as Record<string, unknown>;
  const commonFieldsValid =
    typeof envelope.iterations === "number" &&
    envelope.iterations >= 1 &&
    envelope.iterations <= 1_000_000 &&
    typeof envelope.salt === "string" &&
    typeof envelope.iv === "string" &&
    typeof envelope.ciphertext === "string";

  if (
    envelope.version === LEGACY_FORMAT_VERSION &&
    envelope.kdf === LEGACY_KDF_NAME &&
    commonFieldsValid
  ) {
    return {
      version: LEGACY_FORMAT_VERSION,
      kdf: LEGACY_KDF_NAME,
      iterations: envelope.iterations as number,
      salt: envelope.salt as string,
      iv: envelope.iv as string,
      ciphertext: envelope.ciphertext as string,
    };
  }

  if (
    envelope.version === FORMAT_VERSION &&
    envelope.kdf === KDF_NAME &&
    commonFieldsValid &&
    typeof envelope.vaultId === "string" &&
    envelope.vaultId.length > 0 &&
    envelope.vaultId.length <= 64
  ) {
    return {
      version: FORMAT_VERSION,
      kdf: KDF_NAME,
      iterations: envelope.iterations as number,
      vaultId: envelope.vaultId,
      salt: envelope.salt as string,
      iv: envelope.iv as string,
      ciphertext: envelope.ciphertext as string,
    };
  }
  throw new Error("This vault file uses an unsupported or invalid format.");
}

export function createUnlockFactors(): UnlockFactors {
  return {
    vaultId: crypto.randomUUID(),
    deviceKey: toBase64(crypto.getRandomValues(new Uint8Array(32))),
    totpSecret: createTotpSecret(),
  };
}

export function createTotpSecret(): string {
  return encodeBase32(crypto.getRandomValues(new Uint8Array(20)));
}

export function totpUri(secret: string, accountName = "Personal Vault"): string {
  const label = encodeURIComponent(accountName);
  const issuer = encodeURIComponent("Personal Vault");
  return `otpauth://totp/${label}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
}

function timingSafeEqual(left: string, right: string): boolean {
  let difference = left.length ^ right.length;
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

export async function verifyTotp(secret: string, code: string, now = Date.now()): Promise<boolean> {
  const normalizedCode = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalizedCode)) return false;

  const secretBytes = decodeBase32(secret);
  const key = await crypto.subtle.importKey(
    "raw",
    toArrayBuffer(secretBytes),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const currentStep = Math.floor(now / 30_000);
  for (const offset of [-1, 0, 1]) {
    let counter = BigInt(currentStep + offset);
    const counterBytes = new Uint8Array(8);
    for (let index = 7; index >= 0; index -= 1) {
      counterBytes[index] = Number(counter & 0xffn);
      counter >>= 8n;
    }
    const digest = new Uint8Array(
      await crypto.subtle.sign("HMAC", key, toArrayBuffer(counterBytes)),
    );
    const truncationOffset = digest[digest.length - 1] & 0x0f;
    const binary =
      ((digest[truncationOffset] & 0x7f) << 24) |
      ((digest[truncationOffset + 1] & 0xff) << 16) |
      ((digest[truncationOffset + 2] & 0xff) << 8) |
      (digest[truncationOffset + 3] & 0xff);
    const expectedCode = String(binary % 1_000_000).padStart(6, "0");
    if (timingSafeEqual(expectedCode, normalizedCode)) return true;
  }
  return false;
}

export async function sealVault(session: VaultSession, items: VaultItem[]): Promise<EncryptedVaultV2> {
  if (session.version !== FORMAT_VERSION || !session.deviceKey) {
    throw new Error("Set up device protection before saving this vault.");
  }
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = new TextEncoder().encode(JSON.stringify(items));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: toArrayBuffer(iv) },
    session.key,
    toArrayBuffer(plaintext),
  );
  return {
    version: FORMAT_VERSION,
    kdf: KDF_NAME,
    iterations: session.iterations,
    vaultId: session.vaultId,
    salt: toBase64(session.salt),
    iv: toBase64(iv),
    ciphertext: toBase64(new Uint8Array(ciphertext)),
  };
}

export async function createVault(
  password: string,
  items: VaultItem[],
  factors: UnlockFactors,
): Promise<{ session: VaultSession; envelope: EncryptedVaultV2 }> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const deviceKey = fromBase64(factors.deviceKey);
  if (deviceKey.byteLength !== 32) throw new Error("The device key is invalid.");
  const session: VaultSession = {
    key: await deriveVaultKey(password, salt, KDF_ITERATIONS, deviceKey, factors.vaultId),
    salt,
    iterations: KDF_ITERATIONS,
    vaultId: factors.vaultId,
    deviceKey,
    version: FORMAT_VERSION,
  };
  return { session, envelope: await sealVault(session, items) };
}

export async function unlockVault(
  serialized: string,
  password: string,
  deviceKeyBase64?: string,
): Promise<{ session: VaultSession; items: VaultItem[]; envelope: EncryptedVault }> {
  const envelope = parseEncryptedVault(serialized);
  const salt = fromBase64(envelope.salt);
  const iv = fromBase64(envelope.iv);
  const ciphertext = fromBase64(envelope.ciphertext);
  if (salt.byteLength !== 16 || iv.byteLength !== 12 || ciphertext.byteLength < 16) {
    throw new Error("This vault file is incomplete or damaged.");
  }

  let session: VaultSession;
  if (envelope.version === LEGACY_FORMAT_VERSION) {
    session = {
      key: await deriveLegacyKey(password, salt, envelope.iterations),
      salt,
      iterations: envelope.iterations,
      vaultId: "",
      deviceKey: null,
      version: LEGACY_FORMAT_VERSION,
    };
  } else {
    if (!deviceKeyBase64) throw new Error("The device key for this vault is not available.");
    const deviceKey = fromBase64(deviceKeyBase64);
    if (deviceKey.byteLength !== 32) throw new Error("The device key for this vault is invalid.");
    session = {
      key: await deriveVaultKey(password, salt, envelope.iterations, deviceKey, envelope.vaultId),
      salt,
      iterations: envelope.iterations,
      vaultId: envelope.vaultId,
      deviceKey,
      version: FORMAT_VERSION,
    };
  }

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: toArrayBuffer(iv) },
      session.key,
      toArrayBuffer(ciphertext),
    );
  } catch {
    throw new Error("The password or device key is incorrect, or this vault file is damaged.");
  }

  let parsedItems: unknown;
  try {
    parsedItems = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error("The decrypted vault data is invalid.");
  }
  if (!Array.isArray(parsedItems) || !parsedItems.every(isVaultItem)) {
    throw new Error("The decrypted vault data is invalid.");
  }
  return { session, items: parsedItems, envelope };
}
