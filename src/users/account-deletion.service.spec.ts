import { AccountDeletionService } from './account-deletion.service';
import { UserRole } from './entities/user-role.enum';

describe('AccountDeletionService', () => {
  it('treats TypeORM PostgreSQL DELETE [rows, rowCount] output as one successful deletion', async () => {
    const manager = {
      query: jest.fn((sql: string) => {
        if (sql.includes('SELECT id, name, email, role FROM users')) {
          return Promise.resolve([
            {
              id: 'student-1',
              name: 'Student',
              email: 'student@example.test',
              role: UserRole.STUDENT,
            },
          ]);
        }
        if (sql.includes("SELECT 'orders' AS table")) return Promise.resolve([]);
        if (sql.includes('information_schema.table_constraints')) return Promise.resolve([]);
        if (sql.includes('DELETE FROM users')) return Promise.resolve([[{ id: 'student-1' }], 1]);
        return Promise.resolve([]);
      }),
      getRepository: jest.fn(() => ({ save: jest.fn().mockResolvedValue(undefined) })),
    };
    const dataSource = {
      transaction: jest.fn((work: (entityManager: typeof manager) => unknown) => work(manager)),
      manager,
      getRepository: jest.fn(),
    };
    const service = new AccountDeletionService(dataSource as never);

    await expect(
      service.permanentlyDelete('student-1', UserRole.STUDENT, 'admin-1'),
    ).resolves.toMatchObject({
      deleted: true,
      alreadyDeleted: false,
    });
  });

  it('blocks permanent deletion when financial history exists', async () => {
    const manager = {
      query: jest.fn((sql: string) => {
        if (sql.includes('SELECT id, name, email, role FROM users')) {
          return Promise.resolve([
            {
              id: 'teacher-1',
              name: 'Teacher',
              email: 'teacher@example.test',
              role: UserRole.TEACHER,
            },
          ]);
        }
        if (sql.includes("SELECT 'orders' AS table")) {
          return Promise.resolve([{ table: 'orders', count: 1 }]);
        }
        return Promise.resolve([]);
      }),
      getRepository: jest.fn(),
    };
    const dataSource = {
      transaction: jest.fn((work: (entityManager: typeof manager) => unknown) => work(manager)),
      manager,
      getRepository: jest.fn(),
    };
    const service = new AccountDeletionService(dataSource as never);

    await expect(
      service.permanentlyDelete('teacher-1', UserRole.TEACHER, 'admin-1'),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'ACCOUNT_DELETE_FINANCIAL_RECORDS_RETAINED' }),
    });
  });
});
