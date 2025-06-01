
// REDIS DATA MODEL

const lockIdField = 'lockId'
const lockStatusField = 'lockStatus'
const lockObjKeyPrefix = 'data-store.'

export const lockObjKey = (key: string) => `${lockObjKeyPrefix}${key}`

export function redisPubSubChannel(namespacedKey: string) {
    return `redis-distributed-lock-notify:${namespacedKey}`;
}

export const tryAcquireLockLuaScript = ` \
  local exists = redis.call('EXISTS', KEYS[1]) \
  local objKey = ${lockObjKeyPrefix} .. KEYS[1] \
  local lockObj = redis.call('GET', objKey) \
  if (exists == 0 or redis.call('HGET', KEYS[1], '${lockStatusField}') ~= 'locked') then \
        redis.call('HSET', KEYS[1], '${lockIdField}', ARGV[1]) \
        redis.call('PEXPIRE', KEYS[1], ARGV[2]) \
        redis.call('HSET', KEYS[1], '${lockStatusField}', 'locked') \
        return {ARGV[1], 'locked', lockObj} \
  else \
        local lockId = redis.call('HGET', KEYS[1], '${lockIdField}') \
        local lockStatus = redis.call('HGET', KEYS[1], '${lockStatusField}') \
        return {lockId, lockStatus, lockObj} \
  end \
`

export const tryWriteLockLuaScript = ` \
  local exists = redis.call('EXISTS', KEYS[1]) \
  if (exists == 1 and redis.call('HGET', KEYS[1], '${lockIdField}') == ARGV[1]) then \
      local objKey = ${lockObjKeyPrefix} .. KEYS[1] \
      redis.call('SET', objKey, ARGV[2]) \
      if (ARGV[3] == -1) then \
          redis.call('PERSIST', objKey) \
      else \
          redis.call('PEXPIRE', objKey, ARGV[3]) \
      end \
      redis.call('HSET', KEYS[1], '${lockStatusField}', 'unlocked') \
      return true \
  else \
      return false \
  end \
`

export const getLockObjLuaScript = ` \
  local objKey = ${lockObjKeyPrefix} .. KEYS[1] \
  local lockStatus = redis.call('HGET', KEYS[1], '${lockStatusField}') \
  return {lockStatus, lockObj} \
`
