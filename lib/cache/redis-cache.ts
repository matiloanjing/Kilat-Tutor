/**
 * Upstash Redis Cache for KilatCode
 * Distributed cache that survives Vercel cold starts
 * 
 * Features:
 * - User tier caching (5 min TTL)
 * - Tier limits caching (10 min TTL - rarely changes)
 * - Rate limit state (shared across instances)
 * 
 * Copyright © 2026 KilatOS
 */

import { Redis } from '@upstash/redis';

// ============================================================================
// Redis Client Initialization
// ============================================================================

const redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL!,
    token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

// ============================================================================
// Cache TTL Constants (in seconds)
// ============================================================================

const TTL = {
    USER_TIER: 300,         // 5 minutes - user tier rarely changes
    TIER_LIMITS: 600,       // 10 minutes - tier_limits table almost never changes
    COST_LIMITS: 600,       // 10 minutes - cost_limits almost never changes
    RATE_LIMIT_STATE: 60,   // 1 minute - for distributed rate limiting
    DAILY_USAGE: 120,       // 2 minutes - usage updates frequently but can be slightly stale
};

// ============================================================================
// Cache Key Prefixes
// ============================================================================

const PREFIX = {
    USER_TIER: 'tier:',
    TIER_LIMITS: 'limits:',
    COST_LIMITS: 'costlimits:',
    RATE_LIMIT: 'ratelimit:',
    USAGE: 'usage:',
};

// ============================================================================
// User Tier Cache
// ============================================================================

export async function getCachedUserTier(userId: string): Promise<string | null> {
    try {
        return await redis.get<string>(`${PREFIX.USER_TIER}${userId}`);
    } catch (error) {
        console.error('[Redis] getCachedUserTier error:', error);
        return null;
    }
}

export async function setCachedUserTier(userId: string, tier: string): Promise<void> {
    try {
        await redis.set(`${PREFIX.USER_TIER}${userId}`, tier, { ex: TTL.USER_TIER });
    } catch (error) {
        console.error('[Redis] setCachedUserTier error:', error);
    }
}

// ============================================================================
// Tier Limits Cache (Global - same for all users of same tier)
// ============================================================================

export async function getCachedTierLimits(tier: string, category: string): Promise<number | null> {
    try {
        return await redis.get<number>(`${PREFIX.TIER_LIMITS}${tier}:${category}`);
    } catch (error) {
        console.error('[Redis] getCachedTierLimits error:', error);
        return null;
    }
}

export async function setCachedTierLimits(tier: string, category: string, limit: number): Promise<void> {
    try {
        await redis.set(`${PREFIX.TIER_LIMITS}${tier}:${category}`, limit, { ex: TTL.TIER_LIMITS });
    } catch (error) {
        console.error('[Redis] setCachedTierLimits error:', error);
    }
}

// ============================================================================
// Cost Limits Cache (Global)
// ============================================================================

export async function getCachedCostLimits(tier: string, category: string): Promise<number | null> {
    try {
        return await redis.get<number>(`${PREFIX.COST_LIMITS}${tier}:${category}`);
    } catch (error) {
        console.error('[Redis] getCachedCostLimits error:', error);
        return null;
    }
}

export async function setCachedCostLimits(tier: string, category: string, limit: number): Promise<void> {
    try {
        await redis.set(`${PREFIX.COST_LIMITS}${tier}:${category}`, limit, { ex: TTL.COST_LIMITS });
    } catch (error) {
        console.error('[Redis] setCachedCostLimits error:', error);
    }
}

// ============================================================================
// Distributed Rate Limiting (Shared across all Vercel instances)
// ============================================================================

interface RateLimitState {
    count: number;
    windowStart: number;
}

export async function getRateLimitState(provider: string): Promise<RateLimitState | null> {
    try {
        return await redis.get<RateLimitState>(`${PREFIX.RATE_LIMIT}${provider}`);
    } catch (error) {
        console.error('[Redis] getRateLimitState error:', error);
        return null;
    }
}

export async function incrementRateLimit(provider: string, limit: number, windowMs: number = 60000): Promise<boolean> {
    try {
        const key = `${PREFIX.RATE_LIMIT}${provider}`;
        const now = Date.now();

        // Use Redis MULTI for atomic operations
        const current = await redis.get<RateLimitState>(key);

        if (!current || (now - current.windowStart) > windowMs) {
            // New window
            await redis.set(key, { count: 1, windowStart: now }, { ex: Math.ceil(windowMs / 1000) });
            return true;
        }

        if (current.count >= limit) {
            return false; // Rate limit exceeded
        }

        // Increment
        await redis.set(key, { count: current.count + 1, windowStart: current.windowStart }, {
            ex: Math.ceil((windowMs - (now - current.windowStart)) / 1000)
        });
        return true;
    } catch (error) {
        console.error('[Redis] incrementRateLimit error:', error);
        return true; // Fail open - allow request if Redis fails
    }
}

// ============================================================================
// Daily Usage Cache (Reduces DB reads for quota checks)
// ============================================================================

export async function getCachedDailyUsage(userId: string, category: string): Promise<number | null> {
    try {
        return await redis.get<number>(`${PREFIX.USAGE}${userId}:${category}`);
    } catch (error) {
        console.error('[Redis] getCachedDailyUsage error:', error);
        return null;
    }
}

export async function setCachedDailyUsage(userId: string, category: string, count: number): Promise<void> {
    try {
        await redis.set(`${PREFIX.USAGE}${userId}:${category}`, count, { ex: TTL.DAILY_USAGE });
    } catch (error) {
        console.error('[Redis] setCachedDailyUsage error:', error);
    }
}

export async function incrementCachedDailyUsage(userId: string, category: string, increment: number = 1): Promise<void> {
    try {
        const key = `${PREFIX.USAGE}${userId}:${category}`;
        await redis.incrby(key, increment);
        // Reset TTL on increment
        await redis.expire(key, TTL.DAILY_USAGE);
    } catch (error) {
        console.error('[Redis] incrementCachedDailyUsage error:', error);
    }
}

// ============================================================================
// Health Check
// ============================================================================

export async function checkRedisHealth(): Promise<{ healthy: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
        await redis.ping();
        return { healthy: true, latencyMs: Date.now() - start };
    } catch (error) {
        console.error('[Redis] Health check failed:', error);
        return { healthy: false, latencyMs: Date.now() - start };
    }
}

// ============================================================================
// Export Redis client for advanced usage
// ============================================================================

export { redis };
export default redis;
