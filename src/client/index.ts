/**
 * dsh-evolve browser half — registers the "dsh-evolve" settings section.
 * The section component owns its own polling + fetch calls to the host's
 * same-origin /api/evolve/* routes.
 * @module dsh-evolve/client
 */

import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { EvolveSettingsSection } from './EvolveSettingsSection.tsx'

/** Required client services. */
export const inject = ['slots']

/**
 * Client plugin body: register the settings section. The section component owns
 * its own polling + action calls to /api/evolve/*.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('settings.section', () => {
    const unregister = ctx.slots.register({
      name: 'settings.section',
      id: 'dsh-evolve',
      order: 150,
      label: () => 'dsh-evolve',
    }, EvolveSettingsSection)
    return () => unregister()
  })
}
