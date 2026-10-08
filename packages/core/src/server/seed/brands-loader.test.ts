import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectDb } from '@pulse/db';
import { BrandModel } from '../brands/model';
import { SEED_BRANDS } from './core-data';
import { coreSeedLoaders } from './loaders';

// The product seed loader (docs/TESTING.md#master-data-tests,
// docs/modules/core.md#bootstrap-system-administrator-account). Made-up data only.

function brandsLoader() {
  const loader = coreSeedLoaders.find((l) => l.name === 'brands');
  if (!loader) throw new Error('No brands loader.');
  return loader;
}

beforeAll(async () => {
  await connectDb();
  await BrandModel.init();
});

beforeEach(async () => {
  await BrandModel.collection.deleteMany({});
});

describe('the product seed loader', () => {
  it('adds the 13 products to an empty database, each with its seed key', async () => {
    expect(await brandsLoader().run()).toEqual({ added: 13, skipped: 0 });

    const brands = await BrandModel.find({}, { name: 1, seedKey: 1, createdBy: 1 }).lean();
    expect(brands).toHaveLength(13);
    expect(brands.map((b) => [b.seedKey, b.name]).sort()).toEqual(
      SEED_BRANDS.map((b) => [b.seedKey, b.name]).sort(),
    );
    expect(brands.every((b) => b.createdBy === null)).toBe(true);
  });

  it('adds nothing on a second run', async () => {
    await brandsLoader().run();
    expect(await brandsLoader().run()).toEqual({ added: 0, skipped: 13 });
    expect(await BrandModel.countDocuments()).toBe(13);
  });

  it('doesn’t add a renamed seeded product again, retired or not', async () => {
    await brandsLoader().run();
    await BrandModel.updateOne({ seedKey: 'general' }, { $set: { name: 'Unbranded' } });
    await BrandModel.updateOne({ seedKey: 'verifone' }, { $set: { deletedAt: new Date() } });

    expect(await brandsLoader().run()).toEqual({ added: 0, skipped: 13 });
    expect(await BrandModel.countDocuments({}, { withDeleted: true })).toBe(13);
    const general = await BrandModel.findOne({ seedKey: 'general' }).lean().orFail();
    expect(general.name).toBe('Unbranded');
  });

  it('counts a product added by hand with a seeded name, in any case, as present', async () => {
    await BrandModel.create({ name: 'extreme networks' });

    expect(await brandsLoader().run()).toEqual({ added: 12, skipped: 1 });
    const matching = await BrandModel.find({ name: 'Extreme Networks' })
      .collation({ locale: 'en', strength: 2 })
      .lean();
    expect(matching).toHaveLength(1);
    expect(matching[0]?.name).toBe('extreme networks');
    expect(matching[0]?.seedKey).toBeNull();
  });
});
