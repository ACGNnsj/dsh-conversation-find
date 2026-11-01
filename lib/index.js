/**
 * dsh-conversation-find — host half.
 *
 * The feature is entirely client-side (a find bar plus DOM highlighting in the
 * Web UI), so this half only has to exist and mount cleanly: a bundle row needs
 * a resolvable package entry, and any throw here would fail the whole plugin
 * tree at boot. Keep it inert.
 *
 * @module dsh-conversation-find
 */

export const name = 'dsh-conversation-find'

// No host service is required; declaring one as a hard dependency would delay
// `apply` until it appears.
export const inject = []

export function apply(ctx) {
  try {
    const logger = ctx && typeof ctx.logger === 'function' ? ctx.logger('conversation-find') : undefined
    if (logger && typeof logger.info === 'function') {
      logger.info('conversation-find: client-only plugin mounted')
    }
  } catch {
    /* a logging failure must never break boot */
  }
}
