/**
 * CodeGen Agent Main Orchestrator
 * Supports 6 modes with agentic self-correction
 * Copyright © 2025 KilatCode Studio
 */

import { agenticCodeGeneration, CodeGenRequest, CodeGenResult } from './agentic-loop';

export interface CodeGenParams {
    mode: 'paper2code' | 'text2web' | 'text2backend' | 'vision2code' | 'refactor' | 'test-gen';
    input: string | { source: string; imageUrl?: string };
    language?: 'typescript' | 'python' | 'go' | 'rust';
    framework?: string;
    options?: {
        maxIterations?: number;
        includeTests?: boolean;
        includeDocs?: boolean;
    };
    userId?: string;
    model?: string; // Added for Database-Driven model selection
    // NEW: Progress callback for real-time UI updates
    onProgress?: (progress: number, message: string) => Promise<void>;
}

export interface CodeGenResponse {
    sessionId: string;
    status: 'blueprint' | 'coding' | 'reviewing' | 'completed' | 'failed';
    iteration: number;
    code?: {
        files: Record<string, string>;
        tests?: Record<string, string>;
        documentation?: string;
    };
    blueprint?: {
        architecture: string;
        files: string[];
        dependencies: string[];
    };
    errors?: Array<{
        file: string;
        message: string;
        fix?: string;
    }>;
    cost: {
        pollen: number;
        iterations: number;
    };
    model?: string;      // NEW: Track model used for usage logging
    costUsd?: number;    // NEW: Track cost for usage logging
}

/**
 * Main CodeGen orchestrator
 */
export async function generateCode(params: CodeGenParams): Promise<CodeGenResponse> {
    // Generate session ID
    const sessionId = `codegen_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    try {
        // Process input
        let processedInput: string;
        if (params.mode === 'vision2code' && typeof params.input === 'object' && params.input.imageUrl) {
            // Vision mode not supported yet - use text description
            console.warn('⚠️ Vision mode requires pollination-vision (not implemented)');
            processedInput = typeof params.input.source === 'string' ? params.input.source : 'Create a UI component based on the provided mockup';
        } else {
            processedInput = typeof params.input === 'string' ? params.input : params.input.source;
        }

        // Build request
        const request: CodeGenRequest = {
            mode: params.mode,
            input: {
                source: processedInput,
                language: params.language || 'typescript',
                framework: params.framework
            },
            options: {
                maxIterations: params.options?.maxIterations || 3,
                enableSelfCorrection: true,
                includeTests: params.options?.includeTests ?? true,
                includeDocs: params.options?.includeDocs ?? true
            },
            userId: params.userId, // Added for tier-based model selection
            model: params.model, // Propagate model user selection
            onProgress: params.onProgress // NEW: Pass progress callback to agentic loop
        };

        // DEBUG: Log request structure
        console.log('🔍 DEBUG orchestrator request:', {
            mode: request.mode,
            hasInput: Boolean(request.input),
            hasSource: Boolean(request.input?.source),
            sourceType: typeof request.input?.source,
            sourcePreview: request.input?.source?.substring(0, 50),
            userId: request.userId
        });

        // Log initial request
        console.log(`📝 CodeGen session ${sessionId}: mode=${params.mode}`);
        console.log(`📝 Input: ${processedInput.substring(0, 100)}...`);

        // Run agentic code generation
        const result = await agenticCodeGeneration(request, sessionId);

        // Log result
        console.log(`✅ CodeGen completed: iterations=${result.iterations}, success=${result.success}`);
        if (result.code) {
            console.log(`📦 Generated ${Object.keys(result.code).length} files`);
        }

        // Format response
        return {
            sessionId,
            status: result.success ? 'completed' : 'failed',
            iteration: result.iterations,
            code: result.code ? {
                files: result.code,
                tests: params.options?.includeTests ? await generateTests(result.code, params) : undefined,
                documentation: params.options?.includeDocs ? await generateDocs(result.code, result.blueprint!) : undefined
            } : undefined,
            blueprint: result.blueprint ? {
                architecture: result.blueprint.architecture,
                files: result.blueprint.files.map(f => f.path),
                dependencies: result.blueprint.dependencies
            } : undefined,
            errors: result.errors.map(e => ({
                file: e.file,
                message: e.message,
                fix: e.fix
            })),
            cost: {
                pollen: estimateCodeGenCost(result.iterations, Object.keys(result.code || {}).length),
                iterations: result.iterations
            },
            model: result.model,        // NEW: Track model for usage logging
            costUsd: result.costUsd     // NEW: Track cost for usage logging
        };

    } catch (error) {
        console.error('CodeGen error:', error);

        console.error(`❌ CodeGen failed for session ${sessionId}:`, error instanceof Error ? error.message : 'Unknown error');

        throw error;
    }
}

/**
 * Generate tests for generated code
 */
async function generateTests(
    code: Record<string, string>,
    params: CodeGenParams
): Promise<Record<string, string>> {
    try {
        const { generateTests: genTests } = await import('./modes/test-gen');

        const testSuite = await genTests(
            code,
            params.language || 'typescript',
            {
                testFramework: params.framework === 'nextjs' ? 'jest' : undefined,
                coverageTarget: 80,
                includeEdgeCases: true,
                includeIntegration: params.mode === 'text2backend'
            }
        );

        // Convert test suite to file map
        const testFiles: Record<string, string> = {};
        for (const file of testSuite.files) {
            testFiles[file.path] = file.content;
        }

        return testFiles;
    } catch (error) {
        console.warn('⚠️ Test generation skipped (module not available in production)');
        return {};
    }
}

/**
 * Generate documentation for generated code
 */
async function generateDocs(
    code: Record<string, string>,
    blueprint: any
): Promise<string> {
    const { generateDocumentation } = await import('./modes/documentation');

    return generateDocumentation(
        code,
        blueprint,
        'typescript', // TODO: Get from params
        {
            format: 'markdown',
            includeExamples: true,
            includeAPI: true,
            includeDiagrams: false
        }
    );
}

/**
 * Estimate code generation cost
 */
function estimateCodeGenCost(iterations: number, fileCount: number): number {
    // Rough estimate: ~3-5 pollen per iteration per file
    return iterations * fileCount * 4;
}
