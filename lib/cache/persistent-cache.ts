/**
 * Persistent Response Cache using Supabase job_queue
 * 
 * Replaces in-memory ResponseCache with database-backed cache
 * that persists across Vercel serverless function instances.
 * 
 * Copyright © 2026 KilatCode Studio
 */

import { SupabaseClient } from '@supabase/supabase-js';

// ============================================================================
// Types
// ============================================================================

export interface CachedResponse {
    jobId: string;
    outputContent: string;
    files: Record<string, string> | null;
    completedAt: string;
    similarity: number;
}

// ============================================================================
// Prompt Normalization
// ============================================================================

/**
 * Normalize prompt for comparison
 * Removes noise, lowercases, and extracts key terms
 */
function normalizePrompt(text: string): string {
    return text
        .toLowerCase()
        .replace(/[^\w\s]/g, ' ')  // Remove punctuation
        .replace(/\s+/g, ' ')       // Collapse whitespace
        .trim()
        .slice(0, 200);             // Limit length
}

/**
 * Extract meaningful tokens from prompt
 */
function tokenize(text: string): Set<string> {
    const normalized = normalizePrompt(text);
    const stopWords = new Set([
        'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been',
        'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
        'would', 'could', 'should', 'may', 'might', 'must', 'shall',
        'can', 'dengan', 'dan', 'yang', 'untuk', 'di', 'ke', 'dari',
        'saya', 'mau', 'buatkan', 'tolong', 'buat', 'bikin'
    ]);

    return new Set(
        normalized.split(' ')
            .filter(word => word.length > 2 && !stopWords.has(word))
    );
}

/**
 * Jaccard similarity between two token sets
 */
function jaccardSimilarity(setA: Set<string>, setB: Set<string>): number {
    if (setA.size === 0 || setB.size === 0) return 0;

    const intersection = [...setA].filter(x => setB.has(x)).length;
    const union = new Set([...setA, ...setB]).size;

    return intersection / union;
}

// ============================================================================
// Persistent Cache Functions
// ============================================================================

/**
 * Find cached response from job_queue
 * 
 * @param prompt - User's input prompt
 * @param supabase - Supabase client
 * @param maxAgeHours - Max age of cached response (default 24h)
 * @param threshold - Similarity threshold (default 0.7)
 */
export async function findCachedResponse(
    prompt: string,
    supabase: SupabaseClient,
    maxAgeHours: number = 72,  // 3 days default
    threshold: number = 0.7
): Promise<CachedResponse | null> {
    try {
        // Calculate cutoff date
        const cutoffDate = new Date();
        cutoffDate.setHours(cutoffDate.getHours() - maxAgeHours);

        // Query recent completed jobs
        const { data: jobs, error } = await supabase
            .from('job_queue')
            .select('id, input_message, output_content, files, completed_at')
            .eq('status', 'completed')
            .gte('completed_at', cutoffDate.toISOString())
            .not('output_content', 'is', null)
            .order('completed_at', { ascending: false })
            .limit(100);  // Limit search scope

        if (error || !jobs || jobs.length === 0) {
            return null;
        }

        // Tokenize input prompt
        const inputTokens = tokenize(prompt);

        // Find best matching job
        let bestMatch: CachedResponse | null = null;
        let bestScore = 0;

        for (const job of jobs) {
            if (!job.input_message) continue;

            const jobTokens = tokenize(job.input_message);
            const similarity = jaccardSimilarity(inputTokens, jobTokens);

            if (similarity >= threshold && similarity > bestScore) {
                bestScore = similarity;
                bestMatch = {
                    jobId: job.id,
                    outputContent: job.output_content,
                    files: job.files,
                    completedAt: job.completed_at,
                    similarity: similarity
                };
            }
        }

        if (bestMatch) {
            console.log(`🎯 [PersistentCache] HIT (similarity: ${(bestScore * 100).toFixed(1)}%, age: ${getAge(bestMatch.completedAt)})`);
        }

        return bestMatch;

    } catch (error) {
        console.error('[PersistentCache] Search error:', error);
        return null;
    }
}

/**
 * Calculate age string from timestamp
 */
function getAge(timestamp: string): string {
    const diff = Date.now() - new Date(timestamp).getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    if (hours < 1) return 'just now';
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

/**
 * Check if prompt has cached response (quick check)
 * For use in progress updates
 */
export async function hasCachedResponse(
    prompt: string,
    supabase: SupabaseClient
): Promise<boolean> {
    const result = await findCachedResponse(prompt, supabase, 72, 0.7);
    return result !== null;
}

export default {
    findCachedResponse,
    hasCachedResponse,
    normalizePrompt,
    jaccardSimilarity
};
