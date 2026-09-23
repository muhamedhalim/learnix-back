import { RedisKeyvStore } from './redis-keyv.store';

interface FakeRedisClient {
  get: jest.Mock;
  mGet: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  scanIterator: jest.Mock;
  isOpen: boolean;
  quit: jest.Mock;
}

function fakeClient(): FakeRedisClient {
  return {
    get: jest.fn().mockResolvedValue(null),
    mGet: jest.fn().mockResolvedValue([]),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    scanIterator: jest.fn().mockReturnValue([]),
    isOpen: true,
    quit: jest.fn().mockResolvedValue(undefined),
  };
}

describe('RedisKeyvStore', () => {
  it('defaults to the production-shaped prefix when no prefix is supplied (unchanged behaviour)', async () => {
    const client = fakeClient();
    const store = new RedisKeyvStore(client as never);

    await store.get('foo');

    expect(client.get).toHaveBeenCalledWith('learnix:cache:foo');
  });

  it('uses the supplied namespace prefix on get/set/delete', async () => {
    const client = fakeClient();
    const store = new RedisKeyvStore(client as never, 'learnix:staging:learnix:cache:');

    await store.get('foo');
    await store.set('foo', 'bar');
    await store.delete('foo');

    expect(client.get).toHaveBeenCalledWith('learnix:staging:learnix:cache:foo');
    expect(client.set).toHaveBeenCalledWith('learnix:staging:learnix:cache:foo', 'bar');
    expect(client.del).toHaveBeenCalledWith('learnix:staging:learnix:cache:foo');
  });

  it('getMany() issues exactly one MGET on prefixed keys and maps null to undefined', async () => {
    const client = fakeClient();
    client.mGet.mockResolvedValue(['{"value":1}', null, '{"value":3}']);
    const store = new RedisKeyvStore(client as never, 'learnix:staging:learnix:cache:');

    const values = await store.getMany<string>(['a', 'b', 'c']);

    expect(client.mGet).toHaveBeenCalledTimes(1);
    expect(client.mGet).toHaveBeenCalledWith([
      'learnix:staging:learnix:cache:a',
      'learnix:staging:learnix:cache:b',
      'learnix:staging:learnix:cache:c',
    ]);
    expect(values).toEqual(['{"value":1}', undefined, '{"value":3}']);
    expect(client.get).not.toHaveBeenCalled();
  });

  it('getMany() with no keys sends no command', async () => {
    const client = fakeClient();
    const store = new RedisKeyvStore(client as never);

    await expect(store.getMany([])).resolves.toEqual([]);
    expect(client.mGet).not.toHaveBeenCalled();
  });

  it('clear() scans only keys under the resolved prefix', async () => {
    const client = fakeClient();
    const store = new RedisKeyvStore(client as never, 'learnix:staging:learnix:cache:');

    await store.clear();

    expect(client.scanIterator).toHaveBeenCalledWith(
      expect.objectContaining({ MATCH: 'learnix:staging:learnix:cache:*' }),
    );
  });
});
