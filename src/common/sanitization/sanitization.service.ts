import { Injectable, Logger } from '@nestjs/common';

import sanitizeHtml from 'sanitize-html';

/**
 * Sanitization Service for protecting against XSS attacks
 *
 * Provides multiple sanitization levels for different types of user content:
 * - STRICT: Plain text only (usernames, titles)
 * - BASIC: Limited HTML for rich text (course descriptions, lessons)
 * - PERMISSIVE: More HTML tags for advanced content editors
 *
 * Always sanitize on WRITE (when saving to DB), not on READ.
 * This ensures data is clean and prevents double-sanitization.
 */
@Injectable()
export class SanitizationService {
  private readonly logger = new Logger(SanitizationService.name);

  /**
   * STRICT sanitization - strips ALL HTML tags
   * Use for: usernames, titles, short descriptions where HTML is not needed
   */
  public sanitizeStrict(dirty: string): string {
    if (dirty === '') {
      return '';
    }

    const clean = sanitizeHtml(dirty, {
      allowedTags: [], // No HTML tags allowed
      allowedAttributes: {}, // No attributes allowed
    });

    if (this.containsHtml(dirty) && dirty !== clean) {
      this.logger.warn(
        `Stripped HTML from strict input: ${dirty.substring(0, 50)}...`,
      );
    }

    return clean.trim();
  }

  /**
   * BASIC sanitization - allows safe formatting tags
   * Use for: course descriptions, lesson content, announcements
   * Allows: bold, italic, paragraphs, lists, links
   */
  public sanitizeBasic(dirty: string): string {
    if (dirty === '') {
      return '';
    }

    const clean = sanitizeHtml(dirty, {
      allowedTags: [
        'p',
        'br',
        'strong',
        'b',
        'em',
        'i',
        'u',
        'ul',
        'ol',
        'li',
        'a',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'blockquote',
        'code',
        'pre',
      ],
      allowedAttributes: {
        a: ['href', 'title', 'target', 'rel'],
        // No other attributes allowed to prevent data-* attributes used in XSS
      },
      allowedSchemes: ['http', 'https', 'mailto'],
      allowedSchemesByTag: {
        a: ['http', 'https', 'mailto'],
      },
      // Transform all links to open in new tab with security attributes
      transformTags: {
        a: (_tagName: string, attribs: Record<string, string>) => {
          return {
            tagName: 'a',
            attribs: {
              ...attribs,
              target: '_blank',
              rel: 'noopener noreferrer', // Security: prevent window.opener access
            },
          };
        },
      },
    });

    if (dirty !== clean) {
      this.logger.debug(
        `Sanitized basic HTML input (length: ${String(dirty.length)} -> ${String(clean.length)})`,
      );
    }

    return clean;
  }

