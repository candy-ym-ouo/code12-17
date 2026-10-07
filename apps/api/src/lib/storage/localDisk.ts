import fs from "node:fs/promises";
import path from "node:path";
import type { StorageAdapter, StorageVariant } from "./index";

const KEY_PATTERN = /^[A-Za-z0-9/_-]+\.webp$/;

/**
 * 本地磁盘存储：thumb/、display/、original/ 三个目录前缀 + 年/月目录。
 * key 形如 2025/03/<uuid>.webp，全部由服务端生成，不接受用户输入。
 */
export class LocalDiskStorage implements StorageAdapter {
  constructor(private readonly root: string) {}

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

  async list(variant: StorageVariant): Promise<string[]> {
    const base = path.resolve(this.root, variant);
    const keys: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      let entries;
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
        } else if (entry.isFile()) {
          keys.push(path.relative(base, full).split(path.sep).join("/"));
        }
      }
    };
    await walk(base);
    return keys.sort();
  }

  publicUrl(key: string, variant: StorageVariant): string {
    return `/files/${variant}/${key}`;
  }
}
