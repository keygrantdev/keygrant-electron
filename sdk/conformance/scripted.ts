/**
 * A machine-id source scripted by a vector (`machineIds.source`): the reads the
 * reference makes (machine-id.ts `MachineIdSource`), answered from the JSON.
 */
import type { MachineIdSource } from '../src/machine-id.js'

/** An error as `execFile` and `fs` give it: an errno string or an exit code, or a process killed. */
export interface MachineIdError {
  code?: string | number
  killed?: boolean
  signal?: string
}

/** What a vector scripts of the system its machine id is read from. */
export interface ScriptedSource {
  platform: string
  systemRoot?: string
  /** A file's text, or the error reading it gives; with when it was last written. Unlisted: ENOENT. */
  files?: Record<string, { content?: string; error?: MachineIdError; mtimeMs?: number }>
  /** A command's output, or the error running it gives. Unlisted: ENOENT. */
  commands?: Record<string, { output?: string; error?: MachineIdError }>
}

/** The error a source rejects with, as `execFile` and `fs` do. */
function failure(error: MachineIdError): Error {
  return Object.assign(new Error('scripted failure'), error)
}

/** A `MachineIdSource` that answers from a vector. */
export function scripted(given: ScriptedSource): MachineIdSource {
  const missing = () => failure({ code: 'ENOENT' })
  return {
    platform: given.platform,
    ...(given.systemRoot !== undefined ? { systemRoot: given.systemRoot } : {}),
    async run(command) {
      const answer = given.commands?.[command]
      if (!answer) throw missing()
      if (answer.error) throw failure(answer.error)
      return answer.output ?? ''
    },
    async readFile(path) {
      const file = given.files?.[path]
      if (!file) throw missing()
      if (file.error) throw failure(file.error)
      return file.content ?? ''
    },
    async stat(path) {
      const file = given.files?.[path]
      if (file?.mtimeMs === undefined) throw missing()
      return { mtimeMs: file.mtimeMs }
    },
  }
}
