/**
 * QStash Webhook Endpoint for Background Job Processing
 * 
 * This endpoint is called by QStash to execute long-running jobs.
 * It verifies the QStash signature and processes the job payload.
 * 
 * Copyright © 2026 KilatCode Studio
 */

import { NextRequest, NextResponse } from 'next/server';
import { verifyQStashSignature, QStashJobPayload } from '@/lib/queue/qstash-client';
import { jobQueue } from '@/lib/queue/job-queue';
import { kilatOS, initializeApps } from '@/lib/core';
import { orchestrator } from '@/lib/orchestrator/multi-agent';
import { verifyAndFix } from '@/lib/executor/code-verifier';
import { aiMandor } from '@/lib/ai/mandor';
import { hierarchicalMemory } from '@/lib/memory/HierarchicalMemory';
import { createClient as createSupabaseClient, SupabaseClient } from '@supabase/supabase-js';
import { recordAgentExecution } from '@/lib/agents/adaptive/integration';
import { prefetchRelatedPatterns } from '@/lib/cache/prefetch';
import { semanticCache } from '@/lib/cache/semantic-cache';
import { traceLogger, STEP_TYPES } from '@/lib/tracking/trace-logger';

// =========================================================================
// SPECIALIZED AGENT ORCHESTRATORS
// =========================================================================
import { research } from '@/lib/agents/research/orchestrator';
import { coWrite } from '@/lib/agents/cowriter/orchestrator';
import { solve } from '@/lib/agents/solve/orchestrator';
import { generateQuestions } from '@/lib/agents/question/orchestrator';
import { guide } from '@/lib/agents/guide/orchestrator';
import { generateIdeas } from '@/lib/agents/ideagen/orchestrator';
import { KilatCrawler } from '@/lib/agents/crawl/kilatcrawl';
import { generateImages } from '@/lib/agents/imagegen/orchestrator';
import { analyzeRepository, analyzeLocalFiles, generateFixes } from '@/lib/github/analyzer';
import { createGitHubClient } from '@/lib/github/client';
import { generateDocumentation } from '@/lib/agents/codegen/modes/documentation';
import { getPrompt, LANGUAGE_RULES } from '@/lib/prompts/templates';
import { callAgent } from '@/lib/agents/router';
import { suggestAgents } from '@/lib/agents/recommender';
import { getUserAgentSettings } from '@/lib/db/user-settings';
import { getAdaptiveContext } from '@/lib/ai/adaptive-prompt';
import { loadCrossAgentContext, CrossAgentContext } from '@/lib/ai/cross-agent-context';
import { processAndInjectAttachments, AttachmentInput } from '@/lib/ai/vision-processor';

// Initialize apps
let initialized = false;
function ensureInitialized() {
    if (!initialized) {
        initializeApps();
        initialized = true;
    }
}

/**
 * POST /api/kilat/process-job
 * 
 * Called by QStash to execute background jobs.
 * Verifies signature and processes the job payload.
 */
export async function POST(request: NextRequest) {
    const startTime = Date.now();

    try {
        ensureInitialized();

        // =====================================================================
        // QSTASH SIGNATURE VERIFICATION
        // =====================================================================
        const signature = request.headers.get('upstash-signature');
        const body = await request.text();

        if (!signature) {
            console.error('❌ Missing QStash signature');
            return NextResponse.json(
                { success: false, error: 'Missing signature' },
                { status: 401 }
            );
        }

        const isValid = await verifyQStashSignature(signature, body);
        if (!isValid) {
            console.error('❌ Invalid QStash signature');
            return NextResponse.json(
                { success: false, error: 'Invalid signature' },
                { status: 403 }
            );
        }

        // =====================================================================
        // PARSE PAYLOAD
        // =====================================================================
        const payload: QStashJobPayload = JSON.parse(body);
        const { jobId, message, mode, selectedModel, sessionId, userId, agentType, attachments, authToken } = payload;

        console.log(`🚀 QStash processing job: ${jobId} (mode: ${mode}, model: ${selectedModel})`);

        // =====================================================================
        // CREATE SCOPED SUPABASE CLIENT (FOR RLS)
        // =====================================================================
        let scopedClient: SupabaseClient | undefined;
        if (authToken) {
            scopedClient = createSupabaseClient(
                process.env.NEXT_PUBLIC_SUPABASE_URL!,
                process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
                { global: { headers: { Authorization: `Bearer ${authToken}` } } }
            );
        }

        // =====================================================================
        // PROCESS THE JOB
        // =====================================================================
        await processJob(
            jobId,
            message,
            mode,
            selectedModel,
            sessionId,
            scopedClient,
            userId,
            agentType,
            attachments as AttachmentInput[]
        );

        const duration = Date.now() - startTime;
        console.log(`✅ Job ${jobId} completed in ${duration}ms`);

        return NextResponse.json({
            success: true,
            jobId,
            duration
        });

    } catch (error) {
        console.error('❌ QStash job processing failed:', error);

        // Try to extract jobId from body for error tracking
        let jobId: string | undefined;
        try {
            const body = await request.text();
            const payload = JSON.parse(body);
            jobId = payload.jobId;
        } catch { }

        // Mark job as failed if we have jobId
        if (jobId) {
            try {
                await jobQueue.updateJob(jobId, {
                    status: 'failed',
                    errorMessage: error instanceof Error ? error.message : 'QStash processing failed'
                });
            } catch { }
        }

        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : 'Processing failed' },
            { status: 500 }
        );
    }
}

