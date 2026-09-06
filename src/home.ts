/**
 * Resolve the on-disk credential store path inside the active DSH_HOME.
 *
 * Resolution order:
 *   1. DSH_HOME env var
 *   2. ~/.dsh (default)
 *
 * @module dsh-llm-minimax-oauth/home
 */

import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface HomeContext {
  dshHome: string
  credentialsPath: string
}

export async function resolveHome(): Promise<HomeContext> {
  const dshHome = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  await fs.mkdir(dshHome, { recursive: true })
  return {
    dshHome,
    credentialsPath: path.join(dshHome, 'minimax-oauth.json'),
  }
}
