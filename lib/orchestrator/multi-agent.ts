/**
 * Multi-Agent Orchestrator
 * 
 * DeepCode-style task decomposition and parallel execution.
 * 
 * Flow:
 * 1. User request → Orchestrator decomposes into sub-tasks
 * 2. Sub-tasks assigned to specialized agents (parallel)
 * 3. Results merged into cohesive output
 * 
 * Copyright © 2026 KilatOS
 */

import { aiMandor } from '@/lib/ai/mandor';
import { codeVerifier, verifyAndFix } from '@/lib/executor/code-verifier';
import { finalVerify } from '@/lib/executor/final-verifier';
import { agenticRAGForCode, type RAGResult } from '@/lib/agents/codegen/rag-integration';

// Integrated Services
import { quotaManager } from '@/lib/quota/quota-manager';
import { saveGeneratedCode } from '@/lib/history/code-history';
import { savePattern } from '@/lib/learning/pattern-store';
import { trackSessionStart, trackAction } from '@/lib/analytics/session-analytics';
import { v4 as uuidv4 } from 'uuid';

// Shared Cache (Phase 1: Unified caching for Fast + Planning modes)
import { responseCache } from '@/lib/agents/codegen/response-cache';
import { semanticCache } from '@/lib/cache/semantic-cache';
import { prefetchRelatedPatterns } from '@/lib/cache/prefetch';
import { promptCache } from '@/lib/cache/prompt-cache';
import { findCachedResponse } from '@/lib/cache/persistent-cache';

// Supabase for persistent cache
import { createClient } from '@/lib/auth/server';

// Database-driven model service (replaces hardcoded AGENT_MODELS)
import { modelService, getDefaultModel } from '@/lib/models/model-service';

// Non-blocking DB writes for latency optimization
import { fireAndForget } from '@/lib/utils/non-blocking-db';

// Token budget enforcement (prevents context overflow)
import { enforceTokenBudget, enforceRAGBudget, estimateTokens } from '@/lib/utils/token-budget';

// KilatOS Universe - Cross-Agent Communication (NEW!)
import { callAgents, type AgentCall, type AgentResult as RouterAgentResult } from '@/lib/agents/router';
import { suggestAgentsAsync, shouldAutoExecute, type AgentSuggestion } from '@/lib/agents/recommender';

// Self-Learning System (Skynet!)
import { buildEnhancedPrompt, learnFromResponse } from '@/lib/learning/self-improve';

// Request Tracing (for monitoring + AI learning)
import { traceLogger, STEP_TYPES } from '@/lib/tracking/trace-logger';
import { agenticRAG, formatRAGContext, syncGeneratedCodeToKB, syncTestResultsToLearning } from '@/lib/rag/agent-rag';

// Language Rules for multi-language support
import { LANGUAGE_RULES } from '@/lib/prompts/templates';

// OpenCode-Style System Prompts (FORBIDDEN patterns, WebContainer constraints)
import {
    DECOMPOSE_SYSTEM_PROMPT,
    VERIFY_CHAIN_PROMPT,
    MERGE_SPECIALIST_PROMPT,
    FORBIDDEN_PATTERNS,
    REQUIRED_STRUCTURE,
    OUTPUT_FORMAT_RULES,
    CONVERSATION_FORMAT,
    buildKilatCodeSystemPrompt
} from '@/lib/prompts/kilatcode-system';

// ============================================================================
// Types
// ============================================================================

export interface SubTask {
    id: string;
    agent: 'design' | 'frontend' | 'backend' | 'database' | 'research';
    description: string;
    dependencies: string[];  // IDs of tasks that must complete first
    priority: 'high' | 'medium' | 'low';
}

export interface TaskPlan {
    projectName: string;
    summary: string;
    subTasks: SubTask[];
    parallelGroups: string[][];  // Tasks that can run in parallel
}

export interface AgentResult {
    taskId: string;
    agent: string;
    success: boolean;
    output: string;
    files?: Record<string, string>;
    duration: number;
}

export interface OrchestratorResult {
    success: boolean;
    projectName: string;
    summary: string;
    files: Record<string, string>;
    agentResults: AgentResult[];
    totalDuration: number;
}

// ============================================================================
// Model Assignment - NOW DYNAMIC (DB-Driven)
// The selectedModel parameter is passed from frontend/API
// Fallback uses modelService.getDefaultModel() if not specified
// ============================================================================

// DEPRECATED: Hardcoded AGENT_MODELS removed. Use selectedModel parameter instead.
// Legacy reference kept for documentation purposes only:
// const LEGACY_AGENT_MODELS = { orchestrator: 'gemini-fast', frontend: 'qwen-coder', ... };

// ============================================================================
// Orchestrator Class
// ============================================================================

export class MultiAgentOrchestrator {
    private enableLogging: boolean = true;
    private currentUserId: string = 'anon'; // Tracks current user for AI calls

    constructor(options?: { enableLogging?: boolean }) {
        this.enableLogging = options?.enableLogging ?? true;
    }