/**
 * Main job processing logic
 * Moved from /api/kilat/async/route.ts processJobInBackground()
 */
async function processJob(
    jobId: string,
    message: string,
    mode: 'planning' | 'fast' = 'planning',
    selectedModel: string,
    sessionId?: string,
    client?: SupabaseClient,
    userId?: string,
    agentType?: string,
    attachments?: AttachmentInput[]
) {
    console.log(`🚀 Processing job: ${jobId} (mode: ${mode}, model: ${selectedModel})`);
    const startTime = Date.now();

    // =========================================================================
    // START REQUEST TRACE
    // =========================================================================
    const traceId = await traceLogger.startTrace(
        jobId,
        sessionId,
        userId || '',
        agentType || 'unknown',
        mode,
        message.substring(0, 200)
    );

    // =========================================================================
    // ADAPTIVE AI CONTEXT
    // =========================================================================
    let adaptivePromptInjection = '';
    if (userId && agentType) {
        try {
            const adaptiveContext = await getAdaptiveContext(userId, agentType);
            adaptivePromptInjection = adaptiveContext.promptInjection;
            console.log(`🧠 Adaptive Context: ${adaptiveContext.userPreferences ? 'User prefs loaded' : 'New user'}`);
        } catch (e) {
            console.warn('⚠️ Adaptive context loading failed (non-blocking):', e);
        }
    }

    // =========================================================================
    // CROSS-AGENT CONTEXT
    // =========================================================================
    let crossAgentContext: CrossAgentContext | null = null;
    if (sessionId && agentType) {
        try {
            crossAgentContext = await loadCrossAgentContext(sessionId, agentType);
            if (crossAgentContext.hasContext) {
                console.log(`🔗 Cross-Agent Context: ${crossAgentContext.agentSummaries.length} agents`);
            }
        } catch (e) {
            console.warn('⚠️ Cross-agent context loading failed (non-blocking):', e);
        }
    }

    // =========================================================================
    // ATTACHMENT PROCESSING
    // =========================================================================
    let attachmentInjection = '';
    if (attachments && attachments.length > 0) {
        try {
            console.log(`📎 Processing ${attachments.length} attachment(s)...`);
            const { processed, injectionText } = await processAndInjectAttachments(attachments, userId);
            attachmentInjection = injectionText;
            console.log(`📎 Attachments processed: ${processed.length} items`);
        } catch (e) {
            console.warn('⚠️ Attachment processing failed (non-blocking):', e);
            attachmentInjection = '\n\n## 📎 ATTACHMENTS\n[Attachment processing failed.]\n\n';
        }
    }

    // =========================================================================
    // SESSION CONTEXT LOADING
    // =========================================================================
    let conversationContext = '';
    let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];

    if (sessionId) {
        try {
            await hierarchicalMemory.ensureSession(sessionId, userId!, 'general', client);

            // Add current message to immediate memory
            await hierarchicalMemory.addToImmediate(sessionId, {
                role: 'user',
                content: message,
                timestamp: new Date()
            }, undefined, client, agentType);

            // Get recent messages for context
            const recentMessages = await hierarchicalMemory.getImmediate(sessionId, undefined, client);

            if (recentMessages.length > 1) {
                conversationContext = recentMessages.slice(0, -1).map(m =>
                    `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.substring(0, 200)}${m.content.length > 200 ? '...' : ''}`
                ).join('\n');

                conversationHistory = recentMessages.slice(0, -1).map(m => ({
                    role: m.role as 'user' | 'assistant',
                    content: m.content
                }));

                console.log(`📝 Loaded ${recentMessages.length} messages for context`);
            }
        } catch (error) {
            console.warn('Failed to load session context:', error);
        }
    }

    // Inject contexts
    if (adaptivePromptInjection) {
        conversationContext = adaptivePromptInjection + '\n\n' + conversationContext;
    }
    if (crossAgentContext?.hasContext && crossAgentContext.injectionText) {
        conversationContext = crossAgentContext.injectionText + '\n\n' + conversationContext;
    }
    if (attachmentInjection) {
        conversationContext = attachmentInjection + '\n\n' + conversationContext;
    }

    try {
        // Update status to processing
        await jobQueue.updateJob(jobId, {
            status: 'processing',
            progress: 10,
            currentStep: mode === 'fast' ? '⚡ Fast mode: Direct execution...' : 'Analyzing request...'
        });

        let outputContent: string = '';
        let filesObject: Record<string, string> | undefined;

        // =========================================================================
        // MODE-BASED EXECUTION
        // =========================================================================
        if (mode === 'fast') {
            // FAST MODE: Route to appropriate agent
            const result = await executeFastMode(
                jobId,
                message,
                selectedModel,
                sessionId,
                userId,
                agentType,
                conversationContext,
                conversationHistory,
                crossAgentContext,
                traceId
            );
            outputContent = result.outputContent;
            filesObject = result.filesObject;
        } else {
            // PLANNING MODE: Multi-agent orchestration
            const result = await executePlanningMode(
                jobId,
                message,
                selectedModel,
                sessionId,
                userId,
                agentType,
                conversationContext,
                conversationHistory,
                crossAgentContext,
                client,
                traceId
            );
            outputContent = result.outputContent;
            filesObject = result.filesObject;
        }

        // =========================================================================
        // COMPLETE JOB
        // =========================================================================
        await jobQueue.updateJob(jobId, {
            status: 'completed',
            progress: 100,
            currentStep: '✅ Complete!',
            outputContent: outputContent,
            files: filesObject
        });

        // Save to session memory
        if (sessionId) {
            try {
                await hierarchicalMemory.addToImmediate(sessionId, {
                    role: 'assistant',
                    content: outputContent.substring(0, 5000),
                    timestamp: new Date()
                }, undefined, client, agentType);
            } catch (e) {
                console.warn('Failed to save response to memory:', e);
            }
        }

        // Record for adaptive learning
        if (userId && agentType && sessionId) {
            try {
                const agentTypeValue = agentType as import('@/lib/config/models').AgentType;
                await recordAgentExecution(
                    sessionId,
                    userId,
                    agentTypeValue,
                    {
                        success: true,
                        model: selectedModel,
                        executionTime: Date.now() - startTime
                    }
                );
            } catch (e) {
                console.warn('Failed to record execution:', e);
            }
        }

        // End trace
        await traceLogger.endTrace(traceId, 'success', { file_count: filesObject ? Object.keys(filesObject).length : 0 });

        console.log(`✅ Job ${jobId} completed successfully`);

    } catch (error) {
        console.error(`❌ Job ${jobId} failed:`, error);

        await jobQueue.updateJob(jobId, {
            status: 'failed',
            errorMessage: error instanceof Error ? error.message : 'Unknown error',
            currentStep: '❌ Failed'
        });

        await traceLogger.endTrace(traceId, 'error', { error_message: error instanceof Error ? error.message : 'Unknown error' });

        throw error;
    }
}

