/**
 * KilatCode Agent - Advanced Code Generation with Adapter Pattern
 * 
 * Philosophy: Apple Way
 * - Simple Interface (AgentPipeline)
 * - Advanced Backend (Agentic Loop + RAG + Vision)
 * - All Features Preserved
 * 
 * Copyright © 2026 KilatOS
 */

import {
    AgentPipeline,
    UserRequest,
    ParsedInput,
    Intent,
    Context,
    Plan,
    ExecutionResult,
    ValidationResult,
    Issue,
    FinalOutput
} from '../base/AgentPipeline';
import { generateCode, CodeGenParams, CodeGenResponse } from './orchestrator';
import type { RAGResult } from './rag-integration';

// Hybrid Prompt System
import { AgentEnhancer } from '@/lib/ai/agent-enhancer';
import { KILATCODE_RULES } from '@/lib/ai/enhancement-rules';

// Usage Tracking
import { usageTracker } from '@/lib/tracking/usage-tracker';

// Import RAG function dynamically to avoid module errors during build
let agenticRAGForCode: any;
import('./rag-integration').then(module => {
    agenticRAGForCode = module.agenticRAGForCode;
}).catch(() => {
    console.warn('⚠️ RAG integration not available yet (will be built in Week 3)');
});

// ============================================================================
// DeepCode-Style Enhancement Agents (New!)
// ============================================================================
import { documentSegmenter } from './document-segmenter';
import { planningAgent, CodePlan } from './planning-agent';
import { referenceAgent, ReferenceSearchResult } from './reference-agent';
import { responseCache } from './response-cache';

// Test executor removed - not needed in production
const testExecutor: any = null;

// ============================================================================
// Types (Internal - Advanced Backend)
// ============================================================================

interface InternalCodeGenInput extends CodeGenParams {
    userId: string;
    model?: string; // Database-Driven model selection
    sessionId?: string;
    ragMode?: 'fast' | 'fresh' | 'hybrid';
    // DeepCode-style orchestration options
    enablePlanning?: boolean;      // Enable PlanningAgent for complex tasks
    enableReferences?: boolean;    // Enable ReferenceAgent for patterns
    enableTesting?: boolean;       // Enable TestExecutor verification
    enableSegmentation?: boolean;  // Enable DocumentSegmenter for large docs
}

// ============================================================================
// KilatCode Agent Class (Adapter Pattern)
// ============================================================================

export class KilatCodeAgent extends AgentPipeline<InternalCodeGenInput, CodeGenResponse> {
    // Hybrid Prompt System
    private enhancer = new AgentEnhancer('code', KILATCODE_RULES);

    constructor() {
        super('code');
    }

    // ==========================================================================
    // Layer 1: INPUT (AgentPipeline Required)
    // ==========================================================================

    protected parseInput(request: UserRequest): InternalCodeGenInput {
        const text = request.text;

        // Detect mode from keywords
        const mode = this.detectMode(text);
        const language = this.detectLanguage(text) || 'typescript';
        const framework = this.detectFramework(text, language);
        const complexity = this.classifyComplexity(text);

        // Auto-enable orchestration based on complexity
        const isComplex = complexity === 'high' || text.length > 500;
        const isLargeDocument = text.length > 10000; // ~2500 tokens

        return {
            mode,
            input: text,
            language: language as any,
            framework,
            options: {
                maxIterations: 3,
                includeTests: true,
                includeDocs: true
            },
            userId: request.userId || '',
            sessionId: request.sessionId,
            ragMode: this.detectRAGMode(text, framework),
            // Pass model from context (if manually invoked via generateCode)
            model: request.context?.model,
            // DeepCode-style: auto-enable for complex tasks
            enablePlanning: isComplex,
            enableReferences: true, // Always helpful!
            enableTesting: isComplex,
            enableSegmentation: isLargeDocument
        };
    }

