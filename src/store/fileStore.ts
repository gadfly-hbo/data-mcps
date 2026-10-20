import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 版本化文件存储（PRD 存储决策；红队 K3）。
 * 布局：dataRoot/<collection>/<id>.json。所有写入 = 写临时文件 + 同目录 rename（APFS 原子）。
 * 进程内互斥串行化写，避免并发写同一登记文件。
 */
export class FileStore {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(public readonly root: string) {}

  private collectionDir(collection: string): string {
    return join(this.root, collection);
  }

  /** 串行化所有写操作 */
  private enqueue<T>(op: () => Promise<T>): Promise<T> {
    const next = this.queue.then(op, op);
    this.queue = next.catch(() => {});
    return next;
  }

  async read<T>(collection: string, id: string): Promise<T | null> {
    try {
      const raw = await readFile(join(this.collectionDir(collection), `${id}.json`), "utf8");
      return JSON.parse(raw) as T;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async write<T>(collection: string, id: string, value: T): Promise<void> {
    return this.enqueue(async () => {
      const dir = this.collectionDir(collection);
      await mkdir(dir, { recursive: true });
      const final = join(dir, `${id}.json`);
      const tmp = join(dir, `.tmp-${id}-${process.pid}.json`);
      await writeFile(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
      await rename(tmp, final);
    });
  }

  async list<T>(collection: string): Promise<T[]> {
    const dir = this.collectionDir(collection);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const out: T[] = [];
    for (const name of names.sort()) {
      if (name.startsWith(".tmp-") || !name.endsWith(".json")) continue;
      out.push(JSON.parse(await readFile(join(dir, name), "utf8")) as T);
    }
    return out;
  }

  async exists(collection: string, id: string): Promise<boolean> {
    return (await this.read(collection, id)) !== null;
  }
}