    /**
     * Main entry point - orchestrate a complex task
     * @param selectedModel - User-selected model from frontend (DB-driven)
     */
    async orchestrate(
        userRequest: string,
        userId: string = 'anon',
        sessionId: string = uuidv4(),
        onProgress?: (progress: number, message: string) => Promise<void>,
        selectedModel?: string  // NEW: Dynamic model from DB
    ): Promise<OrchestratorResult> {
        const startTime = Date.now();

        // Store userId for internal method access
        this.currentUserId = userId;

        if (this.enableLogging) {
            console.log('\n🎭 Multi-Agent Orchestrator: Starting...');
            console.log(`   Request: "${userRequest.substring(0, 50)}..."`);
            console.log(`   User: ${userId}, Session: ${sessionId}`);
        }

        try {
            // Start trace for this request
            const traceId = await traceLogger.startTrace(
                sessionId,
                sessionId,
                userId,
                'multi-agent',
                'planning',
                userRequest
            );

            // Store traceId for use in catch block
            (this as any)._currentTraceId = traceId;

            // =====================================================
            // CACHE CHECK (Phase 1: Shared cache for instant response)
            // =====================================================

            // 0. Try Persistent cache (Supabase job_queue) - survives Vercel cold starts!
            try {
                const supabase = await createClient();
                const persistentResult = await findCachedResponse(userRequest, supabase, 72, 0.7);
                if (persistentResult && persistentResult.files) {
                    console.log('💾 [Planning] PERSISTENT Cache hit! Returning from job_queue.');
                    traceLogger.addStep(traceId, STEP_TYPES.CACHE_PERSISTENT, 'hit', { source: 'job_queue' });
                    await traceLogger.endTrace(traceId, 'success', { file_count: Object.keys(persistentResult.files).length });
                    if (onProgress) await onProgress(100, 'Using cached result...');
                    return {
                        success: true,
                        projectName: 'cached-project',
                        summary: persistentResult.outputContent || 'Cached response from previous request',
                        files: persistentResult.files,
                        agentResults: [],
                        totalDuration: Date.now() - startTime
                    };
                }
            } catch (persistentError) {
                console.warn('[Planning] Persistent cache check failed:', persistentError);
                // Continue to in-memory cache
            }

            // 1. Try Jaccard-based cache (faster, exact-ish match)
            const cachedResult = responseCache.findSimilar(userRequest);
            if (cachedResult) {
                console.log('🚀 [Planning] Cache hit! (Jaccard) Returning cached response.');
                traceLogger.addStep(traceId, STEP_TYPES.CACHE_JACCARD, 'hit', { similarity: 'high' });
                await traceLogger.endTrace(traceId, 'success', { file_count: Object.keys(cachedResult.response.files || {}).length });
                if (onProgress) await onProgress(100, 'Found similar cached result!');
                return {
                    success: true,
                    projectName: cachedResult.response.projectName || 'cached-project',
                    summary: cachedResult.response.summary || 'Cached response',
                    files: cachedResult.response.files || {},
                    agentResults: [],
                    totalDuration: Date.now() - startTime
                };
            }
            traceLogger.addStep(traceId, STEP_TYPES.CACHE_JACCARD, 'miss');

            // 2. Try Semantic cache (slower, meaning-based match) - FIX: This was NEVER CALLED before!
            const semanticResult = await semanticCache.findSimilar(userRequest, 0.8);
            if (semanticResult) {
                console.log('🧠 [Planning] Cache hit! (Semantic) Returning cached response.');
                traceLogger.addStep(traceId, STEP_TYPES.CACHE_SEMANTIC, 'hit', { type: 'semantic' });
                await traceLogger.endTrace(traceId, 'success', { file_count: Object.keys(semanticResult.response.files || {}).length });
                return {
                    success: true,
                    projectName: semanticResult.response.projectName || 'cached-project',
                    summary: semanticResult.response.summary || 'Cached response (semantic match)',
                    files: semanticResult.response.files || {},
                    agentResults: [],
                    totalDuration: Date.now() - startTime
                };
            }
            traceLogger.addStep(traceId, STEP_TYPES.CACHE_SEMANTIC, 'miss');

            // Track session start
            await trackSessionStart(userId, sessionId, { deviceType: 'api' });
            // Step 0: Retrieve RAG context for enhanced code generation
            let ragContext: RAGResult | null = null;
            const ragStartTime = Date.now();
            try {
                if (this.enableLogging) {
                    console.log('   📚 RAG: Retrieving context...');
                }
                if (onProgress) await onProgress(5, 'Consulting knowledge base (RAG)...');
                ragContext = await agenticRAGForCode({
                    mode: 'hybrid', // Best of cached + fresh
                    searchQuery: userRequest,
                    language: 'typescript',
                    framework: 'react'
                });
                if (this.enableLogging) {
                    console.log(`   ✅ RAG: Found ${ragContext.examples.length} examples, ${ragContext.bestPractices.length} best practices`);
                }
                traceLogger.addStep(traceId, STEP_TYPES.RAG_RETRIEVAL, 'success', {
                    examples: ragContext.examples.length,
                    practices: ragContext.bestPractices.length
                }, Date.now() - ragStartTime);
            } catch (ragError) {
                console.warn('   ⚠️ RAG context retrieval failed, continuing without:', ragError);
                traceLogger.addStep(traceId, STEP_TYPES.RAG_RETRIEVAL, 'error', {
                    error: ragError instanceof Error ? ragError.message : 'unknown'
                }, Date.now() - ragStartTime);
            }

            // =====================================================
            // STEP 0.5: KilatOS Universe Auto-Collaboration (NEW!)
            // Calls KilatCrawl, KilatResearch, KilatIdea, KilatDesign in parallel
            // BEFORE code generation - user doesn't see this process
            // =====================================================
            let universeContext = '';
            try {
                if (onProgress) await onProgress(6, '🌐 Activating KilatOS Universe...');
                const { enhancedContext } = await this.executeWithAutoAgents(
                    userRequest,
                    sessionId,
                    userId,
                    selectedModel, // Pass user's selected model
                    onProgress
                );
                universeContext = enhancedContext;
            } catch (universeError) {
                console.warn('   ⚠️ KilatOS Universe auto-agents failed, continuing:', universeError);
            }

            // Merge Universe context with RAG context for enhanced code generation
            const combinedContext = [
                ragContext ? `## RAG CONTEXT\n${ragContext.examples.join('\n')}` : '',
                universeContext
            ].filter(Boolean).join('\n\n');

            // Step 1: Decompose task (uses user's selected model)
            if (onProgress) await onProgress(15, 'Decomposing task into agent sub-tasks...');
            const plan = await this.decompose(
                combinedContext ? `${userRequest}\n\n[ENHANCED CONTEXT]:\n${combinedContext}` : userRequest,
                selectedModel
            );

            // Step 2: Execute parallel groups (Workers) with RAG context
            if (onProgress) await onProgress(30, 'Executing specialized agents (Parallel Mode)...');
            const workerResults = await this.executeParallel(plan, ragContext, userId, sessionId, onProgress, selectedModel);

            // Step 3: Verify and Refine (The MVP Layer) - uses user's selected model
            if (onProgress) await onProgress(70, 'Verifying code quality and integration...');
            const verifiedResults = await this.verifyChain(plan, workerResults, selectedModel);

            // Step 4: Merge results - uses user's selected model
            if (onProgress) await onProgress(90, 'Merging results and generating final package...');
            const merged = await this.merge(plan, verifiedResults, selectedModel);

            // =====================================================
            // JUNK FILE FILTER (Remove merger artifacts)
            // =====================================================
            // Merger's "last-write-wins" fallback can create junk files
            const cleanedFiles: Record<string, string> = {};
            for (const [path, content] of Object.entries(merged.files)) {
                const filename = path.split('/').pop() || path;
                // Skip obvious junk files
                if (/^file\d+\.json$/i.test(filename)) continue;
                if (/^data\d+\.json$/i.test(filename)) continue;
                // Skip placeholder-only content
                const trimmed = content.trim();
                if (trimmed === '...' || trimmed === '// TODO' || trimmed === '/* TODO */') continue;
                // Skip empty files
                if (trimmed.length === 0) continue;
                cleanedFiles[path] = content;
            }
            merged.files = cleanedFiles;
            console.log(`   🧹 [Merger] Cleaned files: ${Object.keys(cleanedFiles).length} valid files`);

            // =====================================================
            // CACHE SET (Phase 1: Store for future instant responses)
            // =====================================================

            // =====================================================
            // FINAL VERIFIER (Phase: Last quality gate)
            // Validates structure, consolidates deps, LLM greeting
            // =====================================================
            const verificationResult = await finalVerify(
                merged.files,
                userRequest,
                plan.projectName,
                userId,
                selectedModel
            );

            console.log(`   ✅ [FinalVerifier] Verified: ${Object.keys(verificationResult.files).length} files`);
            if (verificationResult.fixes.length > 0) {
                console.log(`   🔧 [FinalVerifier] Applied fixes: ${verificationResult.fixes.join(', ')}`);
            }

            const finalResult = {
                success: true,
                projectName: plan.projectName,
                summary: verificationResult.greeting,
                files: verificationResult.files,
                agentResults: verifiedResults,
                totalDuration: Date.now() - startTime
            };

            responseCache.set(userRequest, finalResult, 'complex');
            console.log('   💾 [Planning] Response cached for future queries.');
            traceLogger.addStep(traceId, STEP_TYPES.CACHE_SAVE, 'response', { type: 'response_cache' });

            // AI LEARNING: Sync generated code to KB for future RAG examples
            fireAndForget(() => syncGeneratedCodeToKB(userRequest, verificationResult.files, 'codegen'));

            // AI LEARNING: Sync test results if available
            if (verificationResult.testResults) {
                fireAndForget(() => syncTestResultsToLearning(
                    userRequest,
                    verificationResult.testResults!,
                    verificationResult.files
                ));
            }

            // End trace with success
            await traceLogger.endTrace(traceId, 'success', {
                file_count: Object.keys(verificationResult.files).length
            });

            return finalResult;

        } catch (error) {
            // End trace with error
            const traceId = (this as any)._currentTraceId;
            if (traceId) {
                await traceLogger.endTrace(traceId, 'error', {
                    error_message: error instanceof Error ? error.message : 'Unknown error'
                });
            }

            return {
                success: false,
                projectName: 'error',
                summary: error instanceof Error ? error.message : 'Unknown error',
                files: {},
                agentResults: [],
                totalDuration: Date.now() - startTime
            };
        }
    }

