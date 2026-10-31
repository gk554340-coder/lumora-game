import { createSign } from "node:crypto";

import type { GooglePlayConfig } from "../../config/google-play.js";

/**
 * Minimal Google Play Developer API client (androidpublisher v3).
 * Only what the server needs: read a one-time product purchase and
 * consume it. Purchase tokens and access tokens are never logged.
 */

export interface PlayProductPurchase {
  orderId: string | null;
  productId: string | null;
  /** 0 purchased, 1 canceled, 2 pending. */
  purchaseState: number;
  /** 0 not consumed, 1 consumed. */
  consumptionState: number;
  quantity: number;
  obfuscatedExternalAccountId: string | null;
  /** Absent for real purchases. 0 test, 1 promo, 2 rewarded. */
  purchaseType: number | null;
}

export interface PlayBillingClient {
  /** Returns null when Google says the purchase does not exist. */
  getProductPurchase(
    sku: string,
    purchaseToken: string,
  ): Promise<PlayProductPurchase | null>;
  consume(sku: string, purchaseToken: string): Promise<void>;
}

export class PlayApiError extends Error {
  public readonly status: number | null;

  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "PlayApiError";
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API_BASE =
  "https://androidpublisher.googleapis.com/androidpublisher/v3/applications";
const SCOPE = "https://www.googleapis.com/auth/androidpublisher";
const REQUEST_TIMEOUT_MS = 10_000;
const TOKEN_LIFETIME_SECONDS = 3600;
const TOKEN_REFRESH_MARGIN_SECONDS = 60;

type FetchLike = typeof fetch;

export interface GooglePlayClientOptions {
  fetchImpl?: FetchLike;
  now?: () => number;
}

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

export class GooglePlayClient implements PlayBillingClient {
  private readonly config: GooglePlayConfig;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;

  private cachedToken: { value: string; expiresAt: number } | null =
    null;
  private pendingToken: Promise<string> | null = null;

  constructor(
    config: GooglePlayConfig,
    options: GooglePlayClientOptions = {},
  ) {
    this.config = config;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  private buildAssertion(): string {
    const issuedAt = Math.floor(this.now() / 1000);

    const header = base64Url(
      JSON.stringify({ alg: "RS256", typ: "JWT" }),
    );
    const claims = base64Url(
      JSON.stringify({
        iss: this.config.serviceAccount.clientEmail,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: issuedAt,
        exp: issuedAt + TOKEN_LIFETIME_SECONDS,
      }),
    );

    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${claims}`);
    const signature = signer.sign(this.config.serviceAccount.privateKey);

    return `${header}.${claims}.${base64Url(signature)}`;
  }

  private async fetchAccessToken(): Promise<string> {
    let response: Response;

    try {
      response = await this.fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
          assertion: this.buildAssertion(),
        }).toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new PlayApiError("Could not reach the Google token service.");
    }

    if (!response.ok) {
      throw new PlayApiError(
        "Google refused the service account credentials.",
        response.status,
      );
    }

    const body = (await response.json().catch(() => null)) as {
      access_token?: unknown;
      expires_in?: unknown;
    } | null;

    if (!body || typeof body.access_token !== "string") {
      throw new PlayApiError("Google returned an unexpected token reply.");
    }

    const lifetime =
      typeof body.expires_in === "number" && body.expires_in > 0
        ? body.expires_in
        : TOKEN_LIFETIME_SECONDS;

    this.cachedToken = {
      value: body.access_token,
      expiresAt:
        this.now() +
        Math.max(lifetime - TOKEN_REFRESH_MARGIN_SECONDS, 0) * 1000,
    };

    return body.access_token;
  }

  private getAccessToken(): Promise<string> {
    if (this.cachedToken && this.cachedToken.expiresAt > this.now()) {
      return Promise.resolve(this.cachedToken.value);
    }

    // Concurrent callers share one refresh.
    if (!this.pendingToken) {
      this.pendingToken = this.fetchAccessToken().finally(() => {
        this.pendingToken = null;
      });
    }

    return this.pendingToken;
  }

  private purchaseUrl(sku: string, purchaseToken: string): string {
    return (
      `${API_BASE}/${encodeURIComponent(this.config.packageName)}` +
      `/purchases/products/${encodeURIComponent(sku)}` +
      `/tokens/${encodeURIComponent(purchaseToken)}`
    );
  }

  private async call(
    url: string,
    method: "GET" | "POST",
  ): Promise<Response> {
    const accessToken = await this.getAccessToken();

    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method,
        headers: { authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new PlayApiError("Could not reach the Google Play API.");
    }

    if (response.status === 401) {
      // Token may have been revoked early. Next call fetches a new one.
      this.cachedToken = null;
    }

    return response;
  }

  async getProductPurchase(
    sku: string,
    purchaseToken: string,
  ): Promise<PlayProductPurchase | null> {
    const response = await this.call(
      this.purchaseUrl(sku, purchaseToken),
      "GET",
    );

    if (
      response.status === 400 ||
      response.status === 404 ||
      response.status === 410
    ) {
      return null;
    }

    if (!response.ok) {
      throw new PlayApiError(
        "The Google Play API returned an error.",
        response.status,
      );
    }

    const body = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;

    if (!body || typeof body !== "object") {
      throw new PlayApiError("Google Play returned an unexpected reply.");
    }

    const text = (value: unknown): string | null =>
      typeof value === "string" && value ? value : null;
    const number = (value: unknown, fallback: number): number =>
      typeof value === "number" && Number.isFinite(value)
        ? value
        : fallback;

    return {
      orderId: text(body.orderId),
      productId: text(body.productId),
      purchaseState: number(body.purchaseState, -1),
      consumptionState: number(body.consumptionState, 0),
      quantity: number(body.quantity, 1),
      obfuscatedExternalAccountId: text(body.obfuscatedExternalAccountId),
      purchaseType:
        typeof body.purchaseType === "number" ? body.purchaseType : null,
    };
  }

  async consume(sku: string, purchaseToken: string): Promise<void> {
    const response = await this.call(
      `${this.purchaseUrl(sku, purchaseToken)}:consume`,
      "POST",
    );

    if (!response.ok) {
      throw new PlayApiError(
        "Google Play refused to consume the purchase.",
        response.status,
      );
    }
  }
}
