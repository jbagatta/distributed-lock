# Johnny Locke

A robust, strongly-consistent distributed locking library for Node.js that provides atomic operations across multiple processes. Implemented on top of your choice of either Redis or Nats JetStream, it fits into your existing production cluster without additional dependency.

Designed to function like a distributed address space, the library provides wait/notify-like syntax for process synchronization on top of the locked object data. Data safety is guaranteed using fencing tokens to ensure that only the process which holds the lock can ever write or update data.

## Features

- **Mutual Exclusion**: Only one process can hold a lock at any time
- **Atomic State Updates**: Guarantee data consistency across processes, using fencing tokens to prevent race conditions
- **Automatic Timeout**: Locks automatically expire if the holding process crashes or otherwise overshoots the lock timeout
    - Object stores are configured separately from lock mechanisms and can be expired or persisted indefinitely, allowing them to function as either short-term cache or long-term storage
- **Event-Driven**: Robust wait/notify-like syntax supported using pub/sub for lock release eventing 
- **Multiple Backends**: Support for both Redis and Nats JetStream under the hood

## API Reference

### Lock Configuration

```typescript
interface LockConfiguration {
    namespace: string;       // Prefix for all keys in the backend
    lockTimeoutMs: number;   // How long locks are held before auto-expiry
    objectExpiryMs?: number; // Optional: How long objects persist after last access
}
```

### Core Methods

#### `withLock<T>(key: string, timeoutMs: number, callback: (state: T | null) => Promise<T>): Promise<Readable<T>>`

Acquires a lock and executes the callback against the current object state. Automatically releases the lock regardless of success, error or timeout.

The callback is passed the current value of the locked object (or null, if it's a new lock). The value returned by the callback is written back as an atomic update to the locked object.

```typescript
const result = await lock.withLock<number>('my-key', 1000, async (state) => {
    // input is the existing value
    const existingValue = state ?? 0

    // output written back to the lock store
    return existingValue + 1;
});
```

#### `acquireLock<T>(key: string, timeoutMs: number): Promise<Writable<T>>`

Manually acquires a lock and returns a writable state handle. Useful for long-running operations. 

The timeout provided tells the library how long to wait to *acquire the lock*, not how long to *hold it once required* (which is configured globally via `LockConfiguration.lockTimeoutMs`)

#### `releaseLock<T>(key: string, Writable<T>): Promise<boolean>`

Releases the lock on the object, writing the given state back to the lock store. Notifies any waiting processes that the lock is available.

Returns true if the lock was released and the value written, false otherwise (i.e. if the lock expired)

```typescript
const lockObj = await lock.acquireLock<string>('my-key', 1000);
try {
    // Do work while holding the lock
    const updated = lockObj.update('updatedState')

    // Write and release
    await lock.releaseLock('my-key', updated);
} catch (error) {
    // release lock without updating data
    await lock.releaseLock('my-key', lockObj);
    
    // ...
}
```

#### `tryAcquireLock<T>(key: string): Promise<{acquired: boolean, value: Writable<T> | undefined}>`

Attempts to acquire the lock and immediately returns success or failure.

```typescript
const result = await lock.tryAcquireLock<string>('my-key');
if (!result.acquired) {
  // result.value is undefined, lock not acquired
}

try {
    // Do work while holding the lock
    const updated = result.value.update('updatedState')

    // Write and release
    await lock.releaseLock('my-key', updated);
} catch (error) {
    // release lock without updating data
    await lock.releaseLock('my-key', result.value);
    
    // ...
}
```

#### `wait<T>(key: string, timeoutMs: number): Promise<Readable<T>>`

Waits for `timeoutMs` for a lock to become available, returns its current state as a readonly state handle without acquiring it.

```typescript
const state = await lock.wait('my-key', 1000);

console.log('Current state:', state.value);
```

## Implementation Details

### Redis Implementation
```typescript
import { RedisDistributedLock } from 'johnny-locke';
import Redis from 'ioredis';

const redis = new Redis('redis://localhost:6379')
const lock = await RedisDistributedLock.create(redis, {
    namespace: 'my-app',
    lockTimeoutMs: 5000,    // Lock expires after 5 seconds
    objectExpiryMs: 300000  // Objects expire after 5 minutes (optional)
});

// do your stuff

lock.close()
await redis.quit() // redis client is not managed by the instance
```

The Redis implementation uses:
- Lua scripts for atomic operations
- Hash structures for lock metadata, separate object keys for separate expiry
- Redis Pub/Sub for lock release notifications
- Key expiration for object and lock timeouts

### Nats JetStream Implementation
```typescript
import { JetstreamDistributedLock } from 'johnny-locke';
import { connect } from 'nats';

const nats = await connect({servers: ['nats://localhost:4222']})
const lock = await JetstreamDistributedLock.create(nats, {
    namespace: 'my-app',
    lockTimeoutMs: 5000,    // Lock expires after 5 seconds
    objectExpiryMs: 300000  // Objects expire after 5 minutes (optional)
})

// do your stuff

lock.close()
await nats.close() // nats client is not managed by the instance
```

The Nats implementation uses:
- JetStream for persistence
- Key-value store for lock metadata
- K/V stream consumer for lock release notifications
- Stream TTL for object expiry (manual lock timeouts)

## Best Practices

1. **Keep Lock Times Short**: Minimize the duration locks are held to reduce contention
2. **Use Appropriate Timeouts**: Set timeouts based on the expected duration of state updates
3. **Handle Errors**: Always implement proper error handling when manually locking/unlocking (or use `withLock` for convenience) to avoid relying on timeouts
4. **Be Diligent With Resources**: Generally you should only need one `DistributedLock` instance per server (per namespace). Always clean up by calling `close()` when shutting down your application
5. **Use Namespaces**: Isolate application locks to avoid collisions

## Running Tests

Spin up a test environment with redis and nats servers using docker compose:
```
docker compose -f tests/docker-compose.yml up -d
```

and then run the tests:
```
npm run test
```

## License

MIT License - see LICENSE file for details