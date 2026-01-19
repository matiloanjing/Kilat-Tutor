/**
 * AI Mandor - The Digital Foreman
 * Main queue management and API coordination service
 * 
 * Responsibilities:
 * - Queue management with concurrency control
 * - Rate limiting (protect from IP ban)
 * - Multi-tier API routing (Paid/Free/Groq)
 * - Automatic retry with exponential backoff
 * - Cost optimization
 * 
 * Apple Philosophy:
 * - Simple API for agents (one line call!)
 * - Complex orchestration internally (12 steps)
 * 
 * Copyright © 2026 KilatOS
 */

import { AIRateLimiter } from './rate-limiter';
import { RetryHandler } from './retry-handler';
import { TierRouter, TaskComplexity, APITier } from './tier-router';
import { groqProvider } from './providers/groq';
import { distributedRateLimiter, type ProviderName } from './distributed-rate-limiter';

// ============================================================================
// Types
// ============================================================================

export interface AIMandorRequest {
    prompt: string;
    systemPrompt?: string;  // NEW: For PromptOptimizer integration
    complexity?: TaskComplexity;
    preferredTier?: APITier;
    preferredModel?: string; // Force specific model (e.g. 'qwen-coder')
    model?: string;  // Alias for preferredModel (backward compat)
    userPlan?: 'free' | 'pro' | 'enterprise'; // Business Logic: Strict Plan Enforcement
    userId?: string;  // User ID for tier detection and quota tracking
    sessionId?: string;  // Session ID for tracking
    agentType?: string;  // Agent type for tracking (e.g., 'codegen', 'solve', 'image')
    priority?: 'low' | 'normal' | 'high';
    timeout?: number;
    maxTokens?: number;  // Max tokens for quota tracking
    validateQuality?: boolean;
    enableThinking?: boolean; // Use prompt-based CoT (safer, works with all models)
}

export interface AIMandorResponse {
    result: string;
    tier: APITier;
    model: string;
    attempts: number;
    cost: number;
    duration: number;
    queueTime: number;
    // Token tracking for AI learning
    tokensInput?: number;
    tokensOutput?: number;
}

export interface AIMandorStats {
    totalRequests: number;
    successfulRequests: number;
    failedRequests: number;
    averageLatency: number;
    costToday: number;
    queueLength: number;
}

// ============================================================================
// AI Mandor Class
// ============================================================================

export class AIMandor {
    private rateLimiter: AIRateLimiter;
    private retryHandler: RetryHandler;
    private tierRouter: TierRouter;
    private queue: Array<{ fn: () => Promise<any>; priority: number }> = [];
    private isProcessing = false;
    private stats: AIMandorStats = {
        totalRequests: 0,
        successfulRequests: 0,
        failedRequests: 0,
        averageLatency: 0,
        costToday: 0,
        queueLength: 0
    };

    // Universal Code-Gen Enhancement Rules
    private readonly CODEGEN_RULES = `
## CRITICAL CODE GENERATION RULES (ALWAYS FOLLOW)

### 1. FILE MANIFEST FIRST
Before generating ANY code, list every file you will create:
\`\`\`
FILES TO CREATE:
- /App.tsx (main component)
- /components/Navbar.tsx (navigation)
- /package.json (dependencies)
\`\`\`

### 2. COMPLETE FILES ONLY
- NO placeholders like "// TODO" or "..."
- NO truncated code with "// rest of implementation..."
- Every file must be complete and runnable

### 3. DEPENDENCIES VERIFICATION
package.json MUST include ALL imports:
- Every "import X from 'package'" → must have matching entry in dependencies
- Use specific versions: "react": "^18.2.0", NOT "react": "latest"
- Include ALL peer dependencies

### 4. IMPORT VERIFICATION
For every import statement:
- If importing from "./path" → You MUST create that file
- If path doesn't exist in manifest → ADD IT before generating

### 5. OUTPUT FORMAT
Return as JSON with all files:
\`\`\`json
{
  "files": {
    "/App.tsx": "import React from 'react';...",
    "/components/Navbar.tsx": "export function Navbar...",
    "/package.json": "{\\"name\\":\\"app\\",...}"
  }
}
\`\`\`
`;

