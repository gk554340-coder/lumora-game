import { createHmac } from "node:crypto";

import { loadGooglePlayConfig } from "../../config/google-play.js";
import {
  GooglePlayClient,
  type PlayBillingClient,
} from "./google-play.client.js";

/**
 * The payment settings and the Google client, created once on first
 * use. Tests replace them with setPaymentsRuntime.
 */

export interface PaymentsRuntime {
  client: PlayBillingClient;
  accountSecret: string;
  allowTestPurchases: boolean;
}

let runtime: PaymentsRuntime | null | undefined;

export function getPaymentsRuntime(): PaymentsRuntime | null {
  if (runtime === undefined) {
    const config = loadGooglePlayConfig();

    runtime = config
      ? {
          client: new GooglePlayClient(config),
          accountSecret: config.accountSecret,
          allowTestPurchases: config.allowTestPurchases,
        }
      : null;
  }

  return runtime;
}

export function setPaymentsRuntime(
  value: PaymentsRuntime | null,
): void {
  runtime = value;
}

/**
 * The id the app passes to Google when it starts a purchase. It is a
 * keyed hash, so Google never sees the real user id, and the server
 * can later prove a purchase was started by this exact user.
 */
export function obfuscatedAccountId(
  accountSecret: string,
  userId: string,
): string {
  return createHmac("sha256", accountSecret)
    .update(`lumora:user:${userId}`)
    .digest("base64url");
}
