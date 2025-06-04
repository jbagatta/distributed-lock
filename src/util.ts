import { Writable } from "./types"

export class WritableObject<T> implements Writable<T> {
    constructor(public value: T | null, public lockId: string) {}

    update(value: T | null): Writable<T> {
        this.value = value
        return this
    }
}

export interface LockConfiguration {
    namespace: string
    lockTimeoutMs: number
    objectExpiryMs?: number
}

export function validateLockConfiguration(config: LockConfiguration) {
    if (config.lockTimeoutMs <= 0) {
        throw new Error('lockTimeoutMs must be greater than 0')
    }
    if (config.objectExpiryMs && config.objectExpiryMs <= 0) {
        throw new Error('objectExpiryMs must be greater than 0 when set')
    }
}

export class TimeoutError extends Error {
    constructor(key: string) {
        super(`Lock Wait Timeout for key: ${key}`)
        this.name = 'TimeoutError'
    }
}

export type LockStatus = 'locked' | 'unlocked' | 'expired'

export function computeLockDuration(defaultTimeout: number, requestedTimeout?: number) {
    if (!requestedTimeout) return defaultTimeout

    return Math.max(requestedTimeout, defaultTimeout)
}