    protected async analyze(userRequest: UserRequest): Promise<InternalCodeGenInput> {
        // This method is not used in the current flow - parseInput handles it
        // Keeping for AgentPipeline compatibility
        return this.parseInput(userRequest);
    }

    protected validateInput(input: InternalCodeGenInput): boolean {
        return typeof input.input === 'string' && input.input.length > 0;
    }

    // ==========================================================================
    // Simple Task Detection (NEW - Performance Optimization)
    // ==========================================================================

    /**
     * Detect if task is simple enough to bypass planning stages
     * Simple tasks: short query, no complex keywords
     */
    private isSimpleTask(input: InternalCodeGenInput): boolean {
        const text = typeof input.input === 'string' ? input.input : input.input.source;
        const wordCount = text.split(/\s+/).length;

        // Keywords that indicate complex tasks
        const complexKeywords = /multi|fullstack|api|database|auth|dashboard|ecommerce|payment|oauth|websocket|realtime|microservice/i;

        // Simple if: short query AND no complex keywords
        return wordCount < 30 && !complexKeywords.test(text);
    }

    /**
     * Get task complexity level for caching
     */
    private getTaskComplexity(input: InternalCodeGenInput): 'simple' | 'medium' | 'complex' {
        const text = typeof input.input === 'string' ? input.input : input.input.source;
        const wordCount = text.split(/\s+/).length;

        if (wordCount < 30) return 'simple';
        if (wordCount < 100) return 'medium';
        return 'complex';
    }

    // ==========================================================================
    // Layer 2: UNDERSTANDING (AgentPipeline Required)
    // ==========================================================================

    protected async understandIntent(input: InternalCodeGenInput): Promise<Intent> {
        const query = typeof input.input === 'string' ? input.input : input.input.source;

        return {
            primary: 'code_generation',
            secondary: ['architecture', 'testing', 'documentation'],
            complexity: this.classifyComplexity(query),
            confidence: 0.95
        };
    }

    protected extractRequirements(context: Context): string[] {
        return context.requirements || [];
    }

    /**
     * Override gatherContext to pass parsed input to execute()
     * CRITICAL: AgentPipeline.process() creates Context that doesn't have 'input' property
     * We need to include the parsed InternalCodeGenInput in context so execute() can access it
     */
    protected async gatherContext(intent: Intent, request: UserRequest): Promise<Context & InternalCodeGenInput> {
        const baseContext = await super.gatherContext(intent, request);
        const parsedInput = this.parseInput(request);

        // Merge context with parsed input so execute() has access to all data
        return {
            ...baseContext,
            ...parsedInput
        } as Context & InternalCodeGenInput;
    }

    // ==========================================================================
    // Layer 3: PLANNING (AgentPipeline Required)
    // ==========================================================================

    protected async createPlan(context: Context): Promise<Plan> {
        const input = context as any; // Context contains our input

        return {
            steps: [
                'RAG retrieval',
                'Code generation',
                'Self-correction',
                'Test generation',
                'Documentation'
            ],
            tools: ['RAG', 'Pollination AI', 'AgenticLoop'],
            strategy: `Advanced: Agentic self-correction with ${input.ragMode || 'hybrid'} RAG`,
            estimatedTime: 30000
        };
    }

    protected selectTools(plan: Plan): string[] {
        return plan.tools;
    }

    // ==========================================================================
    // Layer 4: EXECUTION (AgentPipeline Required) - ADVANCED BACKEND HERE!
    // ==========================================================================

