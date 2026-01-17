/**
 * Session Details API
 * GET /api/kilat/sessions/[id]
 * - Returns session metadata and message history
 * - Enforces correct user usage
 * 
 * Copyright © 2026 KilatCode Studio
 */

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@/lib/auth/server';

export async function GET(
    request: NextRequest,
    { params }: { params: Promise<{ id: string }> }
) {
    const supabase = await createClient();
    // Next.js 14: params is now a Promise, must await
    const { id: sessionId } = await params;

    console.log('[Session API] Fetching session:', sessionId);

    // Strict Auth
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
        return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    try {
        // 1. Get Session (verify ownership)
        const { data: session, error: sessionError } = await supabase
            .from('sessions')
            .select('*')
            .eq('id', sessionId)
            .eq('user_id', user.id)
            .single();

        if (sessionError || !session) {
            return NextResponse.json({ success: false, error: 'Session not found' }, { status: 404 });
        }

        // 2. Get Messages (agent_states)
        // We look for 'context_message' steps which represent chat history
        const { data: messages, error: msgError } = await supabase
            .from('agent_states')
            .select('*')
            .eq('session_id', sessionId)
            .eq('step_type', 'context_message') // FIX: Only fetch chat messages
            .order('created_at', { ascending: true });

        if (msgError) {
            console.error('Failed to fetch messages:', msgError);
            return NextResponse.json({ success: false, error: 'Failed to fetch messages' }, { status: 500 });
        }

        // Map to mutable array for potential job_queue additions
        const formattedMessages: any[] = messages.map(row => {
            const data = row.state_data || {};

            if (row.step_type === 'context_message' || (data.role && data.content)) {
                return {
                    id: row.id,
                    role: data.role || 'assistant',
                    content: data.content || '',
                    timestamp: row.created_at,
                    agent: data.agent,
                    status: 'complete'
                };
            }
            return null;
        }).filter(Boolean);

        // =====================================================================
        // FALLBACK: Load from job_queue if primary storage failed
        // This handles cases where save to agent_states/sessions.context failed
        // but job_queue was updated successfully (Vercel timeout edge case)
        // =====================================================================

        // Get completed job for this session
        const { data: completedJob } = await supabase
            .from('job_queue')
            .select('id, output_content, files, completed_at, agent_type')
            .eq('session_id', sessionId)
            .eq('status', 'completed')
            .order('completed_at', { ascending: false })
            .limit(1)
            .single();

        // Check if we need to add assistant message from job_queue
        const hasAssistantMessage = formattedMessages.some((m: any) => m.role === 'assistant');
        if (!hasAssistantMessage && completedJob?.output_content) {
            formattedMessages.push({
                id: `job_${completedJob.id}`,
                role: 'assistant',
                content: completedJob.output_content,
                timestamp: completedJob.completed_at,
                agent: completedJob.agent_type || 'codegen',
                status: 'complete'
            });
            console.log('[Session API] Added assistant message from job_queue fallback');
        }

        // Extract files - prioritize session.context, fallback to job_queue
        let generatedFiles = (session.context as any)?.files || null;

        if (!generatedFiles && completedJob?.files) {
            generatedFiles = completedJob.files;
            console.log('[Session API] Using files from job_queue fallback');
        }

        return NextResponse.json({
            success: true,
            session,
            messages: formattedMessages,
            files: generatedFiles
        });

    } catch (error) {
        console.error('[Session Details] Exception:', error);
        return NextResponse.json({ success: false, error: 'Internal server error' }, { status: 500 });
    }
}
