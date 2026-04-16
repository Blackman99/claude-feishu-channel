import type { RenderEvent } from "../../../../src/claude/render-event.js";

export type EmitFn = (event: RenderEvent) => Promise<void>;

/**
 * Records RenderEvents emitted by the session under test.
 *
 * - `events`: chronological list of everything the session emitted
 * - `emit`: the callback to pass to `session.submit(...)`
 * - `failNextEmitWith(err)`: arm the spy so the next emit call
 *   rejects — lets tests exercise the session's "emit threw" branch
 *   without smuggling in production Feishu-client errors
 */
export class SpyRenderer {
  readonly events: RenderEvent[] = [];
  private pendingError: unknown | null = null;

  readonly emit: EmitFn = async (event: RenderEvent) => {
    if (this.pendingError !== null) {
      const err = this.pendingError;
      this.pendingError = null;
      throw err;
    }
    this.events.push(event);
  };

  failNextEmitWith(err: unknown): void {
    this.pendingError = err;
  }

  eventsOfType<T extends RenderEvent["type"]>(
    type: T,
  ): Extract<RenderEvent, { type: T }>[] {
    return this.events.filter(
      (e): e is Extract<RenderEvent, { type: T }> => e.type === type,
    );
  }
}
