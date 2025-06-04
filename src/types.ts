export interface Readable<T> {
    value: Readonly<T> | null
}

export interface Writable<T> {
    value: T | null,
    lockId: string
    update(value: T | null): Writable<T>
}

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
     * Waits for timeoutMs milliseconds to acquire a lock for the 
     * given key, then executes the callback on the locked state.
     * On success, writes the updated state.
     * Automatically releases the lock on success or failure.
     */
    withLock<T>(
        key: string, 
        timeoutMs: number, 
        callback: (state: T | null) => Promise<T>,
        lockDuration?: number
    ): Promise<Readable<T>>

    /** 
     * Waits for timeoutMs milliseconds to acquire a lock for the given key. 
     * Returns the current state of the lock.
     * Throws a TimeoutError if the lock is not acquired by the timeout.
     */
    acquireLock<T>(key: string, timeoutMs: number, lockDuration?: number): Promise<Writable<T>>

    /** 
     * Attempts to acquire the lock and immediately returns success or failure 
     * Returns the current state of the lock if acquired.
     */
    tryAcquireLock<T>(key: string, lockDuration?: number): Promise<{acquired: boolean, value: Writable<T> | undefined}>

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

    /*
     * Reset the lock object expiry - for sliding expiration features
     */
    resetExpiry(key: string): Promise<boolean>

    /** Closes the distributor and releases all resources. */
    close(): void
}