    /**
     * KilatOS Universe Auto-Collaboration
     * 
     * Automatically calls relevant agents BEFORE code generation:
     * - KilatCrawl: Research similar websites
     * - KilatResearch: Find best practices
     * - KilatIdea: Brainstorm features
     * - KilatDesign: Generate UI mockup concept
     * 
     * All agents work in PARALLEL, same session ID!
     * User doesn't see this process - it's behind the scenes.
     */
    async executeWithAutoAgents(
        userRequest: string,
        sessionId: string,
        userId: string,
        selectedModel?: string, // User's selected model
        onProgress?: (progress: number, message: string) => Promise<void>
    ): Promise<{
        enhancedContext: string;
        agentResults: RouterAgentResult[];
    }> {
        if (this.enableLogging) {
            console.log('   🌐 [KilatOS Universe] Auto-collaboration starting...');
        }

        try {
            // 1. Get auto-suggestions based on user request
            const suggestions = await suggestAgentsAsync({
                currentAgent: 'codegen',
                userMessage: userRequest,
                projectContext: {}
            });

            // 2. Filter for auto-executable agents (high confidence)
            const autoAgents = shouldAutoExecute(suggestions, 'auto', 0.80);

            if (autoAgents.length === 0) {
                if (this.enableLogging) {
                    console.log('   ⏩ [KilatOS Universe] No auto-agents triggered');
                }
                return { enhancedContext: '', agentResults: [] };
            }

            if (onProgress) {
                await onProgress(8, `🌐 Calling ${autoAgents.length} KilatOS agents...`);
            }

            // 3. Build AgentCall array for parallel execution
            const calls: AgentCall[] = autoAgents.map(s => ({
                from: 'codegen',
                to: s.agent,
                reason: s.reason,
                context: {
                    query: userRequest,
                    topic: userRequest,
                    prompt: userRequest, // For imagegen
                    url: this.extractUrl(userRequest), // For crawl
                    model: selectedModel, // Pass user's selected model
                },
                priority: 'high' as const,
                sessionId,
                userId
            }));

            if (this.enableLogging) {
                console.log(`   🚀 [KilatOS Universe] Calling: ${calls.map(c => c.to).join(', ')}`);
            }

            // 4. Execute ALL agents in parallel!
            const results = await callAgents(calls);

            // 5. Merge results into enhanced context
            const successfulResults = results.filter(r => r.success);
            const enhancedContext = successfulResults.map(r => {
                const agentName = r.agent.toUpperCase();
                let content = '';

                if (r.agent === 'crawl' && r.data?.content) {
                    content = r.data.content.substring(0, 2000);
                } else if (r.agent === 'research' && r.data?.report) {
                    content = r.data.report.substring(0, 2000);
                } else if (r.agent === 'ideagen' && r.data?.ideas) {
                    content = r.data.ideas.map((i: any) => `- ${i.title}`).join('\n');
                } else if (r.agent === 'imagegen' && r.data?.description) {
                    content = `UI Concept: ${r.data.description}`;
                } else if (typeof r.data === 'string') {
                    content = r.data.substring(0, 1000);
                }

                return `## 🔗 ${agentName} CONTEXT\n${content}`;
            }).join('\n\n');

            if (this.enableLogging) {
                console.log(`   ✅ [KilatOS Universe] ${successfulResults.length}/${results.length} agents succeeded`);
            }

            if (onProgress) {
                await onProgress(12, `✅ ${successfulResults.length} agents provided context`);
            }

            return { enhancedContext, agentResults: results };

        } catch (error) {
            console.warn('   ⚠️ [KilatOS Universe] Auto-collaboration failed:', error);
            return { enhancedContext: '', agentResults: [] };
        }
    }

    /**
     * Helper: Extract URL from user request for KilatCrawl
     */
    private extractUrl(request: string): string | undefined {
        const urlMatch = request.match(/(https?:\/\/[^\s]+)/i);
        if (urlMatch) return urlMatch[1];

        // Infer URL from known keywords
        const inferMap: Record<string, string> = {
            'netflix': 'https://netflix.com',
            'spotify': 'https://spotify.com',
            'twitter': 'https://twitter.com',
            'instagram': 'https://instagram.com',
            'tiktok': 'https://tiktok.com',
            'uber': 'https://uber.com',
            'airbnb': 'https://airbnb.com',
        };

        for (const [keyword, url] of Object.entries(inferMap)) {
            if (request.toLowerCase().includes(keyword)) {
                return url;
            }
        }

        return undefined;
    }

