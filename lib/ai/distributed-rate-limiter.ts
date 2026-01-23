/**
 * Distributed Rate Limiter with Provider-Specific Limits
 * Uses Upstash Redis for cross-instance rate limiting
 * 
 * CRITICAL: Prevents IP ban from AI providers (Groq, Pollinations)
 * 
 * Features:
 * - Provider-specific rate limits (Groq: 30 RPM, Pollinations: 60 RPM)
 * - Distributed state (shared across all Vercel instances)
 * - Request queue with FIFO processing
 * - Fallback to in-memory when Redis unavailable
 * 
 * Copyright © 2026 KilatOS
 */

import { Redis } from '@upstash/redis';

// ============================================================================
// Configuration (Based on Provider Documentation)
// ============================================================================

/**
 * Provider rate limits from official documentation:
 * - Groq: 30 RPM (free tier), 14,400 RPD
 * - Pollinations: 20 concurrent (with auth), 60 RPM estimated
 * - OpenRouter: 200 RPM (varies by model)
 */
export const PROVIDER_LIMITS = {
    groq: {
        maxRPM: 25,         // Leave 5 buffer from 30 RPM limit
        maxConcurrent: 3,   // Conservative for stability
        windowMs: 60_000,   // 1 minute window
    },
    pollinations: {
        maxRPM: 50,         // Conservative estimate
        maxConcurrent: 15,  // Leave 5 buffer from 20 limit
        windowMs: 60_000,
    },
    openrouter: {
        maxRPM: 150,        // Leave buffer from 200
        maxConcurrent: 10,
        windowMs: 60_000,
    },
    // Default for unknown providers
    default: {
        maxRPM: 30,
        maxConcurrent: 5,
        windowMs: 60_000,
    }
} as const;

export type ProviderName = keyof typeof PROVIDER_LIMITS;

// ============================================================================
// Redis Client (Lazy initialization)
// ============================================================================

let redis: Redis | null = null;

function getRedis(): Redis | null {
    if (redis) return redis;

    if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
        try {
            redis = new Redis({
                url: process.env.UPSTASH_REDIS_REST_URL,
                token: process.env.UPSTASH_REDIS_REST_TOKEN,
            });
            return redis;
        } catch (e) {
            console.error('[DistributedRateLimiter] Failed to init Redis:', e);
            return null;
        }
    }
    return null;
}

// ============================================================================
// Distributed Rate Limiter Class
// ============================================================================

interface RateLimitResult {
    allowed: boolean;
    remaining: number;
    resetMs: number;
    queuePosition?: number;
}

interface QueuedRequest {
    id: string;
    provider: ProviderName;
    enqueuedAt: number;
    resolve: (value: void) => void;
    reject: (error: Error) => void;
}

class DistributedRateLimiter {
    // In-memory fallback state (per instance)
    private localCounts = new Map<string, { count: number; windowStart: number }>();
    private localConcurrent = new Map<string, number>();

    // Request queue (in-memory, processed by this instance)
    private queue: QueuedRequest[] = [];
    private isProcessing = false;

    // =========================================================================
    // Main API: Check if request can proceed
    // =========================================================================

    async checkLimit(provider: ProviderName): Promise<RateLimitResult> {
        const limits = PROVIDER_LIMITS[provider] || PROVIDER_LIMITS.default;
        const redis = getRedis();
        const now = Date.now();

        // Try Redis first (distributed)
        if (redis) {
            try {
                return await this.checkRedisLimit(redis, provider, limits, now);
            } catch (e) {
                console.warn('[DistributedRateLimiter] Redis error, falling back to local:', e);
            }
        }

        // Fallback to local rate limiting
        return this.checkLocalLimit(provider, limits, now);
    }

    // =========================================================================
    // Redis-based distributed rate limiting
    // =========================================================================

    private async checkRedisLimit(
        redis: Redis,
        provider: ProviderName,
        limits: typeof PROVIDER_LIMITS[ProviderName],
        now: number
    ): Promise<RateLimitResult> {
        const countKey = `ratelimit:${provider}:count`;
        const windowKey = `ratelimit:${provider}:window`;
        const concurrentKey = `ratelimit:${provider}:concurrent`;

        // Get current window
        const [windowStart, currentCount, concurrent] = await Promise.all([
            redis.get<number>(windowKey),
            redis.get<number>(countKey),
            redis.get<number>(concurrentKey),
        ]);

        // FIX 2026-01-22: If window is null (expired), MUST reset count
        // Before: windowStart || now caused count to never reset
        // After: Explicitly check for null and reset
        const currentConcurrent = concurrent || 0;

        // If window expired or null, start fresh window
        if (!windowStart || Date.now() - windowStart >= limits.windowMs) {
            const now = Date.now();
            await Promise.all([
                redis.set(windowKey, now, { ex: Math.ceil(limits.windowMs / 1000) }),
                redis.set(countKey, 1, { ex: Math.ceil(limits.windowMs / 1000) }),
            ]);
            console.log(`[RateLimiter] ${provider}: New window started, count reset to 1`);
            return { allowed: true, remaining: limits.maxRPM - 1, resetMs: limits.windowMs };
        }

        const count = currentCount || 0;

        // Check RPM limit
        if (count >= limits.maxRPM) {
            const resetMs = limits.windowMs - (Date.now() - windowStart);
            return { allowed: false, remaining: 0, resetMs };
        }

        // Check concurrent limit
        if (currentConcurrent >= limits.maxConcurrent) {
            return { allowed: false, remaining: limits.maxRPM - count, resetMs: 1000 };
        }

        // Increment counters
        // FIX 2026-01-24: Add TTL to concurrent key to auto-cleanup on job crash
        // Before: concurrent key had NO TTL, stuck jobs = permanently blocked
        await Promise.all([
            redis.incr(countKey),
            redis.incr(concurrentKey),
        ]);
        // Set TTL on concurrent key (5 min max job duration)
        await redis.expire(concurrentKey, 300);

        return {
            allowed: true,
            remaining: limits.maxRPM - count - 1,
            resetMs: limits.windowMs - (Date.now() - windowStart)
        };
    }

