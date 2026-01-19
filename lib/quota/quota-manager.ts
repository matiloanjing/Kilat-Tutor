/**
 * Quota Manager
 * Tracks and enforces user usage quotas using usage_quotas table
 * 
 * Copyright © 2026 KilatOS
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

const supabase = createClient(supabaseUrl, supabaseKey);

// ============================================================================
// Types
// ============================================================================

export interface UsageQuota {
    id: string;
    user_id: string;
    agent_id: string;
    date: string; // YYYY-MM-DD
    count: number;
    created_at: string;
    updated_at: string;
}

export interface QuotaStatus {
    used: number;
    limit: number;
    remaining: number;
    isExceeded: boolean;
    resetAt: Date;
}

// ============================================================================
// Quota Manager Class
// ============================================================================

// Cache entry type
interface CacheEntry<T> {
    data: T;
    expires: number;
}

// Import Redis cache functions
import {
    getCachedUserTier,
    setCachedUserTier,
    getCachedTierLimits,
    setCachedTierLimits,
    getCachedCostLimits,
    setCachedCostLimits,
} from '@/lib/cache/redis-cache';

class QuotaManager {
    // =========================================================================
    // In-Memory Cache (Fallback when Redis unavailable)
    // Redis is primary cache (shared across Vercel instances)
    // =========================================================================
    private tierCache = new Map<string, CacheEntry<string>>();
    private limitsCache = new Map<string, CacheEntry<number>>();
    private costLimitsCache = new Map<string, CacheEntry<number>>();
    private readonly CACHE_TTL_MS = 30_000; // 30 seconds for in-memory fallback

    /**
     * Get cached tier - Redis first, then in-memory, then DB
     */
    private async getCachedTier(userId: string): Promise<string> {
        // Try Redis first (distributed cache)
        try {
            const redisCached = await getCachedUserTier(userId);
            if (redisCached) {
                return redisCached;
            }
        } catch (e) {
            // Redis failed, continue to fallbacks
        }

        // Try in-memory cache
        const cacheKey = userId;
        const cached = this.tierCache.get(cacheKey);
        if (cached && cached.expires > Date.now()) {
            return cached.data;
        }

        // Fetch from DB
        const { getUserTier } = await import('@/lib/auth/user-tier');
        const tier = await getUserTier(userId);

        // Cache in both Redis and in-memory
        try {
            await setCachedUserTier(userId, tier);
        } catch (e) {
            // Redis write failed, ignore
        }

        this.tierCache.set(cacheKey, {
            data: tier,
            expires: Date.now() + this.CACHE_TTL_MS
        });

        return tier;
    }

    /**
     * Get cached daily limit - Redis first, then in-memory, then DB
     */
    private async getCachedLimit(tier: string, category: string): Promise<number> {
        // Try Redis first (10 min TTL for tier limits - rarely changes)
        try {
            const redisCached = await getCachedTierLimits(tier, category);
            if (redisCached !== null) {
                return redisCached;
            }
        } catch (e) {
            // Redis failed, continue to fallbacks
        }

        // Try in-memory cache
        const cacheKey = `${tier}:${category}`;
        const cached = this.limitsCache.get(cacheKey);
        if (cached && cached.expires > Date.now()) {
            return cached.data;
        }

        // Fetch from DB
        const { data: limitData } = await supabase
            .from('tier_limits')
            .select('limit_daily')
            .eq('tier', tier)
            .eq('agent_id', category)
            .single();

        // Fallback limits if DB query fails
        let limit = 20;
        if (limitData?.limit_daily) {
            limit = limitData.limit_daily;
        } else {
            if (tier === 'free') limit = category === 'image' ? 5 : 20;
            else if (tier === 'pro') limit = category === 'image' ? 20 : 100;
            else if (tier === 'enterprise') limit = category === 'image' ? 50 : 500;
        }

        // Cache in both Redis and in-memory
        try {
            await setCachedTierLimits(tier, category, limit);
        } catch (e) {
            // Redis write failed, ignore
        }

        this.limitsCache.set(cacheKey, {
            data: limit,
            expires: Date.now() + this.CACHE_TTL_MS
        });

        return limit;
    }

    /**
     * Get cached cost limit - Redis first, then in-memory, then DB
     */
    private async getCachedCostLimit(tier: string, category: string): Promise<number> {
        // Try Redis first (10 min TTL for cost limits - rarely changes)
        try {
            const redisCached = await getCachedCostLimits(tier, category);
            if (redisCached !== null) {
                return redisCached;
            }
        } catch (e) {
            // Redis failed, continue to fallbacks
        }

        // Try in-memory cache
        const cacheKey = `cost:${tier}:${category}`;
        const cached = this.costLimitsCache.get(cacheKey);
        if (cached && cached.expires > Date.now()) {
            return cached.data;
        }

        // Fetch from DB
        const { data: limitData } = await supabase
            .from('tier_limits')
            .select('max_daily_cost_usd')
            .eq('tier', tier)
            .eq('agent_id', category)
            .single();

        // Fallback limits
        const costLimit = parseFloat(limitData?.max_daily_cost_usd) ||
            (tier === 'free' ? 0.50 : tier === 'pro' ? 2.00 : 25.00);

        // Cache in both Redis and in-memory
        try {
            await setCachedCostLimits(tier, category, costLimit);
        } catch (e) {
            // Redis write failed, ignore
        }

        this.costLimitsCache.set(cacheKey, {
            data: costLimit,
            expires: Date.now() + this.CACHE_TTL_MS
        });

        return costLimit;
    }

    /**
     * Check if user has quota remaining for an agent
     */
    /**
     * Check if user has quota remaining for an agent
     */
    async checkQuota(
        userId: string,
        agentId: string = 'default'
    ): Promise<QuotaStatus> {
        const today = this.getTodayDate();

        // 1. Get current usage
        const { data: usageData, error: usageError } = await supabase
            .from('usage_quotas')
            .select('count')
            .eq('user_id', userId)
            .eq('agent_id', agentId)
            .eq('date', today)
            .single();

        const used = usageData?.count || 0;

        // 2. Get user tier (CACHED)
        const tier = await this.getCachedTier(userId);

        // 3. Get specific limit for this agent & tier (CACHED)
        const category = this.mapAgentToCategory(agentId);
        const limit = await this.getCachedLimit(tier, category);

        const remaining = Math.max(0, limit - used);

        return {
            used,
            limit,
            remaining,
            isExceeded: used >= limit,
            resetAt: this.getNextMidnight()
        };
    }

    /**
     * Map specific agent IDs to broad categories (code vs image)
     * agent_id in usage_quotas can be 'solve', 'write' etc.
     * agent_id in tier_limits is usually 'code' or 'image'
     */
    private mapAgentToCategory(agentId: string): string {
        if (['image', 'flux', 'ideagen', 'kilatimage', 'imagegen'].includes(agentId)) return 'image';
        if (['audio-transcription', 'whisper'].includes(agentId)) return 'audio';
        return 'code'; // Default to code limit for solve, write, research, etc.
    }

    /**
     * Check if user has exceeded their daily cost budget
     * Uses max_daily_cost_usd from tier_limits table
     */
    async checkCostBudget(
        userId: string,
        agentId: string = 'code'
    ): Promise<{ exceeded: boolean; spent: number; limit: number; remaining: number }> {
        const today = this.getTodayDate();

        // 1. Get user tier (CACHED)
        const tier = await this.getCachedTier(userId);

        // 2. Get cost limit (CACHED)
        const category = this.mapAgentToCategory(agentId);
        const costLimit = await this.getCachedCostLimit(tier, category);

        // 3. Get today's total cost from agent_usage_logs
        const { data: costData } = await supabase
            .from('agent_usage_logs')
            .select('cost_usd')
            .eq('user_id', userId)
            .gte('created_at', `${today}T00:00:00`)
            .lte('created_at', `${today}T23:59:59`);

        const spent = costData?.reduce((sum, row) => sum + (parseFloat(row.cost_usd) || 0), 0) || 0;
        const remaining = Math.max(0, costLimit - spent);

        console.log(`💰 [CostBudget] User ${userId.substring(0, 8)}... spent $${spent.toFixed(4)} / $${costLimit.toFixed(2)}`);

        return {
            exceeded: spent >= costLimit,
            spent,
            limit: costLimit,
            remaining
        };
    }

    /**
     * Increment usage count for a user
     */
    async incrementUsage(
        userId: string,
        agentId: string = 'default',
        amount: number = 1
    ): Promise<boolean> {
        // Skip DB operations for anonymous users (prevents UUID format error)
        if (!userId || userId === 'anon' || userId === 'anonymous' || userId.length < 10) {
            console.log(`📊 [QuotaManager] Anonymous user - skipping DB tracking`);
            return true; // Allow but don't track
        }

        const today = this.getTodayDate();

        try {
            // Try to update existing record
            const { data: existing } = await supabase
                .from('usage_quotas')
                .select('id, count')
                .eq('user_id', userId)
                .eq('agent_id', agentId)
                .eq('date', today)
                .single();

            if (existing) {
                // Update existing
                const { error } = await supabase
                    .from('usage_quotas')
                    .update({
                        count: existing.count + amount,
                        updated_at: new Date().toISOString()
                    })
                    .eq('id', existing.id);

                if (error) {
                    console.error('[QuotaManager] Failed to update usage:', error);
                    return false;
                }
            } else {
                // Create new record
                const { error } = await supabase
                    .from('usage_quotas')
                    .insert({
                        user_id: userId,
                        agent_id: agentId,
                        date: today,
                        count: amount
                    });

                if (error) {
                    console.error('[QuotaManager] Failed to insert usage:', error);
                    return false;
                }
            }

            console.log(`📊 [QuotaManager] User ${userId.substring(0, 8)}... used ${amount} for ${agentId}`);
            return true;
        } catch (error) {
            console.error('[QuotaManager] Exception:', error);
            return false;
        }
    }

    /**
     * Get total usage for today
     */
    async getTodayUsage(userId: string): Promise<Record<string, number>> {
        const today = this.getTodayDate();

        const { data, error } = await supabase
            .from('usage_quotas')
            .select('agent_id, count')
            .eq('user_id', userId)
            .eq('date', today);

        if (error || !data) return {};

        return data.reduce((acc, row) => {
            acc[row.agent_id] = row.count;
            return acc;
        }, {} as Record<string, number>);
    }

    /**
     * Get usage history for a user (last N days)
     */
    async getUsageHistory(
        userId: string,
        days: number = 7
    ): Promise<Array<{ date: string; total: number }>> {
        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days);

        const { data, error } = await supabase
            .from('usage_quotas')
            .select('date, count')
            .eq('user_id', userId)
            .gte('date', startDate.toISOString().split('T')[0])
            .order('date', { ascending: true });

        if (error || !data) return [];

        // Aggregate by date
        const byDate: Record<string, number> = {};
        for (const row of data) {
            byDate[row.date] = (byDate[row.date] || 0) + row.count;
        }

        return Object.entries(byDate).map(([date, total]) => ({ date, total }));
    }

    /**
     * Reset quota for testing (admin only)
     */
    async resetQuota(userId: string): Promise<boolean> {
        const today = this.getTodayDate();

        const { error } = await supabase
            .from('usage_quotas')
            .delete()
            .eq('user_id', userId)
            .eq('date', today);

        return !error;
    }

    // Helpers
    private getTodayDate(): string {
        return new Date().toISOString().split('T')[0];
    }

    private getNextMidnight(): Date {
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        tomorrow.setHours(0, 0, 0, 0);
        return tomorrow;
    }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const quotaManager = new QuotaManager();

console.log('✅ Quota Manager initialized');
