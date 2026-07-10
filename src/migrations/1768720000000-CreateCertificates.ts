import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Create the certificate system: templates + issued certificates.
 */
export class CreateCertificates1768720000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    // Templates
    await queryRunner.query(`
      CREATE TABLE certificate_templates (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        name VARCHAR(120) NOT NULL,
        title VARCHAR(160) NOT NULL DEFAULT 'Certificate of Completion',
        body TEXT NOT NULL DEFAULT 'This is proudly presented to {{student}} for successfully completing {{course}}.',
        signature_name VARCHAR(120),
        signature_title VARCHAR(120),
        accent_color VARCHAR(9) NOT NULL DEFAULT '#6d28d9',
        is_default BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_certificate_templates_is_default"
        ON certificate_templates(is_default);
    `);

    // Certificates
    await queryRunner.query(`
      CREATE TYPE certificate_status_enum AS ENUM ('issued', 'revoked');
    `);
    await queryRunner.query(`
      CREATE TABLE certificates (
        id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
        certificate_number VARCHAR(40) NOT NULL,
        verification_code VARCHAR(40) NOT NULL,
        student_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        package_id UUID NOT NULL REFERENCES lesson_packages(id) ON DELETE CASCADE,
        student_name VARCHAR(200) NOT NULL,
        course_title VARCHAR(200) NOT NULL,
        teacher_name VARCHAR(200),
        completion_percentage INTEGER NOT NULL DEFAULT 100,
        template_id UUID,
        status certificate_status_enum NOT NULL DEFAULT 'issued',
        issued_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "UQ_certificate_student_package" UNIQUE (student_id, package_id)
      );
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_certificates_verification_code"
        ON certificates(verification_code);
    `);
    await queryRunner.query(`
      CREATE UNIQUE INDEX "IDX_certificates_number"
        ON certificates(certificate_number);
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_certificates_student_id" ON certificates(student_id);
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_certificates_package_id" ON certificates(package_id);
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS certificates;`);
    await queryRunner.query(`DROP TYPE IF EXISTS certificate_status_enum;`);
    await queryRunner.query(`DROP TABLE IF EXISTS certificate_templates;`);
  }
}
