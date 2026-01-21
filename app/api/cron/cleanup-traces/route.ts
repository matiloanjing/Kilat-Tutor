/**
 * Cleanup Traces Cron Job
 * 
 * Runs daily to:
 * 1. Extract patterns from traces older than 7 days → learned_patterns
 * 2. Compress traces older than 7 days (remove large fields)
 * 3. Delete traces older than 30 days
 * 
 * Deployment: Vercel Cron (vercel.json)
 * Schedule: Every day at midnight UTC
 * 
 * Copyright © 2026 KilatOS
 */

import { createClient } from '@supabase/supabase-js';
import { NextResponse } from 'next/server';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function GET(request: Request) {
    // Verify cron secret (optional security)
    const authHeader = request.headers.get('authorization');
    if (process.env.CRON_SECRET && authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
        return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const results = {
        patternsExtracted: 0,
        tracesCompressed: 0,
        tracesDeleted: 0,
        errors: [] as string[],
    };

    try {
        // =====================================================
        // Step 1: Extract patterns from traces (7-30 days old)
        // =====================================================
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const { data: oldTraces, error: fetchError } = await supabase
            .from('request_traces')
            .select('*')
            .lt('created_at', sevenDaysAgo.toISOString())
            .eq('is_compressed', false)
            .limit(500);

        if (fetchError) {
            results.errors.push(`Fetch error: ${fetchError.message}`);
        }

        if (oldTraces && oldTraces.length > 0) {
            // Group by agent_type + status for pattern extraction
            const patterns: Record<string, {
                agent_type: string;
                status: string;
                count: number;
                avg_duration: number;
                cache_hit_rate: number;
                common_steps: string[];
            }> = {};

            for (const trace of oldTraces) {
                const key = `${trace.agent_type}_${trace.status}`;
                if (!patterns[key]) {
                    patterns[key] = {
                        agent_type: trace.agent_type,
                        status: trace.status,
                        count: 0,
                        avg_duration: 0,
                        cache_hit_rate: 0,
                        common_steps: [],
                    };
                }
                patterns[key].count++;
                patterns[key].avg_duration += trace.total_duration_ms || 0;
                patterns[key].cache_hit_rate += (trace.cache_hits / Math.max(1, trace.cache_hits + trace.cache_misses));
            }

            // Save patterns to learned_patterns
            for (const [key, pattern] of Object.entries(patterns)) {
                try {
                    await supabase.from('learned_patterns').upsert({
                        pattern_id: `trace_${key}_${new Date().toISOString().slice(0, 10)}`,
                        pattern_type: pattern.status === 'success' ? 'success_path' : 'error_path',
                        trigger: pattern.agent_type,
                        pattern_data: {
                            source: 'trace_extraction',
                            agent_type: pattern.agent_type,
                            status: pattern.status,
                            sample_size: pattern.count,
                            avg_duration_ms: Math.round(pattern.avg_duration / pattern.count),
                            cache_hit_rate: Math.round((pattern.cache_hit_rate / pattern.count) * 100) / 100,
                            extracted_at: new Date().toISOString(),
                        },
                        confidence: Math.min(0.95, 0.5 + (pattern.count * 0.01)), // More samples = higher confidence
                        times_used: pattern.count,
                        times_succeeded: pattern.status === 'success' ? pattern.count : 0,
                    }, { onConflict: 'pattern_id' });
                    results.patternsExtracted++;
                } catch (patternError) {
                    results.errors.push(`Pattern save error: ${patternError}`);
                }
            }

            // =====================================================
            // Step 2: Compress old traces (remove large fields)
            // =====================================================
            const traceIds = oldTraces.map(t => t.id);

            // Update: keep only summary, remove step details
            const { error: compressError } = await supabase
                .from('request_traces')
                .update({
                    is_compressed: true,
                    prompt_preview: null, // Remove prompt
                    steps: [], // Clear steps (already extracted)
                })
                .in('id', traceIds);

            if (compressError) {
                results.errors.push(`Compress error: ${compressError.message}`);
            } else {
                results.tracesCompressed = traceIds.length;
            }
        }

        // =====================================================
        // Step 3: Delete traces older than 30 days
        // =====================================================
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const { error: deleteError, count: deletedCount } = await supabase
            .from('request_traces')
            .delete({ count: 'exact' })
            .lt('created_at', thirtyDaysAgo.toISOString());

        if (deleteError) {
            results.errors.push(`Delete error: ${deleteError.message}`);
        } else {
            results.tracesDeleted = deletedCount || 0;
        }

        // Log summary
        console.log('[Cleanup Traces] Results:', results);

        return NextResponse.json({
            success: true,
            ...results,
            timestamp: new Date().toISOString(),
        });

    } catch (error) {
        console.error('[Cleanup Traces] Fatal error:', error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
            ...results,
        }, { status: 500 });
    }
}
