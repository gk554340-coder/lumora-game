export interface ApiResponse<T> {
  success: boolean;
  data?: T;
  error?: {
    code: string;
    message: string;
  };
}

export interface HealthResponse {
  status: "ok";
  service: string;
  version: string;
  environment: string;
}
