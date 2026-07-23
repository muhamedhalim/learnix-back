import { typeOrmArtifactPaths } from './data-source';

describe('production TypeORM artifact paths', () => {
  it('discovers compiled entity and migration JavaScript files', () => {
    expect(typeOrmArtifactPaths(true)).toEqual({
      entities: ['dist/**/entities/*.entity.js'],
      migrations: ['dist/src/migrations/[0-9]*-*.js'],
    });
  });
});
