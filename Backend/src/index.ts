import { buildApp } from "./app.js";
import { env, requireProductionSecrets } from "./config/env.js";
import {
  connectDatabase,
  disconnectDatabase,
} from "./config/prisma.js";

const app = buildApp();

let shuttingDown = false;

const start = async (): Promise<void> => {
  try {
    requireProductionSecrets();

    await connectDatabase();

    await app.listen({
      port: env.port,
      host: "0.0.0.0",
    });

    app.log.info(
      {
        port: env.port,
        environment: env.nodeEnv,
      },
      "LUMORA backend started successfully",
    );
  } catch (error) {
    app.log.error(error, "Failed to start LUMORA backend");

    try {
      await disconnectDatabase();
    } catch (disconnectError) {
      app.log.error(
        disconnectError,
        "Failed to disconnect database during startup failure",
      );
    }

    process.exit(1);
  }
};

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;

  app.log.info({ signal }, "Graceful shutdown started");

  try {
    await app.close();
    await disconnectDatabase();

    app.log.info("LUMORA backend shutdown completed");
    process.exit(0);
  } catch (error) {
    app.log.error(error, "Graceful shutdown failed");
    process.exit(1);
  }
};

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await start();
