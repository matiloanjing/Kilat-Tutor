'use client';
/**
 * KilatCode - Code Generation IDE
 * 
 * Project-based code generation with:
 * - IconNav (left 64px sidebar)
 * - ChatPanel (380px chat area) 
 * - PreviewHeader + WorkspacePanel (main content)
 * 
 * URL: /kilatcode/c/[id]
 * Project ID comes from URL param, not localStorage
 * 
 * Copyright © 2026 KilatCode Studio
 */

import { useState, useCallback, useEffect, use } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/AuthProvider';
import { useQuota } from '@/hooks/useQuota';
import IconNav from '@/components/ui/IconNav';
import { ChatPanel } from '@/components/ui/ChatPanel';
import WorkspacePanel from '@/components/WorkspacePanel';
import { GlobalHeader } from '@/components/ui/GlobalHeader';
import { ExplorerPanel } from '@/components/ui/ExplorerPanel';
import { LoadingKilat } from '@/components/ui/LoadingKilat';
import { ProcessingSteps } from '@/components/ui/ProcessingSteps';
import { AgentSuggestionPanel } from '@/components/agents/AgentSuggestionPanel';
import { getPostTaskSuggestions, AGENT_ROUTES, type AgentSuggestion } from '@/lib/agents/post-task-suggestions';

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
    agent?: string;
    status?: 'pending' | 'streaming' | 'complete' | 'error';
    steps?: { label: string; status: 'done' | 'active' | 'pending' }[];
}

interface PageProps {
    params: { id: string };
}