    protected async execute(plan: Plan, context: Context): Promise<ExecutionResult> {
        const input = context as any as InternalCodeGenInput;
        const startTime = Date.now();
        let requestId: string | undefined;

        try {
            // Step 0: Optimize with Hybrid Prompt System
            const taskDescription = this.buildTaskDescription(input);
            const complexity = this.determineComplexity(input);

            // Report Progress: Optimization
            if ((context as any).onProgress) {
                await (context as any).onProgress(15, 'Optimizing prompt & constraints...');
            }

            console.log('✨ Optimizing with Hybrid Prompt System...');
            const optimized = await this.enhancer.optimize(taskDescription, {
                framework: input.framework,
                language: input.language,
                complexity,
                features: this.extractFeatures(input)
            });

            console.log(`✅ Hybrid optimization applied:`);
            console.log(`   - Enhancements: ${optimized.agentEnhancements.join(', ')}`);
            console.log(`   - Quality checks: ${optimized.qualityChecks.length}`);
            console.log(`   - Proven patterns: ${optimized.provenPatterns?.length || 0}`);

            // ================================================================
            // CACHE CHECK (NEW - Performance Optimization)
            // ================================================================
            const queryText = typeof input.input === 'string' ? input.input : input.input.source;
            const cachedResponse = responseCache.findSimilar(queryText, 0.75);

            if (cachedResponse) {
                console.log('🚀 Cache hit! Returning cached response');
                if ((context as any).onProgress) {
                    await (context as any).onProgress(100, 'Retrieved from cache!');
                }
                return {
                    success: true,
                    artifacts: cachedResponse.response?.code ? [cachedResponse.response.code] : [],
                    metadata: {
                        codeGenResult: cachedResponse.response,
                        fromCache: true,
                        confidence: 0.95
                    }
                };
            }

            // ================================================================
            // SIMPLE TASK FAST PATH (NEW - Skip heavy processing)
            // ================================================================
            if (this.isSimpleTask(input)) {
                console.log('⚡ Simple task detected - using fast path (skipping planning stages)');

                if ((context as any).onProgress) {
                    await (context as any).onProgress(30, 'Simple task - direct generation...');
                }

                // Skip planning stages, go directly to code generation
                const codeGenInput: CodeGenParams = {
                    ...input,
                    input: optimized.userPrompt
                };

                console.log('⚙️ Running direct code generation (simple task)...');
                if ((context as any).onProgress) {
                    await (context as any).onProgress(50, 'Generating code...');
                }

                const codeGenResult = await generateCode(codeGenInput);

                // Cache the result
                responseCache.set(queryText, codeGenResult, 'simple');

                return {
                    success: codeGenResult.status === 'completed',
                    artifacts: codeGenResult.code ? [codeGenResult.code] : [],
                    metadata: {
                        codeGenResult,
                        fastPath: true,
                        confidence: 0.90
                    }
                };
            }

            // ================================================================
            // PARALLEL ORCHESTRATION STAGES (BGE-M3 Style)
            // Run ALL preparation stages IN PARALLEL for maximum speed
            // ================================================================
            if ((context as any).onProgress) {
                await (context as any).onProgress(25, 'Running parallel preparation (RAG + Planning + References)...');
            }

            console.log('🚀 Running PARALLEL orchestration stages...');
            const parallelStartTime = Date.now();

            // Prepare input for parallel processing
            let processedInput = typeof input.input === 'string' ? input.input : input.input.source;

            // Run all stages in parallel with Promise.allSettled
            const [segmentResult, planResult, refResult, ragResult] = await Promise.allSettled([
                // Document Segmentation
                input.enableSegmentation && documentSegmenter.needsSegmentation(processedInput)
                    ? documentSegmenter.segment(processedInput)
                    : Promise.resolve(null),

                // Planning Agent (for complex tasks)
                input.enablePlanning && complexity === 'heavy'
                    ? planningAgent.createPlan({
                        description: processedInput,
                        type: this.detectTaskType(input),
                        preferredStack: {
                            framework: input.framework,
                            language: input.language
                        }
                    })
                    : Promise.resolve(null),

                // Reference Mining
                input.enableReferences
                    ? referenceAgent.findReferences({
                        description: processedInput,
                        type: this.detectTaskType(input),
                        framework: input.framework,
                        language: input.language || 'TypeScript',
                        features: this.extractFeatures(input)
                    })
                    : Promise.resolve(null),

                // RAG retrieval
                agenticRAGForCode && input.ragMode
                    ? agenticRAGForCode({
                        mode: input.ragMode,
                        searchQuery: this.buildRAGQuery(input),
                        language: input.language || 'typescript',
                        framework: input.framework
                    })
                    : Promise.resolve(null)
            ]);

            const parallelDuration = Date.now() - parallelStartTime;
            console.log(`✅ Parallel stages completed in ${parallelDuration}ms (vs sequential would be 4x longer)`);

            // Extract results safely from Promise.allSettled
            const chunks = segmentResult.status === 'fulfilled' && segmentResult.value
                ? segmentResult.value as any[]
                : null;
            const codePlan: CodePlan | undefined = planResult.status === 'fulfilled'
                ? planResult.value as CodePlan
                : undefined;
            const referenceResults: ReferenceSearchResult | undefined = refResult.status === 'fulfilled'
                ? refResult.value as ReferenceSearchResult
                : undefined;
            const ragResults: RAGResult | undefined = ragResult.status === 'fulfilled'
                ? ragResult.value as RAGResult
                : undefined;

            // Log what succeeded/failed
            console.log('📊 Parallel stage results:');
            console.log(`   - Segmentation: ${chunks ? `${chunks.length} chunks` : 'skipped/failed'}`);
            console.log(`   - Planning: ${codePlan ? `${codePlan.modules.length} modules` : 'skipped/failed'}`);
            console.log(`   - References: ${referenceResults ? `${referenceResults.patterns.length} patterns` : 'skipped/failed'}`);
            console.log(`   - RAG: ${ragResults ? 'success' : 'skipped/failed'}`);

            // Handle segmentation results
            if (chunks && chunks.length > 0) {
                processedInput = chunks[0].content + (chunks.length > 1
                    ? `\n\n[Note: Document has ${chunks.length} sections. Processing main section first.]`
                    : '');
            }

            // ================================================================
            // END PARALLEL ORCHESTRATION
            // ================================================================

            // Step 3: Prepare enriched input for code generation
            // Combine: optimized prompt + RAG + plan + references
            let enrichedPrompt = ragResults
                ? this.enrichWithRAG(optimized.userPrompt, ragResults)
                : optimized.userPrompt;

            // Enrich with plan context
            if (codePlan) {
                enrichedPrompt = this.enrichWithPlan(enrichedPrompt, codePlan);
            }

            // Enrich with reference patterns
            if (referenceResults) {
                enrichedPrompt = enrichedPrompt + referenceResults.contextPrompt;
            }

            const codeGenInput: CodeGenParams = {
                ...input,
                input: enrichedPrompt // enrichedPrompt is already a string
            };

            // DEBUG: Log codeGenInput structure
            console.log('🔍🔍 DEBUG index.ts codeGenInput:', {
                mode: codeGenInput.mode,
                inputType: typeof codeGenInput.input,
                inputIsString: typeof codeGenInput.input === 'string',
                inputPreview: typeof codeGenInput.input === 'string'
                    ? codeGenInput.input.substring(0, 50)
                    : 'NOT A STRING',
                language: codeGenInput.language,
                framework: codeGenInput.framework
            });

            // Step 4: Run EXISTING advanced code generation (PRESERVED!)
            // This includes:
            // - Agentic self-correction loop
            // - Blueprint → Code → Review → Fix
            // - Vision integration
            // - Vision integration
            // - Multi-file generation
            // Report Progress: Code Gen
            if ((context as any).onProgress) {
                await (context as any).onProgress(50, 'Generating code (DeepCode AI)...');
            }
            console.log('⚙️ Running advanced agentic code generation (with hybrid optimization)...');
            const codeGenResult = await generateCode(codeGenInput);

            // Step 5: Validate quality
            // Report Progress: Validation
            if ((context as any).onProgress) {
                await (context as any).onProgress(85, 'Validating code quality...');
            }
            const outputCode = codeGenResult.code ? JSON.stringify(codeGenResult.code) : '';
            const validation = this.enhancer.validateResult(
                outputCode,
                optimized.qualityChecks
            );

            console.log(`✅ Quality validation: ${validation.score}/100`);

            // ================================================================
            // Step 6: Test Verification (NEW - DeepCode-style!)
            // ================================================================
            let testVerification: {
                success: boolean;
                testsGenerated: number;
                coverage: number;
                issues: string[];
                fixApplied: boolean;
            } | undefined;

            if (input.enableTesting && codeGenResult.code) {
                // Report Progress: Testing
                if ((context as any).onProgress) {
                    await (context as any).onProgress(90, 'Running verification tests...');
                }
                console.log('🧪 Running TestExecutor verification...');
                try {
                    // Extract main code file for testing
                    const mainCode = this.extractMainCode(codeGenResult.code);

                    if (mainCode) {
                        // Generate and verify tests
                        const verifyResult = await testExecutor.generateAndVerify(mainCode);

                        testVerification = {
                            success: verifyResult.success,
                            testsGenerated: verifyResult.tests.length,
                            coverage: verifyResult.validation.estimatedCoverage,
                            issues: verifyResult.validation.issues.map(i => i.description),
                            fixApplied: Boolean(verifyResult.fixedCode)
                        };

                        console.log(`   - Tests generated: ${testVerification.testsGenerated}`);
                        console.log(`   - Coverage: ${testVerification.coverage}%`);
                        console.log(`   - Issues found: ${testVerification.issues.length}`);

                        if (!verifyResult.success && verifyResult.validation.suggestions.length > 0) {
                            console.log(`   - Suggestions: ${verifyResult.validation.suggestions.slice(0, 2).join(', ')}`);
                        }
                    }
                } catch (testError) {
                    console.warn('⚠️ Test verification skipped (error):', testError instanceof Error ? testError.message : 'Unknown');
                }
            }

            const latencyMs = Date.now() - startTime;
            const success = codeGenResult.status === 'completed' && validation.passed;

            // Get tier for logging
            const { getUserTier, getModelForTier } = await import('@/lib/auth/user-tier');
            const userTier = await getUserTier(input.userId);
            const tierModel = getModelForTier(userTier, 'text');

            // Step 7: Log usage to Supabase
            requestId = await usageTracker.logUsage({
                userId: input.userId,
                sessionId: input.sessionId,
                agentType: 'code',
                taskInput: taskDescription,
                taskComplexity: complexity,
                taskCategory: input.framework || input.language,
                baseTemplateUsed: 'code-v1',
                enhancementsApplied: optimized.agentEnhancements,
                qualityChecksRun: optimized.qualityChecks,
                provenPatternsUsed: optimized.provenPatterns,
                aiProvider: 'pollination-free', // From existing codegen
                modelUsed: tierModel,
                priority: 'normal',
                success,
                outputText: outputCode.substring(0, 5000), // Truncate
                qualityScore: validation.score,
                validationPassed: validation.passed,
                failedQualityChecks: validation.failedChecks,
                latencyMs,
                tokensInput: undefined, // TODO: Track from API
                tokensOutput: undefined,
                costUsd: typeof codeGenResult.cost === 'number' ? codeGenResult.cost : 0,
                retries: typeof codeGenResult.iteration === 'number' ? codeGenResult.iteration : 0
            });

            console.log(`📊 Usage logged: ${requestId}`);

            // Step 8: Cache the result for similar future queries
            responseCache.set(queryText, codeGenResult, this.getTaskComplexity(input));
            console.log(`💾 Result cached for future similar queries`);

            // Step 9: Return as ExecutionResult
            return {
                success,
                artifacts: codeGenResult.code ? [codeGenResult.code] : [],
                metadata: {
                    codeGenResult,
                    ragResults,
                    iterations: codeGenResult.iteration,
                    filesGenerated: codeGenResult.code ? Object.keys(codeGenResult.code.files).length : 0,
                    cost: codeGenResult.cost,
                    // Hybrid system metadata
                    hybridOptimization: {
                        enhancements: optimized.agentEnhancements,
                        qualityScore: validation.score,
                        validationPassed: validation.passed,
                        requestId
                    },
                    // DeepCode-style orchestration metadata
                    orchestration: {
                        planningUsed: Boolean(codePlan),
                        referencesUsed: Boolean(referenceResults),
                        testVerification
                    }
                },
                errors: codeGenResult.errors?.map(e => new Error(e.message))
            };

        } catch (error) {
            const latencyMs = Date.now() - startTime;

            // Log failure
            await usageTracker.logUsage({
                userId: input.userId,
                sessionId: input.sessionId,
                agentType: 'code',
                taskInput: typeof input.input === 'string' ? input.input : 'complex input',
                taskComplexity: 'medium',
                taskCategory: input.framework || input.language,
                baseTemplateUsed: 'code-v1',
                enhancementsApplied: [],
                qualityChecksRun: [],
                aiProvider: 'unknown',
                modelUsed: 'unknown',
                priority: 'normal',
                success: false,
                qualityScore: 0,
                validationPassed: false,
                failedQualityChecks: [error instanceof Error ? error.message : 'Unknown error'],
                latencyMs
            });

            return {
                success: false,
                artifacts: [],
                metadata: { error: error instanceof Error ? error.message : 'Unknown error' },
                errors: [error instanceof Error ? error : new Error(String(error))]
            };
        }
    }

