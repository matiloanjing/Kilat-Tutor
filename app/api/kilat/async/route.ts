/**
 * Async Job Submission Endpoint
 * 
 * POST /api/kilat/async
 * - Creates a job instantly (no timeout)
 * - Returns jobId for polling
 * - Background processes the multi-agent task
 * 
 * Copyright © 2026 KilatCode Studio
 */

import { NextResponse } from 'next/server';
import { jobQueue } from '@/lib/queue/job-queue';
import { publishJobToQStash, QStashJobPayload } from '@/lib/queue/qstash-client';
import { kilatOS, initializeApps } from '@/lib/core';
import { orchestrator } from '@/lib/orchestrator/multi-agent';
import { verifyAndFix } from '@/lib/executor/code-verifier';
import { aiMandor } from '@/lib/ai/mandor';
import { hierarchicalMemory } from '@/lib/memory/HierarchicalMemory';
import { createClient } from '@/lib/auth/server';
import { createClient as createSupabaseClient, SupabaseClient } from '@supabase/supabase-js';
import { recordAgentExecution } from '@/lib/agents/adaptive/integration';
import { prefetchRelatedPatterns } from '@/lib/cache/prefetch';
import { semanticCache } from '@/lib/cache/semantic-cache';
import { traceLogger, STEP_TYPES } from '@/lib/tracking/trace-logger';

// =========================================================================
// SPECIALIZED AGENT ORCHESTRATORS
// Each agent has its own processing logic
// =========================================================================
import { research } from '@/lib/agents/research/orchestrator';
import { coWrite } from '@/lib/agents/cowriter/orchestrator';
import { solve } from '@/lib/agents/solve/orchestrator';
import { generateQuestions } from '@/lib/agents/question/orchestrator';
import { guide } from '@/lib/agents/guide/orchestrator';
import { generateIdeas } from '@/lib/agents/ideagen/orchestrator';
import { KilatCrawler } from '@/lib/agents/crawl/kilatcrawl';
import { generateImages } from '@/lib/agents/imagegen/orchestrator';
// Audit and Docs agents
import { analyzeRepository, analyzeLocalFiles, generateFixes } from '@/lib/github/analyzer';
import { createGitHubClient } from '@/lib/github/client';
import { generateDocumentation } from '@/lib/agents/codegen/modes/documentation';
// Agent Persona Prompts
import { getPrompt, LANGUAGE_RULES } from '@/lib/prompts/templates';

// Multi-Agent Orchestration
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

export async function POST(request: Request) {
    try {
        ensureInitialized();

        // STRICT AUTH CHECK
        const supabase = await createClient();
        const { data: { user }, error: authError } = await supabase.auth.getUser();

        if (authError || !user) {
            return NextResponse.json({
                success: false,
                error: 'Unauthorized. Please log in.'
            }, { status: 401 });
        }

        const body = await request.json();
        const { message, sessionId, mode, model, agentType, attachments } = body;

        // Validate: message is required unless attachments are present
        if ((!message || typeof message !== 'string') && (!attachments || attachments.length === 0)) {
            return NextResponse.json({
                success: false,
                error: 'Message or attachments required'
            }, { status: 400 });
        }

        // User-selected model (from frontend dropdown) - NO FALLBACK, must be specified
        if (!model) {
            return NextResponse.json({
                success: false,
                error: 'Model must be specified from frontend. No hardcoded fallbacks allowed.'
            }, { status: 400 });
        }
        const selectedModel = model;
        console.log(`🎯 Model selected by user: ${selectedModel} (User: ${user.id})`);

        // Determine execution mode (default: planning)
        const executionMode: 'planning' | 'fast' = mode === 'fast' ? 'fast' : 'planning';

        // Create job instantly (no timeout) with mode tracking
        const jobId = await jobQueue.createJob({
            userId: user.id, // Strictly use authenticated user ID
            sessionId,
            inputMessage: message,
            agentType: agentType || 'code', // Use frontend agentType, fallback to 'code'
            executionMode  // NEW: Track mode in database for AI training
        });

        if (!jobId) {
            return NextResponse.json({
                success: false,
                error: 'Failed to create job. Check Supabase connection.'
            }, { status: 500 });
        }

        // Extract auth token to create scoped client that respects RLS
        // Strategy: 1. Check Header (API) -> 2. Check Cookie Session (Browser)
        let authToken = request.headers.get('Authorization')?.replace('Bearer ', '');

        if (!authToken) {
            try {
                // If call is from browser (fetch), try getting session from cookies
                const cookieClient = await createClient();
                const { data: { session } } = await cookieClient.auth.getSession();
                if (session?.access_token) {
                    authToken = session.access_token;
                }
            } catch (e) {
                console.warn('Failed to extract session from cookies:', e);
            }
        }

        let scopedClient: SupabaseClient | undefined;

        if (authToken) {
            scopedClient = createSupabaseClient(
                process.env.NEXT_PUBLIC_SUPABASE_URL!,
                process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
                { global: { headers: { Authorization: `Bearer ${authToken}` } } }
            );
        }

        // =====================================================================
        // QSTASH BACKGROUND JOB SUBMISSION
        // Use QStash for reliable 15min+ execution, fallback to fire-and-forget
        // =====================================================================
        const baseUrl = process.env.NEXT_PUBLIC_APP_URL || `https://${request.headers.get('host')}`;

        const qstashPayload: QStashJobPayload = {
            jobId,
            message: message || '',
            mode: executionMode,
            selectedModel,
            sessionId,
            userId: user.id,
            agentType: agentType || 'code',
            attachments: attachments as any[],
            authToken // Include auth token for RLS-scoped client in process-job
        };

        const { fallback } = await publishJobToQStash(qstashPayload, baseUrl);

        if (fallback) {
            // QStash not configured or failed - use fire-and-forget fallback
            console.log('⚠️ Falling back to fire-and-forget (QStash unavailable)');
            processJobInBackground(
                jobId,
                message || '',
                executionMode,
                selectedModel,
                sessionId,
                scopedClient,
                user.id,
                agentType || 'code',
                attachments as AttachmentInput[]
            ).catch(err => {
                console.error(`Job ${jobId} failed:`, err);
            });
        }

        // Return immediately with jobId
        return NextResponse.json({
            success: true,
            jobId,
            message: fallback
                ? 'Job submitted (fallback mode). Poll /api/kilat/status?jobId=xxx for updates.'
                : 'Job queued to QStash. Poll /api/kilat/status?jobId=xxx for updates.',
            pollUrl: `/api/kilat/status?jobId=${jobId}`,
            qstash: !fallback
        });

    } catch (error) {
        console.error('Async API Error:', error);
        return NextResponse.json({
            success: false,
            error: error instanceof Error ? error.message : 'Internal server error'
        }, { status: 500 });
    }
}

/**
 * Background Processing (non-blocking)
 * Supports both 'planning' (multi-agent) and 'fast' (single-layer) modes
 */
