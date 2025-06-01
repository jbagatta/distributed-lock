import { Redis } from "ioredis"
import { TimeoutError } from "../types"
import { redisPubSubChannel } from "./data-model"

export class LockListener<T> {
    private readonly subscriber: Redis
    private readonly notification: Promise<T | null>

    constructor(private readonly redis: Redis, private readonly namespacedKey: string, timeoutMs: number) { 
        this.subscriber = redis.duplicate()
        this.notification = this.initialize(timeoutMs)
    }

    async waitUntilNotified(): Promise<T | null> {
        try {
            return await this.notification
        } finally {
            this.close()
        }
    }

    close(): void {
        this.subscriber.unsubscribe(redisPubSubChannel(this.namespacedKey))
        this.subscriber.quit().catch(console.error)
    }
    
    private initialize(timeoutMs: number): Promise<T | null> {
        return new Promise<T | null>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new TimeoutError(this.namespacedKey)), timeoutMs)

            this.subscriber.subscribe(redisPubSubChannel(this.namespacedKey), (err, message) => {
                clearTimeout(timeout)

                if (err) return reject(err) 
                const payload = message as string | undefined
                if (!payload) return reject(new Error('Invalid message'))

                return resolve(JSON.parse(payload) as T)
            })
        })
    }
}
