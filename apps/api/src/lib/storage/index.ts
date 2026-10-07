import { env } from "../../config/env";
import { LocalDiskStorage } from "./localDisk";

export type StorageVariant = "thumb" | "display" | "original";

export interface StorageAdapter {
  put(key: string, body: Buffer, variant: StorageVariant, contentType: string): Promise<void>;
  read(key: string, variant: StorageVariant): Promise<Buffer>;
  remove(key: string, variant: StorageVariant): Promise<void>;
  /** 递归列出某个变体目录下的全部 key（正斜杠、升序），目录不存在时返回空数组。 */
  list(variant: StorageVariant): Promise<string[]>;
  publicUrl(key: string, variant: StorageVariant): string;
}

export const storage: StorageAdapter = new LocalDiskStorage(env.uploadDir);
