import fs from "node:fs/promises";
import path from "node:path";
import { env } from "../../config/env";
import { LocalDiskStorage } from "./localDisk";

export type StorageVariant = "thumb" | "display" | "original";

export interface StoredObject {
  key: string;
  variant: StorageVariant;
  bytes: number;
}

export interface StorageAdapter {
  put(key: string, body: Buffer, variant: StorageVariant, contentType: string): Promise<void>;
  read(key: string, variant: StorageVariant): Promise<Buffer>;
  remove(key: string, variant: StorageVariant): Promise<void>;
  publicUrl(key: string, variant: StorageVariant): string;
  /** 列出某个变体目录下的全部对象 key（相对变体根目录，形如 2025/03/x.webp）。 */
  list(variant: StorageVariant): Promise<StoredObject[]>;
  /** 移动到隔离区并返回凭据；不存在时抛错，由调用方决定如何记账。 */
  quarantine(key: string, variant: StorageVariant, receiptId: string): Promise<{ quarantinePath: string; bytes: number }>;
  /** 凭隔离凭据还原；失败时抛错，保证凭据不会被静默核销。 */
  restoreFromQuarantine(key: string, variant: StorageVariant, receiptId: string): Promise<{ bytes: number }>;
}

export const storage: StorageAdapter = new LocalDiskStorage(env.uploadDir);
