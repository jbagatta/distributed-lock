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
    namespace: string;                 // Prefix for all keys in the backend
    defaultLockDurationMs: number;     // How long locks are held before auto-expiry
    objectExpiryMs?: number; // Optional: How long objects persist after last access
    replication?: number;    // Optional: Replication for the nats or redis cluster
}
```

### `withLock<T>(key: string, timeoutMs: number, callback: (state: T | null) => Promise<T>, lockDuration?: number): Promise<Readable<T>>`

Acquires a lock and executes the callback against the current object state. Automatically releases the lock regardless of success, error or timeout.

The callback is passed the current value of the locked object (or null, if it's a new lock). The value returned by the callback is written back as an atomic update to the locked object.

`timeoutMs` tells the library how long to wait to try and *acquire the lock*, not how long to *hold it once required* (which is configured globally via `LockConfiguration.defaultLockDurationMs` or optionally overridden by the `lockDuration` parameter if desired)

```typescript
const result = await lock.withLock<number>('my-key', 1000, async (state) => {
    // input is the existing value
    const existingValue = state ?? 0

    // output written back to the lock store
    return existingValue + 1;
});
```

### `acquireLock<T>(key: string, timeoutMs: number, lockDuration?: number): Promise<Writable<T>>`

Manually acquires a lock and returns a writable state handle. Useful for long-running operations. 

`timeoutMs` tells the library how long to wait to try and *acquire the lock*, not how long to *hold it once required* (which is configured globally via `LockConfiguration.defaultLockDurationMs` or optionally overridden by the `lockDuration` parameter if desired)

### `releaseLock<T>(key: string, Writable<T>): Promise<boolean>`

Releases the lock on the object, writing the given state back to the lock store. Notifies any waiting processes that the lock is available.

Returns true if the lock was released and the value written, false otherwise (i.e. if the lock expired)

```typescript
const lockObj = await lock.acquireLock<string>('my-key', 1000);
try {
    // do work while holding the lock
    const updated = lockObj.update('updatedState')

    // write and release
    await lock.releaseLock('my-key', updated);
} catch (error) {
    // release lock without updating data
    await lock.releaseLock('my-key', lockObj);
}
```

### `tryAcquireLock<T>(key: string, lockDuration?: number): Promise<{acquired: boolean, value: Writable<T> | undefined}>`

Attempts to acquire the lock and immediately returns success or failure.

```typescript
const result = await lock.tryAcquireLock<string>('my-key');
if (!result.acquired) {
  // lock not acquired, result.value is undefined
} else {
  // lock acquired, result.value is a writable state handle
  // be sure to release this lock as shown above
}
```

### `wait<T>(key: string, timeoutMs: number): Promise<Readable<T>>`

Waits for `timeoutMs` for a lock to become available (or returns immediately if the object is not currently locked), returns its current state as a readonly state handle without acquiring the lock.

```typescript
const state = await lock.wait('my-key', 1000);

console.log('Current state:', state.value);
```

## Implementation Details

### Nats JetStream K/V
```typescript
import { JetstreamDistributedLock } from 'johnny-locke';
import { connect } from 'nats';

const nats = await connect({servers: ['nats://localhost:4222']})
const lock = await JetstreamDistributedLock.create(nats, {
    namespace: 'my-app',
    defaultLockDurationMs: 5000, // lock expires after 5 seconds
    objectExpiryMs: 300000       // objects expire after 5 minutes (optional)
})

// do your stuff

lock.close()
await nats.close()  // nats client is not managed by the instance
```

The Nats implementation uses:
- JetStream K/V messages for atomic operations
- Key-value store for lock metadata, revision/seqID validation for fencing tokens
- K/V stream consumer for lock release notifications
- Stream message TTL for object expiry, manual lock timeout enforcement

Jetstream uses RAFT consensus under the hood for stream state consistency, which provides strong CP consistency under network partition (and some fault tolernace for high availability, using 3/5 replicas). K/V updates allow an optional `priorSeqId` validating the prior state of the key, which serves as a fencing token for safety guarantees.

### Redis
```typescript
import { RedisDistributedLock } from 'johnny-locke';
import Redis from 'ioredis';

const redis = new Redis('redis://localhost:6379')
const lock = await RedisDistributedLock.create(redis, {
    namespace: 'my-app',
    defaultLockDurationMs: 5000, // lock expires after 5 seconds
    objectExpiryMs: 300000       // objects expire after 5 minutes (optional)
});

// do your stuff

lock.close()
await redis.quit()  // redis client is not managed by the instance
```

The Redis implementation uses:
- Lua scripting for atomic operations
    - Order of operations is important here to maintain strong consistency and timeout support even if a server crashes in the middle of a script execution
- Hash structures for lock metadata + fencing tokens
    - Separate key for object storage to support separate expiry/persistence
- Redis Pub/Sub for lock release notifications
- Key expiration for both object and lock timeouts

As opposed to Jetstream, Redis replication does not, by default, support strong CP consistency because replication is asynchronous. Fortunately, the use of fencing tokens provides write-lock consistency in all scenarios. The fencing tokens are atomic with the lock data itself, so while a process may lose a lock it believes it maintains in the event of primary server crash, that process will not be able to write any data with the lost lock. Mutual exclusion and atomicity are maintained in this case, which may not be systemically "fair", but remains consistent and deterministic.

However, this does not guarantee read consistency. Consider the case of a primary server crashing in the middle of replication: some replicas may differ from others, and from the primary. The resulting state of the lock and the data itself is then indeterminate, since it depends on which replica is promoted to primary, and whether or not it received the replication of that data. It is thus possible that some reads occurred against the old primary which returned data that is no longer consistent with the new primary.

Redis 3.0 introduced the `WAIT` command to enforce synchronous replication to a certain number of replicas before returning. Johnny Locke support the `WAIT` command by setting the optional `replication` configuration value above 1. This will ensure that data writes are replicated synchronously, so as long as the Redis cluster is configured to allow reads ONLY against the primary, this edge case is eliminated and strong consistency is maintained. *NOTE: the resulting lock state is still indeterminate here, but the read inconsistency has been resolved. The state is whatever the new primary says it is, which is fine - the lock was never acked to the caller, and the primary never returned data related to the updated state.*

However, this feature comes with a **significant** performance tradeoff, and is only recommended if you TRULY need it (and if you aren't sure, you almost certainly *don't*). Refer to the [Redis replication docs](https://redis.io/docs/latest/operate/oss_and_stack/reference/cluster-spec/#scaling-reads-using-replica-nodes) for more details on how to configure the cluster to disable reads against replicas.

## Best Practices

1. **Keep Lock Times Short**: Minimize the duration locks are held to reduce contention
2. **Use Appropriate Timeouts**: Set timeouts based on the expected duration of state updates
3. **Handle Errors**: Always implement proper error handling when manually locking/unlocking (or use `withLock` for convenience)
4. **Use Namespaces**: Isolate application locks to avoid collisions

## Running Tests

Spin up a test environment with Redis and Nats servers using docker compose:
```
docker compose -f tests/docker-compose.yml up -d
```

and then run the tests:
```
npm run test
```

## License

MIT License 
