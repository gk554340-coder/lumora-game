import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import type { FastifyInstance } from "fastify";

import { prisma } from "../src/config/prisma.js";
import {
  ensureCurrentEvent,
  finalizeEvent,
} from "../src/modules/events/event.service.js";
import { weeklyWindow } from "../src/modules/events/event.catalog.js";
import { getOrCreateLevel } from "../src/modules/levels/level.service.js";
import {
  createNotification,
  getUnreadCount,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  purgeReadNotifications,
} from "../src/modules/notifications/notification.service.js";
import {
  bearer,
  expectAppError,
  registerTestUser,
  startApp,
  stopApp,
} from "./helpers.js";

describe("notifications", () => {
  let app: FastifyInstance;

  before(async () => {
    app = await startApp();
  });

  after(async () => {
    await stopApp(app);
  });

  async function send(userId: string, title: string, dedupeKey?: string) {
    return createNotification({
      userId,
      type: "SYSTEM",
      title,
      message: `${title} message`,
      dedupeKey,
    });
  }

  it("creates a notification that starts unread", async () => {
    const { userId } = await registerTestUser(app);

    const result = await createNotification({
      userId,
      type: "REWARD",
      title: "Welcome",
      message: "Thanks for playing.",
      data: { amount: 10 },
    });

    assert.equal(result.created, true);
    assert.equal(await getUnreadCount(userId), 1);

    const list = await listNotifications(userId);
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0]?.title, "Welcome");
    assert.equal(list.items[0]?.type, "REWARD");
    assert.equal(list.items[0]?.read, false);
    assert.deepEqual(list.items[0]?.data, { amount: 10 });
    assert.equal(list.nextCursor, null);
  });

  it("sends a keyed notification only once, even in parallel", async () => {
    const { userId } = await registerTestUser(app);

    const results = await Promise.all(
      Array.from({ length: 6 }, () => send(userId, "Once", "same-key")),
    );

    assert.equal(results.filter((item) => item.created).length, 1);
    assert.equal(new Set(results.map((item) => item.id)).size, 1);
    assert.equal((await listNotifications(userId)).items.length, 1);

    // The key is private to the server and never shown.
    const shown = (await listNotifications(userId)).items[0];
    assert.equal("dedupeKey" in (shown?.data ?? {}), false);

    // Another player can use the same key.
    const other = await registerTestUser(app);
    assert.equal((await send(other.userId, "Once", "same-key")).created, true);
  });

  it("pages from newest to oldest with a cursor", async () => {
    const { userId } = await registerTestUser(app);

    for (let index = 1; index <= 5; index += 1) {
      await send(userId, `Message ${index}`);
    }

    const first = await listNotifications(userId, { limit: 2 });
    assert.deepEqual(
      first.items.map((item) => item.title),
      ["Message 5", "Message 4"],
    );
    assert.ok(first.nextCursor);

    const second = await listNotifications(userId, {
      limit: 2,
      cursor: first.nextCursor ?? "",
    });
    assert.deepEqual(
      second.items.map((item) => item.title),
      ["Message 3", "Message 2"],
    );

    const third = await listNotifications(userId, {
      limit: 2,
      cursor: second.nextCursor ?? "",
    });
    assert.deepEqual(
      third.items.map((item) => item.title),
      ["Message 1"],
    );
    assert.equal(third.nextCursor, null);

    await expectAppError(
      listNotifications(userId, { cursor: "garbage" }),
      "INVALID_CURSOR",
    );
    await expectAppError(
      listNotifications(userId, { limit: 51 }),
      "INVALID_LIMIT",
    );
  });

  it("marks one or all as read and counts unread", async () => {
    const { userId } = await registerTestUser(app);
    const one = await send(userId, "One");
    await send(userId, "Two");
    await send(userId, "Three");

    assert.equal(await getUnreadCount(userId), 3);

    await markNotificationRead(userId, one.id);
    // Reading twice is fine and changes nothing.
    await markNotificationRead(userId, one.id);
    assert.equal(await getUnreadCount(userId), 2);

    const unread = await listNotifications(userId, { unreadOnly: true });
    assert.equal(unread.items.length, 2);

    const all = await markAllNotificationsRead(userId);
    assert.equal(all.updated, 2);
    assert.equal(await getUnreadCount(userId), 0);
    assert.equal((await listNotifications(userId)).items.length, 3);
  });

  it("keeps notifications private to their owner", async () => {
    const owner = await registerTestUser(app);
    const other = await registerTestUser(app);
    const secret = await send(owner.userId, "Private");

    await expectAppError(
      markNotificationRead(other.userId, secret.id),
      "NOTIFICATION_NOT_FOUND",
    );
    await expectAppError(
      markNotificationRead(other.userId, "not-a-uuid"),
      "NOTIFICATION_NOT_FOUND",
    );

    assert.equal((await listNotifications(other.userId)).items.length, 0);
    assert.equal(await getUnreadCount(owner.userId), 1);
  });

  it("shortens long text and rejects empty text", async () => {
    const { userId } = await registerTestUser(app);

    await createNotification({
      userId,
      type: "SYSTEM",
      title: "T".repeat(500),
      message: "M".repeat(5000),
    });

    const item = (await listNotifications(userId)).items[0];
    assert.equal(item?.title.length, 200);
    assert.equal(item?.message.length, 1000);

    await expectAppError(
      createNotification({
        userId,
        type: "SYSTEM",
        title: "  ",
        message: "x",
      }),
      "VALIDATION_ERROR",
    );
    await expectAppError(
      createNotification({
        userId: "00000000-0000-4000-8000-000000000000",
        type: "SYSTEM",
        title: "Ghost",
        message: "x",
      }),
      "USER_NOT_FOUND",
    );
  });

  it("deletes only old read notifications", async () => {
    const { userId } = await registerTestUser(app);
    const oldRead = await send(userId, "Old read");
    const oldUnread = await send(userId, "Old unread");
    const newRead = await send(userId, "New read");

    await markNotificationRead(userId, oldRead.id);
    await markNotificationRead(userId, newRead.id);

    const longAgo = new Date(Date.now() - 100 * 86_400_000);
    await prisma.notification.update({
      where: { id: oldRead.id },
      data: { readAt: longAgo },
    });
    await prisma.notification.update({
      where: { id: oldUnread.id },
      data: { createdAt: longAgo },
    });

    const removed = await purgeReadNotifications(90);
    assert.ok(removed >= 1);

    const left = (await listNotifications(userId)).items.map(
      (item) => item.title,
    );
    assert.deepEqual(left.sort(), ["New read", "Old unread"]);

    await expectAppError(purgeReadNotifications(0), "VALIDATION_ERROR");
  });

  it("tells players their event result once", async () => {
    const window = weeklyWindow(new Date(Date.UTC(2031, 8, 17, 12)));
    const event = await ensureCurrentEvent(
      new Date(window.start.getTime() + 3_600_000),
    );

    const { userId } = await registerTestUser(app);
    const level = await getOrCreateLevel(1);
    const at = new Date(window.start.getTime() + 2 * 3_600_000);

    await prisma.playerProgress.create({
      data: {
        userId,
        levelId: level.id,
        completed: true,
        stars: 3,
        bestScore: 250,
        firstCompletedAt: at,
      },
    });
    await prisma.levelAttempt.create({
      data: {
        userId,
        levelId: level.id,
        attemptNumber: 1,
        status: "COMPLETED",
        score: 250,
        completedAt: at,
      },
    });

    const after = new Date(window.end.getTime() + 3_600_000);
    await finalizeEvent(event.id, after);

    const list = await listNotifications(userId);
    assert.equal(list.items.length, 1);
    assert.equal(list.items[0]?.type, "EVENT");
    assert.equal(list.items[0]?.data.eventId, event.id);
    assert.equal(list.items[0]?.data.rank, 1);
    assert.equal(list.items[0]?.data.score, 250);

    // A second run, even after closing, sends nothing more.
    await prisma.gameEvent.update({
      where: { id: event.id },
      data: { status: "ACTIVE" },
    });
    await finalizeEvent(event.id, after);
    assert.equal((await listNotifications(userId)).items.length, 1);
  });

  it("works over HTTP and requires login", async () => {
    const user = await registerTestUser(app);
    const first = await send(user.userId, "First");
    await send(user.userId, "Second");

    const anonymous = await app.inject({
      method: "GET",
      url: "/api/notifications",
    });
    assert.equal(anonymous.statusCode, 401);

    const list = await app.inject({
      method: "GET",
      url: "/api/notifications?limit=1",
      headers: bearer(user.token),
    });
    assert.equal(list.statusCode, 200);
    assert.equal(list.json().data.items.length, 1);
    assert.ok(list.json().data.nextCursor);

    const count = await app.inject({
      method: "GET",
      url: "/api/notifications/unread-count",
      headers: bearer(user.token),
    });
    assert.equal(count.json().data.unread, 2);

    const read = await app.inject({
      method: "POST",
      url: `/api/notifications/${first.id}/read`,
      headers: bearer(user.token),
    });
    assert.equal(read.statusCode, 200);

    const missing = await app.inject({
      method: "POST",
      url: "/api/notifications/00000000-0000-4000-8000-000000000000/read",
      headers: bearer(user.token),
    });
    assert.equal(missing.statusCode, 404);

    const readAll = await app.inject({
      method: "POST",
      url: "/api/notifications/read-all",
      headers: bearer(user.token),
    });
    assert.equal(readAll.json().data.updated, 1);

    const badLimit = await app.inject({
      method: "GET",
      url: "/api/notifications?limit=500",
      headers: bearer(user.token),
    });
    assert.equal(badLimit.statusCode, 400);
    assert.equal(badLimit.json().error.code, "INVALID_LIMIT");
  });
});