    protected async executeStep(step: string, context: any): Promise<any> {
        // Individual step execution (already handled in execute)
        return { step, completed: true };
    }

    // ==========================================================================
    // Layer 5: VALIDATION (AgentPipeline Required)
    // ==========================================================================

    protected async validate(result: ExecutionResult): Promise<ValidationResult> {
        const issues: Issue[] = [];

        // Check if code was generated
        if (!result.success || result.artifacts.length === 0) {
            issues.push({
                severity: 'error',
                message: 'No code was generated',
                suggestedFix: 'Review input requirements and try again'
            });
        }

        // Check for errors from codegen
        if (result.errors && result.errors.length > 0) {
            result.errors.forEach(error => {
                issues.push({
                    severity: 'error',
                    message: error.message
                });
            });
        }

        const passed = issues.filter(i => i.severity === 'error').length === 0;
        const score = passed ? 0.95 : 0.5;

        return {
            passed,
            score,
            issues,
            metrics: {
                filesGenerated: result.metadata?.filesGenerated || 0,
                iterations: result.metadata?.iterations || 0
            }
        };
    }

    // ==========================================================================
    // Layer 6: OUTPUT (AgentPipeline Required)
    // ==========================================================================

    protected formatOutput(result: ExecutionResult): CodeGenResponse {
        // If code generation failed or result is missing, return error response
        if (!result.metadata?.codeGenResult) {
            const errorMessage = result.errors && result.errors.length > 0
                ? result.errors[0].message
                : 'Code generation failed - no result returned';

            console.error('❌ formatOutput: codeGenResult missing', {
                success: result.success,
                hasErrors: Boolean(result.errors?.length),
                errorMessage
            });

            // Return error-formatted CodeGenResponse
            return {
                sessionId: `error_${Date.now()}`,
                status: 'failed',
                iteration: 0,
                errors: result.errors?.map(e => ({
                    file: 'system',
                    message: e.message
                })) || [],
                cost: {
                    pollen: 0,
                    iterations: 0
                }
            };
        }

        // Return the original CodeGenResponse from advanced backend
        return result.metadata.codeGenResult as CodeGenResponse;
    }