    // =========================================================================
    // Local fallback rate limiting (per-instance)
    // =========================================================================

    private checkLocalLimit(
        provider: ProviderName,
        limits: typeof PROVIDER_LIMITS[ProviderName],
        now: number
    ): RateLimitResult {
        const key = provider;
        const state = this.localCounts.get(key);
        const concurrent = this.localConcurrent.get(key) || 0;

        // Check if window expired
        if (!state || now - state.windowStart >= limits.windowMs) {
            this.localCounts.set(key, { count: 1, windowStart: now });
            return { allowed: true, remaining: limits.maxRPM - 1, resetMs: limits.windowMs };
        }

        // Check RPM limit (divided by estimated instances for safety)
        const instanceAdjustedLimit = Math.max(5, Math.floor(limits.maxRPM / 5));
        if (state.count >= instanceAdjustedLimit) {
            const resetMs = limits.windowMs - (now - state.windowStart);
            return { allowed: false, remaining: 0, resetMs };
        }

        // Check concurrent
        const instanceAdjustedConcurrent = Math.max(2, Math.floor(limits.maxConcurrent / 3));
        if (concurrent >= instanceAdjustedConcurrent) {
            return { allowed: false, remaining: instanceAdjustedLimit - state.count, resetMs: 500 };
        }

        state.count++;
        this.localConcurrent.set(key, concurrent + 1);

        return {
            allowed: true,
            remaining: instanceAdjustedLimit - state.count,
            resetMs: limits.windowMs - (now - state.windowStart)
        };
    }

    // =========================================================================
    // Release concurrent slot after request completes
    // =========================================================================

    async releaseSlot(provider: ProviderName): Promise<void> {
        const redis = getRedis();

        if (redis) {
            try {
                const concurrentKey = `ratelimit:${provider}:concurrent`;
                // FIX 2026-01-24: Only decrement if value exists and > 0
                // Before: blind decr caused negative values when jobs were never properly tracked
                const current = await redis.get<number>(concurrentKey);
                if (current && current > 0) {
                    await redis.decr(concurrentKey);
                } else if (current !== null && current <= 0) {
                    // Reset to 0 if somehow negative
                    await redis.del(concurrentKey);
                }
            } catch (e) {
                // Ignore Redis errors on release
            }
        }

        // Also decrement local
        const concurrent = this.localConcurrent.get(provider) || 0;
        if (concurrent > 0) {
            this.localConcurrent.set(provider, concurrent - 1);
        }

        // Process queue
        this.processQueue();
    }

    // =========================================================================
    // Wait for slot with queue
    // =========================================================================

    async waitForSlot(provider: ProviderName, timeoutMs: number = 30000): Promise<void> {
        const startTime = Date.now();

        while (true) {
            const result = await this.checkLimit(provider);

            if (result.allowed) {
                return;
            }

            // Check timeout
            if (Date.now() - startTime > timeoutMs) {
                throw new Error(`Rate limit timeout for ${provider} after ${timeoutMs}ms`);
            }

            // Wait before retry
            const waitTime = Math.min(result.resetMs, 5000, timeoutMs - (Date.now() - startTime));
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }
    }

    // =========================================================================
    // Queue Processing
    // =========================================================================

    private async processQueue(): Promise<void> {
        if (this.isProcessing || this.queue.length === 0) return;

        this.isProcessing = true;

        while (this.queue.length > 0) {
            const request = this.queue[0];
            const result = await this.checkLimit(request.provider);

            if (result.allowed) {
                this.queue.shift();
                request.resolve();
            } else {
                // Wait and retry
                await new Promise(resolve => setTimeout(resolve, Math.min(result.resetMs, 1000)));
            }
        }

        this.isProcessing = false;
    }

    // =========================================================================
    // Status for monitoring
    // =========================================================================

    async getStatus(): Promise<Record<ProviderName, { count: number; concurrent: number; limit: number }>> {
        const redis = getRedis();
        const status: Record<string, { count: number; concurrent: number; limit: number }> = {};

        for (const provider of Object.keys(PROVIDER_LIMITS) as ProviderName[]) {
            if (provider === 'default') continue;

            const limits = PROVIDER_LIMITS[provider];
            let count = 0;
            let concurrent = 0;

            if (redis) {
                try {
                    const [c, con] = await Promise.all([
                        redis.get<number>(`ratelimit:${provider}:count`),
                        redis.get<number>(`ratelimit:${provider}:concurrent`),
                    ]);
                    count = c || 0;
                    concurrent = con || 0;
                } catch (e) {
                    // Use local
                    count = this.localCounts.get(provider)?.count || 0;
                    concurrent = this.localConcurrent.get(provider) || 0;
                }
            } else {
                count = this.localCounts.get(provider)?.count || 0;
                concurrent = this.localConcurrent.get(provider) || 0;
            }

            status[provider] = { count, concurrent, limit: limits.maxRPM };
        }

        return status as Record<ProviderName, { count: number; concurrent: number; limit: number }>;
    }
}

// ============================================================================
// Export singleton instance
// ============================================================================

export const distributedRateLimiter = new DistributedRateLimiter();

export default DistributedRateLimiter;