    /**
     * Enhance prompt for code generation with universal rules
     */
    private enhancePromptForCodeGen(prompt: string): string {
        const isCodeRequest = /buatkan?|generate|create|build|code|website|app|component|function|page|form/i.test(prompt);

        if (!isCodeRequest) return prompt;

        return `${this.CODEGEN_RULES}\n\n## USER REQUEST:\n${prompt}`;
    }

    constructor() {
        this.rateLimiter = new AIRateLimiter({
            maxRequestsPerSecond: 5,
            maxConcurrent: 3,
            cooldownMs: 1000,
            burstAllowance: 2
        });

        this.retryHandler = new RetryHandler({
            maxRetries: 3,
            initialDelayMs: 1000,
            maxDelayMs: 10000,
            backoffMultiplier: 2,
            jitterMs: 200
        });

        this.tierRouter = new TierRouter();
    }

    /**
     * Main API - Simple interface for agents!
     * 
     * @example
     * const result = await aiMandor.call('Generate code for navbar');
     * const result = await aiMandor.call({
     *   prompt: 'Design architecture',
     *   complexity: 'heavy',
     *   preferredTier: 'pro'
     * });
     */
    async call(
        prompt: string | AIMandorRequest,
        options?: Partial<AIMandorRequest>
    ): Promise<AIMandorResponse> {
        // Normalize input
        const request: AIMandorRequest = typeof prompt === 'string'
            ? { prompt, ...options }
            : { ...prompt, ...options };

        // Default values
        request.complexity = request.complexity || 'medium';
        request.priority = request.priority || 'normal';
        request.validateQuality = request.validateQuality ?? true;

        // Add to queue and execute
        return this.enqueue(
            () => this.executeRequest(request),
            this.getPriorityValue(request.priority!)
        );
    }

    /**
     * Batch execution for multiple prompts
     */
    async batch(requests: AIMandorRequest[]): Promise<AIMandorResponse[]> {
        console.log(`📋 AI Mandor: Processing ${requests.length} tasks in batch...`);

        const promises = requests.map(req =>
            this.enqueue(
                () => this.executeRequest(req),
                this.getPriorityValue(req.priority || 'medium')
            )
        );

        return Promise.all(promises);
    }

    /**
     * Internal: Queue management
     */
    private async enqueue<T>(
        task: () => Promise<T>,
        priority: number
    ): Promise<T> {
        return new Promise((resolve, reject) => {
            this.queue.push({
                fn: async () => {
                    try {
                        const result = await task();
                        resolve(result);
                    } catch (error) {
                        reject(error);
                    }
                },
                priority
            });

            // Sort by priority (higher first)
            this.queue.sort((a, b) => b.priority - a.priority);

            this.stats.queueLength = this.queue.length;

            // Start processing if not already
            if (!this.isProcessing) {
                this.processQueue();
            }
        });
    }

    /**
     * Internal: Process queue with rate limiting
     */
    private async processQueue() {
        if (this.queue.length === 0) {
            this.isProcessing = false;
            return;
        }

        this.isProcessing = true;

        while (this.queue.length > 0) {
            const task = this.queue.shift();
            if (!task) continue;

            this.stats.queueLength = this.queue.length;

            // Wait for rate limiter slot
            await this.rateLimiter.waitForSlot();

            try {
                await task.fn();
            } catch (error) {
                console.error('Task execution error:', error);
            } finally {
                this.rateLimiter.releaseSlot();
            }
        }

        this.isProcessing = false;
    }

