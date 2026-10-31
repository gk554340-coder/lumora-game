import assert from "node:assert/strict";
import {
  createPublicKey,
  createVerify,
  generateKeyPairSync,
} from "node:crypto";
import { describe, it } from "node:test";

import { loadGooglePlayConfig } from "../src/config/google-play.js";
import {
  GooglePlayClient,
  PlayApiError,
} from "../src/modules/payments/google-play.client.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const config = {
  packageName: "com.example.lumora",
  serviceAccount: {
    clientEmail: "svc@example.iam.gserviceaccount.com",
    privateKey,
  },
  accountSecret: "x".repeat(40),
  allowTestPurchases: true,
};

interface Call {
  url: string;
  init: RequestInit;
}

function stubFetch(
  handler: (call: Call) => Response | Promise<Response>,
): { fetchImpl: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];

  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    const call = { url: String(url), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;

  return { fetchImpl, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function tokenReply(): Response {
  return json({ access_token: "access-1", expires_in: 3600 });
}

describe("google play client", () => {
  it("signs a valid RS256 assertion and caches the access token", async () => {
    const { fetchImpl, calls } = stubFetch((call) =>
      call.url.includes("oauth2")
        ? tokenReply()
        : json({
            orderId: "GPA.1",
            productId: "sku_a",
            purchaseState: 0,
            consumptionState: 0,
            quantity: 1,
            obfuscatedExternalAccountId: "acct",
          }),
    );

    const client = new GooglePlayClient(config, { fetchImpl });

    const purchase = await client.getProductPurchase("sku_a", "tok");
    await client.getProductPurchase("sku_a", "tok");

    assert.equal(purchase?.orderId, "GPA.1");
    assert.equal(purchase?.purchaseType, null);
    assert.equal(
      calls.filter((call) => call.url.includes("oauth2")).length,
      1,
    );

    const form = new URLSearchParams(String(calls[0]?.init.body));
    assert.equal(
      form.get("grant_type"),
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );

    const [header, claims, signature] = (
      form.get("assertion") ?? ""
    ).split(".");

    const verifier = createVerify("RSA-SHA256");
    verifier.update(`${header}.${claims}`);
    assert.equal(
      verifier.verify(
        createPublicKey(publicKey),
        Buffer.from(signature ?? "", "base64url"),
      ),
      true,
    );

    const parsed = JSON.parse(
      Buffer.from(claims ?? "", "base64url").toString(),
    );
    assert.equal(parsed.iss, config.serviceAccount.clientEmail);
    assert.equal(
      parsed.scope,
      "https://www.googleapis.com/auth/androidpublisher",
    );
    assert.equal(parsed.exp - parsed.iat, 3600);
  });

  it("refreshes the token after it expires", async () => {
    let now = 1_000_000;
    const { fetchImpl, calls } = stubFetch((call) =>
      call.url.includes("oauth2") ? tokenReply() : json({}),
    );

    const client = new GooglePlayClient(config, {
      fetchImpl,
      now: () => now,
    });

    await client.getProductPurchase("sku_a", "tok");
    now += 3_600_000;
    await client.getProductPurchase("sku_a", "tok");

    assert.equal(
      calls.filter((call) => call.url.includes("oauth2")).length,
      2,
    );
  });

  it("encodes the sku and token in the URL and sends the bearer token", async () => {
    const { fetchImpl, calls } = stubFetch((call) =>
      call.url.includes("oauth2") ? tokenReply() : json({}),
    );

    const client = new GooglePlayClient(config, { fetchImpl });
    await client.getProductPurchase("sku_a", "a/b c");

    const call = calls[1];
    assert.ok(call);
    assert.ok(
      call.url.endsWith(
        "/applications/com.example.lumora/purchases/products/sku_a/tokens/a%2Fb%20c",
      ),
    );
    assert.deepEqual(call.init.headers, {
      authorization: "Bearer access-1",
    });
  });

  it("maps 400, 404 and 410 to null and other failures to errors", async () => {
    for (const status of [400, 404, 410]) {
      const { fetchImpl } = stubFetch((call) =>
        call.url.includes("oauth2") ? tokenReply() : json({}, status),
      );
      const client = new GooglePlayClient(config, { fetchImpl });
      assert.equal(await client.getProductPurchase("s", "t"), null);
    }

    for (const status of [401, 403, 429, 500, 503]) {
      const { fetchImpl } = stubFetch((call) =>
        call.url.includes("oauth2") ? tokenReply() : json({}, status),
      );
      const client = new GooglePlayClient(config, { fetchImpl });

      await assert.rejects(
        client.getProductPurchase("s", "t"),
        (error: unknown) =>
          error instanceof PlayApiError && error.status === status,
      );
    }
  });

  it("turns network and credential failures into PlayApiError", async () => {
    const offline = new GooglePlayClient(config, {
      fetchImpl: (async () => {
        throw new Error("offline");
      }) as typeof fetch,
    });

    await assert.rejects(
      offline.getProductPurchase("s", "t"),
      PlayApiError,
    );

    const rejected = new GooglePlayClient(config, {
      fetchImpl: stubFetch(() => json({}, 401)).fetchImpl,
    });

    await assert.rejects(rejected.consume("s", "t"), PlayApiError);
  });

  it("posts to the consume endpoint", async () => {
    const { fetchImpl, calls } = stubFetch((call) =>
      call.url.includes("oauth2")
        ? tokenReply()
        : new Response(null, { status: 204 }),
    );

    const client = new GooglePlayClient(config, { fetchImpl });
    await client.consume("sku_a", "tok");

    const call = calls[1];
    assert.equal(call?.init.method, "POST");
    assert.ok(call?.url.endsWith("/tokens/tok:consume"));
  });
});

describe("google play config", () => {
  const serviceAccount = JSON.stringify({
    client_email: "svc@example.com",
    private_key: "key",
  });

  it("is disabled when nothing is set", () => {
    assert.equal(loadGooglePlayConfig({}), null);
    assert.equal(
      loadGooglePlayConfig({ GOOGLE_PLAY_PACKAGE_NAME: "  " }),
      null,
    );
  });

  it("refuses a partial setup", () => {
    assert.throws(() =>
      loadGooglePlayConfig({ GOOGLE_PLAY_PACKAGE_NAME: "com.a.b" }),
    );
  });

  it("reads raw and base64 service accounts", () => {
    const base = {
      GOOGLE_PLAY_PACKAGE_NAME: "com.a.b",
      GOOGLE_PLAY_ACCOUNT_SECRET: "s".repeat(32),
    };

    const raw = loadGooglePlayConfig({
      ...base,
      GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: serviceAccount,
    });
    const encoded = loadGooglePlayConfig({
      ...base,
      GOOGLE_PLAY_SERVICE_ACCOUNT_JSON:
        Buffer.from(serviceAccount).toString("base64"),
    });

    assert.equal(raw?.serviceAccount.clientEmail, "svc@example.com");
    assert.deepEqual(raw, encoded);
  });

  it("rejects a short secret, bad JSON and a bad flag", () => {
    const valid = {
      GOOGLE_PLAY_PACKAGE_NAME: "com.a.b",
      GOOGLE_PLAY_ACCOUNT_SECRET: "s".repeat(32),
      GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: serviceAccount,
    };

    assert.throws(() =>
      loadGooglePlayConfig({
        ...valid,
        GOOGLE_PLAY_ACCOUNT_SECRET: "short",
      }),
    );
    assert.throws(() =>
      loadGooglePlayConfig({
        ...valid,
        GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: "{nope",
      }),
    );
    assert.throws(() =>
      loadGooglePlayConfig({
        ...valid,
        GOOGLE_PLAY_ALLOW_TEST_PURCHASES: "maybe",
      }),
    );
  });

  it("allows test purchases by default only outside production", () => {
    const valid = {
      GOOGLE_PLAY_PACKAGE_NAME: "com.a.b",
      GOOGLE_PLAY_ACCOUNT_SECRET: "s".repeat(32),
      GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: serviceAccount,
    };

    assert.equal(
      loadGooglePlayConfig({ ...valid, NODE_ENV: "development" })
        ?.allowTestPurchases,
      true,
    );
    assert.equal(
      loadGooglePlayConfig({ ...valid, NODE_ENV: "production" })
        ?.allowTestPurchases,
      false,
    );
  });
});
