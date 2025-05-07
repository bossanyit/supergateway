import type { Logger } from '../types.js'

function formatTimestamp(): string {
  const iso = new Date().toISOString()
  const [date, timeWithMs] = iso.split('T')
  const time = timeWithMs.split('.')[0]
  return `${date} ${time}`
}

// Returns a Logger that prefixes each message with [name ISO_TIMESTAMP]
export function createLogger(name: string): Logger {
  const prefix = () => `[${name} ${formatTimestamp()}]`
  return {
    info: (...args: any[]) => console.log(prefix(), ...args),
    error: (...args: any[]) => console.error(prefix(), ...args),
  }
}
