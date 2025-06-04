import { Redis } from "ioredis"
import { TimeoutError } from "../util"
import { redisPubSubChannel } from "./data-model"

export class LockListener {
    private readonly subscriber: Redis
    private readonly listeners = new Map<string, Map<string, (payload: any) => void>>()

    constructor(private readonly redis: Redis, private readonly namespace: string) { 
        this.subscriber = this.redis.duplicate()        
        
        this.subscriber.subscribe(redisPubSubChannel(this.namespace))
        this.subscriber.on('message', (channel, message) => {
            try {
                const { key, payload } = JSON.parse(message as string)
                const listeners = this.listeners.get(key)
                if (listeners) {
                    listeners.forEach(callback => callback(payload))
                    listeners.clear()
                } 
            } catch (error) {
                console.error(error)
            }
        })
    }

    async notify<T>(namespacedKey: string, payload: T): Promise<void> {
        await this.redis.publish(redisPubSubChannel(this.namespace), JSON.stringify({ key: namespacedKey, payload }))
    }

    async waitUntilNotified<T>(namespacedKey: string, timeoutMs: number): Promise<T> {
        return new Promise<T>((resolve, reject) => {
            this.resolveOnNotification.bind(this)(namespacedKey, timeoutMs, resolve, reject)
        })
    }

    cancel<T>(wait: Promise<T>): void {
        wait.then().catch(() => {})
    }

    private async resolveOnNotification<T>(
        namespacedKey: string, 
        timeoutMs: number,
        resolve: (value: T) => void, 
        reject: (reason?: unknown) => void
    ): Promise<void> {
        const watchId = crypto.randomUUID()
    
        const timeout = setTimeout(() => {
            this.listeners.get(namespacedKey)?.delete(watchId)
            reject(new TimeoutError(namespacedKey))
        }, timeoutMs)
    
        const callback = (payload: T) => {
            this.listeners.get(namespacedKey)?.delete(watchId)
            clearTimeout(timeout)
            resolve(payload)
        }

        if (!this.listeners.has(namespacedKey)) {
            this.listeners.set(namespacedKey, new Map())
        }
        this.listeners.get(namespacedKey)!.set(watchId, callback.bind(this))
    }

    close(): void {
        this.subscriber.unsubscribe(redisPubSubChannel(this.namespace))
        this.subscriber.quit().catch(console.error)
    }
}
