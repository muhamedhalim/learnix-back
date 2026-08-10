import type { JwtPayload } from '../../common/interfaces/user-request.interface';
import { StudentBooksController } from './student-books.controller';

describe('StudentBooksController.purchaseBook (DEF-013)', () => {
  const user: JwtPayload = {
    userId: 'student-1',
    email: 'student@example.com',
    name: 'Student',
    role: 'student',
  };

  function buildController(existing: unknown = null) {
    const bookPurchasesService = {
      checkAlreadyPurchased: jest.fn().mockResolvedValue(existing),
    };
    const booksService = {
      findOne: jest.fn().mockResolvedValue({
        id: 'book-1',
        title: 'Algebra',
        title_ar: 'الجبر',
        price: 100,
      }),
    };
    const controller = new StudentBooksController(
      bookPurchasesService as never,
      booksService as never,
      {} as never,
      {} as never,
    );
    return { controller, bookPurchasesService, booksService };
  }

  it('never claims a payment/order was started for an unpurchased book', async () => {
    const { controller } = buildController();

    const result = (await controller.purchaseBook(user, {
      book_id: 'book-1',
    } as never)) as Record<string, unknown>;

    // The old, misleading contract this replaces.
    expect(result['redirect_to_payment']).toBe(false);
    expect(result).toMatchObject({
      deprecated: true,
      already_purchased: false,
      successor_endpoint: 'POST /payments/orders',
      book: { id: 'book-1', title: 'Algebra', title_ar: 'الجبر', price: 100 },
    });
  });

  it('reports already-purchased books truthfully without fabricating payment state', async () => {
    const existing = { id: 'purchase-1', book_id: 'book-1', student_id: 'student-1' };
    const { controller, booksService } = buildController(existing);

    const result = (await controller.purchaseBook(user, {
      book_id: 'book-1',
    } as never)) as Record<string, unknown>;

    expect(result).toMatchObject({ deprecated: true, already_purchased: true, purchase: existing });
    expect(result).not.toHaveProperty('redirect_to_payment', true);
    // Already-purchased short-circuits before any price lookup — matches
    // the pre-existing behavior, only the "not purchased" branch changed.
    expect(booksService.findOne).not.toHaveBeenCalled();
  });

  it('echoes back the caller-supplied discount/purchase codes verbatim (no silent drop)', async () => {
    const { controller } = buildController();

    const result = (await controller.purchaseBook(user, {
      book_id: 'book-1',
      discount_code: 'SAVE20',
      purchase_code: 'FREE-BOOK-123',
    } as never)) as Record<string, unknown>;

    expect(result).toMatchObject({ discount_code: 'SAVE20', purchase_code: 'FREE-BOOK-123' });
  });
});
