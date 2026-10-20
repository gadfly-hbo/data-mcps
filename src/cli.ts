import { Command } from "commander";
import { startServer } from "./server/app.js";

const program = new Command();

program
  .name("data-mcps")
  .description("local-first 外部数据集市与采集工作台")
  .version("0.1.0");

program
  .command("ui")
  .description("启动本地 Web 工作台（仅监听 127.0.0.1）")
  .option("-p, --port <port>", "端口", "4173")
  .option("--data-root <dir>", "数据根目录（默认 <cwd>/.data-mcps）")
  .action(async (opts: { port: string; dataRoot?: string }) => {
    const port = Number.parseInt(opts.port, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      console.error(`无效端口：${opts.port}`);
      process.exit(1);
    }
    const dataRoot = opts.dataRoot ?? `${process.cwd()}/.data-mcps`;
    try {
      const { url } = await startServer({ port, dataRoot });
      console.log(`data-mcps 工作台已启动：${url}`);
      console.log(`数据根：${dataRoot}`);
      console.log("提示：本实例仅监听本机回环；真实外部数据商调用未授权，外部数据边界为明确标注的合成夹具。");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        // 不静默换端口（GRILL 包 16）
        console.error(`端口 ${port} 已被占用。请用 -p 指定其他端口；未自动更换，以免打开错误实例。`);
        process.exit(1);
      }
      throw err;
    }
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
