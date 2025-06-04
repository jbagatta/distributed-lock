import { KV, QueuedIterator, KvEntry, NatsConnection, StorageType, nanos } from 'nats'
import { LockConfiguration, TimeoutError, validateLockConfiguration, Writable, WritableObject } from '../types'
import { Readable } from '../types'
import { IDistributedLock } from '../types'

type LockStatus = 'locked' | 'unlocked' | 'expired'
interface LockMessage {
    status: LockStatus
    lockId?: string,
    value?: string
}
interface LockState extends LockMessage {
    revision?: number
    timestamp: number
}

type MessageHandler = (lockState: LockState) => Promise<void>
interface SynchronizedObject {
    watchers: Map<string, MessageHandler>
    state: LockState
}

export class JetstreamDistributedLock implements IDistributedLock {
  private state = new Map<string, SynchronizedObject>()
  private watch: QueuedIterator<KvEntry> | undefined
  private active = false
  private initialized = false

  private constructor(private readonly kv: KV, private readonly config: LockConfiguration) { }

  static async connect(natsClient: NatsConnection, config: LockConfiguration): Promise<IDistributedLock> {
    validateLockConfiguration(config)

    const kv = await natsClient.jetstream().views.kv(config.namespace, { bindOnly: true })
    console.log(`JetstreamDistributedLock connected to namespace ${config.namespace}: ${JSON.stringify(await kv.status())}`)
    
    const distributor = new JetstreamDistributedLock(kv, config)
    await new Promise<void>(distributor.initialize.bind(distributor))
    
    return distributor
  }
  
  static async create(natsClient: NatsConnection, config: LockConfiguration): Promise<IDistributedLock> {
    validateLockConfiguration(config)
    
    const kv = await natsClient.jetstream().views.kv(config.namespace, { 
      history: 1,
      ttl: config.objectExpiryMs ? nanos(config.objectExpiryMs) : undefined,
      storage: StorageType.Memory,
      replicas: 1
    })
  
    console.log(`JetstreamDistributedLock created namespace ${config.namespace}: ${JSON.stringify(await kv.status())}`)
    
    const distributor = new JetstreamDistributedLock(kv, config)
    await new Promise<void>(distributor.initialize.bind(distributor))
    
    return distributor
  }
  
  async initialize(
    resolve: () => void,
    reject: (reason?: unknown) => void
  ): Promise<void> {
    try {
      if (this.initialized) {
        throw new Error('JetstreamDistributedLock already initialized')
      }

      const watch = await this.kv.watch({
        key: `${this.config.namespace}.>`,
        initializedFn: () => {
          this.active = true
          this.initialized = true
          resolve()
        }
      })
      this.watch = watch

      ;(async () => {
        for await (const entry of watch) {
          if (this.initialized && !this.active) {
            throw new Error('JetstreamDistributedLock closed')
          }
          this.processEntry(entry)
        }
      }).bind(this)().catch(reject)
    } catch (error) {
      reject(error)
    }
  }

  private processEntry(entry: KvEntry): void {
    try {
      const lockState = entry.operation === 'PUT'
        ? JSON.parse(entry.string()) as LockMessage
        : {status: 'expired'} as LockMessage

      this.updateLocalState(entry.key, lockState, entry.revision)
    } catch (error) {
      console.error(`Could not process entry ${entry.key}, revision: ${entry.revision}, error: ${error}`)
    }
  }

  public close(): void {
    this.watch?.stop()
    this.active = false

    this.state.clear()
  }

