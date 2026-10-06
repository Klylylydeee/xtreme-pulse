import { beforeAll, describe, expect, it } from 'vitest';
import { mongo, Types } from 'mongoose';
import { connectDb, withTransaction } from '@pulse/db';
import { isInternalHref } from '../../notifications';
import { NotificationModel } from './model';
import {
  countUnread,
  listNotifications,
  markAllRead,
  markRead,
  notify,
  NotificationInvalidError,
} from './service';

// In-app notifications (docs/modules/core.md#notifications,
// docs/TESTING.md#audit-notification-and-reveal-tests). Made-up data only.

const base = {
  module: 'core' as const,
  event: 'core.testEvent',
  title: 'Something happened',
  href: '/notifications',
};

async function rawAll(): Promise<string> {
  const docs = await NotificationModel.collection.find({}).sort({ _id: 1 }).toArray();
  return mongo.BSON.EJSON.stringify(docs, { relaxed: false });
}

async function idsOf(userId: Types.ObjectId): Promise<string[]> {
  const docs = await NotificationModel.find({ recipientUserId: userId }).sort({ _id: 1 }).lean();
  return docs.map((doc) => doc._id.toHexString());
}

beforeAll(async () => {
  await connectDb();
});

describe('notify', () => {
  it('writes one notification per recipient, once each, and counts unread', async () => {
    const alice = new Types.ObjectId();
    const bob = new Types.ObjectId();
    const written = await notify({ ...base, recipients: [alice, bob, alice.toHexString()] });
    expect(written).toBe(2);
    await notify({ ...base, recipients: [alice], title: 'Second' });
    expect(await countUnread(alice.toHexString())).toBe(2);
    expect(await countUnread(bob.toHexString())).toBe(1);
    expect(await countUnread('not-an-id')).toBe(0);
  });

  it('cuts long titles and bodies and drops control characters', async () => {
    const user = new Types.ObjectId();
    await notify({
      ...base,
      recipients: [user],
      title: `Hello\u0007 ${'t'.repeat(300)}`,
      body: 'b'.repeat(1500),
    });
    const [doc] = await NotificationModel.find({ recipientUserId: user }).lean();
    expect(doc?.title.length).toBeLessThanOrEqual(200);
    expect(doc?.title).not.toContain('\u0007');
    expect(doc?.title.endsWith('…')).toBe(true);
    expect(doc?.body?.length).toBeLessThanOrEqual(1000);
  });

  it('refuses a link that leaves the app', async () => {
    const before = await rawAll();
    for (const href of [
      'https://evil.example',
      '//evil.example',
      '/\\evil.example',
      '\\\\evil.example',
      '/ok//evil',
      'javascript:alert(1)',
      '/tab\there',
      'relative/path',
      '',
    ]) {
      expect(isInternalHref(href), href).toBe(false);
      await expect(
        notify({ ...base, recipients: [new Types.ObjectId()], href }),
      ).rejects.toBeInstanceOf(NotificationInvalidError);
    }
    expect(await rawAll()).toBe(before);
    expect(isInternalHref('/talent/leave/123?tab=history#top')).toBe(true);
  });

  it('commits and aborts with the caller’s transaction', async () => {
    const user = new Types.ObjectId();
    await expect(
      withTransaction(async (session) => {
        await notify({ ...base, recipients: [user] }, { session });
        throw new Error('the change failed');
      }),
    ).rejects.toThrow('the change failed');
    expect(await countUnread(user.toHexString())).toBe(0);
    await withTransaction((session) => notify({ ...base, recipients: [user] }, { session }));
    expect(await countUnread(user.toHexString())).toBe(1);
  });
});

describe('the duplicate check (dedupeKey)', () => {
  const keyed = { ...base, dedupeKey: 'core.testReminder:2026-10-05' };

  it('skips recipients who already have the key, and sends the rest', async () => {
    const alice = new Types.ObjectId();
    const bob = new Types.ObjectId();
    expect(await notify({ ...keyed, recipients: [alice] })).toBe(1);
    expect(await notify({ ...keyed, recipients: [alice, bob] })).toBe(1);
    expect(await notify({ ...keyed, recipients: [alice, bob] })).toBe(0);
    expect(await countUnread(alice.toHexString())).toBe(1);
    expect(await countUnread(bob.toHexString())).toBe(1);

    // Another key, or no key, is sent as usual.
    expect(
      await notify({ ...keyed, dedupeKey: 'core.testReminder:2026-10-06', recipients: [alice] }),
    ).toBe(1);
    expect(await notify({ ...base, recipients: [alice] })).toBe(1);
    expect(await notify({ ...base, recipients: [alice] })).toBe(1);
    expect(await countUnread(alice.toHexString())).toBe(4);

    const [doc] = await NotificationModel.find({ recipientUserId: bob }).lean();
    expect(doc?.dedupeKey).toBe(keyed.dedupeKey);
  });

  it('skips inside a transaction too, and the skip rolls back with it', async () => {
    const user = new Types.ObjectId();
    const key = 'core.testReminder:in-transaction';
    await withTransaction(async (session) => {
      expect(await notify({ ...keyed, dedupeKey: key, recipients: [user] }, { session })).toBe(1);
      expect(await notify({ ...keyed, dedupeKey: key, recipients: [user] }, { session })).toBe(0);
    });
    expect(await countUnread(user.toHexString())).toBe(1);
  });

  it('holds under concurrent sends: each recipient gets the key once', async () => {
    const recipients = Array.from({ length: 5 }, () => new Types.ObjectId());
    const key = 'core.testReminder:concurrent';
    const results = await Promise.all(
      Array.from({ length: 6 }, () => notify({ ...keyed, dedupeKey: key, recipients })),
    );
    expect(results.reduce((sum, count) => sum + count, 0)).toBe(recipients.length);
    for (const recipient of recipients) {
      expect(
        await NotificationModel.countDocuments({ recipientUserId: recipient, dedupeKey: key }),
      ).toBe(1);
    }
  });

  it('refuses a key that is too long or empty, and the key can’t be changed', async () => {
    const user = new Types.ObjectId();
    for (const dedupeKey of ['', 'k'.repeat(201)]) {
      await expect(notify({ ...keyed, dedupeKey, recipients: [user] })).rejects.toBeInstanceOf(
        NotificationInvalidError,
      );
    }
    await notify({ ...keyed, recipients: [user] });
    await expect(
      NotificationModel.updateOne(
        { recipientUserId: user },
        { $set: { readAt: new Date(), dedupeKey: 'other' } },
      ),
    ).rejects.toThrow(/only marking them read/);
  });
});