/**
 * Execute Fast Mode (single-layer agent)
 */
async function executeFastMode(
    jobId: string,
    message: string,
    selectedModel: string,
    sessionId: string | undefined,
    userId: string | undefined,
    agentType: string | undefined,
    conversationContext: string,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
    crossAgentContext: CrossAgentContext | null,
    traceId: string
): Promise<{ outputContent: string; filesObject?: Record<string, string> }> {
    let outputContent = '';
    let filesObject: Record<string, string> | undefined;

    await jobQueue.updateJob(jobId, {
        progress: 30,
        currentStep: `⚡ Fast mode: Processing with ${agentType || 'code'}...`
    });

    // Route based on agentType (simplified - full routing in original file)
    if (agentType === 'chat') {
        traceLogger.addStep(traceId, STEP_TYPES.AI_CALL, 'chat-fast');
        const chatResult = await aiMandor.call({
            prompt: `You are KilatChat, a friendly AI assistant.
${LANGUAGE_RULES}
${conversationContext ? `Previous conversation:\n${conversationContext}\n\n` : ''}User: ${message}`,
            complexity: 'light',
            priority: 'high',
            userId: userId,
            model: selectedModel
        });
        outputContent = chatResult.result;
    } else if (agentType === 'research') {
        traceLogger.addStep(traceId, STEP_TYPES.AI_CALL, 'research-fast');
        const researchResult = await research({
            topic: message,
            preset: 'quick',
            kbName: sessionId || 'default',
            userId: userId,
            locale: 'id'
        });
        outputContent = researchResult.report || 'Research complete!';
        if (researchResult.citations) {
            filesObject = { 'citations.json': JSON.stringify(researchResult.citations, null, 2) };
        }
    } else if (agentType === 'imagegen') {
        traceLogger.addStep(traceId, STEP_TYPES.AI_CALL, 'imagegen-fast');
        const imageResult = await generateImages({
            mode: 'ui-mockup',
            prompt: message,
            userId: userId,
            textModel: selectedModel
        });
        outputContent = `# 🎨 UI Mockup Generated!\n\n**Prompt:** ${message}\n\n![Generated Mockup](${imageResult.images?.[0]?.url || ''})`;
    } else if (agentType === 'kilatimage') {
        traceLogger.addStep(traceId, STEP_TYPES.AI_CALL, 'kilatimage-fast');
        const imageResult = await generateImages({
            mode: 'text2image',
            prompt: message,
            userId: userId,
            textModel: selectedModel,
            quality: 'standard'
        });
        if (imageResult.images && imageResult.images.length > 0) {
            const img = imageResult.images[0];
            outputContent = `# 🖼️ Image Generated!\n\n**Prompt:** ${message}\n\n**Model:** ${img.model || 'flux'}\n\n![Generated Image](${img.url})`;
        } else {
            outputContent = '❌ Image generation failed.';
        }
    } else {
        // Default: Code generation (KilatCode)
        traceLogger.addStep(traceId, STEP_TYPES.AI_CALL, 'codegen-fast');
        const codeResult = await orchestrator.executeFast(
            message,
            conversationContext,
            userId,
            sessionId,
            selectedModel
        );
        outputContent = codeResult.summary || '';
        filesObject = codeResult.files;
    }

    await jobQueue.updateJob(jobId, {
        progress: 90,
        currentStep: '⚡ Fast mode complete!'
    });

    return { outputContent, filesObject };
}

