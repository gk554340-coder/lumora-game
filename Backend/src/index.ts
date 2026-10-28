import { buildApp } from "./app.js";
import { env, requireProductionSecrets } from "./config/env.js";
import {
  connectDatabase,
  disconnectDatabase,
} from "./config/prisma.js";

const app = buildApp();

let shuttingDown = false;
let startupCompleted = false;

const start = async (): Promise<void> => {
  try {
    requireProductionSecrets();

    await connectDatabase();

    await app.listen({
      port: env.port,
      host: "0.0.0.0",
    });

    startupCompleted = true;

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
      await app.close();
    } catch (closeError) {
      app.log.error(
        closeError,
        "Failed to close application after startup failure",
      );
    }

    try {
      await disconnectDatabase();
    } catch (disconnectError) {
      app.log.error(
        disconnectError,
        "Failed to disconnect database during startup failure",
      );
    }

    process.exitCode = 1;
  }
};

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    app.log.warn(
      { signal },
      "Shutdown already in progress",
    );
    return;
  }

  shuttingDown = true;

  app.log.info({ signal }, "Graceful shutdown started");

  let shutdownFailed = false;

  if (startupCompleted) {
    try {
      await app.close();
    } catch (error) {
      shutdownFailed = true;
      app.log.error(error, "Failed to close application");
    }
  }

  try {
    await disconnectDatabase();
  } catch (error) {
    shutdownFailed = true;
    app.log.error(error, "Failed to disconnect database");
  }

  if (shutdownFailed) {
    app.log.error("LUMORA backend shutdown completed with errors");
    process.exitCode = 1;
    return;
  }

  app.log.info("LUMORA backend shutdown completed");
  process.exitCode = 0;
};

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

await start();