async function processJobInBackground(
    jobId: string,
    message: string,
    mode: 'planning' | 'fast' = 'planning',
    selectedModel: string,  // REQUIRED - no hardcoded fallback
    sessionId?: string,
    client?: SupabaseClient,
    userId?: string,     // VERIFIED AUTH USER ID
    agentType?: string,  // Agent type for tracking (codegen, imagegen, etc.)
    attachments?: AttachmentInput[] // NEW: Attached images/documents
) {
    console.log(`🚀 Starting background job: ${jobId} (mode: ${mode}, model: ${selectedModel}, session: ${sessionId || 'none'})`);
    const startTime = Date.now(); // Track execution time for learning

    // =========================================================================
    // START REQUEST TRACE (Full granularity for all agents)
    // =========================================================================
    const traceId = await traceLogger.startTrace(
        jobId,
        sessionId,
        userId || '',  // Handle undefined userId
        agentType ? agentType : 'unknown',  // Explicit check for undefined agentType
        mode,
        message.substring(0, 200)
    );

    // =========================================================================
    // ADAPTIVE AI CONTEXT (Per-User + Global Learning)
    // Load user preferences and global patterns to enhance AI responses
    // =========================================================================
    let adaptivePromptInjection = '';
    if (userId && agentType) {
        try {
            const adaptiveContext = await getAdaptiveContext(userId, agentType);
            adaptivePromptInjection = adaptiveContext.promptInjection;
            console.log(`🧠 Adaptive Context: ${adaptiveContext.userPreferences ? 'User prefs loaded' : 'New user'}, ${adaptiveContext.globalPatterns.length} global patterns`);
        } catch (e) {
            console.warn('⚠️ Adaptive context loading failed (non-blocking):', e);
        }
    }

    // =========================================================================
    // CROSS-AGENT CONTEXT (KilatOS Universe)
    // Load context from other agents that have worked on this project
    // =========================================================================
    let crossAgentContext: CrossAgentContext | null = null;
    if (sessionId && agentType) {
        try {
            crossAgentContext = await loadCrossAgentContext(sessionId, agentType);
            if (crossAgentContext.hasContext) {
                console.log(`🔗 Cross-Agent Context: ${crossAgentContext.agentSummaries.length} agents, ${Object.keys(crossAgentContext.files).length} files`);
            }
        } catch (e) {
            console.warn('⚠️ Cross-agent context loading failed (non-blocking):', e);
        }
    }

    // =========================================================================
    // ATTACHMENT PROCESSING (Vision Pre-Processing)
    // Use gemini-fast to describe images/documents for any model
    // =========================================================================
    let attachmentInjection = '';
    if (attachments && attachments.length > 0) {
        try {
            console.log(`📎 Processing ${attachments.length} attachment(s)...`);
            const { processed, injectionText } = await processAndInjectAttachments(attachments, userId);
            attachmentInjection = injectionText;
            console.log(`📎 Attachments processed: ${processed.length} items (${processed.map(p => p.name).join(', ')})`);
        } catch (e) {
            console.warn('⚠️ Attachment processing failed (non-blocking):', e);
            attachmentInjection = '\n\n## 📎 ATTACHMENTS\n[Attachment processing failed. User may have attached files.]\n\n';
        }
    }

    // =========================================================================
    // SESSION CONTEXT LOADING
    // Load conversation history for context-aware responses
    // =========================================================================
    let conversationContext = '';
    let conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    let userPreferences: Record<string, any> = {};

    if (sessionId) {
        try {
            // NEW: Ensure session record exists in 'sessions' table
            // This fixes the bug where history loading failed because the parent session was missing
            await hierarchicalMemory.ensureSession(sessionId, userId!, 'general', client);

            // =====================================================================
            // AUTO-TITLE UPDATE: If session title is "New Chat", update to first message
            // =====================================================================
            try {
                const supabase = client || await createClient();
                const { data: sessionData } = await supabase
                    .from('sessions')
                    .select('title')
                    .eq('id', sessionId)
                    .single();

                if (sessionData?.title === 'New Chat' && message) {
                    // Generate title from first user message (max 40 chars)
                    const autoTitle = message.substring(0, 40).trim() + (message.length > 40 ? '...' : '');
                    await supabase
                        .from('sessions')
                        .update({ title: autoTitle, updated_at: new Date().toISOString() })
                        .eq('id', sessionId);
                    console.log(`📝 Auto-titled session ${sessionId}: "${autoTitle}"`);
                }
            } catch (titleError) {
                // Non-blocking - don't fail job if title update fails
                console.warn('⚠️ Auto-title update failed (non-blocking):', titleError);
            }

            // Add current message to immediate memory (DATABASE) with agent type
            await hierarchicalMemory.addToImmediate(sessionId, {
                role: 'user',
                content: message,
                timestamp: new Date()
            }, undefined, client, agentType);

            // Get recent messages (last 5) for context (FROM DATABASE)
            const recentMessages = await hierarchicalMemory.getImmediate(sessionId, undefined, client);

            // NEW: Auto-name session from first message (IMMEDIATELY)
            console.log(`🔍 Auto-title check: session=${sessionId}, messageCount=${recentMessages.length}`);

            // ALWAYS try to update on first message (recentMessages.length <= 1 means this IS first message)
            if (recentMessages.length <= 2) {
                // Use user's message for title
                const titleSource = message;

                if (titleSource && titleSource.length > 0) {
                    // Create smart title (first 50 chars, cleaned up)
                    let autoTitle = titleSource
                        .replace(/\n/g, ' ')      // Remove newlines
                        .replace(/\s+/g, ' ')      // Collapse whitespace
                        .trim();

                    if (autoTitle.length > 50) {
                        autoTitle = autoTitle.substring(0, 47).trim() + '...';
                    }

                    // Update session title in database
                    try {
                        const supabase = client || await createClient();

                        // FORCE UPDATE on first message (don't check current title)
                        const { error } = await supabase
                            .from('sessions')
                            .update({
                                title: autoTitle,
                                updated_at: new Date().toISOString()
                            })
                            .eq('id', sessionId);

                        if (error) {
                            console.error('❌ Auto-title update error:', error);
                        } else {
                            console.log(`📝 Auto-named session: "${autoTitle}"`);
                        }
                    } catch (titleError) {
                        console.warn('Failed to auto-name session:', titleError);
                    }
                }
            }


            if (recentMessages.length > 1) {
                // Build string context for fast mode
                conversationContext = recentMessages.slice(0, -1).map(m =>
                    `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.substring(0, 200)}${m.content.length > 200 ? '...' : ''}`
                ).join('\n');

                // Build array context for gents (KilatContext)
                conversationHistory = recentMessages.slice(0, -1).map(m => ({
                    role: m.role as 'user' | 'assistant',
                    content: m.content
                }));

                console.log(`📝 Loaded ${recentMessages.length} messages for context (from database)`);
            }
        } catch (error) {
            console.warn('Failed to load session context:', error);
        }
    }

    // Inject adaptive context into conversation context
    if (adaptivePromptInjection) {
        conversationContext = adaptivePromptInjection + '\n\n' + conversationContext;
        console.log('🧠 Injected adaptive context into prompt');
    }

    // Inject cross-agent context (KilatOS Universe)
    if (crossAgentContext?.hasContext && crossAgentContext.injectionText) {
        conversationContext = crossAgentContext.injectionText + '\n\n' + conversationContext;
        console.log('🔗 Injected cross-agent context into prompt');
    }

    // Inject attachment descriptions (pre-processed by gemini-fast)
    if (attachmentInjection) {
        conversationContext = attachmentInjection + '\n\n' + conversationContext;
        console.log('📎 Injected attachment descriptions into prompt');
    }


    try {
        // Update status to processing
        await jobQueue.updateJob(jobId, {
            status: 'processing',
            progress: 10,
            currentStep: mode === 'fast' ? '⚡ Fast mode: Direct execution...' : 'Analyzing request...'
        });

        // Result variables
        let outputContent: string = '';
        let filesObject: Record<string, string> | undefined;

        // =========================================================================
        // AGENT ORCHESTRATION (Auto Mode) (Step 9 in Blueprint)
        // =========================================================================
        if (mode === 'planning' && userId) { // Only in planning mode and authenticated
            try {
                // Get user settings
                const settings = await getUserAgentSettings(userId);

                if (settings.mode === 'auto') {
                    console.log('🤖 Auto-mode active. Checking for required agents...');

                    // Suggest agents based on current context
                    const suggestions = suggestAgents({
                        currentAgent: (agentType as any) || 'codegen',
                        userMessage: message,
                        projectContext: {
                            files: filesObject,
                            activeFile: undefined,
                            recentMessages: conversationHistory
                        }
                    });

                    // Filter: Must be in auto_agents list AND high confidence
                    const autoRunAgents = suggestions.filter(s =>
                        settings.auto_agents.includes(s.agent) &&
                        s.confidence >= settings.confirm_threshold
                    );

                    if (autoRunAgents.length > 0) {
                        console.log(`🤖 Auto-running ${autoRunAgents.length} agents: ${autoRunAgents.map(a => a.agent).join(', ')}`);

                        await jobQueue.updateJob(jobId, {
                            progress: 15,
                            currentStep: `🤖 Auto-consulting: ${autoRunAgents.map(a => a.name).join(', ')}...`
                        });

                        // Execute in parallel
                        // NOTE: router's callAgent needs 'context' object. We construct it from message.
                        const results = await Promise.all(autoRunAgents.map(async (suggestion) => {
                            return callAgent({
                                from: 'codegen',
                                to: suggestion.agent,
                                reason: suggestion.reason,
                                priority: 'medium',
                                userId: userId,
                                context: {
                                    query: message,
                                    topic: message,
                                    kbName: sessionId || 'default',
                                    files: filesObject
                                }
                            });
                        }));

                        // Process results into context
                        const autoContexts = results
                            .filter(r => r.success)
                            .map(r => `> **[${r.agent.toUpperCase()}] (${r.duration_ms}ms)**:\n${JSON.stringify(r.data, null, 2)}`)
                            .join('\n\n');

                        if (autoContexts) {
                            conversationContext += `\n\n=== 🤖 AUTO-AGENT CONTEXT ===\n${autoContexts}\n=============================\n`;
                            console.log('✅ Auto-agent results added to context.');
                        }
                    } else {
                        console.log('🤖 No auto-agents matched threshold.');
                    }
                }
            } catch (orchError) {
                console.warn('⚠️ Auto-orchestration failed (non-blocking):', orchError);
            }
        }

        // =========================================================================
        // MODE-BASED EXECUTION
        // =========================================================================
        if (mode === 'fast') {
            // FAST MODE: Check if this is an image request first

            // =====================================================================
            // IMAGEGEN FAST ROUTING
            // If agentType === 'imagegen', use generateImages directly (UI mockups)
            // =====================================================================
            if (agentType === 'imagegen') {
                console.log('🎨 Fast Mode: Using ImageGen Agent (UI Mockups)');
                await jobQueue.updateJob(jobId, {
                    progress: 30,
                    currentStep: '🎨 Fast mode: Generating UI mockup...'
                });

                try {
                    const imageResult = await generateImages({
                        mode: 'ui-mockup',  // UI/UX mockup mode
                        prompt: message,
                        userId: userId,
                        textModel: selectedModel
                    });

                    await jobQueue.updateJob(jobId, {
                        progress: 90,
                        currentStep: '🎨 UI mockup generated!'
                    });

                    outputContent = `# 🎨 UI Mockup Generated!\n\n**Prompt:** ${message}\n\n**Optimized:** ${imageResult.optimizedPrompt || message}\n\n![Generated Mockup](${imageResult.images?.[0]?.url || ''})`;
                } catch (imgError) {
                    throw new Error(`UI mockup generation failed: ${imgError instanceof Error ? imgError.message : 'Unknown error'}`);
                }

            } else if (agentType === 'kilatimage') {
                // =====================================================================
                // KILATIMAGE FAST ROUTING (SHADOW AGENT - Pure Image Generation)
                // Uses Pollinations API with smart model selection (flux, zimage, etc)
                // =====================================================================
                console.log('🖼️ Fast Mode: Using KilatImage Agent (Pure Image Gen)');
                await jobQueue.updateJob(jobId, {
                    progress: 30,
                    currentStep: '🖼️ Fast mode: Generating image with AI...'
                });

                try {
                    const imageResult = await generateImages({
                        mode: 'text2image',  // Pure image generation mode
                        prompt: message,
                        userId: userId,
                        textModel: selectedModel,
                        quality: 'standard'
                    });

                    await jobQueue.updateJob(jobId, {
                        progress: 90,
                        currentStep: '🖼️ Image generated!'
                    });

                    if (imageResult.images && imageResult.images.length > 0) {
                        const img = imageResult.images[0];
                        // NOTE: Frontend renderContent() already adds Download button below each image,
                        // so we don't add redundant markdown link here to avoid duplication.
                        outputContent = `# 🖼️ Image Generated!\n\n**Original Prompt:** ${message}\n\n**Optimized:** ${imageResult.optimizedPrompt || message}\n\n**Model:** ${img.model || 'flux'}\n\n![Generated Image](${img.url})`;
                    } else {
                        outputContent = `❌ Image generation failed. Please try again.`;
                    }
                } catch (imgError) {
                    console.error('🖼️ KilatImage error:', imgError);
                    throw new Error(`Image generation failed: ${imgError instanceof Error ? imgError.message : 'Unknown error'}`);
                }

            } else if (agentType === 'chat') {
                // =====================================================================
                // CHAT FAST ROUTING - Conversational AI (NO code generation!)
                // =====================================================================
                console.log('💬 Fast Mode: Using Chat Agent (conversational)');
                await jobQueue.updateJob(jobId, {
                    progress: 30,
                    currentStep: '💬 Fast mode: Processing chat...'
                });

                try {
                    const chatResult = await aiMandor.call({
                        prompt: `You are KilatChat, a friendly and helpful AI assistant.
${LANGUAGE_RULES}
COMMUNICATION STYLE:
- Be conversational, warm, and helpful
- Answer questions clearly and concisely  
- DO NOT generate code files unless explicitly asked
- If user asks about coding, explain concepts without generating full files
- Suggest specialized agents when appropriate:
  - "For code generation, try KilatCode"
  - "For research, try KilatResearch"
  - "For security audits, try KilatAudit"

${conversationContext ? `Previous conversation:\n${conversationContext}\n\n` : ''}User question: ${message}`,
                        complexity: 'light',
                        priority: 'high',
                        userId: userId,
                        model: selectedModel
                    });

                    outputContent = chatResult.result;
                    // No files for chat - it's purely conversational!
                    filesObject = undefined;

                    await jobQueue.updateJob(jobId, {
                        progress: 90,
                        currentStep: '💬 Chat complete!'
                    });
                } catch (chatError) {
                    console.error('💬 Chat error:', chatError);
                    throw new Error(`Chat failed: ${chatError instanceof Error ? chatError.message : 'Unknown error'}`);
                }

            } else if (agentType === 'research') {
                // =====================================================================
                // RESEARCH FAST ROUTING - Quick research mode
                // =====================================================================
                console.log('🔬 Fast Mode: Using Research Agent (quick)');
                traceLogger.addStep(traceId, STEP_TYPES.AI_CALL, 'research-fast');
                await jobQueue.updateJob(jobId, { progress: 30, currentStep: '🔬 Fast mode: Quick research...' });

                try {
                    const researchResult = await research({
                        topic: message,
                        preset: 'quick',  // Fast preset for quick research
                        kbName: sessionId || 'default',
                        userId: userId,
                        locale: 'id'
                    });
                    outputContent = researchResult.report || 'Research complete!';
                    if (researchResult.citations) {
                        filesObject = { 'citations.json': JSON.stringify(researchResult.citations, null, 2) };
                    }
                    await jobQueue.updateJob(jobId, { progress: 90, currentStep: '🔬 Research complete!' });
                } catch (researchError) {
                    throw new Error(`Research failed: ${researchError instanceof Error ? researchError.message : 'Unknown error'}`);
                }

            } else if (agentType === 'cowriter') {
                // =====================================================================
                // COWRITER FAST ROUTING - Quick content editing
                // =====================================================================
                console.log('✍️ Fast Mode: Using CoWriter Agent');
                traceLogger.addStep(traceId, STEP_TYPES.AI_CALL, 'cowriter-fast');
                await jobQueue.updateJob(jobId, { progress: 30, currentStep: '✍️ Fast mode: Quick edit...' });

                try {
                    const writeResult = await coWrite({
                        operation: 'rewrite',
                        content: message,
                        userId: userId,
                        locale: 'id'
                    });
                    outputContent = writeResult.modifiedContent;
                    await jobQueue.updateJob(jobId, { progress: 90, currentStep: '✍️ Writing complete!' });
                } catch (writeError) {
                    throw new Error(`CoWriter failed: ${writeError instanceof Error ? writeError.message : 'Unknown error'}`);
                }

            } else if (agentType === 'solve') {
                // =====================================================================
                // SOLVE FAST ROUTING - Quick problem solving
                // =====================================================================
                console.log('🧮 Fast Mode: Using Solve Agent');
                traceLogger.addStep(traceId, STEP_TYPES.AI_CALL, 'solve-fast');
                await jobQueue.updateJob(jobId, { progress: 30, currentStep: '🧮 Fast mode: Solving...' });

                try {
                    const solveResult = await solve({
                        question: message,
                        kbName: sessionId || 'default',
                        userId: userId,
                        locale: 'id'
                    });
                    outputContent = solveResult.finalAnswer || 'Solution found!';
                    if (solveResult.citations) {
                        filesObject = { 'citations.json': JSON.stringify(solveResult.citations, null, 2) };
                    }
                    await jobQueue.updateJob(jobId, { progress: 90, currentStep: '🧮 Problem solved!' });
                } catch (solveError) {
                    throw new Error(`Solve failed: ${solveError instanceof Error ? solveError.message : 'Unknown error'}`);
                }

            } else if (agentType === 'question') {
                // =====================================================================
                // QUESTION FAST ROUTING - Quick quiz generation
                // =====================================================================
                console.log('❓ Fast Mode: Using Question Agent');
                traceLogger.addStep(traceId, STEP_TYPES.AI_CALL, 'question-fast');
                await jobQueue.updateJob(jobId, { progress: 30, currentStep: '❓ Fast mode: Generating quiz...' });

                try {
                    const questionResult = await generateQuestions({
                        mode: 'custom',
                        requirements: message,
                        kbName: sessionId || 'default',
                        count: 3,  // Fewer questions for fast mode
                        difficulty: 'medium',
                        questionType: 'multiple-choice',
                        userId: userId,
                        locale: 'id'
                    });
                    outputContent = JSON.stringify(questionResult.questions, null, 2);
                    filesObject = { 'quiz.json': JSON.stringify(questionResult, null, 2) };
                    await jobQueue.updateJob(jobId, { progress: 90, currentStep: '❓ Quiz generated!' });
                } catch (questionError) {
                    throw new Error(`Question failed: ${questionError instanceof Error ? questionError.message : 'Unknown error'}`);
                }

            } else if (agentType === 'guide') {
                // =====================================================================
                // GUIDE FAST ROUTING - Quick tutorial
                // =====================================================================
                console.log('📚 Fast Mode: Using Guide Agent');
                traceLogger.addStep(traceId, STEP_TYPES.AI_CALL, 'guide-fast');
                await jobQueue.updateJob(jobId, { progress: 30, currentStep: '📚 Fast mode: Creating guide...' });

                try {
                    const guideResult = await guide({
                        notebooks: [message],
                        kbName: sessionId || 'default',
                        userId: userId,
                        locale: 'id'
                    });
                    outputContent = guideResult.summary || 'Guide created!';
                    filesObject = { 'guide.json': JSON.stringify(guideResult.knowledgePoints, null, 2) };
                    await jobQueue.updateJob(jobId, { progress: 90, currentStep: '📚 Guide complete!' });
                } catch (guideError) {
                    throw new Error(`Guide failed: ${guideError instanceof Error ? guideError.message : 'Unknown error'}`);
                }

            } else if (agentType === 'ideagen') {
                // =====================================================================
                // IDEAGEN FAST ROUTING - Quick brainstorming
                // =====================================================================
                console.log('💡 Fast Mode: Using IdeaGen Agent');
                traceLogger.addStep(traceId, STEP_TYPES.AI_CALL, 'ideagen-fast');
                await jobQueue.updateJob(jobId, { progress: 30, currentStep: '💡 Fast mode: Generating ideas...' });

                try {
                    const ideaResult = await generateIdeas({
                        topic: message,
                        kbName: sessionId || 'default',
                        count: 5,  // Fewer ideas for fast mode
                        userId: userId,
                        locale: 'id'
                    });
                    outputContent = ideaResult.synthesis || JSON.stringify(ideaResult.ideas, null, 2);
                    filesObject = { 'ideas.json': JSON.stringify(ideaResult, null, 2) };
                    await jobQueue.updateJob(jobId, { progress: 90, currentStep: '💡 Ideas generated!' });
                } catch (ideaError) {
                    throw new Error(`IdeaGen failed: ${ideaError instanceof Error ? ideaError.message : 'Unknown error'}`);
                }

            } else if (agentType === 'crawl') {
                // =====================================================================
                // CRAWL FAST ROUTING - Quick web scraping
                // =====================================================================
                console.log('🕷️ Fast Mode: Using Crawl Agent');
                traceLogger.addStep(traceId, STEP_TYPES.AI_CALL, 'crawl-fast');
                await jobQueue.updateJob(jobId, { progress: 30, currentStep: '🕷️ Fast mode: Crawling...' });

                try {
                    const crawler = new KilatCrawler();
                    const crawlResult = await crawler.crawl({ url: message });
                    await crawler.cleanup();
                    outputContent = crawlResult.markdown || crawlResult.summary || 'Crawl complete!';
                    filesObject = {
                        'content.md': crawlResult.markdown || '',
                        'metadata.json': JSON.stringify(crawlResult.metadata, null, 2)
                    };
                    await jobQueue.updateJob(jobId, { progress: 90, currentStep: '🕷️ Crawl complete!' });
                } catch (crawlError) {
                    throw new Error(`Crawl failed: ${crawlError instanceof Error ? crawlError.message : 'Unknown error'}`);
                }

            } else if (agentType === 'audit') {
                // =====================================================================
                // AUDIT FAST ROUTING - Quick code audit
                // =====================================================================
                console.log('🔍 Fast Mode: Using Audit Agent');
                traceLogger.addStep(traceId, STEP_TYPES.AI_CALL, 'audit-fast');
                await jobQueue.updateJob(jobId, { progress: 30, currentStep: '🔍 Fast mode: Quick audit...' });

                try {
                    const repoMatch = message.match(/github\.com\/([^\/]+)\/([^\/\s]+)/);
                    const contextFiles = crossAgentContext?.files || null;

                    if (repoMatch) {
                        const [, owner, repo] = repoMatch;
                        const githubClient = createGitHubClient(process.env.GITHUB_TOKEN || '');
                        const auditResult = await analyzeRepository(githubClient, owner, repo.replace('.git', ''), {
                            checks: ['security', 'bugs'],  // Fewer checks for fast mode
                            maxFiles: 15,  // Less files for fast mode
                            model: selectedModel
                        });
                        const issuesList = auditResult.issues.slice(0, 10).map((issue: any, i: number) =>
                            `${i + 1}. **[${issue.severity.toUpperCase()}]** ${issue.file}:${issue.line || '?'}\n   ${issue.message}`
                        ).join('\n\n');
                        outputContent = `# 🔍 Quick Audit: ${owner}/${repo}\n\n${issuesList || 'No critical issues found! ✨'}`;
                        filesObject = { 'audit-report.json': JSON.stringify(auditResult, null, 2) };
                    } else if (contextFiles && Object.keys(contextFiles).length > 0) {
                        const auditResult = await analyzeLocalFiles(contextFiles, {
                            checks: ['security', 'bugs'],
                            model: selectedModel,
                            projectName: 'kilatcode-project'
                        });
                        const issuesList = auditResult.issues.slice(0, 10).map((issue: any, i: number) =>
                            `${i + 1}. **[${issue.severity.toUpperCase()}]** ${issue.file}\n   ${issue.message}`
                        ).join('\n\n');
                        outputContent = `# 🔍 Quick Local Audit\n\n${issuesList || 'No critical issues found! ✨'}`;
                        filesObject = { 'audit-report.json': JSON.stringify(auditResult, null, 2) };
                    } else {
                        outputContent = '❌ Please provide a GitHub URL or use from a KilatCode session.';
                    }
                    await jobQueue.updateJob(jobId, { progress: 90, currentStep: '🔍 Audit complete!' });
                } catch (auditError) {
                    throw new Error(`Audit failed: ${auditError instanceof Error ? auditError.message : 'Unknown error'}`);
                }

            } else if (agentType === 'docs') {
                // =====================================================================
                // DOCS FAST ROUTING - Quick documentation
                // =====================================================================
                console.log('📄 Fast Mode: Using Docs Agent');
                traceLogger.addStep(traceId, STEP_TYPES.AI_CALL, 'docs-fast');
                await jobQueue.updateJob(jobId, { progress: 30, currentStep: '📄 Fast mode: Generating docs...' });

                try {
                    const codeMatch = message.match(/```[\s\S]*?```/g);
                    if (codeMatch && codeMatch.length > 0) {
                        const codeFiles: Record<string, string> = {};
                        codeMatch.forEach((block, i) => {
                            const content = block.replace(/```\w*\n?/, '').replace(/```$/, '');
                            codeFiles[`file${i + 1}.ts`] = content;
                        });
                        const docsResult = await generateDocumentation(
                            codeFiles,
                            { architecture: 'Unknown', files: Object.keys(codeFiles).map(f => ({ path: f, purpose: 'Generated', dependencies: [] })), dependencies: [] },
                            'typescript',
                            { format: 'markdown', includeExamples: false, includeAPI: true, includeDiagrams: false }  // Simpler for fast mode
                        );
                        outputContent = docsResult;
                        filesObject = { 'documentation.md': docsResult };
                    } else {
                        outputContent = '# 📄 Documentation Generator\n\nProvide code in code blocks to generate documentation.';
                    }
                    await jobQueue.updateJob(jobId, { progress: 90, currentStep: '📄 Docs complete!' });
                } catch (docsError) {
                    throw new Error(`Docs failed: ${docsError instanceof Error ? docsError.message : 'Unknown error'}`);
                }

            } else {
                // =====================================================================
                // CODEGEN FAST ROUTING (Original)
                // =====================================================================
                console.log('⚡ Using Fast Mode (single-layer)');

                await jobQueue.updateJob(jobId, {
                    progress: 30,
                    currentStep: '⚡ Fast mode: Generating code directly...'
                });

                // FIX: Pass parameters in correct order matching executeFast signature
                // executeFast(userRequest, context?, userId, sessionId, selectedModel)
                const fastResult = await orchestrator.executeFast(
                    message,
                    conversationContext,
                    userId,           // ✅ FIX: Pass authenticated user ID
                    sessionId || jobId, // ✅ FIX: Use actual sessionId or jobId
                    selectedModel // Now in correct 5th position!
                );

                if (fastResult.success) {
                    outputContent = fastResult.summary;
                    filesObject = fastResult.files;

                    // =================================================================
                    // CODE VERIFICATION (Piston API)
                    // Verify code is Sandpack-compatible before sending to UI
                    // =================================================================
                    if (filesObject && Object.keys(filesObject).length > 0) {
                        await jobQueue.updateJob(jobId, {
                            progress: 60,
                            currentStep: '🔍 Verifying code for live preview...'
                        });

                        const verified = await verifyAndFix(filesObject, async (fixPrompt) => {
                            // AI callback to fix errors
                            const fixResult = await aiMandor.call({
                                prompt: fixPrompt,
                                complexity: 'medium',
                                priority: 'high',
                                model: selectedModel // BUG FIX: Use user-selected model for fixing
                            });

                            // Extract fixed files from AI response
                            try {
                                const jsonMatch = fixResult.result.match(/\{[\s\S]*\}/);
                                if (jsonMatch) {
                                    return JSON.parse(jsonMatch[0]);
                                }
                            } catch {
                                console.warn('[Verify] Failed to parse AI fix response');
                            }
                            return filesObject!;
                        });

                        filesObject = verified.files;
                        console.log(`🔍 [Verify] ${verified.verified ? '✅ Passed' : '⚠️ Best effort'} after ${verified.attempts} attempt(s)`);
                    }

                    await jobQueue.updateJob(jobId, {
                        progress: 90,
                        currentStep: '⚡ Fast mode: Complete!'
                    });
                } else {
                    throw new Error(fastResult.summary || 'Fast mode execution failed');
                }
            } // End of else (codegen fast mode)

        } else {
            // PLANNING MODE: Route to specialized agent orchestrator based on agentType
            console.log(`🎭 Using Planning Mode (agentType: ${agentType})`);

            // =========================================================================
            // AGENT-TYPE BASED ROUTING
            // Each agent uses its specialized orchestrator
            // =========================================================================
            let result: any;
            let specializedResult: any = null;

            switch (agentType) {
                // =====================================================================
                // RESEARCH AGENT - Deep research with citations
                // =====================================================================
                case 'research':
                    console.log('🔬 Routing to Research Agent');
                    await jobQueue.updateJob(jobId, { progress: 20, currentStep: '🔬 Starting deep research...' });
                    specializedResult = await research({
                        topic: message,
                        preset: 'medium',
                        kbName: sessionId || 'default',
                        userId: userId,
                        locale: 'id'
                    });
                    outputContent = specializedResult.report || 'Research complete!';
                    if (specializedResult.citations) {
                        filesObject = { 'citations.json': JSON.stringify(specializedResult.citations, null, 2) };
                    }
                    break;

                // =====================================================================
                // COWRITER AGENT - Content editing and narration
                // =====================================================================
                case 'cowriter':
                    console.log('✍️ Routing to CoWriter Agent');
                    await jobQueue.updateJob(jobId, { progress: 20, currentStep: '✍️ Processing content...' });
                    specializedResult = await coWrite({
                        operation: 'rewrite', // Default, can be enhanced later
                        content: message,
                        userId: userId,
                        locale: 'id'
                    });
                    outputContent = specializedResult.modifiedContent;
                    break;

                // =====================================================================
                // SOLVE AGENT - Problem solving with web search
                // =====================================================================
                case 'solve':
                    console.log('🧮 Routing to Solve Agent');
                    await jobQueue.updateJob(jobId, { progress: 20, currentStep: '🧮 Investigating problem...' });
                    specializedResult = await solve({
                        question: message,
                        kbName: sessionId || 'default',
                        userId: userId,
                        locale: 'id'
                    });
                    outputContent = specializedResult.finalAnswer || 'Solution found!';
                    if (specializedResult.citations) {
                        filesObject = { 'citations.json': JSON.stringify(specializedResult.citations, null, 2) };
                    }
                    break;

                // =====================================================================
                // QUESTION AGENT - Quiz generation
                // =====================================================================
                case 'question':
                    console.log('❓ Routing to Question Agent');
                    await jobQueue.updateJob(jobId, { progress: 20, currentStep: '❓ Generating quiz...' });
                    specializedResult = await generateQuestions({
                        mode: 'custom',
                        requirements: message,
                        kbName: sessionId || 'default',
                        count: 5,
                        difficulty: 'medium',
                        questionType: 'multiple-choice',
                        userId: userId,
                        locale: 'id'
                    });
                    outputContent = JSON.stringify(specializedResult.questions, null, 2);
                    filesObject = { 'quiz.json': JSON.stringify(specializedResult, null, 2) };
                    break;

                // =====================================================================
                // GUIDE AGENT - Tutorial generation
                // =====================================================================
                case 'guide':
                    console.log('📚 Routing to Guide Agent');
                    await jobQueue.updateJob(jobId, { progress: 20, currentStep: '📚 Creating learning guide...' });
                    specializedResult = await guide({
                        notebooks: [message],
                        kbName: sessionId || 'default',
                        userId: userId,
                        locale: 'id'
                    });
                    outputContent = specializedResult.summary || 'Guide created!';
                    filesObject = { 'guide.json': JSON.stringify(specializedResult.knowledgePoints, null, 2) };
                    break;

                // =====================================================================
                // IDEAGEN AGENT - Brainstorming
                // =====================================================================
                case 'ideagen':
                    console.log('💡 Routing to IdeaGen Agent');
                    await jobQueue.updateJob(jobId, { progress: 20, currentStep: '💡 Generating ideas...' });
                    specializedResult = await generateIdeas({
                        topic: message,
                        kbName: sessionId || 'default',
                        count: 10,
                        userId: userId,
                        locale: 'id'
                    });
                    outputContent = specializedResult.synthesis || JSON.stringify(specializedResult.ideas, null, 2);
                    filesObject = { 'ideas.json': JSON.stringify(specializedResult, null, 2) };
                    break;

                // =====================================================================
                // CRAWL AGENT - Web scraping
                // =====================================================================
                case 'crawl':
                    console.log('🕷️ Routing to Crawl Agent');
                    await jobQueue.updateJob(jobId, { progress: 20, currentStep: '🕷️ Crawling website...' });
                    const crawler = new KilatCrawler();
                    try {
                        specializedResult = await crawler.crawl({ url: message });
                        outputContent = specializedResult.markdown || specializedResult.summary || 'Crawl complete!';
                        filesObject = {
                            'content.md': specializedResult.markdown || '',
                            'metadata.json': JSON.stringify(specializedResult.metadata, null, 2)
                        };
                    } finally {
                        await crawler.cleanup();
                    }
                    break;

                // =====================================================================
                // AUDIT AGENT - GitHub repository analysis (Jules-style)
                // Also supports auditing local files from session context
                // =====================================================================
                case 'audit':
                    console.log('🔍 Routing to Audit Agent');
                    await jobQueue.updateJob(jobId, { progress: 20, currentStep: '🔍 Analyzing code...' });

                    // Parse GitHub URL from message
                    const repoMatch = message.match(/github\.com\/([^\/]+)\/([^\/\s]+)/);

                    // Check if we have local files from session context (from KilatCode)
                    const contextFiles = crossAgentContext?.files || null;

                    if (repoMatch) {
                        // GitHub Repository Audit
                        const [, owner, repo] = repoMatch;
                        try {
                            const githubClient = createGitHubClient(process.env.GITHUB_TOKEN || '');
                            specializedResult = await analyzeRepository(githubClient, owner, repo.replace('.git', ''), {
                                checks: ['security', 'performance', 'bugs', 'style'],
                                maxFiles: 30,
                                model: selectedModel
                            });

                            const issuesList = specializedResult.issues.slice(0, 20).map((issue: any, i: number) =>
                                `${i + 1}. **[${issue.severity.toUpperCase()}]** ${issue.file}:${issue.line || '?'}\n   ${issue.message}`
                            ).join('\n\n');

                            outputContent = `# 🔍 Audit Report: ${owner}/${repo}\n\n## Summary\n- Files analyzed: ${specializedResult.repository.filesAnalyzed}\n- Errors: ${specializedResult.summary.errors}\n- Warnings: ${specializedResult.summary.warnings}\n- Info: ${specializedResult.summary.info}\n\n## Issues Found\n\n${issuesList || 'No issues found! ✨'}`;
                            filesObject = { 'audit-report.json': JSON.stringify(specializedResult, null, 2) };
                        } catch (auditError) {
                            outputContent = `❌ Audit failed: ${auditError instanceof Error ? auditError.message : 'Unknown error'}. Make sure the repository is public or you're logged in with GitHub.`;
                        }
                    } else if (contextFiles && Object.keys(contextFiles).length > 0) {
                        // Local Files Audit (from KilatCode or session)
                        console.log('   📁 Auditing local files from context...');
                        try {
                            specializedResult = await analyzeLocalFiles(contextFiles, {
                                checks: ['security', 'performance', 'bugs', 'style'],
                                model: selectedModel,
                                projectName: 'kilatcode-project'
                            });

                            const issuesList = specializedResult.issues.slice(0, 20).map((issue: any, i: number) =>
                                `${i + 1}. **[${issue.severity.toUpperCase()}]** ${issue.file}:${issue.line || '?'}\n   ${issue.message}`
                            ).join('\n\n');

                            outputContent = `# 🔍 Local Code Audit Report\n\n## Summary\n- Files analyzed: ${specializedResult.repository.filesAnalyzed}\n- Errors: ${specializedResult.summary.errors}\n- Warnings: ${specializedResult.summary.warnings}\n- Info: ${specializedResult.summary.info}\n\n## Issues Found\n\n${issuesList || 'No issues found! ✨'}`;
                            filesObject = { 'audit-report.json': JSON.stringify(specializedResult, null, 2) };
                        } catch (auditError) {
                            outputContent = `❌ Local audit failed: ${auditError instanceof Error ? auditError.message : 'Unknown error'}`;
                        }
                    } else {
                        outputContent = '❌ Please provide a valid GitHub repository URL (e.g., `https://github.com/owner/repo`) or switch from a KilatCode session that has generated files to audit.';
                    }
                    break;

                // =====================================================================
                // DOCS AGENT - Auto-generate documentation
                // =====================================================================
                case 'docs':
                    console.log('📄 Routing to Docs Agent');
                    await jobQueue.updateJob(jobId, { progress: 20, currentStep: '📄 Generating documentation...' });

                    // Parse code from message or treat as description
                    const codeMatch = message.match(/```[\s\S]*?```/g);
                    if (codeMatch && codeMatch.length > 0) {
                        // Extract code blocks and generate docs
                        const codeFiles: Record<string, string> = {};
                        codeMatch.forEach((block, i) => {
                            const content = block.replace(/```\w*\n?/, '').replace(/```$/, '');
                            codeFiles[`file${i + 1}.ts`] = content;
                        });

                        specializedResult = await generateDocumentation(
                            codeFiles,
                            { architecture: 'Unknown', files: Object.keys(codeFiles).map(f => ({ path: f, purpose: 'Generated file', dependencies: [] })), dependencies: [] },
                            'typescript',
                            { format: 'markdown', includeExamples: true, includeAPI: true, includeDiagrams: false }
                        );
                        outputContent = specializedResult;
                        filesObject = { 'documentation.md': specializedResult };
                    } else {
                        // Generate project structure docs based on description
                        outputContent = `# 📄 Documentation Generator\n\nTo generate documentation, please provide your code in code blocks:\n\n\`\`\`typescript\n// Your code here\n\`\`\`\n\nOr upload files/paste code to analyze.`;
                    }
                    break;

                // =====================================================================
                // IMAGEGEN AGENT - Image generation (KilatDesign for mockups)
                // =====================================================================
                case 'imagegen':
                    console.log('🎨 Routing to ImageGen Agent (KilatDesign)');
                    await jobQueue.updateJob(jobId, { progress: 20, currentStep: '🎨 Generating UI mockup...' });
                    specializedResult = await generateImages({
                        mode: 'ui-mockup',
                        prompt: message,
                        userId: userId,
                        textModel: selectedModel
                    });
                    outputContent = `# 🎨 UI Mockup Generated!\n\n**Prompt:** ${message}\n\n**Optimized:** ${specializedResult.optimizedPrompt || message}\n\n![Generated Mockup](${specializedResult.images?.[0]?.url || ''})`;
                    break;

                // =====================================================================
                // KILATIMAGE AGENT - Pure Image Generation (Flux/Pollinations)
                // =====================================================================
                case 'kilatimage':
                    console.log('🎨 Routing to KilatImage Agent');
                    await jobQueue.updateJob(jobId, { progress: 20, currentStep: '🎨 Generating image...' });
                    specializedResult = await generateImages({
                        mode: 'text2image',
                        prompt: message,
                        userId: userId,
                        textModel: selectedModel // Forward user's text model for prompt optimization
                    });
                    outputContent = `# 🖼️ Image Generated!\n\n**Prompt:** ${message}\n\n**Optimized:** ${specializedResult.optimizedPrompt || message}\n\n![Generated Image](${specializedResult.images?.[0]?.url || ''})`;
                    break;

                // =====================================================================
                // CHAT AGENT - Conversational AI (NO code generation!)
                // =====================================================================
                case 'chat':
                    console.log('💬 Routing to Chat Agent (conversational)');
                    await jobQueue.updateJob(jobId, { progress: 20, currentStep: '💬 Processing chat...' });

                    // Use AI Mandor for conversational response (not kilatOS code gen)
                    const { aiMandor } = await import('@/lib/ai/mandor');
                    const chatResult = await aiMandor.call({
                        prompt: `You are KilatChat, a friendly and helpful AI assistant.
${LANGUAGE_RULES}
COMMUNICATION STYLE:
- Be conversational, warm, and helpful
- Answer questions clearly and concisely  
- DO NOT generate code files unless explicitly asked
- If user asks about coding, explain concepts without generating full files
- Suggest specialized agents when appropriate:
  - "For code generation, try KilatCode"
  - "For research, try KilatResearch"
  - "For security audits, try KilatAudit"

${conversationContext ? `Previous conversation and context:\n${conversationContext}\n\n` : ''}User question: ${message}`,
                        complexity: 'light',
                        priority: 'high',
                        userId: userId,
                        model: selectedModel
                    });

                    outputContent = chatResult.result;
                    // No files for chat - it's purely conversational!
                    filesObject = undefined;
                    break;

                // =====================================================================
                // CODEGEN and DEFAULT - Multi-agent orchestration via KilatOS
                // =====================================================================
                case 'codegen':
                case 'code':
                default:
                    console.log('💻 Routing to CodeGen (KilatOS multi-agent)');
                    result = await kilatOS.process(message, {
                        userId, // ✅ FIX: Pass authenticated user ID (not undefined)
                        sessionId: jobId,
                        conversationHistory, // ✨ INJECT CONTEXT ARRAY
                        selectedModel, // ✨ INJECT USER-SELECTED MODEL
                        executionMode: mode, // ✅ FIX 2026-01-16: Pass user's mode to app-registry for proper routing
                        onProgress: async (progress: number, currentStep: string) => {
                            await jobQueue.updateJob(jobId, {
                                progress,
                                currentStep
                            });
                        }
                    });

                    // Safely serialize outputContent
                    // FIX 2026-01-16: Use result.data.summary for conversational output (Planning mode)
                    if ((result as any).data?.summary) {
                        outputContent = (result as any).data.summary;  // ✅ Contains conversational greeting
                        console.log('📝 [Planning] Using conversational summary from result.data.summary');
                    } else if (typeof result.content === 'string') {
                        outputContent = result.content;
                    } else if (result.content) {
                        try {
                            outputContent = JSON.stringify(result.content, null, 2);
                        } catch {
                            outputContent = String(result.content);
                        }
                    }

                    // Extract files from result (Planning mode)
                    if ((result as any).data && typeof (result as any).data === 'object') {
                        const dataFiles = (result as any).data.files;
                        if (dataFiles && typeof dataFiles === 'object' && !Array.isArray(dataFiles)) {
                            filesObject = dataFiles;
                            console.log(`📁 [Planning] Extracted ${Object.keys(filesObject!).length} files from result.data.files`);
                        }
                    }

                    // Fallback: Check metadata.files (Legacy array format)
                    if (!filesObject && result.metadata?.files && Array.isArray(result.metadata.files)) {
                        filesObject = {};
                        result.metadata.files.forEach((f: any) => {
                            if (typeof f === 'string') {
                                filesObject![f] = '';
                            } else if (typeof f === 'object' && f.name) {
                                filesObject![f.name] = typeof f.content === 'string' ? f.content : '';
                            }
                        });
                        console.log(`📁 [Planning] Extracted ${Object.keys(filesObject).length} files from metadata.files (legacy)`);
                    }
                    break;
            }
        }  // END of mode branch


        if (process.env.NODE_ENV === 'development') {
            console.log('[AsyncRoute] Process Result:', {
                mode,
                hasFiles: !!filesObject,
                fileCount: filesObject ? Object.keys(filesObject).length : 0
            });
        }

        // =====================================================
        // FIX 2026-01-22: Check if orchestration actually succeeded
        // Before: Always marked "completed" even on failure
        // After: Check outputContent for error patterns
        // NOTE: Don't fail just because no files - chat agents don't produce files!
        // =====================================================
        const errorPatterns = [
            'orchestration failed',
            'Rate limit timeout',
            'Failed after 3 attempts',
            'Multi-agent orchestration failed'
        ];
        const hasErrorPattern = errorPatterns.some(p => outputContent?.includes(p));
        const isActuallyFailed = hasErrorPattern || !outputContent || outputContent.length < 10;

        const jobStatus = isActuallyFailed ? 'failed' : 'completed';
        const jobStep = isActuallyFailed ? 'Failed - see error message' : 'Done!';

        console.log(`📊 [Job] Final status: ${jobStatus}, hasFiles: ${!!filesObject}, hasError: ${hasErrorPattern}`);

        await jobQueue.updateJob(jobId, {
            status: jobStatus,
            progress: isActuallyFailed ? 99 : 100,
            currentStep: jobStep,
            outputContent: outputContent,
            files: filesObject,
            errorMessage: isActuallyFailed ? outputContent : undefined,
            metadata: { mode }  // Include mode in metadata for AI training
        });

        // =========================================================================
        // END REQUEST TRACE
        // =========================================================================
        await traceLogger.endTrace(traceId, isActuallyFailed ? 'error' : 'success', {
            file_count: filesObject ? Object.keys(filesObject).length : 0,
            error_message: isActuallyFailed ? outputContent.substring(0, 200) : undefined
        });

        // =========================================================================
        // SAVE RESPONSE TO SESSION MEMORY
        // Enables context carryover for next request
        //=========================================================================
        if (sessionId) {
            try {
                await hierarchicalMemory.addToImmediate(sessionId, {
                    role: 'assistant',
                    // Increased limit to 4000 to preserve full URLs (image URLs can be 300+ chars)
                    content: outputContent.substring(0, 4000),
                    timestamp: new Date(),
                    metadata: { hasFiles: !!filesObject, mode }
                }, undefined, client, agentType);
                console.log(`💾 Saved response to session memory (database, session: ${sessionId})`);

                // SAVE GENERATED FILES TO SESSION CONTEXT FOR HISTORY RELOAD
                if (filesObject && Object.keys(filesObject).length > 0) {
                    const supabaseClient = client || await createClient();
                    await supabaseClient
                        .from('sessions')
                        .update({
                            context: { files: filesObject },
                            updated_at: new Date().toISOString()
                        })
                        .eq('id', sessionId);
                    console.log(`📁 Saved ${Object.keys(filesObject).length} files to session context`);
                }
            } catch (error) {
                // Improved error logging for debugging (2026-01-18)
                console.error('❌ Failed to save assistant message to session memory:', {
                    sessionId,
                    agentType,
                    error: error instanceof Error ? error.message : String(error),
                    stack: error instanceof Error ? error.stack : undefined,
                    contentLength: outputContent?.length
                });
            }
        }

        // Log specific usage for analytics/history (mode-aware)
        try {
            const { usageTracker } = await import('@/lib/tracking/usage-tracker');

            console.log('📊 Attempting to log usage for job:', jobId, 'mode:', mode);

            const logResult = await usageTracker.logUsage({
                sessionId: jobId,
                userId: undefined,
                agentType: mode === 'fast' ? 'FastMode' : 'MultiAgent',
                taskInput: message,
                taskComplexity: mode === 'fast' ? 'medium' : 'heavy',

                aiProvider: 'pollinations',
                modelUsed: selectedModel, // ✨ Use actual user-selected model
                costUsd: 0,  // Pollinations is free

                baseTemplateUsed: mode === 'fast' ? 'fast-single-layer' : 'planning-multi-agent',
                enhancementsApplied: [],
                qualityChecksRun: mode === 'fast' ? [] : ['verifier'],

                priority: 'normal',
                success: true,
                outputText: outputContent,
                qualityScore: 80,
                validationPassed: true,

                latencyMs: Date.now() - Date.now(),  // Will be calculated properly
                tokensInput: 0,
                tokensOutput: Math.ceil(outputContent.length / 4)
            });

            console.log('✅ Usage logged successfully, request ID:', logResult);
        } catch (logError) {
            console.error('❌ Usage logging error:', logError);
        }

        // =========================================================================
        // END REQUEST TRACE - Finalize trace with success status
        // =========================================================================
        try {
            await traceLogger.endTrace(traceId, 'success', {
                file_count: filesObject ? Object.keys(filesObject).length : 0
            });
            console.log(`📊 Trace ended: ${traceId}`);
        } catch (traceEndError) {
            console.warn('⚠️ Trace end failed (non-blocking):', traceEndError);
        }

        // =========================================================================
        // ADAPTIVE LEARNING - Record execution for pattern learning
        // =========================================================================
        try {
            await recordAgentExecution(
                sessionId || jobId,
                userId, // Verified User ID (was anonymous)
                'codegen',
                {
                    success: true,
                    model: selectedModel, // ✨ Use actual user-selected model
                    executionTime: Date.now() - startTime,
                    cost: 0, // Pollinations is free
                    iterationCount: 1
                }
            );
            console.log('📊 Adaptive learning recorded');
        } catch (learnError) {
            // Non-blocking - don't fail the job if learning fails
            console.warn('⚠️ Learning record failed (non-blocking):', learnError);
        }

        // =========================================================================
        // PREFETCH - Pre-warm cache with predicted follow-ups
        // =========================================================================
        try {
            await prefetchRelatedPatterns(sessionId || jobId, message);
            // Also cache the embedding for this query for semantic matching
            await semanticCache.addEmbedding(message);
        } catch (prefetchError) {
            // Non-blocking
            console.warn('⚠️ Prefetch failed (non-blocking):', prefetchError);
        }

        // =========================================================================
        // CHAT-TO-RAG SYNC - Store successful conversations for RAG search
        // =========================================================================
        try {
            const { runIncrementalSync } = await import('@/lib/learning/chat-to-rag');
            // Non-blocking: Fire-and-forget for latency
            runIncrementalSync().then(result => {
                if (result.synced > 0) {
                    console.log(`📚 RAG Sync: ${result.synced} conversations synced`);
                }
            }).catch(err => {
                console.warn('⚠️ RAG sync failed (non-blocking):', err);
            });
        } catch (ragError) {
            console.warn('⚠️ RAG sync import failed (non-blocking):', ragError);
        }

        console.log(`✅ Job completed: ${jobId} (mode: ${mode})`);

    } catch (error) {
        console.error(`❌ Job failed: ${jobId}`, error);

        // End trace with failure status
        try {
            await traceLogger.endTrace(traceId, 'error', {
                error_message: error instanceof Error ? error.message : 'Unknown error'
            });
        } catch (traceEndError) {
            console.warn('⚠️ Trace end (failure) failed:', traceEndError);
        }

        await jobQueue.updateJob(jobId, {
            status: 'failed',
            progress: 100,
            errorMessage: error instanceof Error ? error.message : 'Unknown error'
        });
    }
}