/**
 * Execute Planning Mode (multi-agent orchestration)
 */
async function executePlanningMode(
    jobId: string,
    message: string,
    selectedModel: string,
    sessionId: string | undefined,
    userId: string | undefined,
    agentType: string | undefined,
    conversationContext: string,
    conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>,
    crossAgentContext: CrossAgentContext | null,
    client: SupabaseClient | undefined,
    traceId: string
): Promise<{ outputContent: string; filesObject?: Record<string, string> }> {
    await jobQueue.updateJob(jobId, {
        progress: 20,
        currentStep: '🤖 Planning mode: Decomposing task...'
    });

    traceLogger.addStep(traceId, STEP_TYPES.AI_CALL, 'planning-start');

    // Execute full multi-agent orchestration with progress callback
    const onProgress = async (progress: number, step: string) => {
        await jobQueue.updateJob(jobId, {
            progress: 20 + Math.floor(progress * 0.7), // Scale 0-100 to 20-90
            currentStep: step
        });
    };

    const result = await orchestrator.orchestrate(
        message,
        userId,
        sessionId,
        onProgress,
        selectedModel
    );

    await jobQueue.updateJob(jobId, {
        progress: 90,
        currentStep: '🤖 Planning mode complete!'
    });

    return {
        outputContent: result.summary || '',
        filesObject: result.files
    };
}