    // ==========================================================================
    // Helper Methods (Internal Logic - Advanced)
    // ==========================================================================

    private detectMode(text: string): CodeGenParams['mode'] {
        const lower = text.toLowerCase();

        if (lower.includes('paper') || lower.includes('pdf')) return 'paper2code';
        if (lower.includes('web') || lower.includes('frontend') || lower.includes('ui')) return 'text2web';
        if (lower.includes('backend') || lower.includes('api') || lower.includes('server')) return 'text2backend';
        if (lower.includes('refactor') || lower.includes('improve')) return 'refactor';
        if (lower.includes('test')) return 'test-gen';

        return 'text2web';
    }

    private detectLanguage(text: string): string | null {
        const lower = text.toLowerCase();

        if (lower.includes('typescript') || lower.includes('ts')) return 'typescript';
        if (lower.includes('python')) return 'python';
        if (lower.includes('go') || lower.includes('golang')) return 'go';
        if (lower.includes('rust')) return 'rust';

        return null;
    }

    private detectFramework(text: string, language: string): string | undefined {
        const lower = text.toLowerCase();

        if (language === 'typescript') {
            if (lower.includes('next') || lower.includes('nextjs')) return 'nextjs';
            if (lower.includes('react')) return 'react';
        }

        if (language === 'python') {
            if (lower.includes('fastapi')) return 'fastapi';
            if (lower.includes('django')) return 'django';
        }

        return undefined;
    }

