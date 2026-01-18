/**
 * Pollination API Usage Extraction
 * Extract real token counts from API responses
 * Copyright © 2025 KilatCode Studio
 */

import type { ChatResponse } from '../ai/pollination-client';
import { usageTracker } from './usage-tracker';

/**
 * Extract and log usage from Pollination API response
 * Use REAL token counts from API instead of estimates
 */
export async function logPollinationUsage(
    response: ChatResponse | any,
    metadata: {
        userId?: string;
        sessionId?: string;
        agentType: string;
        taskInput: string;
        success: boolean;
        latencyMs: number;
        model: string;
    }
): Promise<void> {
    // Extract real token counts from API response
    const usage = response.usage;

    if (!usage) {
        console.warn('No usage data in response, skipping token tracking');
        return;
    }

    // Log with REAL token counts from API
    try {
        await usageTracker.logUsage({
            // User context
            userId: metadata.userId === 'anonymous' || !metadata.userId ? undefined : metadata.userId,
            sessionId: metadata.sessionId || `pollin_${Date.now()}`,

            // Agent info
            agentType: metadata.agentType,
            agentVersion: '1.0',

            // Task info - matches interface
            taskInput: metadata.taskInput,
            taskComplexity: metadata.taskInput.length > 100 ? 'medium' : 'light',

            // Optimization info
            baseTemplateUsed: metadata.model,
            enhancementsApplied: [],
            qualityChecksRun: [],

            // Execution info
            aiProvider: 'pollination',
            modelUsed: metadata.model,
            priority: 'normal',

            // Results
            success: metadata.success,
            outputText: typeof response === 'string' ? response : response.choices?.[0]?.message?.content,
            qualityScore: metadata.success ? 1.0 : 0.0,
            validationPassed: metadata.success,

            // Performance
            latencyMs: metadata.latencyMs,
            tokensInput: usage.prompt_tokens,
            tokensOutput: usage.completion_tokens,
            costUsd: calculateCost(metadata.model, usage.prompt_tokens, usage.completion_tokens),
        });

        console.log(`✅ Pollination text usage logged successfully: ${usage.prompt_tokens} input + ${usage.completion_tokens} output = ${usage.total_tokens} total tokens`);
    } catch (error) {
        console.error('❌ Failed to log usage:', error instanceof Error ? error.message : error);
    }
}

/**
 * Calculate cost from model and token counts
 * Uses actual token counts from API for accurate billing
 */
function calculateCost(model: string, inputTokens: number, outputTokens: number): number {
    // Pricing per million tokens (from Pollinations screenshots)
    const PRICING: Record<string, { input: number; output: number }> = {
        'gemini-fast': { input: 0.1, output: 0.4 },
        'openai-fast': { input: 0.06, output: 0.44 },
        'claude-fast': { input: 1.0, output: 5.0 },
        'claude': { input: 3.0, output: 15.0 },
        'qwen-coder': { input: 0.06, output: 0.22 },
        'openai-large': { input: 1.75, output: 14.0 },
        'grok': { input: 0.2, output: 0.5 },
        // Add more as needed
    };

    const pricing = PRICING[model] || { input: 0.1, output: 0.5 }; // Default fallback

    const inputCost = (inputTokens / 1_000_000) * pricing.input;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;

    return inputCost + outputCost;
}

/**
 * Log image generation usage
 * Images don't have token counts, track per-image cost
 */
export async function logImageUsage(
    metadata: {
        userId?: string;
        sessionId?: string;
        model: string;
        imagesGenerated: number;
        pollenCost: number;
        taskInput: string;
        success: boolean;
        latencyMs: number;
        modelAttempts?: string[];  // Track fallback chain if retry happened
    }
): Promise<void> {
    // Log fallback chain for debugging
    if (metadata.modelAttempts && metadata.modelAttempts.length > 1) {
        console.log(`📊 Image Fallback chain: ${metadata.modelAttempts.join(' → ')}`);
    }

    await usageTracker.logUsage({
        userId: metadata.userId === 'anonymous' || !metadata.userId ? undefined : metadata.userId, // Fix: undefined instead of "anonymous"
        sessionId: metadata.sessionId,
        agentType: 'imagegen',
        agentVersion: '1.0',
        taskInput: metadata.taskInput,
        taskComplexity: 'light',
        baseTemplateUsed: metadata.model,
        enhancementsApplied: [],
        qualityChecksRun: [],  // No quality checks for image gen
        success: metadata.success,
        qualityScore: metadata.success ? 1.0 : 0.0,
        validationPassed: metadata.success,
        latencyMs: metadata.latencyMs,

        // Pollination API metadata
        aiProvider: 'pollination',
        modelUsed: metadata.model,
        priority: 'normal',

        // Image generation doesn't use tokens
        tokensInput: 0,
        tokensOutput: 0,

        // Cost in USD (convert pollen to USD: 1 pollen ≈ $0.001)
        costUsd: metadata.pollenCost * 0.001
    });

    console.log(`✅ Image usage logged: ${metadata.imagesGenerated} images, ${metadata.pollenCost} pollen`);
}
