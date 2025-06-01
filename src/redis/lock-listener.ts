import { Redis } from "ioredis";
import { TimeoutError } from "../types";
import { redisPubSubChannel } from "./data-model";

export class LockListener<T> {
    private readonly notification: Promise<T | null>;
    constructor(private readonly redis: Redis, private readonly namespacedKey: string, timeoutMs: number) { 
        this.notification = this.initialize(timeoutMs);
    }

    async waitUntilNotified(): Promise<T | null> {
        try {
            return await this.notification;
        } finally {
            this.close();
        }
    }

    close(): void {
        this.redis.unsubscribe(redisPubSubChannel(this.namespacedKey));
    }
    
    private initialize(timeoutMs: number): Promise<T | null> {
        return new Promise<T | null>((resolve, reject) => {
            const timeout = setTimeout(() => reject(new TimeoutError(this.namespacedKey)), timeoutMs);

            this.redis.subscribe(redisPubSubChannel(this.namespacedKey), (err, message) => {
                clearTimeout(timeout);
                return err ? reject(err) : resolve(JSON.parse(message as string));
            });
        });
    }
}
