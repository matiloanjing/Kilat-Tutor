/**
 * Trace Logger
 * Logs step-by-step execution traces to Supabase for monitoring and AI learning.
 * 
 * SEPARATE from usage-tracker.ts (which logs final results).
 * trace-logger logs the JOURNEY, usage-tracker logs the DESTINATION.
 * 
 * Copyright © 2026 KilatOS
 */

import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

// Only initialize on server-side
const supabase = typeof window === 'undefined' && supabaseUrl && supabaseKey
    ? createClient(supabaseUrl, supabaseKey)
    : null;

// ============================================================================
// Types
// ============================================================================

export interface TraceStep {
    timestamp: string;
    step: string;
    result: string;
    details?: Record<string, any>;
    duration_ms?: number;
}

export interface TraceContext {
    id: string;
    job_id: string;
    session_id?: string;
    user_id?: string;
    agent_type: string;
    mode?: 'fast' | 'planning';
    prompt_preview?: string;
    steps: TraceStep[];
    start_time: number;
    cache_hits: number;
    cache_misses: number;
    rate_limit_waits: number;
}

// In-memory store for active traces (during single request lifecycle)
const activeTraces = new Map<string, TraceContext>();

// Step type constants for consistency
export const STEP_TYPES = {
    // Startup
    START: 'start',

    // Tier & Quota
    TIER_CHECK: 'tier_check',
    QUOTA_CHECK: 'quota_check',

    // Caching
    CACHE_PERSISTENT: 'cache_persistent',
    CACHE_JACCARD: 'cache_jaccard',
    CACHE_SEMANTIC: 'cache_semantic',
    CACHE_SAVE: 'cache_save',

    // RAG & Knowledge
    RAG_RETRIEVAL: 'rag_retrieval',
    RAG_SYNC: 'rag_sync',

    // AI Execution
    AI_CALL: 'ai_call',
    RATE_LIMIT: 'rate_limit',

    // Processing
    DECOMPOSE: 'decompose',
    TASK_EXECUTE: 'task_execute',
    VERIFY: 'verify',
    SELF_HEAL: 'self_heal',
    MERGE: 'merge',

    // Collaboration
    AUTO_COLLAB: 'auto_collab',

    // Completion
    COMPLETE: 'complete',
    ERROR: 'error',
} as const;

// ============================================================================
// Trace Logger Class
// ============================================================================

class TraceLogger {

    /**
     * Start a new trace for a request
     */
    async startTrace(
        jobId: string,
        sessionId: string | undefined,
        userId: string | undefined,
        agentType: string,
        mode: 'fast' | 'planning',
        prompt: string
    ): Promise<string> {
        const traceId = crypto.randomUUID();
        const now = Date.now();

        const context: TraceContext = {
            id: traceId,
            job_id: jobId,
            session_id: sessionId,
            user_id: userId,
            agent_type: agentType,
            mode,
            prompt_preview: prompt.substring(0, 200),
            steps: [],
            start_time: now,
            cache_hits: 0,
            cache_misses: 0,
            rate_limit_waits: 0,
        };

        activeTraces.set(traceId, context);

        // Add start step
        this.addStep(traceId, STEP_TYPES.START, 'initiated', {
            agent: agentType,
            mode,
            prompt_length: prompt.length,
        });

        // Persist to DB
        if (supabase) {
            try {
                await supabase.from('request_traces').insert({
                    id: traceId,
                    job_id: jobId,
                    session_id: sessionId,
                    user_id: userId,
                    agent_type: agentType,
                    mode,
                    prompt_preview: prompt.substring(0, 200),
                    steps: [],
                    status: 'started',
                });
            } catch (error) {
                console.error('[TraceLogger] Failed to start trace:', error);
            }
        }

        return traceId;
    }

    /**
     * Add a step to an active trace
     */
    addStep(
        traceId: string,
        step: string,
        result: string,
        details?: Record<string, any>,
        durationMs?: number
    ): void {
        const context = activeTraces.get(traceId);
        if (!context) {
            // Trace not found, but don't error - just log
            console.warn(`[TraceLogger] No active trace: ${traceId}`);
            return;
        }

        const traceStep: TraceStep = {
            timestamp: new Date().toISOString(),
            step,
            result,
            details,
            duration_ms: durationMs,
        };

        context.steps.push(traceStep);

        // Track cache hits/misses
        if (step.startsWith('cache_') && result === 'hit') {
            context.cache_hits++;
        } else if (step.startsWith('cache_') && result === 'miss') {
            context.cache_misses++;
        }

        // Track rate limit waits
        if (step === STEP_TYPES.RATE_LIMIT && details?.waited) {
            context.rate_limit_waits++;
        }

        // Also log to console for terminal visibility
        const emoji = this.getStepEmoji(step, result);
        const detailStr = details ? ` (${JSON.stringify(details).substring(0, 50)})` : '';
        console.log(`   ${emoji} [Trace] ${step}: ${result}${detailStr}${durationMs ? ` [${durationMs}ms]` : ''}`);
    }

    /**
     * End a trace with final status
     */
    async endTrace(
        traceId: string,
        status: 'success' | 'error',
        summary?: {
            file_count?: number;
            error_message?: string;
        }
    ): Promise<void> {
        const context = activeTraces.get(traceId);
        if (!context) {
            console.warn(`[TraceLogger] No active trace to end: ${traceId}`);
            return;
        }

        const totalDuration = Date.now() - context.start_time;

        // Add completion step
        this.addStep(traceId, status === 'success' ? STEP_TYPES.COMPLETE : STEP_TYPES.ERROR, status, {
            total_ms: totalDuration,
            files: summary?.file_count,
            error: summary?.error_message,
        });

        // Persist to DB
        if (supabase) {
            try {
                await supabase.from('request_traces')
                    .update({
                        steps: context.steps,
                        status,
                        total_duration_ms: totalDuration,
                        file_count: summary?.file_count || 0,
                        cache_hits: context.cache_hits,
                        cache_misses: context.cache_misses,
                        rate_limit_waits: context.rate_limit_waits,
                        error_message: summary?.error_message,
                    })
                    .eq('id', traceId);

                console.log(`   ✅ [TraceLogger] Trace saved: ${traceId} (${status})`);
            } catch (error) {
                console.error('[TraceLogger] Failed to save trace:', error);
            }
        }

        // Clean up memory
        activeTraces.delete(traceId);
    }

    /**
     * Get current trace context (for reading steps)
     */
    getTrace(traceId: string): TraceContext | undefined {
        return activeTraces.get(traceId);
    }

    /**
     * Helper to get emoji for console output
     */
    private getStepEmoji(step: string, result: string): string {
        const emojis: Record<string, string> = {
            'start': '🚀',
            'tier_check': '🏷️',
            'quota_check': '📊',
            'cache_persistent': result === 'hit' ? '💾' : '🔍',
            'cache_jaccard': result === 'hit' ? '🎯' : '🔍',
            'cache_semantic': result === 'hit' ? '🧠' : '🔍',
            'cache_save': '💾',
            'rag_retrieval': '📚',
            'rag_sync': '🔄',
            'ai_call': '🤖',
            'rate_limit': result === 'allowed' ? '🚦' : '⏳',
            'decompose': '📋',
            'task_execute': '⚙️',
            'verify': '🕵️',
            'self_heal': '🔧',
            'merge': '🔗',
            'auto_collab': '🌐',
            'complete': '✅',
            'error': '❌',
        };
        return emojis[step] || '📝';
    }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const traceLogger = new TraceLogger();

console.log('✅ Trace Logger initialized');