    /**
     * Fast Mode - Single-layer execution without decompose/verify/merge
     * 
     * CRITICAL: Uses same quality prompts but skips multi-agent layers.
     * For simple tasks that don't need complex orchestration.
     * 
     * Anti-Hallucination Strategy:
     * - Still uses production-grade prompts
     * - Still validates imports and syntax
     * - Just skips the multi-layer overhead
     * 
     * @param userRequest - The user's request
     * @param context - Optional conversation history for context-aware responses
     * @param selectedModel - User-selected model from frontend (DB-driven)
     */
    async executeFast(
        userRequest: string,
        context?: string,
        userId: string = 'anon',
        sessionId: string = uuidv4(),
        selectedModel?: string  // NEW: Dynamic model from DB
    ): Promise<OrchestratorResult> {
        const startTime = Date.now();

        if (this.enableLogging) {
            console.log('\n⚡ Fast Mode: Starting single-layer execution...');
            console.log(`   Request: "${userRequest.substring(0, 50)}..."`);
            console.log(`   User: ${userId}, Session: ${sessionId}`);
            if (context) {
                console.log(`   📝 Context loaded: ${context.split('\n').length} previous messages`);
            }
        }

        try {
            // Start trace for fast mode
            const traceId = await traceLogger.startTrace(
                sessionId,
                sessionId,
                userId,
                'fast-mode',
                'fast',
                userRequest
            );

            // Store traceId for use in catch block
            (this as any)._currentTraceId = traceId;

            // =====================================================
            // CACHE CHECK (Phase 1: Shared cache for instant response)
            // =====================================================

            // Phase 0: PERSISTENT cache (Supabase job_queue) - survives Vercel cold starts!
            try {
                const supabase = await createClient();
                const persistentResult = await findCachedResponse(userRequest, supabase, 72, 0.7);
                if (persistentResult && persistentResult.files) {
                    console.log('💾 [Fast] PERSISTENT Cache hit! Returning from job_queue.');
                    traceLogger.addStep(traceId, STEP_TYPES.CACHE_PERSISTENT, 'hit', { source: 'job_queue' });
                    await traceLogger.endTrace(traceId, 'success', { file_count: Object.keys(persistentResult.files).length });
                    return {
                        success: true,
                        projectName: 'cached-project',
                        summary: persistentResult.outputContent || 'Cached response from previous request',
                        files: persistentResult.files,
                        agentResults: [],
                        totalDuration: Date.now() - startTime
                    };
                }
                traceLogger.addStep(traceId, STEP_TYPES.CACHE_PERSISTENT, 'miss');
            } catch (persistentError) {
                console.warn('[Fast] Persistent cache check failed:', persistentError);
            }

            // Phase 1a: Jaccard similarity (fast, exact match)
            const cachedResult = responseCache.findSimilar(userRequest);
            if (cachedResult) {
                console.log('🚀 [Fast] Cache hit! (Jaccard) Returning cached response.');
                traceLogger.addStep(traceId, STEP_TYPES.CACHE_JACCARD, 'hit', { type: 'jaccard' });
                await traceLogger.endTrace(traceId, 'success', { file_count: Object.keys(cachedResult.response.files || {}).length });
                // Prefetch related patterns in background (NON-BLOCKING) - defaults to 'free' tier
                fireAndForget(() => prefetchRelatedPatterns(sessionId, userRequest, 'free'));
                return {
                    success: true,
                    projectName: cachedResult.response.projectName || 'cached-project',
                    summary: cachedResult.response.summary || 'Cached response',
                    files: cachedResult.response.files || {},
                    agentResults: [],
                    totalDuration: Date.now() - startTime
                };
            }
            traceLogger.addStep(traceId, STEP_TYPES.CACHE_JACCARD, 'miss');

            // Phase 1b: Semantic similarity (slower, uses embeddings)
            const semanticResult = await semanticCache.findSimilar(userRequest, 0.85);
            if (semanticResult) {
                console.log('🧠 [Fast] Cache hit! (Semantic) Returning cached response.');
                traceLogger.addStep(traceId, STEP_TYPES.CACHE_SEMANTIC, 'hit', { type: 'semantic' });
                await traceLogger.endTrace(traceId, 'success', { file_count: Object.keys(semanticResult.response.files || {}).length });
                return {
                    success: true,
                    projectName: semanticResult.response.projectName || 'semantic-cached',
                    summary: semanticResult.response.summary || 'Semantically matched response',
                    files: semanticResult.response.files || {},
                    agentResults: [],
                    totalDuration: Date.now() - startTime
                };
            }
            traceLogger.addStep(traceId, STEP_TYPES.CACHE_SEMANTIC, 'miss');

            // =====================================================
            // LIGHTWEIGHT RAG (Phase 2: RAG in Fast Mode)
            // Uses cache-only mode for speed, no fresh web scraping
            // =====================================================
            let ragContext = '';
            try {
                const ragResult = await agenticRAGForCode({
                    mode: 'fast', // Cache only, no fresh scrape
                    searchQuery: userRequest,
                    language: 'typescript',
                    framework: 'react'
                });
                if (ragResult.examples.length > 0) {
                    const rawContext = `\n[Reference Examples]\n${ragResult.examples.slice(0, 2).join('\n\n')}\n`;
                    // TOKEN BUDGET: Enforce 2000 token limit for Fast Mode RAG
                    ragContext = enforceTokenBudget(rawContext, 2000);
                    const tokenCount = estimateTokens(ragContext);
                    console.log(`   📚 [Fast] RAG: Found ${ragResult.examples.length} cached examples (${tokenCount} tokens)`);
                }
            } catch (ragError) {
                console.warn('   ⚠️ [Fast] RAG skipped:', ragError);
            }

            // Check Quota (request count)
            const quota = await quotaManager.checkQuota(userId, 'fast-mode');
            if (quota.isExceeded) {
                throw new Error(`Quota exceeded for fast-mode. Limit: ${quota.limit}, Used: ${quota.used}`);
            }

            // Check Cost Budget ($ spent)
            const costBudget = await quotaManager.checkCostBudget(userId, 'fast-mode');
            if (costBudget.exceeded) {
                throw new Error(`Daily cost budget exceeded. Spent: $${costBudget.spent.toFixed(4)}, Limit: $${costBudget.limit.toFixed(2)}`);
            }

            // Track action
            await trackAction(sessionId, 'execute_fast');
            // Build contextual prompt with conversation history
            const contextSection = context
                ? `\nPREVIOUS CONVERSATION:\n${context}\n\n(Use this context to maintain style consistency and remember user preferences)\n`
                : '';

            // Single-layer execution - one agent call with comprehensive prompt
            // Use selectedModel if provided, otherwise fall back to default
            const modelToUse = selectedModel || await getDefaultModel('free', 'text');

            // =====================================================
            // PROMPT OPTIMIZER INTEGRATION (NEW!)
            // Enhances prompts with role definitions, quality criteria
            // =====================================================
            const { promptOptimizer } = await import('@/lib/ai/prompt-optimizer');

            const optimized = promptOptimizer.optimize(userRequest, {
                agentType: 'code',
                taskComplexity: 'heavy',
                additionalContext: {
                    framework: 'react',
                    styling: 'tailwind',
                    ragContext: ragContext || undefined,
                    requirements: `
${LANGUAGE_RULES}

${FORBIDDEN_PATTERNS}

${REQUIRED_STRUCTURE}

${CONVERSATION_FORMAT}

${OUTPUT_FORMAT_RULES}

AFTER COMPLETING THE TASK, always end with Next Steps section:
---
**📌 Next Steps:**
- 🎨 **Polish the UI** → Try KilatDesign for mockups and visual improvements
- 🛡️ **Security audit** → Let KilatAudit check for vulnerabilities
- 📖 **Generate docs** → Create README with KilatDocs`
                }
            });

            if (this.enableLogging) {
                console.log(`   🔧 [Fast] Prompt optimized (${optimized.metadata.estimatedTokens} tokens)`);
            }

            // Self-Learning: Enhance prompt with RLHF + User Memory + Proven Patterns
            const enhanced = await buildEnhancedPrompt(
                optimized.systemPrompt,
                'fast-mode',
                userId
            );

            if (this.enableLogging && enhanced.totalEnhancements > 0) {
                console.log(`   🧠 [Fast] Self-learning: +${enhanced.totalEnhancements} enhancements applied`);
            }

            const aiStartTime = Date.now();
            const result = await aiMandor.call({
                prompt: optimized.userPrompt + (contextSection || ''),
                systemPrompt: enhanced.systemPrompt,  // ENHANCED: RLHF + Memory + Patterns
                complexity: 'heavy',
                priority: 'high',
                model: modelToUse,  // DYNAMIC: Use DB-driven model
                userId: this.currentUserId, // Propagate userId for tier detection
                enableThinking: false // FAST MODE: Thinking Disabled
            });
            traceLogger.addStep(traceId, STEP_TYPES.AI_CALL, 'success', {
                model: modelToUse,
                mode: 'fast'
            }, Date.now() - aiStartTime);

            // Extract files from response
            let files = this.extractFiles(result.result);

            // JUNK FILE FILTER (same as Planning Mode for consistency)
            const cleanedFiles: Record<string, string> = {};
            for (const [path, content] of Object.entries(files)) {
                const filename = path.split('/').pop() || path;
                if (/^file\d+\.json$/i.test(filename)) continue;
                if (/^data\d+\.json$/i.test(filename)) continue;
                const trimmed = content.trim();
                if (trimmed === '...' || trimmed === '// TODO' || trimmed === '/* TODO */') continue;
                if (trimmed.length === 0) continue;
                cleanedFiles[path] = content;
            }
            files = cleanedFiles;

            // Generate project name from request
            const projectName = userRequest
                .split(' ')
                .slice(0, 3)
                .join('-')
                .toLowerCase()
                .replace(/[^a-z0-9-]/g, '') || 'fast-project';

            // Increment usage (NON-BLOCKING: Fire-and-forget for latency)
            fireAndForget(() => quotaManager.incrementUsage(userId, 'fast-mode'));

            // Save Generated Code (NON-BLOCKING: Fire-and-forget for latency)
            fireAndForget(() => saveGeneratedCode(sessionId, result.result, {
                userId,
                agentType: 'fast-mode',
                language: 'typescript', // Assumed for fast mode
                filename: projectName, // Use generated project name
                prompt: userRequest,
                modelUsed: 'unknown'
            }));

            if (this.enableLogging) {
                console.log(`   ✅ Fast execution completed in ${Date.now() - startTime}ms`);
                console.log(`   📦 Files generated: ${Object.keys(files).length}`);
                if (Object.keys(files).length === 0) {
                    console.warn('   ⚠️ No files extracted! Raw Output Preview:');
                    console.warn(result.result.substring(0, 500) + '...');
                }
            }

            // =====================================================
            // FINAL VERIFIER (Phase: Last quality gate)
            // Validates structure, consolidates deps, LLM greeting
            // =====================================================
            const verificationResult = await finalVerify(
                files,
                userRequest,
                projectName,
                userId,
                selectedModel
            );

            const finalResult = {
                success: true,
                projectName,
                // Lovable-style: Clean greeting from LLM (multilingual)
                summary: verificationResult.greeting,
                files: verificationResult.files,
                agentResults: [{
                    taskId: 'fast-single',
                    agent: 'fast-mode',
                    success: true,
                    output: result.result,
                    files: verificationResult.files,
                    duration: Date.now() - startTime
                }],
                totalDuration: Date.now() - startTime
            };

            responseCache.set(userRequest, finalResult, 'simple');
            // Also cache embedding for semantic similarity matching (NON-BLOCKING)
            fireAndForget(() => semanticCache.addEmbedding(userRequest));
            // AI LEARNING: Sync generated code to KB for future RAG examples
            fireAndForget(() => syncGeneratedCodeToKB(userRequest, files, 'fast-mode'));
            console.log('   💾 [Fast] Response cached + KB synced for AI learning.');
            traceLogger.addStep(traceId, STEP_TYPES.CACHE_SAVE, 'response', { type: 'fast_cache' });

            // AI LEARNING: Sync test results if available
            if (verificationResult.testResults) {
                fireAndForget(() => syncTestResultsToLearning(
                    userRequest,
                    verificationResult.testResults!,
                    verificationResult.files
                ));
            }

            // End trace with success
            await traceLogger.endTrace(traceId, 'success', {
                file_count: Object.keys(files).length
            });

            return finalResult;

        } catch (error) {
            if (this.enableLogging) {
                console.log(`   ❌ Fast execution failed: ${error}`);
            }

            // End trace with error
            const traceId = (this as any)._currentTraceId;
            if (traceId) {
                await traceLogger.endTrace(traceId, 'error', {
                    error_message: error instanceof Error ? error.message : 'Unknown error'
                });
            }

            return {
                success: false,
                projectName: 'error',
                summary: error instanceof Error ? error.message : 'Unknown error',
                files: {},
                agentResults: [],
                totalDuration: Date.now() - startTime
            };
        }
    }

