import type { FastifyError, FastifyInstance } from "fastify";

import { AppError } from "../errors/AppError.js";

function resolveStatusCode(error: FastifyError): number {
  if (error instanceof AppError) {
    return error.statusCode;
  }

  if (error.validation) {
    return 400;
  }

  if (
    typeof error.statusCode === "number" &&
    error.statusCode >= 400 &&
    error.statusCode <= 599
  ) {
    return error.statusCode;
  }

  return 500;
}

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError, request, reply) => {
    const statusCode = resolveStatusCode(error);
    const logContext = {
      err: error,
      requestId: request.id,
    };

    // Client errors (wrong password, bad input, rate limit) are expected
    // traffic. Only server errors are logged at error level.
    if (statusCode >= 500) {
      request.log.error(logContext, "Request failed");
    } else {
      request.log.warn(logContext, "Request rejected");
    }

    if (error instanceof AppError) {
      return reply.status(statusCode).send({
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

    if (statusCode === 429) {
      return reply.status(429).send({
        success: false,
        error: {
          code: "RATE_LIMIT_EXCEEDED",
          message: "Too many requests. Please try again later.",
        },
      });
    }

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