    /**
     * Internal: Execute single request
     */
    private async executeRequest(
        request: AIMandorRequest
    ): Promise<AIMandorResponse> {
        const startTime = Date.now();
        const queueTime = Date.now() - startTime;

        this.stats.totalRequests++;

        try {
            // Select tier with strict plan enforcement
            const tier = this.tierRouter.selectTier(
                request.complexity!,
                request.preferredTier,
                request.userPlan
            );

            // Clone config to allow overrides without mutating global state
            // 1. Get Initial Tier Config
            let tierConfig = { ...this.tierRouter.getTierConfig(tier)! };

            if (!tierConfig) {
                // Should not happen if TierRouter is correct
                throw new Error(`No configuration for tier: ${tier}`);
            }

            // 2. Smart Routing (Pro/Enterprise Users Only)
            // Dynamically switch model based on task type AND user tier
            if (request.userPlan === 'pro' || request.userPlan === 'enterprise') {
                const { classifyTask } = await import('./task-classifier');
                const taskType = classifyTask(request.prompt);
                const smartModel = this.tierRouter.selectModelForPaidUser(taskType, request.userPlan);

                tierConfig.model = smartModel;
                console.log(`🧠 Smart Routing: Detected '${taskType}' task -> Using ${smartModel} (${request.userPlan} tier)`);
            }

            // Override model if preferred (highest priority)
            // BUG FIX: Check BOTH request.model AND request.preferredModel
            const overrideModel = request.preferredModel || request.model;
            if (overrideModel) {
                tierConfig.model = overrideModel;
            }

            console.log(`🎯 AI Mandor: "${request.prompt.substring(0, 50)}..." via ${tier} tier (${tierConfig.model})`);

            // 3. Execution with Fallback Strategy: Pollination (Primary) -> Groq (Fallback)
            let attempts = 0;
            const result = await this.retryHandler.executeWithRetry(
                async () => {
                    attempts++;

                    // PRIMARY: Always try Pollination first
                    if (attempts === 1 || attempts % 2 === 1) {
                        try {
                            // DISTRIBUTED RATE LIMITING: Wait for Pollination slot
                            await distributedRateLimiter.waitForSlot('pollinations' as ProviderName, 15000);

                            // Import tier-aware model selection
                            const { chatCompletion } = await import('./pollination-client');
                            const { enforceTierModel, getUserTier } = await import('@/lib/auth/user-tier');

                            // Enforce tier model (prevent free users from using expensive models)
                            const userTier = await getUserTier(request.userId); // Use actual userId from request
                            const safeModel = request.model || request.preferredModel || enforceTierModel(tierConfig.model, userTier, 'text');

                            // Enhance prompt for code generation (skip if systemPrompt already provided)
                            const enhancedPrompt = request.systemPrompt
                                ? request.prompt  // PromptOptimizer already enhanced
                                : this.enhancePromptForCodeGen(request.prompt);

                            // Build messages array - include systemPrompt if provided
                            const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
                            if (request.systemPrompt) {
                                messages.push({ role: 'system', content: request.systemPrompt });
                            }
                            messages.push({ role: 'user', content: enhancedPrompt });

                            // LOGGING FIX: Use safeModel to show actual model used
                            console.log(`🎯 Attempt ${attempts}: Using PRIMARY (Pollinations ${safeModel})...`);

                            try {
                                const response = await chatCompletion(
                                    messages,
                                    {
                                        model: safeModel,
                                        enableThinking: request.enableThinking || false
                                    }
                                );
                                return response;
                            } finally {
                                // Release rate limiter slot
                                distributedRateLimiter.releaseSlot('pollinations' as ProviderName);
                            }
                        } catch (e) {
                            console.warn('⚠️ Pollinations failed:', e instanceof Error ? e.message : String(e));
                            throw e; // Let retry handler catch and try fallback
                        }
                    }

                    // FALLBACK: Use Groq on even attempts (2, 4, 6...)
                    console.log(`🛟 Attempt ${attempts}: Switching to FALLBACK (Groq llama-3.3-70b)...`);

                    if (this.tierRouter.groqFallback.enabled) {
                        try {
                            // DISTRIBUTED RATE LIMITING: Wait for Groq slot (CRITICAL: 30 RPM limit)
                            await distributedRateLimiter.waitForSlot('groq' as ProviderName, 20000);

                            try {
                                const groqResponse = await groqProvider.call({ prompt: request.prompt });
                                return groqResponse.content;
                            } finally {
                                // Release rate limiter slot
                                distributedRateLimiter.releaseSlot('groq' as ProviderName);
                            }
                        } catch (e) {
                            console.warn('⚠️ Groq fallback failed:', e instanceof Error ? e.message : String(e));
                            throw e; // Let retry handler try Primary again
                        }
                    } else {
                        console.warn('⚠️ Groq fallback disabled (no GROQ_API_KEY), retrying Primary...');
                        throw new Error('Groq fallback disabled');
                    }
                },
                request.validateQuality
                    ? (response) => this.validateResponse(response)
                    : undefined
            );

            // Track usage (in-memory)
            this.tierRouter.trackUsage(tier);

            // Update stats
            this.stats.successfulRequests++;
            const duration = Date.now() - startTime;
            this.stats.averageLatency =
                (this.stats.averageLatency * (this.stats.successfulRequests - 1) + duration) /
                this.stats.successfulRequests;
            this.stats.costToday += tierConfig.costPerRequest * attempts;

            // ====== CRITICAL: Track to DATABASE for comprehensive logging ======
            // This ensures ALL aiMandor.call() are tracked, not just individual callsites
            try {
                const { usageTracker } = await import('@/lib/tracking/usage-tracker');
                await usageTracker.logUsage({
                    userId: request.userId || undefined,
                    sessionId: request.sessionId || undefined,
                    agentType: request.agentType || 'mandor-generic',
                    agentVersion: '2.0',
                    taskInput: request.prompt.substring(0, 500), // Truncate for storage
                    taskComplexity: request.priority === 'high' ? 'heavy' : request.priority === 'low' ? 'light' : 'medium',
                    taskCategory: request.agentType || 'text',
                    baseTemplateUsed: 'mandor-call',
                    enhancementsApplied: [],
                    qualityChecksRun: request.validateQuality ? ['quality-validation'] : [],
                    aiProvider: tierConfig.model.includes('llama') || tierConfig.model.includes('mixtral') ? 'groq' : 'gemini',
                    modelUsed: tierConfig.model,
                    priority: request.priority || 'normal',
                    success: true,
                    outputText: result.substring(0, 1000), // Truncate output
                    qualityScore: 1.0,
                    validationPassed: true,
                    latencyMs: duration,
                    tokensInput: request.prompt.length * 0.25, // Estimate
                    tokensOutput: result.length * 0.25, // Estimate
                    costUsd: tierConfig.costPerRequest * attempts,
                    retries: attempts - 1
                });
            } catch (trackError) {
                // Don't fail the request if tracking fails
                console.warn('⚠️ [AIMandor] Usage tracking failed:', trackError);
            }

            return {
                result,
                tier,
                model: tierConfig.model,
                attempts,
                cost: tierConfig.costPerRequest * attempts,
                duration,
                queueTime
            };

        } catch (error) {
            this.stats.failedRequests++;
            throw error;
        }
    }