  /**
   * PERMISSIVE sanitization - allows more HTML including images
   * Use for: advanced content editors, blog posts, rich course content
   * Allows: all basic tags + images, tables, divs with limited styling
   */
  public sanitizePermissive(dirty: string): string {
    if (dirty === '') {
      return '';
    }

    const clean = sanitizeHtml(dirty, {
      allowedTags: [
        'p',
        'br',
        'strong',
        'b',
        'em',
        'i',
        'u',
        's',
        'ul',
        'ol',
        'li',
        'a',
        'h1',
        'h2',
        'h3',
        'h4',
        'h5',
        'h6',
        'blockquote',
        'code',
        'pre',
        'img',
        'table',
        'thead',
        'tbody',
        'tr',
        'th',
        'td',
        'div',
        'span',
        'hr',
      ],
      allowedAttributes: {
        a: ['href', 'title', 'target', 'rel'],
        img: ['src', 'alt', 'title', 'width', 'height'],
        table: ['border', 'cellpadding', 'cellspacing'],
        td: ['colspan', 'rowspan'],
        th: ['colspan', 'rowspan'],
        div: ['class'], // Allow class for styling but sanitize class names
        span: ['class'],
      },
      allowedSchemes: ['http', 'https', 'mailto', 'data'],
      allowedSchemesByTag: {
        a: ['http', 'https', 'mailto'],
        img: ['http', 'https', 'data'], // Allow data URIs for inline images
      },
      // Prevent javascript: URLs and other XSS vectors
      allowedSchemesAppliedToAttributes: ['href', 'src'],
      transformTags: {
        a: (_tagName: string, attribs: Record<string, string>) => {
          return {
            tagName: 'a',
            attribs: {
              ...attribs,
              target: '_blank',
              rel: 'noopener noreferrer',
            },
          };
        },
        // Security: Validate data URIs in img tags (prevent XSS and DoS)
        img: (tagName: string, attribs: Record<string, string>) => {
          const { src, ...rest } = attribs;
          if (src?.startsWith('data:') === true) {
            // Validate MIME type - only allow safe image formats
            const validDataUriPattern =
              /^data:image\/(png|jpeg|jpg|gif|webp);base64,/;
            if (!validDataUriPattern.test(src)) {
              // Strip invalid data URI (e.g., data:text/html, data:application/javascript)
              return { tagName, attribs: rest };
            }

            // Check size limit (max 5MB base64 ~= 6.7MB encoded)
            const base64Data = src.split(',')[1];
            if ((base64Data?.length ?? 0) > 5 * 1024 * 1024) {
              // Strip oversized data URI to prevent DoS
              return { tagName, attribs: rest };
            }
          }
          return { tagName, attribs };
        },
      },
      // Prevent style attribute abuse
      allowedStyles: {},
    });

    if (dirty !== clean) {
      this.logger.debug(
        `Sanitized permissive HTML input (length: ${String(dirty.length)} -> ${String(clean.length)})`,
      );
    }

    return clean;
  }

  /**
   * Sanitize an object's string fields
   * Useful for sanitizing DTOs with multiple text fields
   */
  public sanitizeObject<T extends Record<string, unknown>>(
    obj: T,
    fieldsToSanitize: Array<keyof T>,
    level: 'strict' | 'basic' | 'permissive' = 'basic',
  ): T {
    const sanitized = { ...obj };

    for (const field of fieldsToSanitize) {
      if (typeof obj[field] === 'string') {
        const originalValue = obj[field] as string;
        let sanitizedValue: string;

        switch (level) {
          case 'strict':
            sanitizedValue = this.sanitizeStrict(originalValue);
            break;
          case 'permissive':
            sanitizedValue = this.sanitizePermissive(originalValue);
            break;
          case 'basic':
            sanitizedValue = this.sanitizeBasic(originalValue);
            break;
        }

        sanitized[field] = sanitizedValue as T[keyof T];
      }
    }

    return sanitized;
  }

  /**
   * Check if a string contains HTML tags
   */
  private containsHtml(str: string): boolean {
    return /<[^>]*>/g.test(str);
  }

  /**
   * Strip all HTML and return plain text
   * Use for: search indexing, previews, metadata
   */
  public toPlainText(html: string): string {
    if (html === '') {
      return '';
    }

    return sanitizeHtml(html, {
      allowedTags: [],
      allowedAttributes: {},
    }).trim();
  }

  /**
   * Validate that content doesn't contain suspicious patterns
   * Returns true if content appears safe, false if suspicious
   */
  public validateSafety(content: string): { isSafe: boolean; reason?: string } {
    if (content === '') {
      return { isSafe: true };
    }

    // Check for common XSS patterns that might slip through
    const suspiciousPatterns = [
      /javascript:/gi,
      /on\w+\s*=/gi, // onclick=, onerror=, etc.
      /<script/gi,
      /<iframe/gi,
      /data:text\/html/gi,
      /vbscript:/gi,
    ];

    for (const pattern of suspiciousPatterns) {
      if (pattern.test(content)) {
        this.logger.warn(`Suspicious pattern detected: ${String(pattern)}`);
        return {
          isSafe: false,
          reason: `Content contains potentially malicious pattern: ${String(pattern)}`,
        };
      }
    }

    return { isSafe: true };
  }
}
