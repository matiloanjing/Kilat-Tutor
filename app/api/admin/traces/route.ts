/**
 * Admin Traces API
 * Fetches request traces for admin dashboard monitoring
 * 
 * Copyright © 2026 KilatOS
 */

import { createClient } from '@/lib/auth/server';
import { NextResponse } from 'next/server';

export async function GET() {
    try {
        const supabase = await createClient();

        // Check admin access
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // TODO: Add proper admin check via user_profiles.tier = 'admin'
        // For now, allow any authenticated user to view traces

        // Get recent traces (last 7 days)
        const { data: traces, error: tracesError } = await supabase
            .from('request_traces')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(100);

        if (tracesError) {
            console.error('[Admin/Traces] Error fetching traces:', tracesError);
            return NextResponse.json({ error: 'Failed to fetch traces' }, { status: 500 });
        }

        // Get summary stats
        const { data: summary, error: summaryError } = await supabase
            .from('admin_trace_summary')
            .select('*')
            .limit(7);

        // Calculate totals
        const today = traces?.filter(t => {
            const created = new Date(t.created_at);
            const now = new Date();
            return created.toDateString() === now.toDateString();
        }) || [];

        const stats = {
            todayTotal: today.length,
            todaySuccess: today.filter(t => t.status === 'success').length,
            todayErrors: today.filter(t => t.status === 'error').length,
            avgDuration: today.length > 0
                ? Math.round(today.reduce((sum, t) => sum + (t.total_duration_ms || 0), 0) / today.length)
                : 0,
            totalCacheHits: today.reduce((sum, t) => sum + (t.cache_hits || 0), 0),
            totalCacheMisses: today.reduce((sum, t) => sum + (t.cache_misses || 0), 0),
        };

        return NextResponse.json({
            traces: traces || [],
            summary: summary || [],
            stats,
        });

    } catch (error) {
        console.error('[Admin/Traces] Error:', error);
        return NextResponse.json({
            error: 'Internal server error',
            message: error instanceof Error ? error.message : 'Unknown error'
        }, { status: 500 });
    }
}
