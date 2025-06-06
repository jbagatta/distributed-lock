import Redis from 'ioredis'
import { LockConfiguration, IDistributedLock, Readable, Writable } from '../types'
import { LockStatus, computeLockDuration, TimeoutError, validateLockConfiguration, WritableObject } from '../util'
import { LockListener } from './lock-listener'
import { tryAcquireLockLuaScript, tryWriteLockLuaScript, getLockObjLuaScript } from './data-model'

export class RedisDistributedLock implements IDistributedLock {
    private readonly lockListener: LockListener
    private active = false

    private constructor(private readonly redis: Redis, private readonly config: LockConfiguration) {
        this.lockListener = new LockListener(redis, config.namespace)
        this.active = true
    }

    static async create(redis: Redis, config: LockConfiguration): Promise<IDistributedLock> {
        validateLockConfiguration(config)
        
        return new RedisDistributedLock(redis, config)
    }

    public async withLock<T>(
        key: string,
        timeoutMs: number,
        callback: (state: T | null) => Promise<T>, 
        lockDuration?: number
    ): Promise<Readable<T>> {
        const lock = await this.acquireLock<T>(key, timeoutMs, lockDuration)

        try {
            const updatedState = await callback(lock.value) 
            const result = lock.update(updatedState)    
         
            const updated = await this.releaseLock(key, result)
            if (!updated) {
                throw new TimeoutError(key)
            }

            return result
        } catch(error) {
            await this.releaseLock(key, lock)
    
            throw error
        }
    }

    public async acquireLock<T>(key: string, timeoutMs: number, lockDuration?: number): Promise<Writable<T>> {
        this.checkActive()
        const namespacedKey = this.toNamespacedKey(key)
        const lockId = crypto.randomUUID()

        const duration = computeLockDuration(this.config.defaultLockDurationMs, lockDuration)
        
        let now = Date.now()
        const deadline = now + timeoutMs
        while (now < deadline) {
          try {
            const unlockTimeout = deadline - now

            // initialize listener before trying to acquire lock to avoid race condition
            const listener = this.lockListener.waitUntilNotified<T>(namespacedKey, unlockTimeout)

            const lock = await this.getOrCreateLock<T>(namespacedKey, lockId, duration)
            if (lock.lockId === lockId && lock.lockStatus === 'locked') {
                this.lockListener.cancel(listener)
                return new WritableObject(lock.lockObj, lockId)
            }

            // wait until notified of lock release to retry
            await listener
          } catch { 
            // suppress timeouts and retry 
          }
          now = Date.now()
        }

        const lastTry = await this.tryAcquireLock<T>(key)
        if (lastTry.acquired) {
            return lastTry.value!
        }
    
        throw new TimeoutError(namespacedKey)
    }

    public async tryAcquireLock<T>(key: string, lockDuration?: number): Promise<{acquired: boolean, value: Writable<T> | undefined}> {
        this.checkActive()
        const namespacedKey = this.toNamespacedKey(key)
        const lockId = crypto.randomUUID()

        const duration = computeLockDuration(this.config.defaultLockDurationMs, lockDuration)
        const lock = await this.getOrCreateLock<T>(namespacedKey, lockId, duration)
        if (lock.lockId === lockId && lock.lockStatus === 'locked') {
            return {acquired: true, value: new WritableObject(lock.lockObj, lockId)}
        }

        return {acquired: false, value: undefined}
    }

    private async getOrCreateLock<T>(namespacedKey: string, lockId: string, timeout: number) {
        const result = await this.redis.eval(
            tryAcquireLockLuaScript(this.config.replication),
            1,
            namespacedKey,
            lockId,
            timeout
        )  as (string | null)[]

        return {
            lockId: result[0],
            lockStatus: result[1] as LockStatus,
            lockObj: result[2] ? JSON.parse(result[2]) as T : null
        }
    }

    public async releaseLock<T>(key: string, lockObj: Writable<T>): Promise<boolean> {
        this.checkActive()
        const namespacedKey = this.toNamespacedKey(key)
        
        const obj = JSON.stringify(lockObj.value)
        const result = await this.redis.eval(
            tryWriteLockLuaScript(this.config.replication), 
            1, 
            namespacedKey, 
            lockObj.lockId, 
            obj,
            this.config.objectExpiryMs ?? -1
        ) 

        const success = result === 1
        if (success) {
            await this.lockListener.notify(namespacedKey, lockObj.value)
        }
        return success
    }

    public async wait<T>(key: string, timeoutMs: number): Promise<Readable<T>> {
        this.checkActive()
        const namespacedKey = this.toNamespacedKey(key)
        const listener = this.lockListener.waitUntilNotified<T>(namespacedKey, timeoutMs)

        const result = await this.redis.eval(
            getLockObjLuaScript, 
            1, 
            namespacedKey
        ) as (string | null)[]

        if (result[0] === 'locked') {
            const value = await listener
            return {value}
        }

        this.lockListener.cancel(listener)
        return {value: result[1] ? JSON.parse(result[1]) as T : null}
    }

    public async delete(key: string): Promise<boolean> {
        this.checkActive()

        const lock = await this.acquireLock(key, this.config.defaultLockDurationMs)
        return await this.releaseLock(key, lock.update(null))
    }

    close(): void {
        this.lockListener.close()
        this.active = false
    }

    private toNamespacedKey(key: string): string {
      return `${this.config.namespace}.${key}`
    }

    private checkActive(): void {
      if (!this.active) {
        throw new Error('RedisDistributedLock closed')
      }
    }
}