describe('reading and marking read', () => {
  it('marks only the user’s own notifications, ignoring other users’ ids', async () => {
    const alice = new Types.ObjectId();
    const bob = new Types.ObjectId();
    await notify({ ...base, recipients: [alice, bob] });
    await notify({ ...base, recipients: [alice, bob] });
    const aliceIds = await idsOf(alice);
    const bobIds = await idsOf(bob);

    // Alice sends Bob's ids along with one of her own, and some junk.
    const changed = await markRead(alice.toHexString(), [...bobIds, aliceIds[0] as string, 'junk']);
    expect(changed).toBe(1);
    expect(await countUnread(alice.toHexString())).toBe(1);
    expect(await countUnread(bob.toHexString())).toBe(2);

    // Marking again changes nothing.
    expect(await markRead(alice.toHexString(), [aliceIds[0] as string])).toBe(0);

    expect(await markAllRead(alice.toHexString())).toBe(1);
    expect(await countUnread(alice.toHexString())).toBe(0);
    expect(await countUnread(bob.toHexString())).toBe(2);
  });

  it('lists the user’s own notifications, newest first, in pages', async () => {
    const user = new Types.ObjectId();
    const other = new Types.ObjectId();
    for (let index = 0; index < 5; index += 1) {
      await notify({ ...base, recipients: [user, other], title: `Item ${index}` });
    }
    const first = await listNotifications(user.toHexString(), { limit: 3 });
    expect(first.notifications.map((n) => n.title)).toEqual(['Item 4', 'Item 3', 'Item 2']);
    const second = await listNotifications(user.toHexString(), {
      limit: 3,
      cursor: first.nextCursor,
    });
    expect(second.notifications.map((n) => n.title)).toEqual(['Item 1', 'Item 0']);
    expect(second.nextCursor).toBeNull();

    await markRead(user.toHexString(), [first.notifications[0]?.id as string]);
    const unread = await listNotifications(user.toHexString(), { unreadOnly: true });
    expect(unread.notifications).toHaveLength(4);
  });
});

describe('only readAt can change', () => {
  it('refuses every other change and every delete', async () => {
    const user = new Types.ObjectId();
    await notify({ ...base, recipients: [user] });
    const filter = { recipientUserId: user };
    const before = await rawAll();
    const writes: (() => Promise<unknown>)[] = [
      () => NotificationModel.updateOne(filter, { $set: { title: 'Changed' } }),
      () => NotificationModel.updateOne(filter, { $set: { readAt: new Date(), title: 'Changed' } }),
      () => NotificationModel.updateOne(filter, { $set: { href: 'https://evil.example' } }),
      () =>
        NotificationModel.updateMany(filter, { $set: { recipientUserId: new Types.ObjectId() } }),
      () => NotificationModel.updateOne(filter, { $set: { readAt: null } }),
      () => NotificationModel.updateOne(filter, { $unset: { readAt: 1 } }),
      () => NotificationModel.updateOne(filter, { $set: { readAt: new Date() } }, { upsert: true }),
      () => NotificationModel.findOneAndUpdate(filter, { $set: { body: 'Changed' } }),
      () => NotificationModel.replaceOne(filter, { ...base, recipientUserId: user }),
      () => NotificationModel.deleteOne(filter),
      () => NotificationModel.deleteMany(filter),
      () =>
        NotificationModel.bulkWrite([
          { updateOne: { filter, update: { $set: { readAt: new Date() } } } },
        ]),
      async () => {
        const doc = await NotificationModel.findOne(filter).orFail();
        doc.readAt = new Date();
        await doc.save();
      },
    ];
    for (const write of writes) {
      await expect(write()).rejects.toThrow(/only marking them read/);
    }
    expect(await rawAll()).toBe(before);

    // The one allowed change.
    await NotificationModel.updateOne(filter, { $set: { readAt: new Date() } });
    const [doc] = await NotificationModel.find(filter).lean();
    expect(doc?.readAt).toBeInstanceOf(Date);
    expect(doc?.title).toBe(base.title);
  });
});
