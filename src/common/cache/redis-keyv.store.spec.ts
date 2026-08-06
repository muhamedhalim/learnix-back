import { RedisKeyvStore } from './redis-keyv.store';

interface FakeRedisClient {
  get: jest.Mock;
  set: jest.Mock;
  del: jest.Mock;
  scanIterator: jest.Mock;
  isOpen: boolean;
  quit: jest.Mock;
}

function fakeClient(): FakeRedisClient {
  return {
    get: jest.fn().mockResolvedValue(null),
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

  it('clear() scans only keys under the resolved prefix', async () => {
    const client = fakeClient();
    const store = new RedisKeyvStore(client as never, 'learnix:staging:learnix:cache:');

    await store.clear();

    expect(client.scanIterator).toHaveBeenCalledWith(
      expect.objectContaining({ MATCH: 'learnix:staging:learnix:cache:*' }),
    );
  });
});
