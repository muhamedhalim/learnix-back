import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';

import { PaymentAuditLog } from './entities';

describe('PaymentAuditLog TypeORM registration', () => {
  it('boots a Nest TypeOrm feature module and resolves the repository from initialized metadata', async () => {
    const dataSourceName = 'payment-audit-registration';
    const dataSource = new DataSource({
      type: 'postgres',
      host: 'metadata-only',
      port: 5432,
      username: 'metadata-only',
      password: 'metadata-only',
      database: 'metadata-only',
      entities: [PaymentAuditLog],
    });
    await (dataSource as unknown as { buildMetadatas: () => Promise<void> }).buildMetadatas();

    @Global()
    @Module({
      providers: [{ provide: getDataSourceToken(dataSourceName), useValue: dataSource }],
      exports: [getDataSourceToken(dataSourceName)],
    })
    class MetadataDataSourceModule {}

    const module = await Test.createTestingModule({
      imports: [
        MetadataDataSourceModule,
        TypeOrmModule.forFeature([PaymentAuditLog], dataSourceName),
      ],
    }).compile();

    const repository = module.get<Repository<PaymentAuditLog>>(
      getRepositoryToken(PaymentAuditLog, dataSourceName),
    );
    expect(repository.metadata.target).toBe(PaymentAuditLog);
    expect(dataSource.hasMetadata(PaymentAuditLog)).toBe(true);

    await module.close();
  });
});
