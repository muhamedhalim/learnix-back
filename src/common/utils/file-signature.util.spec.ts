import { extensionMatchesMime, hasExpectedMagicBytes } from './file-signature.util';

describe('file signature validation', () => {
  it('accepts matching extension, MIME and magic bytes', () => {
    const pdf = Buffer.from('%PDF-1.7\n');
    expect(extensionMatchesMime('worksheet.pdf', 'application/pdf')).toBe(true);
    expect(hasExpectedMagicBytes('application/pdf', pdf)).toBe(true);
  });

  it('rejects renamed or spoofed files before storage', () => {
    const html = Buffer.from('<script>alert(1)</script>');
    expect(extensionMatchesMime('attack.jpg', 'image/jpeg')).toBe(true);
    expect(hasExpectedMagicBytes('image/jpeg', html)).toBe(false);
    expect(extensionMatchesMime('../attack.pdf', 'application/pdf')).toBe(true);
    expect(extensionMatchesMime('attack.exe', 'application/pdf')).toBe(false);
  });
});
