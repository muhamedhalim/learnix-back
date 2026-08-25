import { Inject, Injectable, Optional } from '@nestjs/common';

import { MeetingProvider } from '../entities/meeting-provider.enum';
import { MEETING_PROVIDERS, type MeetingProviderClient } from './providers/meeting-provider.interface';

const CONNECTABLE_PROVIDERS: readonly MeetingProvider[] = [
  MeetingProvider.GOOGLE_MEET,
  MeetingProvider.ZOOM,
  MeetingProvider.MICROSOFT_TEAMS,
];

/**
 * Resolves a connectable meeting provider by name, mirroring
 * `PaymentProviderRegistry`. Ships in Phase 3 with an empty provider list —
 * `MANUAL` is deliberately never registered here (AD-10: it is not a
 * connectable OAuth account, it is the pre-existing hand-typed URL path).
 * Providers register themselves into `MEETING_PROVIDERS` in their own phase
 * without this class changing.
 */
@Injectable()
export class MeetingProviderRegistry {
  private readonly providers: ReadonlyMap<MeetingProvider, MeetingProviderClient>;

  public constructor(
    @Optional() @Inject(MEETING_PROVIDERS) providers: MeetingProviderClient[] = [],
  ) {
    this.providers = new Map(providers.map((provider) => [provider.name, provider]));
  }

  /** Returns null for an unknown or not-yet-implemented provider — callers decide how to fail. */
  public find(name: MeetingProvider): MeetingProviderClient | null {
    return this.providers.get(name) ?? null;
  }

  public isConnectable(name: MeetingProvider): boolean {
    if (name === MeetingProvider.MANUAL) return false;
    return this.find(name)?.isConfigured() ?? false;
  }

  /**
   * The full connectable-provider roster — every entry the teacher
   * integrations UI should render a card for, not just the ones with a
   * concrete implementation yet. `MANUAL` is excluded (AD-10). A provider
   * whose phase hasn't shipped simply reports `configured: false`, the same
   * as one that has shipped but has no env vars set.
   */
  public list(): Array<{ provider: MeetingProvider; configured: boolean }> {
    return CONNECTABLE_PROVIDERS.map((name) => ({
      provider: name,
      configured: this.find(name)?.isConfigured() ?? false,
    }));
  }
}
