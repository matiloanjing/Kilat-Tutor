/**
 * RLHF - Reinforcement Learning from Human Feedback
 * 
 * Analyzes user feedback (👍/👎) to improve AI responses.
 * Creates prompt adjustments based on success patterns.
 * 
 * Copyright © 2026 KilatOS
 */

import { createClient } from '@/lib/auth/server';

// ============================================================================
// Types
// ============================================================================

interface FeedbackPattern {
    agent_type: string;
    pattern: string;
    positive_count: number;
    negative_count: number;
    success_rate: number;
}

interface RLHFAdjustment {
    agent_type: string;
    adjustment_type: 'prompt_prefix' | 'style_guide' | 'constraint';
    trigger_pattern: string;
    adjustment_content: string;
    confidence: number;
}

// ============================================================================
// Feedback Analysis
// ============================================================================

/**
 * Analyze recent feedback to find success patterns
 */
export async function analyzeFeedbackPatterns(
    daysBack: number = 7
): Promise<FeedbackPattern[]> {
    const supabase = await createClient();

    const since = new Date();
    since.setDate(since.getDate() - daysBack);

    // Get recent feedback with session data
    const { data: feedback, error } = await supabase
        .from('agent_feedback')
        .select('agent_type, rating, was_successful, session_id, created_at')
        .gte('created_at', since.toISOString())
        .order('created_at', { ascending: false });

    if (error || !feedback) {
        console.error('Failed to fetch feedback:', error);
        return [];
    }

    // Aggregate by agent_type
    const patterns = new Map<string, FeedbackPattern>();

    for (const fb of feedback) {
        const key = fb.agent_type || 'unknown';

        if (!patterns.has(key)) {
            patterns.set(key, {
                agent_type: key,
                pattern: key,
                positive_count: 0,
                negative_count: 0,
                success_rate: 0
            });
        }

        const p = patterns.get(key)!;
        // Check rating first, then fallback to was_successful
        const isPositive = fb.rating === 'positive' ||
            fb.rating === 'like' ||
            fb.rating > 0 ||
            (fb.rating === null && fb.was_successful === true);

        if (isPositive) {
            p.positive_count++;
        } else if (fb.rating !== null || fb.was_successful === false) {
            // Only count as negative if explicitly negative
            p.negative_count++;
        }
    }

    // Calculate success rates
    for (const p of patterns.values()) {
        const total = p.positive_count + p.negative_count;
        p.success_rate = total > 0 ? (p.positive_count / total) * 100 : 50;
    }

    return Array.from(patterns.values());
}

// ============================================================================
// Adjustment Generation
// ============================================================================

/**
 * Generate prompt adjustments from feedback analysis
 */
export async function generateAdjustments(
    patterns: FeedbackPattern[]
): Promise<RLHFAdjustment[]> {
    const adjustments: RLHFAdjustment[] = [];

    for (const pattern of patterns) {
        // High success agents - reinforce
        if (pattern.success_rate > 80 && pattern.positive_count >= 3) {
            adjustments.push({
                agent_type: pattern.agent_type,
                adjustment_type: 'style_guide',
                trigger_pattern: '*',
                adjustment_content: `This agent has ${pattern.success_rate.toFixed(0)}% user satisfaction. Maintain current approach.`,
                confidence: pattern.success_rate / 100
            });
        }

        // Low success agents - improve
        if (pattern.success_rate < 60 && pattern.negative_count >= 2) {
            adjustments.push({
                agent_type: pattern.agent_type,
                adjustment_type: 'constraint',
                trigger_pattern: '*',
                adjustment_content: `IMPORTANT: This agent has low satisfaction (${pattern.success_rate.toFixed(0)}%). Be more thorough, provide examples, explain steps clearly.`,
                confidence: 0.7
            });
        }
    }

    return adjustments;
}

// ============================================================================
// Adjustment Storage
// ============================================================================

/**
 * Save adjustments to database
 */
export async function saveAdjustments(
    adjustments: RLHFAdjustment[]
): Promise<number> {
    if (adjustments.length === 0) return 0;

    const supabase = await createClient();
    let saved = 0;

    for (const adj of adjustments) {
        const { error } = await supabase
            .from('rlhf_adjustments')
            .upsert({
                agent_type: adj.agent_type,
                adjustment_type: adj.adjustment_type,
                trigger_pattern: adj.trigger_pattern,
                adjustment_content: adj.adjustment_content,
                confidence: adj.confidence,
                updated_at: new Date().toISOString()
            }, {
                onConflict: 'agent_type,adjustment_type'
            });

        if (!error) saved++;
    }

    return saved;
}

// ============================================================================
// Adjustment Retrieval (for prompt injection)
// ============================================================================

/**
 * Get active adjustments for an agent
 */
export async function getActiveAdjustments(
    agentType: string
): Promise<string[]> {
    const supabase = await createClient();

    const { data, error } = await supabase
        .from('rlhf_adjustments')
        .select('adjustment_content, confidence')
        .eq('agent_type', agentType)
        .eq('is_active', true)
        .gte('confidence', 0.5)
        .order('confidence', { ascending: false })
        .limit(3);

    if (error || !data) {
        return [];
    }

    return data.map(d => d.adjustment_content);
}

/**
 * Inject RLHF adjustments into system prompt
 */
export function injectRLHFContext(
    systemPrompt: string,
    adjustments: string[]
): string {
    if (adjustments.length === 0) return systemPrompt;

    const rlhfBlock = `
[RLHF LEARNED BEHAVIORS]
Based on user feedback analysis:
${adjustments.map((a, i) => `${i + 1}. ${a}`).join('\n')}
[/RLHF]
`;

    return rlhfBlock + '\n\n' + systemPrompt;
}

// ============================================================================
// Main RLHF Processing (for cron job)
// ============================================================================

export async function runRLHFProcessing(): Promise<{
    patterns_found: number;
    adjustments_saved: number;
}> {
    console.log('🧠 [RLHF] Starting feedback analysis...');

    // Analyze last 7 days of feedback
    const patterns = await analyzeFeedbackPatterns(7);
    console.log(`📊 [RLHF] Found ${patterns.length} feedback patterns`);

    // Generate adjustments
    const adjustments = await generateAdjustments(patterns);
    console.log(`✨ [RLHF] Generated ${adjustments.length} adjustments`);

    // Save to database
    const saved = await saveAdjustments(adjustments);
    console.log(`💾 [RLHF] Saved ${saved} adjustments`);

    return {
        patterns_found: patterns.length,
        adjustments_saved: saved
    };
}

export default {
    analyzeFeedbackPatterns,
    generateAdjustments,
    saveAdjustments,
    getActiveAdjustments,
    injectRLHFContext,
    runRLHFProcessing
};