    /**
    /**
     * Internal: Validate response quality
     */
    private validateResponse(response: string): boolean {
        // Basic quality checks
        if (!response || response.length < 20) {
            console.warn('⚠️ Response too short');
            return false;
        }

        // Only reject actual API error patterns, not code discussions about "error handling"
        const lowerResponse = response.toLowerCase();
        const actualErrorPatterns = [
            'sorry, i cannot',
            'i apologize, but i cannot',
            'as an ai, i cannot',
            '{"error":',
            '"error":{"message"'
        ];

        if (actualErrorPatterns.some(pattern => lowerResponse.includes(pattern))) {
            console.warn('⚠️ Response contains actual error indicators');
            return false;
        }

        return true;
    }

    /**
     * Internal: Get priority value
     */
    private getPriorityValue(priority: string): number {
        switch (priority) {
            case 'high': return 10;
            case 'medium': return 5;
            case 'low': return 1;
            default: return 5;
        }
    }

    /**
     * Get current status
     */
    getStatus() {
        return {
            queue: {
                length: this.queue.length,
                isProcessing: this.isProcessing
            },
            rateLimiter: this.rateLimiter.getStatus(),
            retryHandler: this.retryHandler.getStats(),
            tierUsage: this.tierRouter.getUsageStats(),
            stats: { ...this.stats }
        };
    }

    /**
     * Reset daily statistics
     */
    resetDailyStats() {
        this.stats.costToday = 0;
        this.tierRouter.resetQuota();
        this.retryHandler.resetStats();
    }
}

// ============================================================================
// Export singleton instance
// ============================================================================

export const aiMandor = new AIMandor();

export default AIMandor;
