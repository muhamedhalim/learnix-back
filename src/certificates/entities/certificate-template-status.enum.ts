/**
 * Lifecycle of a certificate template (the reusable design).
 *
 * DRAFT      — editable, invisible to issuance. New templates always start here.
 * PUBLISHED  — selectable when issuing certificates (and as the auto-issue default).
 * ARCHIVED   — kept for history; cannot be used for new issuance. Certificates
 *              already issued from it are unaffected (they carry a snapshot).
 */
export enum CertificateTemplateStatus {
  DRAFT = 'draft',
  PUBLISHED = 'published',
  ARCHIVED = 'archived',
}
