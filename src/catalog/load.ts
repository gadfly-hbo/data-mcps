import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { CatalogEntry } from "../core/types.js";

const HERE = dirname(fileURLToPath(import.meta.url));

/** 精选静态目录（catalog/*.json，随仓版本化）。兼容打包（dist/）与源码（src/catalog/）两种位置。 */
export async function loadCatalog(catalogDir?: string): Promise<CatalogEntry[]> {
  const candidates = catalogDir ? [catalogDir] : [join(HERE, "..", "catalog"), join(HERE, "..", "..", "catalog")];
  let dir = "";
  for (const c of candidates) {
    try {
      const names = (await readdir(c)).filter((n) => n.endsWith(".json")).sort();
      if (names.length > 0) {
        dir = c;
        const entries: CatalogEntry[] = [];
        for (const name of names) {
          entries.push(JSON.parse(await readFile(join(dir, name), "utf8")) as CatalogEntry);
        }
        return entries;
      }
    } catch {
      // 尝试下一个候选位置
    }
  }
  throw new Error(`目录数据缺失：${candidates.join(" / ")}（坏包/缺资源拒绝启动）`);
}
