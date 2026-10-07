import fs from "node:fs/promises";
import path from "node:path";
import type { StoredObject, StorageAdapter, StorageVariant } from "./index";

const KEY_PATTERN = /^[A-Za-z0-9/_-]+\.webp$/;

/**
 * 本地磁盘存储：thumb/、display/、original/ 三个目录前缀 + 年/月目录。
 * key 形如 2025/03/<uuid>.webp，全部由服务端生成，不接受用户输入。
 *
 * 处置孤立文件时不做硬删除，而是移动到 .quarantine/<receiptId>/ 目录，
 * receiptId 即 QualityAction.id，凭此凭据可原样还原。
 */
export class LocalDiskStorage implements StorageAdapter {
  private readonly quarantineRoot: string;

  constructor(private readonly root: string) {
    this.quarantineRoot = path.resolve(root, ".quarantine");
  }

  private resolvePath(key: string, variant: StorageVariant): string {
    if (!KEY_PATTERN.test(key) || key.includes("..")) {
      throw new Error(`非法的存储 key：${key}`);
    }
    const target = path.resolve(this.root, variant, key);
    const prefix = path.resolve(this.root, variant) + path.sep;
    if (!target.startsWith(prefix)) {
      throw new Error("存储路径越界");
    }
    return target;
  }

  /** receiptId 只允许 cuid 安全字符，避免隔离目录穿越。 */
  private resolveQuarantinePath(key: string, variant: StorageVariant, receiptId: string): string {
    if (!/^[A-Za-z0-9_-]+$/.test(receiptId)) throw new Error("非法的隔离凭据");
    const target = path.resolve(this.quarantineRoot, receiptId, variant, key);
    const prefix = path.resolve(this.quarantineRoot, receiptId) + path.sep;
    if (!target.startsWith(prefix)) throw new Error("隔离路径越界");
    return target;
  }

  async put(key: string, body: Buffer, variant: StorageVariant): Promise<void> {
    const target = this.resolvePath(key, variant);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  }

  async read(key: string, variant: StorageVariant): Promise<Buffer> {
    return fs.readFile(this.resolvePath(key, variant));
  }

  async remove(key: string, variant: StorageVariant): Promise<void> {
    try {
      await fs.unlink(this.resolvePath(key, variant));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  async list(variant: StorageVariant): Promise<StoredObject[]> {
    const base = path.resolve(this.root, variant);
    const out: StoredObject[] = [];
    async function walk(dir: string): Promise<void> {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && entry.name.endsWith(".webp")) {
          const stat = await fs.stat(full);
          const relative = path.relative(base, full).split(path.sep).join("/");
          if (KEY_PATTERN.test(relative)) out.push({ key: relative, variant, bytes: stat.size });
        }
      }
    }
    await walk(base);
    return out;
  }

  async quarantine(key: string, variant: StorageVariant, receiptId: string): Promise<{ quarantinePath: string; bytes: number }> {
    const source = this.resolvePath(key, variant);
    const target = this.resolveQuarantinePath(key, variant, receiptId);
    const stat = await fs.stat(source);
    await fs.mkdir(path.dirname(target), { recursive: true });
    // rename 在同一卷内是原子操作；跨卷（少见的挂载场景）退化为复制后删除。
    try {
      await fs.rename(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await fs.copyFile(source, target);
      await fs.unlink(source);
    }
    return { quarantinePath: path.relative(this.quarantineRoot, target).split(path.sep).join("/"), bytes: stat.size };
  }

  async restoreFromQuarantine(key: string, variant: StorageVariant, receiptId: string): Promise<{ bytes: number }> {
    const source = this.resolveQuarantinePath(key, variant, receiptId);
    const target = this.resolvePath(key, variant);
    const stat = await fs.stat(source);
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.rename(source, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      await fs.copyFile(source, target);
      await fs.unlink(source);
    }
    return { bytes: stat.size };
  }

  publicUrl(key: string, variant: StorageVariant): string {
    return `/files/${variant}/${key}`;
  }
}
