
import type { FastifyError, FastifyInstance } from "fastify";

import { AppError } from "../errors/AppError.js";

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    request.log.error(
      {
        err: error,
        requestId: request.id,
      },
      "Request failed",
    );

    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        success: false,
        error: {
          code: error.code,
          message: error.message,
        },
      });
    }

    if (error.validation) {
      return reply.status(400).send({
        success: false,
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed.",
        },
      });
    }

    const statusCode =
      typeof error.statusCode === "number" &&
      error.statusCode >= 400 &&
      error.statusCode <= 599
        ? error.statusCode
        : 500;

    const isServerError = statusCode >= 500;

    return reply.status(statusCode).send({
      success: false,
      error: {
        code: isServerError
          ? "INTERNAL_SERVER_ERROR"
          : "REQUEST_ERROR",
        message: isServerError
          ? "An unexpected error occurred."
          : "The request could not be processed.",
      },
    });
  });
}