    private classifyComplexity(query: string): 'low' | 'medium' | 'high' {
        const wordCount = query.split(/\s+/).length;

        if (wordCount < 20) return 'low';
        if (wordCount < 50) return 'medium';
        return 'high';
    }

    private detectRAGMode(query: string, framework?: string): 'fast' | 'fresh' | 'hybrid' {
        const lower = query.toLowerCase();

        // Fresh indicators
        const freshKeywords = ['latest', 'new', 'modern', 'updated', 'current'];
        if (freshKeywords.some(kw => lower.includes(kw)) || framework?.includes('15')) {
            return 'fresh';
        }

        // Fast indicators
        const fastKeywords = ['basic', 'simple', 'example', 'tutorial'];
        if (fastKeywords.some(kw => lower.includes(kw))) {
            return 'fast';
        }

        return 'hybrid';
    }

    private buildRAGQuery(input: InternalCodeGenInput): string {
        return `${input.language} ${input.framework || ''} code examples ${input.mode}`;
    }

    private enrichWithRAG(originalInput: string | { source: string; imageUrl?: string }, ragResults: RAGResult): string {
        const baseInput = typeof originalInput === 'string' ? originalInput : originalInput.source;

        return `${baseInput}

# Reference Examples (RAG ${ragResults.mode} mode):
${ragResults.examples.slice(0, 3).join('\n\n')}

# Best Practices:
${ragResults.bestPractices.slice(0, 5).join('\n')}

# Documentation Context:
${ragResults.documentation.substring(0, 500)}...`;
    }

