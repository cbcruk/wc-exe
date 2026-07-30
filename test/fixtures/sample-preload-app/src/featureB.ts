import { sharedValue } from './shared'

export function featureB(): string {
  return `${sharedValue()}-B`
}
