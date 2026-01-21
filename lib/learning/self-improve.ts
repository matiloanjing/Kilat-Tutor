/**
 * Self-Improvement Loop
 * 
 * Automatically improves AI prompts based on success patterns.
 * Connects proven_patterns → system prompts → better responses.
 * 
 * Copyright © 2026 KilatOS
 */

import { createClient } from '@/lib/auth/server';
import { getActiveAdjustments, injectRLHFContext } from './rlhf';
import { getUserProfile, formatUserMemory, learnFromInteraction } from '../memory/user-memory';
import { fireAndForget } from '@/lib/utils/non-blocking-db';

// ============================================================================
// Types
// ============================================================================

interface ProvenPattern {
    agent_type: string;
    pattern_name: string;
    pattern_content: string;
    success_rate: number;
    usage_count: number;
}

interface EnhancedPrompt {
    systemPrompt: string;
    userMemory: string;
    rlhfAdjustments: string[];
    patterns: string[];
    totalEnhancements: number;
}

// ============================================================================
// Pattern Retrieval
// ============================================================================

/**
 * Get successful patterns for an agent
 */
export async function getSuccessfulPatterns(
    agentType: string,
    limit: number = 3
): Promise<ProvenPattern[]> {
    const supabase = await createClient();

    const { data, error } = await supabase
        .from('proven_patterns')
        .select('agent_type, pattern_name, pattern_content, success_rate, usage_count')
        .eq('agent_type', agentType)
        .gte('success_rate', 0.7) // Only high success patterns
        .order('success_rate', { ascending: false })
        .limit(limit);

    if (error || !data) {
        return [];
    }

    return data;
}

/**
 * Format patterns for prompt injection
 */
export function formatPatterns(patterns: ProvenPattern[]): string {
    if (patterns.length === 0) return '';

    return `
[PROVEN PATTERNS]
Based on successful past executions:
${patterns.map((p, i) => `${i + 1}. ${p.pattern_name}: ${p.pattern_content || 'Follow established approach'}`).join('\n')}
[/PROVEN PATTERNS]
`;
}

// ============================================================================
// Error Pattern Retrieval (NEW)
// ============================================================================

interface ErrorPatternEntry {
    pattern_name: string;
    pattern_content: string;
}

/**
 * Get error patterns to avoid (success_rate = 0)
 */
export async function getErrorPatterns(
    agentType: string,
    limit: number = 3
): Promise<ErrorPatternEntry[]> {
    const supabase = await createClient();

    const { data, error } = await supabase
        .from('proven_patterns')
        .select('pattern_name, pattern_content')
        .eq('agent_type', agentType)
        .eq('success_rate', 0) // Error patterns have success_rate = 0
        .eq('is_active', true)
        .order('usage_count', { ascending: false })
        .limit(limit);

    if (error || !data) {
        return [];
    }

    return data;
}

/**
 * Format error patterns for prompt injection
 */
export function formatErrorPatterns(patterns: ErrorPatternEntry[]): string {
    if (patterns.length === 0) return '';

    return `
[ERROR PATTERNS TO AVOID]
Based on past failures, avoid these mistakes:
${patterns.map((p, i) => `${i + 1}. ${p.pattern_content || 'Unknown error'}`).join('\n')}
[/ERROR PATTERNS]
`;
}

// ============================================================================
// Enhanced Prompt Generation
// ============================================================================

/**
 * Build an enhanced prompt with all self-improvement features
 */
export async function buildEnhancedPrompt(
    basePrompt: string,
    agentType: string,
    userId?: string
): Promise<EnhancedPrompt> {
    const result: EnhancedPrompt = {
        systemPrompt: basePrompt,
        userMemory: '',
        rlhfAdjustments: [],
        patterns: [],
        totalEnhancements: 0
    };

    try {
        // 1. Get RLHF adjustments
        result.rlhfAdjustments = await getActiveAdjustments(agentType);
        if (result.rlhfAdjustments.length > 0) {
            result.systemPrompt = injectRLHFContext(result.systemPrompt, result.rlhfAdjustments);
            result.totalEnhancements += result.rlhfAdjustments.length;
        }

        // 2. Get user memory
        if (userId && userId !== 'anon') {
            const profile = await getUserProfile(userId);
            result.userMemory = formatUserMemory(profile);
            if (result.userMemory) {
                result.systemPrompt = result.userMemory + '\n\n' + result.systemPrompt;
                result.totalEnhancements++;
            }
        }

        // 3. Get proven patterns (success)
        const patterns = await getSuccessfulPatterns(agentType);
        if (patterns.length > 0) {
            result.patterns = patterns.map(p => p.pattern_name);
            const patternsContext = formatPatterns(patterns);
            result.systemPrompt = patternsContext + '\n\n' + result.systemPrompt;
            result.totalEnhancements += patterns.length;
        }

        // 4. Get error patterns to avoid (NEW)
        const errorPatterns = await getErrorPatterns(agentType);
        if (errorPatterns.length > 0) {
            const errorContext = formatErrorPatterns(errorPatterns);
            result.systemPrompt = errorContext + '\n\n' + result.systemPrompt;
            result.totalEnhancements += errorPatterns.length;
            console.log(`🔴 [SelfImprove] Injected ${errorPatterns.length} error patterns to avoid`);
        }

        console.log(`🧠 [SelfImprove] Enhanced prompt for ${agentType}: +${result.totalEnhancements} improvements`);

    } catch (error) {
        console.error('[SelfImprove] Error building enhanced prompt:', error);
    }

    return result;
}

// ============================================================================
// Feedback Integration
// ============================================================================

/**
 * Record feedback and update patterns
 */
export async function recordFeedback(
    agentType: string,
    isPositive: boolean,
    patternUsed?: string
): Promise<void> {
    const supabase = await createClient();

    // Update pattern success rate if pattern was used
    if (patternUsed) {
        const column = isPositive ? 'success_count' : 'failure_count';

        await supabase.rpc('increment_pattern_stat', {
            p_pattern_name: patternUsed,
            p_column: column
        });
    }

    console.log(`📊 [SelfImprove] Feedback recorded: ${isPositive ? '👍' : '👎'} for ${agentType}`);
}

// ============================================================================
// Learning Hook (Call after each interaction)
// ============================================================================

/**
 * Post-interaction learning hook
 */
export async function learnFromResponse(
    userId: string,
    agentType: string,
    userMessage: string,
    wasSuccessful: boolean
): Promise<void> {
    // Learn user preferences from message
    fireAndForget(() => learnFromInteraction(userId, userMessage, agentType));

    // Log success/failure for RLHF
    if (wasSuccessful !== undefined) {
        fireAndForget(() => recordFeedback(agentType, wasSuccessful));
    }
}

// ============================================================================
// Quick Summary
// ============================================================================

export function summarizeSelfImprovement(): string {
    return `
Self-Improvement System Active:
- RLHF: Learns from 👍/👎 feedback
- User Memory: Remembers preferences across sessions
- Proven Patterns: Uses successful past approaches
- Continuous Learning: Updates with each interaction
`;
}

export default {
    getSuccessfulPatterns,
    formatPatterns,
    buildEnhancedPrompt,
    recordFeedback,
    learnFromResponse,
    summarizeSelfImprovement
};