    /**
     * Step 1: Decompose user request into sub-tasks
     */
    private async decompose(userRequest: string, selectedModel?: string): Promise<TaskPlan> {
        if (this.enableLogging) {
            console.log('   📋 Decomposing task...');
            if (selectedModel) console.log(`   🎯 Using model: ${selectedModel}`);
        }

        const result = await aiMandor.call({
            prompt: `${DECOMPOSE_SYSTEM_PROMPT}

User Request: "${userRequest}"`,
            complexity: 'medium',
            priority: 'high',
            model: selectedModel, // USER'S SELECTED MODEL
            userId: this.currentUserId, // Propagate userId for tier detection
            enableThinking: true // PLANNING MODE: Thinking Enabled via prompt
        });

        // Parse JSON from response using universal sanitizer
        const jsonMatch = result.result.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            throw new Error('Failed to parse task decomposition');
        }

        // Using safeParseJSON for multi-model compatibility (handles Claude, Grok, DeepSeek quirks)
        const { safeParseJSON } = await import('@/lib/utils/json-sanitizer');
        const plan = safeParseJSON<TaskPlan>(jsonMatch[0]);

        if (!plan) {
            throw new Error('Failed to parse task decomposition JSON');
        }

        if (this.enableLogging) {
            console.log(`   ✅ Decomposed into ${plan.subTasks.length} sub-tasks`);
            console.log(`   📦 Project: ${plan.projectName}`);
        }