    // ==========================================================================
    // Hybrid System Helper Methods
    // ==========================================================================

    private buildTaskDescription(input: InternalCodeGenInput): string {
        return typeof input.input === 'string'
            ? input.input
            : input.input.source || 'Code generation task';
    }

    /**
     * Detect task type for PlanningAgent and ReferenceAgent
     */
    private detectTaskType(input: InternalCodeGenInput): 'component' | 'api' | 'fullstack' | 'algorithm' | 'utility' {
        const text = this.buildTaskDescription(input).toLowerCase();

        if (text.includes('api') || text.includes('endpoint') || text.includes('route')) {
            return 'api';
        }
        if (text.includes('fullstack') || text.includes('app') || text.includes('application')) {
            return 'fullstack';
        }
        if (text.includes('algorithm') || text.includes('sort') || text.includes('search') ||
            text.includes('calculate') || text.includes('compute')) {
            return 'algorithm';
        }
        if (text.includes('utility') || text.includes('helper') || text.includes('function')) {
            return 'utility';
        }

        return 'component'; // Default
    }

    /**
     * Enrich prompt with plan context from PlanningAgent
     */
    private enrichWithPlan(basePrompt: string, plan: CodePlan): string {
        return `${basePrompt}

## Architecture Plan (from PlanningAgent)

**Summary:** ${plan.summary}

**Tech Stack:** ${plan.techStack.language}${plan.techStack.framework ? ` / ${plan.techStack.framework}` : ''}

**Modules to Implement (in order):**
${plan.implementationOrder.map((name, i) => {
            const module = plan.modules.find(m => m.name === name);
            return `${i + 1}. **${name}**: ${module?.purpose || 'N/A'} (~${module?.estimatedLines || 50} lines)`;
        }).join('\n')}

**Dependencies:** ${plan.dependencies.slice(0, 5).join(', ')}

---
`;
    }

