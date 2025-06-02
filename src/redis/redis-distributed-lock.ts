import Redis from 'ioredis'
import { IDistributedLock, Readable, Writable, TimeoutError, LockConfiguration, LockStatus } from '../types'
import { LockListener } from './lock-listener'
import { tryAcquireLockLuaScript, tryWriteLockLuaScript, getLockObjLuaScript, redisPubSubChannel } from './data-model'

export class RedisDistributedLock implements IDistributedLock {
    private readonly lockListener: LockListener
    private active = false

    private constructor(private readonly redis: Redis, private readonly config: LockConfiguration) {
        this.lockListener = new LockListener(redis, config.namespace)
        this.active = true
    }

    static async create(redis: Redis, config: LockConfiguration): Promise<IDistributedLock> {
        return new RedisDistributedLock(redis, config)
    }

    async withLock<T>(
        key: string,
        timeoutMs: number,
        callback: (state: T | null) => Promise<T>
    ): Promise<Readable<T>> {
        const lock = await this.acquireLock<T>(key, timeoutMs)

        try {
            const updatedState = await callback(lock.value) 
         
            const updated = await this.releaseLock(key, {value: updatedState, lockId: lock.lockId!})
            if (!updated) {
                throw new TimeoutError(key)
            }

            return {value: updatedState} 
        } catch(error) {
            await this.releaseLock(key, lock)
    
            throw error
        }
    }

    async acquireLock<T>(key: string, timeoutMs: number): Promise<Writable<T>> {
        this.checkActive()
        const namespacedKey = this.toNamespacedKey(key)
        const lockId = crypto.randomUUID()

        let now = Date.now()
        const deadline = now + timeoutMs
        while (now <= deadline) {
          try {
            // initialize listener before trying to acquire lock to avoid race condition
            const listener = this.lockListener.waitUntilNotified<T>(namespacedKey, timeoutMs)

            const lock = await this.getOrCreateLock<T>(namespacedKey, lockId)
            if (lock.lockId === lockId && lock.lockStatus === 'locked') {
                this.lockListener.cancel(listener)
                return {value: lock.lockObj, lockId}
            }

            // wait until notified of lock release to retry
            await listener
          } catch { 
            // suppress timeouts and retry 
          }
          now = Date.now()
        }

        const lastTry = await this.tryAcquireLock<T>(key)
        if (lastTry[0]) {
            return lastTry[1]!
        }
    
        throw new TimeoutError(namespacedKey)
    }

    public async tryAcquireLock<T>(key: string): Promise<[boolean, Writable<T> | undefined]> {
        this.checkActive()
        const namespacedKey = this.toNamespacedKey(key)
        const lockId = crypto.randomUUID()

        const lock = await this.getOrCreateLock<T>(namespacedKey, lockId)
        if (lock.lockId === lockId && lock.lockStatus === 'locked') {
            return [true, {value: lock.lockObj, lockId}]
        }

        return [false, undefined]
    }

    private async getOrCreateLock<T>(namespacedKey: string, lockId: string) {
        const result = await this.redis.eval(
            tryAcquireLockLuaScript,
            1,
            namespacedKey,
            lockId,
            this.config.lockTimeoutMs
        )  as (string | null)[]

        return {
            lockId: result[0],
            lockStatus: result[1] as LockStatus,
            lockObj: result[2] ? JSON.parse(result[2]) as T : null
        }
    }

    async releaseLock<T>(key: string, lockObj: Writable<T>): Promise<boolean> {
        this.checkActive()
        const namespacedKey = this.toNamespacedKey(key)
        
        const obj = JSON.stringify(lockObj.value)
        const result = await this.redis.eval(
            tryWriteLockLuaScript, 
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

    async wait<T>(key: string, timeoutMs: number): Promise<Readable<T>> {
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
