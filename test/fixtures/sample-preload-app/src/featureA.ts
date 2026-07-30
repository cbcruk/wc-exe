import { sharedValue } from './shared'

export function featureA(): string {
  return sharedValue()
}
