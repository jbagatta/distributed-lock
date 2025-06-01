import Redis from 'ioredis'
import { IDistributedLock, Readable, Writable, TimeoutError, LockConfiguration, LockStatus } from '../types'
import { LockListener } from './lock-listener'
import { tryAcquireLockLuaScript, tryWriteLockLuaScript, getLockObjLuaScript, redisPubSubChannel } from './data-model'

export class RedisDistributedLock implements IDistributedLock {
    constructor(private readonly redis: Redis, private readonly config: LockConfiguration) { }

    async acquireLock<T>(key: string, timeoutMs: number): Promise<Writable<T>> {
        const namespacedKey = this.toNamespacedKey(key)
        const lockId = crypto.randomUUID()

        let now = Date.now()
        const deadline = now + timeoutMs
        while (now <= deadline) {
          try {
            const listener = new LockListener<T>(this.redis, namespacedKey, timeoutMs)

            const lock = await this.tryAcquireLock<T>(namespacedKey, lockId)
            if (lock.lockId === lockId && lock.lockStatus === 'locked') {
                listener.close()
                return {value: lock.lockObj, lockId}
            }

            await listener.waitUntilNotified()
          } catch {
            now = Date.now()
          }
        }
    
        throw new TimeoutError(namespacedKey)
    }

    private async tryAcquireLock<T>(namespacedKey: string, lockId: string) {
        const result = await this.redis.eval(
            tryAcquireLockLuaScript,
            1,
            namespacedKey,
            lockId,
            this.config.lockTimeoutMs
        )  as string[]
        return {
            lockId: result[0],
            lockStatus: result[1] as LockStatus,
            lockObj: result[2] ? JSON.parse(result[2]) as T : null
        }
    }

    async withLock<T>(
        key: string,
        timeoutMs: number,
        callback: (state: T | null) => Promise<T>
    ): Promise<Readable<T>> {
        const lock = await this.acquireLock<T>(key, timeoutMs)

        try {
            const updatedState = await callback(lock.value) 
            await this.releaseLock(key, {value: updatedState, lockId: lock.lockId!})
            
            return {value: updatedState} 
        } catch(error) {
            await this.releaseLock(key, lock)
    
            throw error
        }
    }

    async releaseLock<T>(key: string, lockObj: Writable<T>): Promise<boolean> {
        const namespacedKey = this.toNamespacedKey(key)
        
        const obj = JSON.stringify(lockObj.value)
        const result = await this.redis.eval(
            tryWriteLockLuaScript, 
            1, 
            namespacedKey, 
            lockObj.lockId, 
            obj,
            this.config.objectExpiryMs ?? -1
        ) as boolean

        if (result) {
            await this.redis.publish(redisPubSubChannel(namespacedKey), obj)
        }
        return result
    }

    async wait<T>(key: string, timeoutMs: number): Promise<Readable<T> | null> {
        const namespacedKey = this.toNamespacedKey(key)
        const listener = new LockListener<T>(this.redis, namespacedKey, timeoutMs)

        const result = await this.redis.eval(getLockObjLuaScript, 1, namespacedKey) as string | null[]
        if (result[0] === 'locked') {
            const value = await listener.waitUntilNotified()
            return {value}
        }

        listener.close()
        return {value: result[1] ? JSON.parse(result[1]) as T : null}
    }

    close(): void {
        // no-op
    }

    private toNamespacedKey(key: string): string {
      return `${this.config.namespace}.${key}`
    }
}
