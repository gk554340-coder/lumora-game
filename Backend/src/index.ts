import { buildApp } from "./app.js";
import { env, requireProductionSecrets } from "./config/env.js";

const app = buildApp();

const start = async (): Promise<void> => {
  try {
    requireProductionSecrets();

    await app.listen({
      port: env.port,
      host: "0.0.0.0"
    });
  } catch (error) {
    app.log.error(error);
    process.exit(1);
  }
};

await start();
