export interface Readable<T> {
    value: Readonly<T> | null
}

export interface Writable<T> {
    value: T | null,
    lockId: string
    update(value: T | null): Writable<T>
}

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

/**
 * A distributed locking system that provides atomic operations across multiple processes.
 * 
 * This interface defines a distributed lock implementation against a shared memory namespace. 
 * It provides a set of operations for acquiring, waiting for, and releasing locks, 
 * as well as for safely executing callbacks within the context of a lock.
 * 
 * The lock mechanism ensures that:
 * - Only one process can hold a lock for a given key at any time
 * - Locks are automatically timed out if the holding process crashes
 * - Data operations on the locked object are atomic and consistent
 */
export interface IDistributedLock {
    /**
     * Acquires a lock and executes the callback on the locked state.
     * On success, writes the updated state.
     * Automatically releases the lock on success or failure.
     */
    withLock<T>(
        key: string, 
        timeoutMs: number, 
        callback: (state: T | null) => Promise<T>
    ): Promise<Readable<T>>

    /** 
     * Waits for timeoutMs milliseconds to acquire a lock for the given key. 
     * Returns the current state of the lock.
     * Throws a TimeoutError if the lock is not acquired by the timeout.
     */
    acquireLock<T>(key: string, timeoutMs: number): Promise<Writable<T>>

    /** 
     * Waits for timeoutMs milliseconds to acquire a lock for the given key. 
     * Returns the current state of the lock.
     * Throws a TimeoutError if the lock is not acquired by the timeout.
     */
    tryAcquireLock<T>(key: string): Promise<{acquired: boolean, value: Writable<T> | undefined}>

    /** 
     * Releases a previously acquired lock and writes the updated state 
     * on release, if the lock is still active. Notifies waiting processes.
     */
    releaseLock<T>(key: string, lockObj: Writable<T>): Promise<boolean>

    /**
     * Waits timeoutMs milliseconds for a lock to become available 
     * and returns its current state as a Readonly object. Does not acquire the lock.
     * Throws a TimeoutError if the wait times out.
     */
    wait<T>(key: string, timeoutMs: number): Promise<Readable<T>>

    /** 
     * Deletes the lock object and lock metadata
     */
    delete(key: string): Promise<boolean>

    /** Closes the distributor and releases all resources. */
    close(): void
}