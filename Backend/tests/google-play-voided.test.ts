import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import {
  GooglePlayClient,
  PlayApiError,
} from "../src/modules/payments/google-play.client.js";

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const config = {
  packageName: "com.example.lumora",
  serviceAccount: { clientEmail: "svc@example.com", privateKey },
  accountSecret: "x".repeat(40),
  allowTestPurchases: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function clientFor(handler: (url: string) => Response) {
  const urls: string[] = [];

  const fetchImpl = (async (url: string | URL | Request) => {
    const text = String(url);
    urls.push(text);
    return text.includes("oauth2")
      ? json({ access_token: "a", expires_in: 3600 })
      : handler(text);
  }) as typeof fetch;

  return { client: new GooglePlayClient(config, { fetchImpl }), urls };
}

describe("google play voided purchases", () => {
  it("reads items and converts string timestamps", async () => {
    const { client, urls } = clientFor(() =>
      json({
        voidedPurchases: [
          {
            purchaseToken: "tok-1",
            orderId: "GPA.1",
            voidedTimeMillis: "1700000000000",
            voidedSource: 0,
            voidedReason: 1,
          },
          { orderId: "no-token" },
        ],
        tokenPagination: { nextPageToken: "next-1" },
      }),
    );

    const page = await client.listVoidedPurchases({
      startTimeMillis: 1234,
    });

    assert.deepEqual(page.items, [
      {
        purchaseToken: "tok-1",
        orderId: "GPA.1",
        voidedTimeMillis: 1_700_000_000_000,
        voidedSource: 0,
        voidedReason: 1,
      },
    ]);
    assert.equal(page.nextPageToken, "next-1");

    const url = new URL(urls[1] ?? "");
    assert.ok(
      url.pathname.endsWith(
        "/applications/com.example.lumora/purchases/voidedpurchases",
      ),
    );
    assert.equal(url.searchParams.get("type"), "0");
    assert.equal(url.searchParams.get("startTime"), "1234");
    assert.equal(url.searchParams.get("token"), null);
  });

  it("sends the page token and handles an empty reply", async () => {
    const { client, urls } = clientFor(() => json({}));

    const page = await client.listVoidedPurchases({
      startTimeMillis: 1,
      pageToken: "abc def",
    });

    assert.deepEqual(page, { items: [], nextPageToken: null });
    assert.equal(
      new URL(urls[1] ?? "").searchParams.get("token"),
      "abc def",
    );
  });

  it("raises PlayApiError on failures", async () => {
    const { client } = clientFor(() => json({}, 403));

    await assert.rejects(
      client.listVoidedPurchases({ startTimeMillis: 1 }),
      (error: unknown) =>
        error instanceof PlayApiError && error.status === 403,
    );
  });
});
