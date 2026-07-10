import { Injectable } from '@nestjs/common';

import { renderFromCatalog } from './parent-template.catalog';
import type { RenderedMessage, TemplateContext } from './template.types';

/**
 * Turns a domain event's typed variables into channel-ready text.
 *
 * Kept as an injectable seam (rather than calling the catalogue directly from
 * the worker) so the renderer can be swapped for a DB-backed or Handlebars
 * implementation without touching the worker, and so it can be stubbed in tests.
 */
@Injectable()
export class TemplateRendererService {
  public render(context: TemplateContext): RenderedMessage {
    return renderFromCatalog(context.eventType, context.language, context.variables);
  }
}