        return plan;
    }

    /**
     * Step 2: Execute sub-tasks in parallel groups
     */
    private async executeParallel(
        plan: TaskPlan,
        ragContext?: RAGResult | null,
        userId: string = 'anon',
        sessionId: string = 'unknown',
        onProgress?: (progress: number, message: string) => Promise<void>,
        selectedModel?: string
    ): Promise<AgentResult[]> {
        const allResults: AgentResult[] = [];

        for (let i = 0; i < plan.parallelGroups.length; i++) {
            const group = plan.parallelGroups[i];

            if (this.enableLogging) {
                console.log(`   🔄 Executing parallel group ${i + 1}/${plan.parallelGroups.length}: [${group.join(', ')}]`);
            }

            if (onProgress) {
                const baseProgress = 30;
                const progressPerGroup = 40 / plan.parallelGroups.length;
                await onProgress(
                    Math.round(baseProgress + (i * progressPerGroup)), // ✅ FIX: Round to integer for DB
                    `Executing agents [${group.join(', ')}] (Group ${i + 1}/${plan.parallelGroups.length})...`
                );
            }

            // Get tasks for this group
            const tasksToRun = plan.subTasks.filter(t => group.includes(t.id));

            // Execute in parallel using Promise.all with individual timeouts
            // FIX 2026-01-22: Add 60s timeout per agent to prevent entire group from hanging
            const AGENT_TIMEOUT = 60000; // 60 seconds per agent

            const groupResults = await Promise.all(
                tasksToRun.map(async task => {
                    const timeoutPromise = new Promise<AgentResult>((_, reject) =>
                        setTimeout(() => reject(new Error(`Agent ${task.agent} timeout after 60s`)), AGENT_TIMEOUT)
                    );

                    try {
                        return await Promise.race([
                            this.executeAgent(task, allResults, ragContext, userId, sessionId, selectedModel),
                            timeoutPromise
                        ]);
                    } catch (error) {
                        console.warn(`   ⚠️ [Parallel] Agent ${task.agent} failed or timed out:`, error);
                        // Return failed result instead of crashing
                        return {
                            taskId: task.id,
                            agent: task.agent,
                            success: false,
                            output: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                            files: {},
                            duration: AGENT_TIMEOUT
                        };
                    }
                })
            );

            allResults.push(...groupResults);
        }

        return allResults;
    }

    /**
     * Execute a single agent for a sub-task
     */
    private async executeAgent(
        task: SubTask,
        previousResults: AgentResult[],
        ragContext?: RAGResult | null,
        userId: string = 'anon',
        sessionId: string = 'unknown',
        selectedModel?: string
    ): Promise<AgentResult> {
        const startTime = Date.now();
        // Use selected model from UI, or fall back to default text model
        const modelToUse = selectedModel || await getDefaultModel('free', 'text');

        if (this.enableLogging) {
            console.log(`      🤖 [${task.agent}] Starting: ${task.description.substring(0, 40)}...`);
        }

        // Check Quota (request count)
        const quota = await quotaManager.checkQuota(userId, task.agent);
        if (quota.isExceeded) {
            throw new Error(`Quota exceeded for agent ${task.agent}. Limit: ${quota.limit}, Used: ${quota.used}`);
        }

        // Check Cost Budget ($ spent)
        const costBudget = await quotaManager.checkCostBudget(userId, task.agent);
        if (costBudget.exceeded) {
            throw new Error(`Daily cost budget exceeded for ${task.agent}. Spent: $${costBudget.spent.toFixed(4)}, Limit: $${costBudget.limit.toFixed(2)}`);
        }

        // Track action
        await trackAction(sessionId, `agent_${task.agent}`);

        // Build context from previous results
        let context = previousResults
            .map(r => `[${r.agent}]: ${r.output.substring(0, 200)}`)
            .join('\n');

        // Inject RAG context for coding agents (with TOKEN BUDGET)
        if (ragContext && ['frontend', 'backend', 'database'].includes(task.agent)) {
            // Apply token budget to RAG context (3000 tokens for agent tasks)
            const budgetedRAG = enforceRAGBudget(
                {
                    examples: ragContext.examples || [],
                    bestPractices: ragContext.bestPractices || [],
                    documentation: ragContext.documentation || ''
                },
                3000 // Token budget for agent RAG context
            );

            const ragSnippet = [
                budgetedRAG.examples.length > 0 ? `## Code Examples:\n${budgetedRAG.examples.join('\n\n')}` : '',
                budgetedRAG.bestPractices.length > 0 ? `## Best Practices:\n${budgetedRAG.bestPractices.join('\n')}` : '',
                budgetedRAG.documentation ? `## Docs:\n${budgetedRAG.documentation}` : ''
            ].filter(Boolean).join('\n\n');

            if (ragSnippet) {
                context = `[RAG CONTEXT]:\n${ragSnippet}\n\n${context}`;
                if (this.enableLogging) {
                    const status = budgetedRAG.truncated ? `truncated ${budgetedRAG.originalTokens}→${budgetedRAG.finalTokens}` : 'full';
                    console.log(`      📚 [${task.agent}] RAG context injected (${status})`);
                }
            }
        }

        const prompt = this.buildAgentPrompt(task, context);

        try {
            // Self-Learning: Get per-agent RAG context
            let agentRAGContext = '';
            try {
                const agentRag = await agenticRAG({
                    agent: task.agent,
                    query: task.description,
                    mode: 'fast',
                    userId
                });
                agentRAGContext = formatRAGContext(agentRag);
                if (agentRAGContext && this.enableLogging) {
                    console.log(`      🧠 [${task.agent}] Per-agent RAG: ${agentRag.examples.length} examples`);
                }
            } catch (ragError) {
                // Silent fail - per-agent RAG is optional
            }

            // Self-Learning: Enhance prompt with RLHF + Memory + Patterns
            const enhanced = await buildEnhancedPrompt(
                agentRAGContext + prompt,
                task.agent,
                userId
            );

            if (this.enableLogging && enhanced.totalEnhancements > 0) {
                console.log(`      🧠 [${task.agent}] Self-learning: +${enhanced.totalEnhancements} enhancements`);
            }

            const result = await aiMandor.call({
                prompt: enhanced.systemPrompt,  // ENHANCED: Per-agent RAG + RLHF + Memory + Patterns
                complexity: task.priority === 'high' ? 'heavy' : 'medium',
                priority: task.priority === 'medium' ? 'normal' : task.priority as 'high' | 'low',
                model: modelToUse,
                userId: this.currentUserId, // Propagate userId for tier detection
                enableThinking: true // AGENT EXECUTION: Thinking Enabled via prompt (Deep Reasoning)
            });

            if (this.enableLogging) {
                console.log(`      ✅ [${task.agent}] Completed in ${Date.now() - startTime}ms`);
            }

            // Increment Usage (NON-BLOCKING: Fire-and-forget)
            fireAndForget(() => quotaManager.incrementUsage(userId, task.agent));

            // Save Generated Code (NON-BLOCKING: Fire-and-forget)
            if (['frontend', 'backend', 'design'].includes(task.agent)) {
                fireAndForget(() => saveGeneratedCode(sessionId, result.result, {
                    userId,
                    agentType: task.agent,
                    filename: `${task.agent}-${task.id}`, // Use agent-taskId as filename
                    prompt: task.description,
                    modelUsed: modelToUse
                }));
            }

            // Save Proven Pattern (NON-BLOCKING: Fire-and-forget)
            fireAndForget(() => savePattern(
                task.agent,
                task.description.split(' ')[0], // Task type guess
                task.id,
                { prompt: this.buildAgentPrompt(task, context) },
                1.0, // Success rate
                0 // Cost (placeholder)
            ));

            return {
                taskId: task.id,
                agent: task.agent,
                success: true,
                output: result.result,
                files: this.extractFiles(result.result),
                duration: Date.now() - startTime
            };

        } catch (error) {
            if (this.enableLogging) {
                console.log(`      ❌ [${task.agent}] Failed: ${error}`);
            }

            return {
                taskId: task.id,
                agent: task.agent,
                success: false,
                output: error instanceof Error ? error.message : 'Unknown error',
                duration: Date.now() - startTime
            };
        }
    }

    /**
     * Build specialized prompt for each agent type
     */
    private buildAgentPrompt(task: SubTask, context: string): string {
        const basePrompt = `You are a specialized ${task.agent} agent.

Task: ${task.description}

${context ? `Context from other agents:\n${context}\n` : ''}

`;

        // CRITICAL: All agents MUST be conversational AND use filename= format
        const OUTPUT_FORMAT_INSTRUCTION = `

⚠️ CRITICAL - RESPONSE FORMAT (MANDATORY):
Your response MUST follow this EXACT structure.

**STEP 1 - GREETING (REQUIRED):**
Start with: "Halo! 👋 Saya akan buatkan [apa yang diminta] untuk kamu!"
Brief vision (1-2 sentences).

**STEP 2 - PLAN (REQUIRED):**  
"📋 **Rencana saya:**"
1. [Step 1]
2. [Step 2]

**STEP 3 - CODE FILES:**
Every file MUST have filename= attribute:
\`\`\`tsx filename="/App.tsx"
// code here
\`\`\`

**STEP 4 - CLOSING (REQUIRED):**
"✅ **Selesai!** Mau saya tambahkan fitur lain?"

❌ DO NOT skip steps 1, 2, or 4.
✅ BE conversational like chatting with a friend.
`;


        switch (task.agent) {
            case 'design':
                return basePrompt + `
Output a detailed UI/UX specification AND React component code:
- Component hierarchy
- Color scheme (hex codes)
- Typography
- Layout structure
- Interactive elements
${OUTPUT_FORMAT_INSTRUCTION}
Example:
\`\`\`tsx filename="/components/Layout.tsx"
export function Layout({ children }) { return <div className="...">...</div>; }
\`\`\``;

            case 'frontend':
                return basePrompt + `
${LANGUAGE_RULES}

${FORBIDDEN_PATTERNS}

${REQUIRED_STRUCTURE}

${CONVERSATION_FORMAT}

${OUTPUT_FORMAT_RULES}

AFTER COMPLETING THE TASK, always end with Next Steps section:
---
**📌 Next Steps:**
- 🎨 **Polish the UI** → Try KilatDesign for mockups and visual improvements
- 🛡️ **Security audit** → Let KilatAudit check for vulnerabilities
- 📖 **Generate docs** → Create README with KilatDocs`;

            case 'backend':
                // Backend agent redirects to frontend-only client-side solution
                return basePrompt + `
⚠️ IMPORTANT: WebContainer runs in BROWSER - no server-side code!

Instead of API routes, create:
- React components with mock data
- JSON data files for static data
- localStorage/IndexedDB for persistence
- External API integration using fetch()

${FORBIDDEN_PATTERNS}

${OUTPUT_FORMAT_RULES}

Generate client-side React components that SIMULATE backend functionality.
Example: Instead of API route, create a data service:
\`\`\`tsx filename="/services/api.ts"
// Mock API service - replace with real API URLs in production
export async function fetchData() {
  // For demo, return static data
  return [{ id: 1, name: "Example" }];
}
\`\`\``;

            case 'database':
                // Database agent redirects to browser storage
                return basePrompt + `
⚠️ IMPORTANT: WebContainer cannot run Prisma/PostgreSQL!

Instead, use browser-based storage:
- localStorage for simple key-value
- IndexedDB for complex queries
- Zustand for in-memory state
- External API (Supabase JS client) for real database

${FORBIDDEN_PATTERNS}

NEVER generate:
- prisma/schema.prisma
- Any .sql files
- Any migration files
- .env files

${OUTPUT_FORMAT_RULES}

Example localStorage wrapper:
\`\`\`tsx filename="/lib/storage.ts"
export const storage = {
  get: (key: string) => JSON.parse(localStorage.getItem(key) || 'null'),
  set: (key: string, value: any) => localStorage.setItem(key, JSON.stringify(value)),
  remove: (key: string) => localStorage.removeItem(key)
};
\`\`\``;

            case 'research':
                return basePrompt + `
Research and provide:
- Best practices for this use case
- Recommended libraries/packages
- Example implementations
- Potential gotchas

Format as actionable markdown recommendations.
Note: Research output does not need code files unless providing examples.`;

            default:
                return basePrompt + OUTPUT_FORMAT_INSTRUCTION + 'Complete the assigned task thoroughly.';
        }
    }

    /**
     * Extract code files from agent output
     * Supports multiple formats from different agents
     */
    private extractFiles(output: string): Record<string, string> {
        const files: Record<string, string> = {};

        // =====================================================================
        // Pattern 1: Standard format ```tsx filename="/path/file.tsx"
        // =====================================================================
        const pattern1 = /```\w*\s*filename=["']?([^"'\s\n]+)["']?\n([\s\S]*?)```/g;
        let match;
        while ((match = pattern1.exec(output)) !== null) {
            const path = match[1].startsWith('/') ? match[1] : `/${match[1]}`;
            files[path] = match[2].trim();
        }

        // =====================================================================
        // Pattern 2: Comment-based filename (// filename: App.tsx or // App.tsx)
        // =====================================================================
        const pattern2 = /```(\w+)\n\/\/\s*(?:filename:?\s*)?(\S+\.\w+)\n([\s\S]*?)```/g;
        while ((match = pattern2.exec(output)) !== null) {
            const path = match[2].startsWith('/') ? match[2] : `/${match[2]}`;
            if (!files[path]) {
                files[path] = match[3].trim();
            }
        }

        // =====================================================================
        // Pattern 3: JSON format { "files": { "/App.tsx": "..." } }
        // =====================================================================
        const jsonMatch = output.match(/\{\s*"files"\s*:\s*(\{[\s\S]*?\})\s*\}/);
        if (jsonMatch) {
            try {
                const parsed = JSON.parse(`{"files": ${jsonMatch[1]}}`);
                if (parsed.files) {
                    for (const [p, content] of Object.entries(parsed.files)) {
                        const path = p.startsWith('/') ? p : `/${p}`;
                        if (typeof content === 'string' && !files[path]) {
                            files[path] = content;
                        }
                    }
                }
            } catch { /* Ignore parse errors */ }
        }

        // =====================================================================
        // Pattern 4: Separator format (// ===== /filename ===== or ### filename)
        // =====================================================================
        if (Object.keys(files).length === 0) {
            const separatorPattern = /\/\/\s*=+\s*\/?([^\s=]+\.[a-zA-Z]+)\s*=+\s*\n([\s\S]*?)(?=\/\/\s*=+\s*\/?[\w\/]+\.[a-zA-Z]+|$)/g;
            let sepMatch;
            while ((sepMatch = separatorPattern.exec(output)) !== null) {
                const path = sepMatch[1].startsWith('/') ? sepMatch[1] : `/${sepMatch[1]}`;
                files[path] = sepMatch[2].trim();
            }
        }

        // =====================================================================
        // Pattern 5: Header-based (### /components/Navbar.tsx or **filename.tsx**)
        // =====================================================================
        if (Object.keys(files).length < 2) {
            const headerPattern = /(?:###?\s+|\*\*)\/?([a-zA-Z_\/]+\.(?:tsx?|jsx?|css|sql|json|html))(?:\*\*)?[\s:]*\n+```\w*\n([\s\S]*?)```/g;
            while ((match = headerPattern.exec(output)) !== null) {
                const path = match[1].startsWith('/') ? match[1] : `/${match[1]}`;
                if (!files[path]) {
                    files[path] = match[2].trim();
                }
            }
        }

        // =====================================================================
        // Pattern 6: Infer from code block language + content structure
        // =====================================================================
        if (Object.keys(files).length < 2) {
            const codeBlocks = output.matchAll(/```(tsx?|jsx?|css|sql|json|html|prisma)\n([\s\S]*?)```/g);
            let componentCount = 0;
            for (const block of codeBlocks) {
                const lang = block[1];
                const content = block[2].trim();

                // Skip if already extracted
                if (Object.values(files).some(f => f.includes(content.substring(0, 100)))) {
                    continue;
                }

                // Infer filename from content
                let filename: string;
                if (lang === 'sql' || lang === 'prisma') {
                    if (content.includes('CREATE TABLE')) {
                        filename = '/schema.sql';
                    } else if (content.includes('INSERT INTO')) {
                        filename = '/seed.sql';
                    } else if (content.includes('SELECT')) {
                        filename = '/queries.sql';
                    } else {
                        filename = `/migrations/00${componentCount + 1}_create_tables.sql`;
                    }
                } else if (lang === 'css') {
                    filename = '/styles.css';
                } else if (lang === 'json' && content.includes('"dependencies"')) {
                    filename = '/package.json';
                } else if (content.includes('export default function App')) {
                    filename = '/App.tsx';
                } else if (content.includes('export async function GET') || content.includes('export async function POST')) {
                    filename = `/api/route.ts`;
                } else if (content.includes('export function') || content.includes('export default function')) {
                    // Try to extract component name
                    const compMatch = content.match(/export (?:default )?function (\w+)/);
                    if (compMatch) {
                        filename = `/components/${compMatch[1]}.tsx`;
                    } else {
                        filename = `/components/Component${++componentCount}.tsx`;
                    }
                } else if (content.includes('const') && content.includes('interface')) {
                    filename = '/types.ts';
                } else {
                    filename = `/file${++componentCount}.${lang}`;
                }

                if (!files[filename]) {
                    files[filename] = content;
                }
            }
        }

        // =====================================================================
        // Final Fallback: If still no files, create App.tsx from first code block
        // =====================================================================
        if (Object.keys(files).length === 0) {
            const fallback = /```(?:\w+)?\n([\s\S]*?)```/;
            const fb = fallback.exec(output);
            if (fb) {
                files['/App.tsx'] = fb[1].trim();
            }
        }

        if (this.enableLogging && Object.keys(files).length > 0) {
            console.log(`      📦 [extractFiles] Extracted ${Object.keys(files).length} files: ${Object.keys(files).join(', ')}`);
        }

        return files;
    }

    /**
     * Step 3: Verify and Refine Worker Outputs (The MVP Layer)
     * Uses both AI verification and Piston code execution
     */
    private async verifyChain(plan: TaskPlan, results: AgentResult[], selectedModel?: string): Promise<AgentResult[]> {
        if (this.enableLogging) {
            console.log('   🕵️ Verifier: Reviewing code and validating libraries...');
        }

        // FIX 2026-01-22: Add 45s timeout to prevent Vercel function timeout
        // Vercel hobby = 60s, pro = 300s. Leave buffer for merge step.
        const VERIFY_CHAIN_TIMEOUT = 45000;
        const timeoutPromise = new Promise<AgentResult[]>((_, reject) =>
            setTimeout(() => reject(new Error('VerifyChain timeout - skipping verification')), VERIFY_CHAIN_TIMEOUT)
        );

        try {
            return await Promise.race([
                this.doVerifyChain(plan, results, selectedModel),
                timeoutPromise
            ]);
        } catch (error) {
            console.warn('   ⚠️ [VerifyChain] Timeout or error, returning unverified results');
            return results; // Return original results on timeout
        }
    }

    // Extracted actual verify logic
    private async doVerifyChain(plan: TaskPlan, results: AgentResult[], selectedModel?: string): Promise<AgentResult[]> {
        const verifiedResults: AgentResult[] = [];

        // Verify key coding tasks (design, frontend, backend, database)
        // Skip research or simple text tasks to save tokens
        const tasksToVerify = results.filter(r => ['frontend', 'backend', 'database', 'design'].includes(r.agent));
        const skippedTasks = results.filter(r => !tasksToVerify.includes(r));

        verifiedResults.push(...skippedTasks);

        // Execute verification in parallel
        const verificationPromises = tasksToVerify.map(async (result) => {
            const task = plan.subTasks.find(t => t.id === result.taskId);
            if (!task) return result;

            if (this.enableLogging) {
                console.log(`      🕵️ [Verifier] Checking ${result.agent} output...`);
            }

            try {
                // Step 3a: AI-based verification with FORBIDDEN import checks
                const verification = await aiMandor.call({
                    prompt: `${VERIFY_CHAIN_PROMPT}

Agent: ${result.agent}
Task: ${task.description}

Code to verify:
${result.output}

Return VERIFIED CODE with any fixes applied.`,
                    complexity: 'heavy',
                    priority: 'high',
                    model: selectedModel, // USER'S SELECTED MODEL
                    userId: this.currentUserId
                });

                let verifiedOutput = verification.result;
                let verifiedFiles = this.extractFiles(verifiedOutput);


                // Step 3b: Self-healing verification for frontend/backend using verifyAndFix()
                // Flow: Verify → IF ERROR: AI Fix → Retry (max 5x)
                if (['frontend', 'backend'].includes(result.agent) && Object.keys(verifiedFiles).length > 0) {
                    if (this.enableLogging) {
                        console.log(`      🔬 [Self-Healing] Running verifyAndFix for ${result.agent}...`);
                    }

                    try {
                        const { files: fixedFiles, verified, attempts } = await verifyAndFix(
                            verifiedFiles,
                            async (fixPrompt: string) => {
                                // AI callback to fix errors
                                if (this.enableLogging) {
                                    console.log(`      🔄 [Self-Healing] AI attempting fix...`);
                                }
                                const fixResponse = await aiMandor.call({
                                    prompt: fixPrompt,
                                    complexity: 'heavy',
                                    priority: 'high',
                                    model: selectedModel,
                                    userId: this.currentUserId
                                });
                                return this.extractFiles(fixResponse.result);
                            }
                        );

                        if (verified) {
                            if (this.enableLogging) {
                                console.log(`      ✅ [Self-Healing] Code verified after ${attempts} attempt(s)`);
                            }
                            verifiedFiles = fixedFiles;
                            // Regenerate output from fixed files
                            verifiedOutput = Object.entries(fixedFiles)
                                .map(([path, content]) => `// ${path}\n${content}`)
                                .join('\n\n');
                        } else {
                            if (this.enableLogging) {
                                console.log(`      ⚠️ [Self-Healing] Max retries reached, using best effort`);
                            }
                            verifiedFiles = fixedFiles;
                        }
                    } catch (verifyError) {
                        console.warn(`      ⚠️ [Self-Healing] Verification failed: ${verifyError}`);
                    }
                }

                // Update result with verified output
                return {
                    ...result,
                    output: verifiedOutput,
                    files: verifiedFiles,
                    agent: `${result.agent}+verified`
                };

            } catch (error) {
                console.error(`      ⚠️ [Verifier] Failed to verify ${result.agent}, keeping original.`);
                return result; // Fallback to original if verifier fails
            }
        });

        const verified = await Promise.all(verificationPromises);
        verifiedResults.push(...verified);

        return verifiedResults;
    }

    /**
     * Step 4: Intelligent Merge (Phase 5)
     * LLM-based conflict detection and resolution instead of simple Object.assign
     */
    private async merge(plan: TaskPlan, results: AgentResult[], selectedModel?: string): Promise<{ files: Record<string, string> }> {
        if (this.enableLogging) {
            console.log('   🔗 [Intelligent Merger] Merging results with conflict detection...');
        }

        // Collect all files from all agents (with conflict tracking)
        const allFiles: Record<string, string> = {};
        const conflicts: Array<{ filename: string; sources: AgentResult[] }> = [];

        for (const result of results) {
            if (result.files) {
                for (const [filename, content] of Object.entries(result.files)) {
                    // FORBIDDEN FILE FILTER: Skip files that crash WebContainer
                    const forbiddenPaths = ['prisma/', 'server/', 'api/', '.env', 'docker', '/migrations/', 'schema.prisma'];
                    if (forbiddenPaths.some(fp => filename.toLowerCase().includes(fp))) {
                        if (this.enableLogging) {
                            console.log(`      🚫 [Merger] Skipping forbidden file: ${filename}`);
                        }
                        continue; // Skip this file
                    }

                    if (allFiles[filename] && allFiles[filename] !== content) {
                        // Conflict detected - different content for same file
                        const existingConflict = conflicts.find(c => c.filename === filename);
                        if (existingConflict) {
                            existingConflict.sources.push(result);
                        } else {
                            conflicts.push({ filename, sources: [result] });
                        }
                    }
                    allFiles[filename] = content;
                }
            }
        }

        // =====================================================
        // INTELLIGENT CONFLICT RESOLUTION
        // =====================================================
        if (conflicts.length > 0 && this.enableLogging) {
            console.log(`   ⚠️ [Merger] ${conflicts.length} conflicts detected, resolving with LLM...`);

            try {
                const conflictSummary = conflicts.map(c =>
                    `File: ${c.filename} (${c.sources.length} versions from: ${c.sources.map(s => s.agent).join(', ')})`
                ).join('\n');

                const resolution = await aiMandor.call({
                    prompt: `${MERGE_SPECIALIST_PROMPT}

Conflicts detected:
${conflictSummary}

Current files:
${Object.entries(allFiles).map(([f, c]) => `--- ${f} ---\n${c.substring(0, 500)}...`).join('\n\n')}

Return resolved files as JSON.`,
                    complexity: 'medium',
                    priority: 'high',
                    model: selectedModel, // USER'S SELECTED MODEL
                    userId: this.currentUserId
                });

                // Try to parse resolved files
                try {
                    const jsonMatch = resolution.result.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        const resolved = JSON.parse(jsonMatch[0]);
                        if (resolved.files) {
                            Object.assign(allFiles, resolved.files);
                            console.log(`   ✅ [Merger] Resolved ${conflicts.length} conflicts`);
                        }
                    }
                } catch (parseError) {
                    console.warn('   ⚠️ [Merger] Could not parse resolution, using last-write-wins');
                }
            } catch (mergeError) {
                console.warn('   ⚠️ [Merger] LLM resolution failed, using last-write-wins');
            }
        }

        // If no structured files, create a combined output file
        if (Object.keys(allFiles).length === 0) {
            const combinedOutput = results
                .filter(r => r.success)
                .map(r => `## ${r.agent.toUpperCase()}\n\n${r.output}`)
                .join('\n\n---\n\n');

            allFiles['output.md'] = combinedOutput;
        }

        if (this.enableLogging) {
            console.log(`   ✅ Merged ${Object.keys(allFiles).length} files`);
        }

        return { files: allFiles };
    }
}

// ============================================================================
// Export singleton
// ============================================================================

export const orchestrator = new MultiAgentOrchestrator();

export default MultiAgentOrchestrator;
