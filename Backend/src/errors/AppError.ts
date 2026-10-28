export class AppError extends Error {
  public readonly code: string;
  public readonly statusCode: number;

  constructor(
    code: string,
    message: string,
    statusCode = 500
  ) {
    super(message);

    this.name = "AppError";
    this.code = code;
    this.statusCode = statusCode;

    Object.setPrototypeOf(this, new.target.prototype);
  }
}