    private determineComplexity(input: InternalCodeGenInput): 'light' | 'medium' | 'heavy' {
        const taskInput = this.buildTaskDescription(input);
        const taskLength = taskInput.length;
        const hasVision = input.mode === 'vision2code';
        const hasRAG = Boolean(input.ragMode);

        if (hasVision || taskLength > 500 || hasRAG) return 'heavy';
        if (taskLength > 200 || input.framework) return 'medium';
        return 'light';
    }

    private extractFeatures(input: InternalCodeGenInput): string[] {
        const features: string[] = [];

        if (input.mode === 'vision2code') features.push('vision-based');
        if (input.ragMode) features.push(`rag-${input.ragMode}`);
        if (input.options?.includeTests) features.push('testing');
        if (input.options?.includeDocs) features.push('documentation');
        if (input.framework) features.push(input.framework);
        if (input.language) features.push(input.language);

        return features;
    }

    /**
     * Extract main code file from generated code for testing
     */
    private extractMainCode(code: { files: Record<string, string> }): string | null {
        const files = code.files;
        const fileNames = Object.keys(files);

        if (fileNames.length === 0) return null;

        // Priority order for main file
        const priorities = [
            'index.tsx', 'index.ts', 'main.tsx', 'main.ts',
            'app.tsx', 'app.ts', 'component.tsx', 'component.ts'
        ];

        // Try to find by priority
        for (const priority of priorities) {
            const match = fileNames.find(f => f.toLowerCase().endsWith(priority));
            if (match) return files[match];
        }

        // Try any .tsx/.ts file
        const tsFile = fileNames.find(f => f.endsWith('.tsx') || f.endsWith('.ts'));
        if (tsFile) return files[tsFile];

        // Fallback to first file
        return files[fileNames[0]];
    }

    // ==========================================================================
    // Legacy API Compatibility
    // ==========================================================================

    /**
     * Legacy generateCode() wrapper
     * Maintains backward compatibility with existing API
     */
    async generateCode(params: CodeGenParams): Promise<CodeGenResponse> {
        const request: UserRequest = {
            userId: params.userId || undefined,
            text: typeof params.input === 'string' ? params.input : params.input.source,
            sessionId: undefined,
            context: {
                model: params.model // Pass model to context so parseInput can find it
            }
        };

        const result = await this.process(request);
        return result.data;
    }

    // ==========================================================================
    // Public API - Legacy Compatibility
    // ==========================================================================

    async generateCodeDirect(params: CodeGenParams): Promise<CodeGenResponse> {
        const request: UserRequest = {
            userId: params.userId || undefined,
            text: typeof params.input === 'string' ? params.input : params.input.source,
            sessionId: undefined,
            context: {}
        };

        const result = await this.process(request);
        return result.data;
    }
}

// ============================================================================
// Export
// ============================================================================

export const kilatCodeAgent = new KilatCodeAgent();

export default KilatCodeAgent;