export default function KilatCodePage({ params }: PageProps) {
    const router = useRouter();
    const { user, loading, signOut } = useAuth();

    // Access params directly (Next.js 14 sync params)
    const projectId = params.id;

    // Chat State
    const [messages, setMessages] = useState<Message[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [chatMode, setChatMode] = useState<'planning' | 'fast'>('planning');
    const [selectedModel, setSelectedModel] = useState('gemini-fast');
    const [availableModels, setAvailableModels] = useState<any[]>([]);

    // Workspace State
    const [previewProjectId, setPreviewProjectId] = useState<string | null>(null);
    const [generatedFiles, setGeneratedFiles] = useState<Record<string, string> | null>(null);
    const [projectName, setProjectName] = useState('my-project');
    const [viewMode, setViewMode] = useState<'preview' | 'code'>('preview');

    // UI State for IDE Layout
    const [isChatCollapsed, setIsChatCollapsed] = useState(false);
    const [isExplorerCollapsed, setIsExplorerCollapsed] = useState(false);
    const [activeFile, setActiveFile] = useState<string | null>(null);

    // Quota State - using useQuota hook for automatic fetching
    const [quota] = useQuota(user?.id, 'code');
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);

    // Post-Task Suggestions (Cross-Agent Workflow)
    const [suggestions, setSuggestions] = useState<AgentSuggestion[]>([]);

    // Progress Tracking (Claude Code-style)
    const [currentStep, setCurrentStep] = useState<string>('Starting...');
    const [stepHistory, setStepHistory] = useState<string[]>([]);
    const [jobProgress, setJobProgress] = useState<number>(0);

    // Handle file changes from Monaco editor (auto-save)
    const handleFileChange = useCallback((filename: string, content: string) => {
        setGeneratedFiles(prev => {
            if (!prev) return { [filename]: content };
            return { ...prev, [filename]: content };
        });
        console.log(`[KilatCode] File saved: ${filename}`);
    }, []);

    // Load project messages on mount (using URL projectId)
    useEffect(() => {
        if (projectId) {
            loadProjectMessages(projectId);
            // FIX 2026-01-30: Resume polling for in-progress jobs after page refresh
            resumeActiveJob(projectId);
        }
    }, [projectId]);

    // FIX 2026-01-30: Resume polling for active jobs on page load
    const resumeActiveJob = async (sessionId: string) => {
        const savedJobId = localStorage.getItem(`kilat_active_job_${sessionId}`);
        if (!savedJobId) return;

        console.log('🔄 [KilatCode] Checking for active job:', savedJobId);

        try {
            const statusRes = await fetch(`/api/kilat/status?jobId=${savedJobId}`);
            const statusData = await statusRes.json();
            const job = statusData.job;

            if (job?.status === 'processing' || job?.status === 'pending') {
                console.log('▶️ [KilatCode] Resuming active job at', job.progress, '%');
                setIsProcessing(true);
                setJobProgress(job.progress || 0);
                setCurrentStep(job.currentStep || 'Resuming...');

                // Add placeholder assistant message
                const resumeMessage: Message = {
                    id: `msg_resume_${Date.now()}`,
                    role: 'assistant',
                    content: '🔄 Resuming in-progress job...',
                    timestamp: Date.now(),
                    agent: 'KilatCode',
                    status: 'streaming',
                };
                setMessages(prev => [...prev, resumeMessage]);

                // Continue polling
                pollJobStatus(savedJobId, resumeMessage.id);
            } else if (job?.status === 'completed') {
                // Job completed while away - load results
                console.log('✅ [KilatCode] Job completed while away, loading results');
                localStorage.removeItem(`kilat_active_job_${sessionId}`);
                if (job.result?.files) {
                    setGeneratedFiles(job.result.files);
                }
            } else if (job?.status === 'failed') {
                // Job failed - show error to user
                console.log('❌ [KilatCode] Job failed:', job.error);
                localStorage.removeItem(`kilat_active_job_${sessionId}`);

                const failedMessage: Message = {
                    id: `msg_failed_${Date.now()}`,
                    role: 'assistant',
                    content: `❌ Previous job failed: ${job.error || 'Unknown error'}. Please try again.`,
                    timestamp: Date.now(),
                    agent: 'KilatCode',
                    status: 'error',
                };
                setMessages(prev => [...prev, failedMessage]);
            } else {
                // Job not found or other status - cleanup
                localStorage.removeItem(`kilat_active_job_${sessionId}`);
            }
        } catch (error) {
            console.error('❌ [KilatCode] Failed to resume job:', error);
            localStorage.removeItem(`kilat_active_job_${sessionId}`);
        }
    };

    // Extracted polling logic for reuse
    const pollJobStatus = async (jobId: string, assistantMessageId: string) => {
        let completed = false;
        let pollCount = 0;
        const maxPolls = 300;

        while (!completed && pollCount < maxPolls) {
            await new Promise(r => setTimeout(r, 1000));
            pollCount++;

            try {
                const statusRes = await fetch(`/api/kilat/status?jobId=${jobId}`);
                const statusData = await statusRes.json();
                const job = statusData.job;

                if (job?.status === 'completed') {
                    completed = true;
                    localStorage.removeItem(`kilat_active_job_${projectId}`);

                    setMessages(prev => prev.map(m =>
                        m.id === assistantMessageId
                            ? {
                                ...m,
                                content: job.result?.content || 'Generation complete!',
                                status: 'complete' as const,
                            }
                            : m
                    ));

                    const files = job.result?.files;
                    if (files && Object.keys(files).length > 0) {
                        setGeneratedFiles(files);
                        const projectName = job.result?.metadata?.projectName;
                        if (projectName) {
                            setProjectName(projectName);
                        }
                    }
                    setIsProcessing(false);
                } else if (job?.status === 'failed') {
                    completed = true;
                    localStorage.removeItem(`kilat_active_job_${projectId}`);
                    setMessages(prev => prev.map(m =>
                        m.id === assistantMessageId
                            ? {
                                ...m,
                                content: `❌ Error: ${job.error || 'Job failed'}`,
                                status: 'error' as const,
                            }
                            : m
                    ));
                    setIsProcessing(false);
                } else {
                    // Update progress
                    const progress = job?.progress || 0;
                    const step = job?.currentStep || 'Processing...';
                    setJobProgress(progress);
                    if (step !== currentStep) {
                        setCurrentStep(step);
                        setStepHistory(prev => {
                            if (prev[prev.length - 1] !== step) {
                                return [...prev.slice(-20), step];
                            }
                            return prev;
                        });
                    }
                }
            } catch (error) {
                console.error('Polling error:', error);
            }
        }
    };

    // Function to load messages from a project
    const loadProjectMessages = async (targetProjectId: string) => {
        console.log('📥 [KilatCode] Loading project:', targetProjectId);
        try {
            const res = await fetch(`/api/kilat/sessions/${targetProjectId}`);
            const data = await res.json();

            if (data.success && data.messages && data.messages.length > 0) {
                interface BackendMessage {
                    id: string;
                    role: 'user' | 'assistant';
                    content: string;
                    timestamp: string;
                    agent?: string;
                }
                const history: Message[] = (data.messages as BackendMessage[]).map(m => ({
                    id: m.id,
                    role: m.role,
                    content: m.content,
                    timestamp: new Date(m.timestamp).getTime(),
                    agent: m.agent,
                    status: 'complete'
                }));
                setMessages(history);
                console.log('✅ [KilatCode] Loaded', history.length, 'messages');

                // Set project name from session title
                if (data.session?.title && data.session.title !== 'New Chat') {
                    setProjectName(data.session.title);
                }

                // Load files if stored in session context
                if (data.files && Object.keys(data.files).length > 0) {
                    setGeneratedFiles(data.files);
                    setActiveFile(Object.keys(data.files)[0]);
                } else {
                    // FALLBACK: Parse code blocks from assistant messages
                    const extractedFiles: Record<string, string> = {};
                    const assistantMessages = history.filter(m => m.role === 'assistant');

                    for (const msg of assistantMessages) {
                        const codeBlockRegex = /```(\w+)?\s*(?:\/\/\s*)?([^\n`]+\.[a-z]+)?[\s\n]([\s\S]*?)```/g;
                        let match;

                        while ((match = codeBlockRegex.exec(msg.content)) !== null) {
                            const [, lang, filePath, code] = match;
                            if (filePath && code.trim()) {
                                const cleanPath = filePath.replace(/^\/+/, '').trim();
                                extractedFiles[cleanPath] = code.trim();
                            } else if (code.trim() && !filePath) {
                                const ext = lang === 'tsx' ? 'tsx' : lang === 'typescript' ? 'ts' : lang === 'javascript' ? 'js' : lang || 'txt';
                                const fileName = `generated.${ext}`;
                                if (!extractedFiles[fileName]) {
                                    extractedFiles[fileName] = code.trim();
                                }
                            }
                        }
                    }

                    if (Object.keys(extractedFiles).length > 0) {
                        setGeneratedFiles(extractedFiles);
                        setActiveFile(Object.keys(extractedFiles)[0]);
                    }
                }
            }
        } catch (error) {
            console.error('❌ [KilatCode] Failed to load project:', error);
        }
    };

    // Fetch available models and user tier
    useEffect(() => {
        const fetchModels = async () => {
            try {
                const res = await fetch('/api/models');
                const data = await res.json();
                if (data.success) {
                    setAvailableModels(data.models);
                    // Note: tier is handled by useQuota hook via /api/kilat/usage

                    if (data.selected) {
                        setSelectedModel(data.selected);
                    } else if (data.models.length > 0) {
                        const defaultModel = data.models.find((m: any) => m.model_id === 'gemini-fast') || data.models[0];
                        setSelectedModel(defaultModel.model_id);
                    }
                }
            } catch (error) {
                console.error('Failed to fetch models:', error);
            }
        };

        if (user) {
            fetchModels();
        }
    }, [user]);

    // Redirect to login if not authenticated
    useEffect(() => {
        if (!loading && !user) {
            router.push('/login');
        }
    }, [user, loading, router]);

    // Post-Task Suggestions: Show after code generation completes
    useEffect(() => {
        if (!isProcessing && generatedFiles && Object.keys(generatedFiles).length > 0) {
            // Delay slightly for smooth UX
            const timer = setTimeout(() => {
                setSuggestions(getPostTaskSuggestions('codegen'));
            }, 500);
            return () => clearTimeout(timer);
        }
    }, [isProcessing, generatedFiles]);

    // Handle sending message
    const handleSendMessage = useCallback(async (content: string, attachments?: { type: 'image' | 'document'; name: string; base64: string }[]) => {
        if ((!content.trim() && (!attachments || attachments.length === 0)) || isProcessing) return;

        const userMessage: Message = {
            id: `msg_${Date.now()}`,
            role: 'user',
            content: attachments?.length ? `${content}${attachments.length > 0 ? ` [${attachments.length} attachment(s)]` : ''}` : content,
            timestamp: Date.now(),
        };

        setMessages(prev => [...prev, userMessage]);
        setIsProcessing(true);

        // CRITICAL FIX 2026-01-22: Clear old files when sending new prompt
        // This prevents stale files from previous job showing while new job processes
        setGeneratedFiles(null);
        setSuggestions([]);

        // Reset progress tracking for new job
        setCurrentStep('Starting...');
        setStepHistory([]);
        setJobProgress(0);

        const assistantMessage: Message = {
            id: `msg_${Date.now()}_assistant`,
            role: 'assistant',
            content: chatMode === 'planning'
                ? '🚀 Starting multi-agent orchestration...\n\nThis may take 2-5 minutes.'
                : '⚡ Processing with Fast Mode...',
            timestamp: Date.now(),
            agent: chatMode === 'planning' ? 'KilatCode (Multi-Agent)' : 'KilatCode (Fast)',
            status: 'streaming',
            // FIX 2026-01-24: Removed duplicate steps - now using ProcessingSteps component only
        };
        setMessages(prev => [...prev, assistantMessage]);

        try {
            const submitRes = await fetch('/api/kilat/async', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: content,
                    userId: user!.id,
                    sessionId: projectId, // Use URL projectId
                    mode: chatMode,
                    model: selectedModel,
                    agentType: 'codegen', // Explicit agent type for KilatCode
                    attachments, // NEW: Pass attachments to backend
                }),
            });

            if (submitRes.status === 401) {
                await signOut();
                router.push('/login');
                return;
            }

            const submitData = await submitRes.json();
            if (!submitData.success || !submitData.jobId) {
                throw new Error(submitData.error || 'Failed to submit job');
            }

            const jobId = submitData.jobId;

            // FIX 2026-01-30: Save jobId to localStorage for resume on refresh
            localStorage.setItem(`kilat_active_job_${projectId}`, jobId);

            // Poll for status using extracted function
            await pollJobStatus(jobId, assistantMessage.id);
        } catch (error) {
            console.error('Chat error:', error);
            setMessages(prev => prev.map(m =>
                m.id === assistantMessage.id
                    ? {
                        ...m,
                        content: `❌ Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
                        status: 'error' as const,
                    }
                    : m
            ));
        } finally {
            setIsProcessing(false);
        }
    }, [isProcessing, chatMode, projectId, selectedModel, user?.id, currentStep, pollJobStatus]);



    // Handle publish
    const handlePublish = async () => {
        if (!generatedFiles || Object.keys(generatedFiles).length === 0) {
            alert('No files to publish. Generate some code first!');
            return;
        }

        try {
            const response = await fetch('/api/kilat/deploy', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectName, files: generatedFiles }),
            });
            const data = await response.json();
            if (data.projectId) {
                setPreviewProjectId(data.projectId);
            }
        } catch (error) {
            console.error('Deploy failed:', error);
        }
    };

    // Handle project switching (navigates to different URL)
    const handleProjectSelect = async (newProjectId: string) => {
        router.push(`/kilatcode/c/${newProjectId}`);
    };

    // Handle new project (generate UUID and navigate)
    const handleNewProject = useCallback(() => {
        const newId = crypto.randomUUID();
        router.push(`/kilatcode/c/${newId}`);
    }, [router]);

    const handleModelChange = useCallback(async (modelId: string) => {
        setSelectedModel(modelId);
        try {
            await fetch('/api/models', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ modelId })
            });
        } catch (e) {
            console.error('Failed to save model preference:', e);
        }
    }, []);

    const handleToggleChat = useCallback(() => {
        setIsChatCollapsed(prev => !prev);
    }, []);

    const handleToggleExplorer = useCallback(() => {
        setIsExplorerCollapsed(prev => !prev);
    }, []);

    // AI Learning: Feedback handler
    const handleFeedback = useCallback(async (messageId: string, rating: 'good' | 'bad') => {
        try {
            const res = await fetch('/api/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messageId,
                    sessionId: projectId,
                    rating,
                    agentType: 'codegen',
                    modelUsed: selectedModel,
                    userId: user?.id
                })
            });

            const data = await res.json();
            if (data.success) {
                console.log(`✅ Feedback submitted: ${rating}`);
            } else {
                console.error('❌ Feedback failed:', data.error);
            }
        } catch (error) {
            console.error('❌ Feedback error:', error);
        }
    }, [projectId, selectedModel, user?.id]);

    // AI Learning: Regenerate handler
    const handleRegenerate = useCallback(async (messageId: string) => {
        try {
            // 1. Log regenerate event for AI learning
            await fetch('/api/kilat/regenerate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messageId,
                    sessionId: projectId,
                    agentType: 'codegen',
                    reason: 'User clicked regenerate button'
                })
            });

            // 2. Find the user message before this assistant message
            const msgIndex = messages.findIndex(m => m.id === messageId);
            if (msgIndex > 0) {
                const userMessage = messages[msgIndex - 1];
                if (userMessage.role === 'user') {
                    console.log('🔄 Regenerating response...');
                    // Re-trigger generation with same prompt
                    await handleSendMessage(userMessage.content);
                }
            }
        } catch (error) {
            console.error('❌ Regenerate error:', error);
        }
    }, [messages, projectId, handleSendMessage]);

    // Copy handler (for analytics)
    const handleCopy = useCallback((content: string) => {
        console.log('✂️ Content copied to clipboard');
        // Optional: track copy events for future analytics
    }, []);


    if (loading) {
        return (
            <div className="h-screen w-screen bg-obsidian flex items-center justify-center">
                <LoadingKilat />
            </div>
        );
    }

    return (
        <div className="flex flex-col h-screen overflow-hidden bg-background-dark font-sans text-slate-200">
            <GlobalHeader
                onPublish={handlePublish}
                projectName={projectName}
            />

            <main className="flex flex-1 overflow-hidden relative">
                <IconNav />

                <ChatPanel
                    sessionId={projectId}
                    messages={messages}
                    isProcessing={isProcessing}
                    chatMode={chatMode}
                    selectedModel={selectedModel}
                    onSendMessage={handleSendMessage}
                    onModeChange={setChatMode}
                    onModelChange={handleModelChange}
                    onFeedback={handleFeedback}
                    onRegenerate={handleRegenerate}
                    onCopy={handleCopy}
                    quota={quota}
                    availableModels={availableModels}
                    onSessionSelect={handleProjectSelect}
                    onNewChat={handleNewProject}
                    isCollapsed={isChatCollapsed}
                    onToggleCollapse={handleToggleChat}
                    agentType="codegen"
                    generatedFileCount={generatedFiles ? Object.keys(generatedFiles).length : 0}
                    currentStep={currentStep}
                    progress={jobProgress}
                    stepHistory={stepHistory}
                />

                {/* Post-Task Agent Suggestions (Cross-Agent Workflow) */}
                {suggestions.length > 0 && !isChatCollapsed && (
                    <div className="absolute bottom-20 left-[64px] z-50 w-[360px] px-4">
                        <AgentSuggestionPanel
                            suggestions={suggestions}
                            onAccept={(agent) => {
                                const route = AGENT_ROUTES[agent] || agent;
                                router.push(`/${route}/c/${projectId}`);
                            }}
                            onSkip={() => setSuggestions([])}
                        />
                    </div>
                )}

                {/* Claude Code-style Progress Display - MOVED TO CHATPANEL */}

                <ExplorerPanel
                    files={generatedFiles || {}}
                    activeFile={activeFile}
                    onFileSelect={setActiveFile}
                    isCollapsed={isExplorerCollapsed}
                    onToggleCollapse={handleToggleExplorer}
                />

                <div className="flex-1 flex flex-col min-w-0 bg-background-dark/30">
                    <WorkspacePanel
                        projectId={previewProjectId}
                        files={generatedFiles}
                        activeFile={activeFile}
                        onFileChange={handleFileChange}
                        onServerReady={setPreviewUrl}
                        className="h-full border-none"
                    />
                </div>
            </main>
        </div>
    );
}
