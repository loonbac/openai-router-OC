/**
 * heartbeat.ts — Multi-instance coordination via filesystem heartbeat
 *
 * Server writes heartbeat every 2s so clients can detect liveness.
 * Lock file prevents race conditions when multiple clients try to start server.
 */

import { readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync } from 'node:fs'

export const HEARTBEAT_PATH = '/tmp/openai-router-heartbeat.json'
export const LOCK_PATH = '/tmp/openai-router-lock.json'

const STALE_THRESHOLD_MS = 6000

export interface HeartbeatData {
  pid: number
  port: number
  timestamp: number
  connections: number
}

export interface LockData {
  pid: number
  timestamp: number
}

// ─── Server side ───────────────────────────────────────────────────────

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

export function startHeartbeat(port: number): void {
  const write = () => {
    const data: HeartbeatData = {
      pid: process.pid,
      port,
      timestamp: Date.now(),
      connections: activeConnections
    }
    try {
      writeFileSync(HEARTBEAT_PATH, JSON.stringify(data))
      try { chmodSync(HEARTBEAT_PATH, 0o666) } catch {}
    } catch {}
  }
  write()
  heartbeatTimer = setInterval(write, 2000)
}

export function stopHeartbeat(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  try { unlinkSync(HEARTBEAT_PATH) } catch {}
}

// ─── Connection tracking ───────────────────────────────────────────────

let activeConnections = 0
let lastActiveTime = Date.now()

export function connectionStart(): void {
  activeConnections++
  lastActiveTime = Date.now()
}

export function connectionEnd(): void {
  activeConnections = Math.max(0, activeConnections - 1)
  if (activeConnections === 0) lastActiveTime = Date.now()
}

export function getIdleTimeMs(): number {
  if (activeConnections > 0) return 0
  return Date.now() - lastActiveTime
}

export function getActiveConnections(): number {
  return activeConnections
}

// ─── Client side ───────────────────────────────────────────────────────

export function readHeartbeat(): HeartbeatData | null {
  try {
    const raw = readFileSync(HEARTBEAT_PATH, 'utf-8')
    const data = JSON.parse(raw) as HeartbeatData
    if (typeof data.pid !== 'number' || typeof data.timestamp !== 'number') return null
    return data
  } catch { return null }
}

export function isHeartbeatStale(hb: HeartbeatData | null): boolean {
  if (!hb) return true
  return Date.now() - hb.timestamp > STALE_THRESHOLD_MS
}

export function isServerHealthy(): boolean {
  return !isHeartbeatStale(readHeartbeat())
}

// ─── Lock acquisition ──────────────────────────────────────────────────

export function tryAcquireLock(): boolean {
  try {
    if (existsSync(LOCK_PATH)) {
      try {
        const existing = JSON.parse(readFileSync(LOCK_PATH, 'utf-8')) as LockData
        if (Date.now() - existing.timestamp < STALE_THRESHOLD_MS) {
          if (existing.pid !== process.pid) return false
        }
      } catch {}
    }
    const lock: LockData = { pid: process.pid, timestamp: Date.now() }
    writeFileSync(LOCK_PATH, JSON.stringify(lock))
    try { chmodSync(LOCK_PATH, 0o666) } catch {}
    return true
  } catch { return false }
}

export function releaseLock(): void {
  try { unlinkSync(LOCK_PATH) } catch {}
}

export function isLockOurs(): boolean {
  try {
    const data = JSON.parse(readFileSync(LOCK_PATH, 'utf-8')) as LockData
    return data.pid === process.pid
  } catch { return false }
}