  public async withLock<T>(
    key: string,
    timeoutMs: number,
    callback: (state: T| null) => Promise<T>
  ): Promise<Readable<T>> {
    const lock = await this.acquireLock<T>(key, timeoutMs)

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

  public async acquireLock<T>(key: string, timeoutMs: number): Promise<Writable<T>> {
    this.checkActive()
    const namespacedKey = this.toNamespacedKey(key)

    let now = Date.now()
    const deadline = now + timeoutMs

    while (now <= deadline) {
      try {
        const unlockTimeout = deadline - now
        const lockState = await new Promise<LockState | undefined>((resolve, reject) => 
            this.resolveOnUnlock.bind(this)(namespacedKey, unlockTimeout, resolve, reject))

        const lock = await this.createOrUpdateLock(namespacedKey, lockState)
        const lockObj = lock.value ? JSON.parse(lock.value) as T : null

        return new WritableObject(lockObj, lock.lockId!)
      } catch(err) {
        // suppress timeouts and lock acquire failures, retry 
        now = Date.now()
      }
    }

    throw new TimeoutError(namespacedKey)
  }

  public async tryAcquireLock<T>(key: string): Promise<{acquired: boolean, value: Writable<T> | undefined}> {
    this.checkActive()
    const namespacedKey = this.toNamespacedKey(key)

    try {
      await this.updateKey(namespacedKey)
      const lockState = this.state.get(namespacedKey)
      if (lockState && this.isLockActive(lockState.state)) {
        return {acquired: false, value: undefined}
      }

      const lock = await this.createOrUpdateLock(namespacedKey, lockState?.state)
      const lockObj = lock.value ? JSON.parse(lock.value) as T : null

      return {acquired: true, value: new WritableObject(lockObj, lock.lockId!)}
    } catch {
      return {acquired: false, value: undefined}
    }
  }

  public async releaseLock<T>(key: string, lockObj: Writable<T>): Promise<boolean> {
    this.checkActive()
    const namespacedKey = this.toNamespacedKey(key)
    
    const lockState = this.state.get(namespacedKey)
    if (lockState && this.isLockActive(lockState.state) && lockState.state.lockId === lockObj.lockId) {
        const newLock = {
            status: 'unlocked' as LockStatus,
            lockId: lockObj.lockId,
            value: lockObj.value ? JSON.stringify(lockObj.value) : undefined
        } as LockMessage
    
        try {
          const revision = await this.kv.update(namespacedKey, JSON.stringify(newLock), lockState.state.revision!)

          this.updateLocalState(namespacedKey, newLock, revision)
          return true
        } catch (error) {
          console.error(`Could not release lock ${namespacedKey}, error: ${error}`)
          return false
        }
    }

    return false
  }

  public async wait<T>(key: string, timeoutMs: number): Promise<Readable<T>> {
    this.checkActive()
    const namespacedKey = this.toNamespacedKey(key)

    const lockState = await new Promise<LockState | undefined>((resolve, reject) => 
        this.resolveOnUnlock.bind(this)(namespacedKey, timeoutMs, resolve, reject))

    const value = lockState?.value ? JSON.parse(lockState.value) as T : null
    return { value }
  }

  public async delete(key: string): Promise<boolean> {
    this.checkActive()

    const lock = await this.acquireLock(key, this.config.lockTimeoutMs)
    return await this.releaseLock(key, lock.update(null))
  }

  private async createOrUpdateLock(namespacedKey: string, lockState: LockState | undefined): Promise<LockState> {
    const newLock = {
        status: 'locked' as LockStatus,
        lockId: crypto.randomUUID(),
        value: lockState?.value
    } as LockMessage

    const revision = lockState?.revision 
        ? await this.kv.update(namespacedKey, JSON.stringify(newLock), lockState.revision)
        : await this.kv.create(namespacedKey, JSON.stringify(newLock))

    return this.updateLocalState(namespacedKey, newLock, revision)
  }

  private async resolveOnUnlock(
    namespacedKey: string, 
    timeoutMs: number, 
    resolve: (value: LockState | undefined) => void, 
    reject: (reason?: unknown) => void
  ) {
    await this.updateKey(namespacedKey)

    const initialState = this.state.get(namespacedKey) 
    if (!initialState || !this.isLockActive(initialState.state)) {
      return resolve(initialState?.state)
    } 

    const watchId = crypto.randomUUID()

    const timeout = setTimeout(() => {
      const state = this.state.get(namespacedKey)
      state?.watchers.delete(watchId)

      !state || !this.isLockActive(state.state)
        ? resolve(state?.state) 
        : reject(new TimeoutError(namespacedKey))
    }, timeoutMs)

    const callback = async (entry: LockState) => {
      if (!this.isLockActive(entry)) {
        const state = this.state.get(namespacedKey)
        state?.watchers.delete(watchId)

        clearTimeout(timeout)
        resolve(entry)
      } 
    }
    initialState.watchers.set(watchId, callback)
  }

  private isLockActive(lockState: LockState): boolean {
    return lockState.status === 'locked' && (lockState.timestamp + this.config.lockTimeoutMs >= Date.now())
  }

  private updateLocalState(namespacedKey: string, lockMessage: LockMessage, newRevision: number): LockState {
    const oldValue = this.state.get(namespacedKey)
    if (oldValue?.state?.revision && oldValue.state.revision >= newRevision) {
      return oldValue.state
    }

    const newState = { 
      state: {
        ...lockMessage,
        revision: newRevision,
        timestamp: Date.now()
      }, 
      watchers: oldValue?.watchers ?? new Map<string, MessageHandler>()
    }
    this.state.set(namespacedKey, newState)

    newState.watchers.forEach(watcher => watcher(newState.state).catch(console.error))

    return newState.state
  }

  private async updateKey(namespacedKey: string) {
    const latest = await this.kv.get(namespacedKey)
    if (latest !== null) {
      this.processEntry(latest)
    }
  }

  private checkActive(): void {
    if (!this.active) {
      throw new Error('JetstreamDistributedLock closed')
    }
  }

  private toNamespacedKey(key: string): string {
    return `${this.config.namespace}.${key}`
  }
} 
