import type { ParentEventType } from '../../common/events/parent-event-type.enum';
import type { PreferredLanguage } from '../../guardians/entities';

/**
 * A rendered message, ready for a channel adapter.
 *
 * `whatsappTemplate` is present when the event has an approved Meta message
 * template. Meta only permits free-form text inside a 24-hour customer service
 * window, which a parent who never messages us will never open — so every
 * business-initiated notification must go out as a template. `body` is the
 * plain-text equivalent, used by SMS and stored for the admin surface.
 */
export interface RenderedMessage {
  /** Stable identifier of what was rendered, e.g. `exam_graded.ar`. */
  templateKey: string;
  body: string;
  whatsappTemplate?: {
    /** Template name as registered in the Meta Business Manager. */
    name: string;
    /** BCP-47-ish locale Meta expects, e.g. `ar` / `en`. */
    language: string;
    /**
     * Positional body parameters, in the order the approved template declares
     * them. Meta rejects a mismatched count, so template edits must be made
     * here and in Business Manager together.
     */
    bodyParameters: string[];
  };
}

export interface TemplateContext {
  eventType: ParentEventType;
  language: PreferredLanguage;
  variables: Record<string, unknown>;
}

/** Renders one event type in one language. */
export interface ParentTemplate {
  readonly eventType: ParentEventType;
  readonly language: PreferredLanguage;
  render(variables: Record<string, unknown>): RenderedMessage;
}
