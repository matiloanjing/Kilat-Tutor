/**
 * Feedback API Route
 * Submit and retrieve user feedback
 * Copyright © 2025 KilatCode Studio
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import {
    submitFeedback,
    getFeedbackStats,
    getTopModels,
    getUserFeedbackTrends
} from '@/lib/agents/adaptive/feedback-collector';

// Feedback submission schema
const FeedbackSubmissionSchema = z.object({
    sessionId: z.string(),
    userId: z.string().optional(),
    agentType: z.enum(['solve', 'question', 'research', 'guide', 'ideagen', 'cowriter', 'codegen', 'imagegen', 'audit']),
    userRating: z.number().min(1).max(5),
    feedbackText: z.string().optional(),
    wasSuccessful: z.boolean(),
    iterationCount: z.number().optional(),
    modelUsed: z.string(),
    executionTime: z.number().optional(),
    costPollen: z.number().optional(),
    metadata: z.record(z.any()).optional()
});

export async function POST(req: NextRequest) {
    try {
        const body = await req.json();

        // BACKWARD COMPATIBLE: Check if this is a simple good/bad feedback from UI buttons
        if (body.rating && (body.rating === 'good' || body.rating === 'bad')) {
            const { messageId, sessionId, rating, agentType, modelUsed, userId } = body;

            if (!messageId || !agentType) {
                return NextResponse.json({
                    success: false,
                    error: 'messageId and agentType are required'
                }, { status: 400 });
            }

            const wasSuccessful = rating === 'good';
            const userRating = rating === 'good' ? 5 : 1;

            console.log(`📊 [Feedback] Simple rating: ${agentType} - ${rating}`);

            await submitFeedback({
                sessionId: sessionId || 'unknown',
                userId: userId || undefined,
                agentType: agentType as any,
                userRating: userRating as 1 | 2 | 3 | 4 | 5,
                feedbackText: undefined,
                wasSuccessful,
                modelUsed: modelUsed || 'unknown',
                metadata: {
                    messageId,
                    source: 'chat_panel_button',
                    timestamp: new Date().toISOString()
                }
            });

            return NextResponse.json({
                success: true,
                message: 'Feedback recorded for AI learning'
            });
        }

        // EXISTING: Full feedback schema validation
        const validatedData = FeedbackSubmissionSchema.parse(body);

        // Ensure userRating is valid 1-5 star rating
        const userRating = Math.max(1, Math.min(5, Math.round(validatedData.userRating))) as 1 | 2 | 3 | 4 | 5;

        await submitFeedback({
            ...validatedData,
            userRating
        });

        return NextResponse.json({
            success: true,
            message: 'Feedback submitted successfully'
        });

    } catch (error) {
        console.error('Feedback API error:', error);

        if (error instanceof z.ZodError) {
            return NextResponse.json(
                { error: 'Validation error', details: error.errors },
                { status: 400 }
            );
        }

        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}

export async function GET(req: NextRequest) {
    try {
        const { searchParams } = new URL(req.url);
        const action = searchParams.get('action');
        const sessionId = searchParams.get('sessionId');
        const agentType = searchParams.get('agentType');
        const model = searchParams.get('model');
        const userId = searchParams.get('userId');

        // BACKWARD COMPATIBLE: Load ratings by sessionId for UI persistence
        if (sessionId && !action) {
            const { createClient } = await import('@supabase/supabase-js');
            const supabase = createClient(
                process.env.NEXT_PUBLIC_SUPABASE_URL!,
                process.env.SUPABASE_SERVICE_ROLE_KEY!
            );

            const { data, error } = await supabase
                .from('agent_feedback')
                .select('metadata, was_successful')
                .eq('session_id', sessionId);

            if (error) throw error;

            const ratings: Record<string, 'good' | 'bad'> = {};
            data?.forEach((entry: any) => {
                const messageId = entry.metadata?.messageId;
                if (messageId) {
                    ratings[messageId] = entry.was_successful ? 'good' : 'bad';
                }
            });

            console.log(`📊 [Feedback GET] Loaded ${Object.keys(ratings).length} ratings for session`);

            return NextResponse.json({
                success: true,
                ratings
            });
        }

        if (action === 'stats' && agentType) {
            // Get feedback statistics
            const stats = await getFeedbackStats(agentType, model || undefined);
            return NextResponse.json(stats);
        }

        if (action === 'top-models' && agentType) {
            // Get top performing models
            const limit = parseInt(searchParams.get('limit') || '5');
            const topModels = await getTopModels(agentType, limit);
            return NextResponse.json(topModels);
        }

        if (action === 'user-trends' && userId) {
            // Get user-specific trends
            const trends = await getUserFeedbackTrends(userId, agentType || undefined);
            return NextResponse.json(trends);
        }

        return NextResponse.json(
            { error: 'Invalid action or missing parameters' },
            { status: 400 }
        );

    } catch (error) {
        console.error('Feedback GET error:', error);
        return NextResponse.json(
            { error: 'Internal server error' },
            { status: 500 }
        );
    }
}
