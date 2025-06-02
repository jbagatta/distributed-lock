import Redis from 'ioredis'
import { RedisDistributedLock } from '../src/redis/redis-distributed-lock'
import { IDistributedLock, TimeoutError, LockConfiguration, Readable } from '../src/types'

describe('RedisDistributedLock', () => {
    let redis1: Redis
    let redis2: Redis
    let lock1: IDistributedLock
    let lock2: IDistributedLock
    
    const config: LockConfiguration = {
        namespace: 'test-locks',
        lockTimeoutMs: 2000,
        objectExpiryMs: 5000
    }

    beforeEach(async () => {
        redis1 = new Redis('redis://localhost:6379')
        redis2 = new Redis('redis://localhost:6379')
        
        lock1 = new RedisDistributedLock(redis1, config)
        lock2 = new RedisDistributedLock(redis2, config)
    })

    afterEach(async () => {
        lock1.close()
        lock2.close()
        await redis1.quit()
        await redis2.quit()
    })

    describe('acquireLock', () => {
        it('should acquire lock when no other process holds it - returns null if new object', async () => {
            const key = crypto.randomUUID()

            const result = await lock1.acquireLock<string>(key, 100)
            await lock1.releaseLock(key, result)

            expect(result.lockId).toBeDefined()
            expect(result.value).toBeNull()
        })

        it('should acquire lock when no other process holds it - returns existing object', async () => {
            const key = crypto.randomUUID()
            const value = crypto.randomUUID()

            await lock1.withLock<string>(key, 100, async (state) => {
                expect(state).toBeNull()
                return value
            })

            const result = await lock1.acquireLock<string>(key, 100)
            await lock1.releaseLock(key, result)

            expect(result.lockId).toBeDefined()
            expect(result.value).toBe(value)
        })

        it('should throw TimeoutError when lock cannot be acquired within timeout', async () => {
            const key = crypto.randomUUID()

            const lock = await lock1.acquireLock<string>(key, 100)
            
            await expect(lock2.acquireLock<string>(key, 100)).rejects.toThrow(TimeoutError)

            await lock1.releaseLock(key, lock)
        })

        it('should allow second process to acquire lock after first process releases it', async () => {
            const key = crypto.randomUUID()

            const lock1Result = await lock1.acquireLock<string>(key, 100)
            const lock2Promise = lock2.acquireLock<string>(key, 1000)

            await sleep(500)
            await lock1.releaseLock(key, {value: 'newval', lockId: lock1Result.lockId})
            
            const lock2Result = await lock2Promise
            await lock2.releaseLock(key, lock2Result)
            
            expect(lock2Result.value).toBe('newval')
            expect(lock2Result.lockId).not.toBe(lock1Result.lockId)
        })

        it('should expire lock after timeout', async () => {
            const key = crypto.randomUUID()

            const lock1Result = await lock1.acquireLock<string>(key, 100)
            await sleep(config.lockTimeoutMs - 200)

            const lock2Promise = lock2.acquireLock<string>(key, 1000)
            await sleep(500)

            const failedLockWrite = await lock1.releaseLock(key, {value: 'NOPE', lockId: lock1Result.lockId})
            expect(failedLockWrite).toBe(false)

            const lock2Result = await lock2Promise
            const lock2Release = await lock2.releaseLock(key, lock2Result)

            expect(lock2Release).toBe(true)
            expect(lock2Result.value).toBeNull()
        })

        it('should maintain data consistency when multiple processes try to modify the same object', async () => {
            const key = crypto.randomUUID()

            const value1 = crypto.randomUUID()
            const lockResult1 = await lock1.acquireLock<string>(key, 100)
            await lock1.releaseLock(key, {value: value1, lockId: lockResult1.lockId})

            const value2 = crypto.randomUUID()
            const lockResult2 = await lock2.acquireLock<string>(key, 100)
            expect(lockResult2.value).toBe(value1)
            await lock2.releaseLock(key, {value: value2, lockId: lockResult2.lockId})

            const result = await lock1.wait<string>(key, 100)
            expect(result?.value).toBe(value2)
        })
    })

    describe('tryAcquireLock', () => {
        it('should return true immediately after acquiring lock', async () => {
            const key = crypto.randomUUID()
            const value = crypto.randomUUID()

            await lock1.withLock<string>(key, 100, async (state) => {
                expect(state).toBeNull()
                return value
            })
            
            const lock1Result = await lock1.tryAcquireLock<string>(key)

            expect(lock1Result[0]).toBe(true)
            expect(lock1Result[1]!.value).toBe(value)
        })

        it('should return false immediately if lock is not acquired', async () => {
            const key = crypto.randomUUID()
            const value = crypto.randomUUID()

            await lock1.withLock<string>(key, 100, async (state) => {
                expect(state).toBeNull()
                return value
            })

            const lockResult2 = await lock2.acquireLock<string>(key, 100)

            const lock1Result = await lock1.tryAcquireLock<string>(key)

            expect(lock1Result[0]).toBe(false)
            expect(lock1Result[1]).toBeUndefined()

            await lock2.releaseLock(key, lockResult2)
        })
    })

    describe('withLock', () => {
        it('should execute callback with current state and release lock', async () => {
            const key = crypto.randomUUID()
            const initialValue = crypto.randomUUID()
            
            const result1 = await lock1.withLock<string>(key, 100, async (state) => {
                expect(state).toBeNull()
                return initialValue
            })
            expect(result1.value).toEqual(initialValue)
            
            const newValue = crypto.randomUUID()
            const result2 = await lock2.withLock<string>(key, 100, async (state) => {
                expect(state).toEqual(initialValue)
                return newValue
            })
            expect(result2.value).toEqual(newValue)
            
            const finalResult = await lock1.wait<string>(key, 100)
            expect(finalResult.value).toEqual(newValue)
        })

        it('should release lock even if callback throws an error', async () => {
            const key = crypto.randomUUID()
            
            await expect(lock1.withLock(key, 100, async () => {
                throw new Error('Test error')
            })).rejects.toThrow('Test error')
            
            const result = await lock2.acquireLock(key, 100)
            expect(result.value).toBeNull()
            await lock2.releaseLock(key, result)
        })

        it('should timeout if callback takes too long', async () => {
            const key = crypto.randomUUID()
            
            await expect(lock1.withLock(key, 100, async () => {
                await sleep(config.lockTimeoutMs + 100)
                return 'NOPE'
            })).rejects.toThrow(TimeoutError)
            
            const result = await lock2.acquireLock(key, 100)
            expect(result.value).toBeNull()
        })

        it('should handle concurrent withLock operations correctly', async () => {
            const key = crypto.randomUUID()
            const operations: Promise<Readable<{ count: number }>>[] = []
            
            const count = 5
            for (let i = 0; i < count; i++) {
                operations.push(
                    lock1.withLock<{count: number}>(key, 1500, async (state) => {
                        const currentCount = state?.count ?? 0
                        return { count: currentCount + 1 }
                    })
                )
                operations.push(
                    lock2.withLock<{count: number}>(key, 1500, async (state) => {
                        const currentCount = state?.count ?? 0
                        return { count: currentCount + 1 }
                    })
                )
            }
            
            await Promise.all(operations)
            
            const finalResult = await lock1.wait<{count: number}>(key, 100)
            expect(finalResult.value?.count).toEqual(2*count)
        })
    })

    describe('wait', () => {
        it('should return current state without acquiring lock', async () => {
            const key = crypto.randomUUID()
            const value = {count: 123}
            
            const lock1Result = await lock1.acquireLock<{count: number}>(key, 100)
            
            const result = lock2.wait<{count: number}>(key, 1000)

            await sleep(500)
            await lock1.releaseLock(key, { lockId: lock1Result.lockId!, value })

            expect((await result)?.value).toEqual(value)
            
            const finalResult = await lock1.acquireLock<{count: number}>(key, 100)
            expect(finalResult.value).toEqual(value)
            await lock1.releaseLock(key, finalResult)
        })

        it('should throw TimeoutError if wait times out', async () => {
            const key = crypto.randomUUID()
            
            const lockResult = await lock1.acquireLock<number>(key, 100)
            
            await expect(lock2.wait<number>(key, 100)).rejects.toThrow(TimeoutError)
            await lock1.releaseLock(key, lockResult)
        })
    })

    describe('releaseLock', () => {
        it('should update value when releasing lock and return true', async () => {
            const key = crypto.randomUUID()
            const value = 123
            
            const lock1Result = await lock1.acquireLock<number>(key, 100)
            const updated = await lock1.releaseLock(key, { lockId: lock1Result.lockId!, value })
            expect(updated).toBe(true)
            
            const finalResult = await lock2.wait<number>(key, 100)
            expect(finalResult.value).toEqual(value)
        })

        it('should not update value when releasing expired lock and return false', async () => {
            const key = crypto.randomUUID()
            const value = 123
            
            const lock1Result = await lock1.acquireLock<number>(key, 100)
            await sleep(config.lockTimeoutMs + 100)

            const updated = await lock1.releaseLock(key, { lockId: lock1Result.lockId!, value })
            expect(updated).toBe(false)
            
            const finalResult = await lock2.wait<number>(key, 100)
            expect(finalResult.value).toBeNull()
        })
    })
}) 

export async function sleep(ms: number) {
    return new Promise((res) => {
        setTimeout(res, ms)
    })
}