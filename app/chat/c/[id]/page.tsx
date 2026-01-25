'use client';
/**
 * Chat Session Page - Dynamic Route with Session ID
 * 
 * URL: /chat/c/[id]
 * Session ID comes from URL param (like ChatGPT/KilatCode)
 * 
 * Copyright © 2026 KilatCode Studio
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/AuthProvider';
import { LoadingKilat } from '@/components/ui/LoadingKilat';
import { GlobalHeader } from '@/components/ui/GlobalHeader';
import IconNav from '@/components/ui/IconNav';
import { AgentModeToggle } from '@/components/agents/AgentModeToggle';
import { AgentSuggestionPanel } from '@/components/agents/AgentSuggestionPanel';
import { AgentMode } from '@/lib/agents/router';
import { useDebounce } from 'use-debounce';
import { useQuota } from '@/hooks/useQuota';

import ChatSidebar from '@/components/ChatSidebar';
import { ModelSelector } from '@/components/ModelSelector';
import { ModeToggle, ChatMode } from '@/components/ModeToggle';
import type { UserTier } from '@/lib/auth/user-tier';
import {
    AttachmentBadge,
    AttachmentMenu,
    createAttachedFile,
    AttachedFile,
    ACCEPTED_IMAGE_TYPES,
    ACCEPTED_DOC_TYPES
} from '@/components/ui/AttachmentBadge';
import { ProcessingSteps } from '@/components/ui/ProcessingSteps';


const AGENTS = [
    { id: 'chat', name: 'KilatChat', icon: 'chat' },
    { id: 'research', name: 'KilatResearch', icon: 'search' },
    { id: 'cowriter', name: 'KilatWrite', icon: 'edit_note' },
    { id: 'solve', name: 'KilatSolve', icon: 'calculate' },
    { id: 'question', name: 'KilatQuestion', icon: 'quiz' },
    { id: 'guide', name: 'KilatGuide', icon: 'auto_stories' },
    { id: 'ideagen', name: 'KilatIdea', icon: 'lightbulb' },
    { id: 'crawl', name: 'KilatCrawl', icon: 'language' },
    { id: 'imagegen', name: 'KilatDesign', icon: 'palette' }, // UI Design
    // NOTE: kilatimage is a SHADOW AGENT - not in dropdown, auto-routes via detectImageRequest()
    { id: 'audit', name: 'KilatAudit', icon: 'bug_report' },
    { id: 'docs', name: 'KilatDocs', icon: 'menu_book' },
    { id: 'codegen', name: 'KilatCode', icon: 'code' },
];

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
    agent?: string;
    status?: 'pending' | 'streaming' | 'complete' | 'error';
    imageUrl?: string;
}

// ============================================================================
// Helper: Detect if user wants to generate an ACTUAL image
// ============================================================================
const IMAGE_TRIGGERS = [
    'gambar', 'foto', 'image', 'ilustrasi', 'illustration',
    'logo', 'banner', 'thumbnail', 'poster', 'art', 'seni',
    'buat gambar', 'generate image', 'create image', 'draw', 'sketch',
    'grafis', 'graphic', 'visual', 'wallpaper', 'icon', 'avatar',
    'picture', 'painting', 'artwork', 'render'
];

// Pattern-based detection for descriptive visual prompts
const VISUAL_SCENE_PATTERNS = [
    // Fantasy/Anime styles
    /\b(anime|manga|chibi|ghibli|cartoon)\b/i,
    /\b(fantasy|medieval|magical|enchanted|mystical)\b.*\b(scene|world|village|castle|forest|market)\b/i,
    /\b(cyberpunk|steampunk|sci-?fi|futuristic)\b.*\b(city|scene|world|street)\b/i,
    // Realistic/Photo styles  
    /\b(realistic|photorealistic|cinematic|dramatic)\b.*\b(portrait|scene|landscape|shot)\b/i,
    /\b(photo|photograph)\s+(of|depicting)\b/i,
    // Character descriptions
    /\b(character|person|woman|man|girl|boy|creature|monster|dragon|elf|goblin)\b.*\b(with|wearing|holding|standing|sitting)\b/i,
    // Scene/Environment descriptions (standalone)
    /\b(bustling|serene|dark|bright|colorful|vibrant)\b.*\b(scene|market|village|city|forest|landscape)\b/i,
    // Direct scene descriptions often used for images
    /^a\s+(fantasy|medieval|modern|ancient|futuristic)\b/i,
    // "of" patterns common in image prompts
    /\b(depiction|scene|view|portrait|illustration|image)\s+of\b/i,
    // Species/creature focused (common in AI art prompts)
    /\b(elves?|goblins?|trolls?|orcs?|dwarve?s?|fairies?|unicorns?|dragons?)\b.*\b(in|at|with|doing)\b/i
];

const DESIGN_EXCLUSIONS = [
    'website', 'web', 'html', 'css', 'ui', 'ux', 'component', 'komponen',
    'layout', 'page', 'halaman', 'button', 'tombol', 'form', 'navbar',
    'sidebar', 'footer', 'header', 'card', 'modal', 'dashboard', 'aplikasi',
    'app', 'frontend', 'landing page', 'interface', 'react', 'tailwind',
    'code', 'kode', 'function', 'fungsi', 'api', 'database', 'backend'
];

function detectImageRequest(input: string): boolean {
    const lowerInput = input.toLowerCase();

    // Check exclusions first (code/web requests)
    const hasExclusion = DESIGN_EXCLUSIONS.some(ex => lowerInput.includes(ex));
    if (hasExclusion) return false;

    // Check explicit image triggers
    const hasExplicitTrigger = IMAGE_TRIGGERS.some(trigger => lowerInput.includes(trigger));
    if (hasExplicitTrigger) return true;

    // Check visual scene patterns (descriptive prompts)
    const matchesVisualPattern = VISUAL_SCENE_PATTERNS.some(pattern => pattern.test(lowerInput));
    if (matchesVisualPattern) {
        console.log('🖼️ [Image Detection] Visual pattern matched:', input.substring(0, 50) + '...');
        return true;
    }

    return false;
}

// ============================================================================
// Helper: Render content with image support
// ============================================================================
function renderContent(content: string): React.ReactNode {
    const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
    // Updated regex to support standard extensions AND Pollinations URLs
    const urlImageRegex = /(https?:\/\/(?:[^\s]+\.(?:png|jpg|jpeg|gif|webp)|gen\.pollinations\.ai\/image\/[^\s]+))/gi;

    const parts: Array<{ type: 'text' | 'image'; content: string; alt?: string }> = [];
    let lastIndex = 0;
    let match;

    while ((match = imageRegex.exec(content)) !== null) {
        if (match.index > lastIndex) {
            parts.push({ type: 'text', content: content.slice(lastIndex, match.index) });
        }
        parts.push({ type: 'image', content: match[2], alt: match[1] });
        lastIndex = match.index + match[0].length;
    }

    if (lastIndex < content.length) {
        const remaining = content.slice(lastIndex);
        const urlMatch = remaining.match(urlImageRegex);
        if (urlMatch) {
            parts.push({ type: 'text', content: remaining.replace(urlMatch[0], '') });
            parts.push({ type: 'image', content: urlMatch[0], alt: 'Generated' });
        } else {
            parts.push({ type: 'text', content: remaining });
        }
    }

    if (parts.length === 0) {
        return <span className="whitespace-pre-wrap">{content}</span>;
    }

    return (
        <>
            {parts.map((part, index) => {
                if (part.type === 'image') {
                    return (
                        <div key={index} className="my-3">
                            <img
                                src={part.content}
                                alt={part.alt || 'Generated image'}
                                className="max-w-full h-auto rounded-lg border border-white/10"
                                loading="lazy"
                                onError={(e) => {
                                    const img = e.target as HTMLImageElement;
                                    if (!img.dataset.retried) {
                                        img.dataset.retried = 'true';
                                        img.src = part.content + (part.content.includes('?') ? '&' : '?') + 't=' + Date.now();
                                    }
                                }}
                            />
                            <a
                                href={part.content}
                                download
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-block mt-2 px-3 py-1 text-xs bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 rounded-lg"
                            >
                                📥 Download
                            </a>
                        </div>
                    );
                }
                return <span key={index} className="whitespace-pre-wrap">{part.content}</span>;
            })}
        </>
    );
}

interface PageProps {
    params: { id: string };
}

export default function ChatSessionPage({ params }: PageProps) {
    const router = useRouter();
    const { user, loading, signOut } = useAuth();

    // ✅ Session ID from URL params (like KilatCode)
    const sessionId = params.id;

    const [messages, setMessages] = useState<Message[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [inputValue, setInputValue] = useState('');
    const [selectedModel, setSelectedModel] = useState('gemini-fast');
    const [agentMode, setAgentMode] = useState<AgentMode>('recommended');
    const [chatMode, setChatMode] = useState<ChatMode>('fast');
    const [agentType, setAgentType] = useState('chat');
    const [userTier, setUserTier] = useState<UserTier>('free');
    const [sidebarOpen, setSidebarOpen] = useState(true);
    const [sessionTitle, setSessionTitle] = useState('New Chat');

    // Progress Tracking
    const [currentStep, setCurrentStep] = useState<string>('Starting...');
    const [stepHistory, setStepHistory] = useState<string[]>([]);
    const [jobProgress, setJobProgress] = useState<number>(0);

    // Quota tracking - fetch from API
    const [quota] = useQuota(user?.id, 'code');

    const [suggestions, setSuggestions] = useState<any[]>([]);
    const [debouncedInput] = useDebounce(inputValue, 800);

    // Attachment state
    const [attachments, setAttachments] = useState<AttachedFile[]>([]);
    const [isAttachmentMenuOpen, setIsAttachmentMenuOpen] = useState(false);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const docInputRef = useRef<HTMLInputElement>(null);

    // Handle file selection
    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files) return;

        for (const file of Array.from(files)) {
            const attached = await createAttachedFile(file);
            setAttachments(prev => [...prev, attached]);
        }
        e.target.value = ''; // Reset input
    };

    const removeAttachment = (index: number) => {
        setAttachments(prev => prev.filter((_, i) => i !== index));
    };

    // Message ratings state for AI training
    const [messageRatings, setMessageRatings] = useState<Record<string, 'good' | 'bad'>>({});

    // Handle user feedback (👍/👎)
    const handleFeedback = async (messageId: string, rating: 'good' | 'bad') => {
        setMessageRatings(prev => ({ ...prev, [messageId]: rating }));
        try {
            await fetch('/api/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messageId,
                    sessionId,
                    rating,
                    agentType: agentType || 'chat',
                    modelUsed: selectedModel,
                    userId: user?.id
                }),
            });
            console.log(`✅ Feedback: ${rating} for ${messageId}`);
        } catch (e) {
            console.error('Feedback failed:', e);
        }
    };

    // Handle regenerate response
    const handleRegenerate = async (messageId: string) => {
        const msgIndex = messages.findIndex(m => m.id === messageId);
        if (msgIndex <= 0) return;
        const userMsg = messages[msgIndex - 1];
        if (userMsg.role !== 'user') return;

        // Log regenerate event for AI training
        try {
            await fetch('/api/kilat/regenerate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messageId,
                    sessionId: sessionId,
                    agentType: agentType || 'general',
                    reason: 'User clicked regenerate'
                }),
            });
            console.log('🔄 Regenerate event logged');
        } catch (e) {
            console.warn('Failed to log regenerate event:', e);
        }

        // Remove old response and re-submit
        setMessages(prev => prev.slice(0, msgIndex));
        setInputValue(userMsg.content);
    };

    // AbortController for Stop functionality
    const abortControllerRef = useRef<AbortController | null>(null);

    // Handle Stop generation
    const handleStop = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        setIsProcessing(false);
        // Update last message to show it was stopped
        setMessages(prev => {
            const last = prev[prev.length - 1];
            if (last && last.role === 'assistant' && last.status === 'streaming') {
                return prev.map((m, i) =>
                    i === prev.length - 1 ? { ...m, content: m.content + '\n\n⏹️ *Generation stopped*', status: 'complete' as const } : m
                );
            }
            return prev;
        });
    };

    // Fetch user tier and models
    useEffect(() => {
        const fetchModelsAndTier = async () => {
            try {
                const res = await fetch('/api/models?type=text');
                if (res.ok) {
                    const data = await res.json();
                    if (data.userTier) setUserTier(data.userTier);
                    if (data.selected) setSelectedModel(data.selected);
                }
            } catch (e) {
                console.warn('[Chat] Failed to fetch models');
            }
        };
        if (user) fetchModelsAndTier();
    }, [user]);

    // ✅ Load session messages and title on mount
    useEffect(() => {
        const loadSession = async () => {
            if (!sessionId) return;

            try {
                // Load messages
                const historyRes = await fetch(`/api/kilat/history?sessionId=${sessionId}`);
                if (historyRes.ok) {
                    const data = await historyRes.json();
                    if (data.messages) {
                        setMessages(data.messages.map((m: any) => ({
                            id: m.id || `msg_${Date.now()}_${Math.random()}`,
                            role: m.role,
                            content: m.content,
                            timestamp: new Date(m.timestamp || m.created_at).getTime(),
                            status: 'complete'
                        })));
                    }
                }

                // Load session title
                const sessionsRes = await fetch('/api/kilat/sessions');
                if (sessionsRes.ok) {
                    const sessData = await sessionsRes.json();
                    const currentSession = sessData.sessions?.find((s: any) => s.id === sessionId);
                    if (currentSession?.title) {
                        setSessionTitle(currentSession.title);
                    }
                }
            } catch (e) {
                console.error('[Chat] Failed to load session');
            }
        };

        if (user) loadSession();
    }, [sessionId, user]);

    // Fetch suggestions
    useEffect(() => {
        if (agentMode !== 'recommended' || !debouncedInput || debouncedInput.length < 5) {
            setSuggestions([]);
            return;
        }

        const fetchSuggestions = async () => {
            try {
                const res = await fetch('/api/kilat/suggest', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ message: debouncedInput, currentAgent: agentType })
                });
                if (res.ok) {
                    const data = await res.json();
                    setSuggestions(data.suggestions?.filter((s: any) => s.agent !== agentType) || []);
                }
            } catch (e) { /* silent */ }
        };
        fetchSuggestions();
    }, [debouncedInput, agentMode, agentType]);

    const handleAcceptSuggestion = (agentId: string) => {
        setAgentType(agentId);
        setSuggestions([]);
    };

    // ✅ Navigate to session via URL
    const handleSessionSelect = (newSessionId: string) => {
        router.push(`/chat/c/${newSessionId}`);
    };

    // ✅ Create new session and navigate
    const handleNewSession = async () => {
        try {
            const res = await fetch('/api/kilat/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ title: 'New Chat' })
            });
            if (res.ok) {
                const data = await res.json();
                if (data.session) {
                    router.push(`/chat/c/${data.session.id}`);
                }
            }
        } catch (e) {
            console.error('[Chat] Failed to create session');
        }
    };

    // Redirect if not authenticated
    useEffect(() => {
        if (!loading && !user) {
            router.push('/login');
        }
    }, [user, loading, router]);

    // Handle send message
    const handleSend = useCallback(async () => {
        if ((!inputValue.trim() && attachments.length === 0) || isProcessing) return;

        // Convert attachments to format with base64 for backend
        const attachmentData = attachments.map(att => ({
            type: att.type,
            name: att.file.name,
            base64: att.preview || ''
        }));

        const userMessage: Message = {
            id: `msg_${Date.now()}`,
            role: 'user',
            content: attachments.length > 0 ? `${inputValue}${attachments.length > 0 ? ` [${attachments.length} attachment(s)]` : ''}` : inputValue,
            timestamp: Date.now(),
        };

        setMessages(prev => [...prev, userMessage]);
        setInputValue('');
        setAttachments([]); // Clear attachments after send
        setIsProcessing(true);

        const assistantMessage: Message = {
            id: `msg_${Date.now()}_assistant`,
            role: 'assistant',
            content: '💭 Thinking...',
            timestamp: Date.now(),
            status: 'streaming',
        };
        setMessages(prev => [...prev, assistantMessage]);

        // Reset progress state
        setCurrentStep('Starting...');
        setStepHistory([]);
        setJobProgress(0);

        try {
            const isImageRequest = detectImageRequest(inputValue);
            const effectiveAgentType = isImageRequest ? 'kilatimage' : agentType;

            // Debug logging
            console.log(`🔍 [Chat] Input: "${inputValue.substring(0, 50)}..."`);
            console.log(`🔍 [Chat] isImageRequest: ${isImageRequest}`);
            console.log(`🔍 [Chat] agentType (user): ${agentType}`);
            console.log(`🔍 [Chat] effectiveAgentType: ${effectiveAgentType}`);

            if (isImageRequest && agentType !== 'kilatimage') {
                console.log('🎨 Auto-detected image request -> Routing to KilatImage');
            }

            const submitRes = await fetch('/api/kilat/async', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    message: inputValue,
                    userId: user!.id,
                    sessionId,
                    mode: chatMode,
                    model: selectedModel,
                    agentType: effectiveAgentType,
                    attachments: attachmentData.length > 0 ? attachmentData : undefined, // Pass attachments
                }),
            });

            if (submitRes.status === 401) {
                await signOut();
                router.push('/login');
                return;
            }

            const submitData = await submitRes.json();
            if (!submitData.success || !submitData.jobId) {
                throw new Error(submitData.error || 'Failed to submit');
            }

            const jobId = submitData.jobId;
            let completed = false;
            let pollCount = 0;

            while (!completed && pollCount < 120) {
                await new Promise(r => setTimeout(r, 1000));
                pollCount++;

                const statusRes = await fetch(`/api/kilat/status?jobId=${jobId}`);
                const statusData = await statusRes.json();
                const job = statusData.job;

                if (job?.status === 'completed') {
                    completed = true;
                    setMessages(prev => prev.map(m =>
                        m.id === assistantMessage.id
                            ? { ...m, content: job.result?.content || 'Done!', status: 'complete' as const }
                            : m
                    ));
                } else if (job) {
                    // Update Progress
                    const progress = job.progress || 0;
                    const step = job.currentStep || 'Processing...';
                    setJobProgress(progress);

                    if (step !== currentStep) {
                        setCurrentStep(step);
                        setStepHistory(prev => {
                            if (prev[prev.length - 1] !== step) return [...prev.slice(-20), step];
                            return prev;
                        });
                    }
                }

                if (job?.status === 'failed') {
                    throw new Error(job.error || 'Failed');
                }
            }
        } catch (error) {
            setMessages(prev => prev.map(m =>
                m.id === assistantMessage.id
                    ? { ...m, content: `❌ Error: ${error instanceof Error ? error.message : 'Unknown'}`, status: 'error' as const }
                    : m
            ));
        } finally {
            setIsProcessing(false);
        }
    }, [inputValue, isProcessing, sessionId, selectedModel, chatMode, user?.id, agentType, signOut, router]);

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    if (loading) {
        return (
            <div className="h-screen w-screen bg-obsidian flex items-center justify-center">
                <LoadingKilat />
            </div>
        );
    }

    return (
        <div className="flex flex-col h-screen bg-background-dark font-sans text-slate-200">
            {/* ✅ Show session title in header */}
            <GlobalHeader projectName={sessionTitle} onPublish={() => { }} />

            <main className="flex flex-1 overflow-hidden">
                <IconNav />

                <ChatSidebar
                    isOpen={sidebarOpen}
                    activeSessionId={sessionId}
                    onSessionSelect={handleSessionSelect}
                    onNewSession={handleNewSession}
                    onClose={() => setSidebarOpen(false)}
                    // TIER_LIMITS: Free=10, Pro=50, Enterprise=Unlimited(-1 shown as 999)
                    maxSessions={userTier === 'enterprise' ? 999 : userTier === 'pro' ? 50 : 10}
                />

                <div className="flex-1 flex flex-col">
                    {/* ✅ Session indicator at top */}
                    <div className="px-4 py-2 border-b border-white/5 flex items-center gap-2">
                        <span className="text-xs text-slate-500">Session:</span>
                        <span className="text-xs font-mono text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded">
                            {sessionId.slice(0, 8)}...
                        </span>
                        <span className="text-xs text-slate-400">• {sessionTitle}</span>
                    </div>

                    {/* Messages */}
                    <div className="flex-1 overflow-y-auto px-4 py-6">
                        <div className="max-w-3xl mx-auto space-y-4">
                            {messages.length === 0 && (
                                <div className="text-center py-20">
                                    <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-primary/20 flex items-center justify-center">
                                        <span className="text-3xl">⚡</span>
                                    </div>
                                    <h2 className="text-xl font-semibold mb-2">Welcome to Kilatos Chat</h2>
                                    <p className="text-slate-400">Ask anything. I&apos;ll route to the best agent.</p>
                                </div>
                            )}

                            {messages.map(msg => (
                                <div key={msg.id} className={`flex group ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                                    <div className={`max-w-[80%] p-4 rounded-2xl ${msg.role === 'user'
                                        ? 'bg-primary/20 border border-primary/30 rounded-tr-sm'
                                        : 'bg-white/5 border border-white/10 rounded-tl-sm'
                                        }`}>
                                        <div className="text-sm">{renderContent(msg.content)}</div>

                                        {/* Footer: Timestamp + Actions */}
                                        <div className={`flex items-center justify-between mt-2 ${msg.role === 'user' ? 'text-primary/50' : 'text-slate-500'}`}>
                                            <div className="text-xs">
                                                {new Date(msg.timestamp).toLocaleTimeString('id-ID', {
                                                    hour: '2-digit',
                                                    minute: '2-digit',
                                                    second: '2-digit'
                                                })}
                                                {msg.agent && <span className="ml-2">• {msg.agent}</span>}
                                                {msg.status === 'streaming' && <span className="ml-2 animate-pulse">⏳</span>}
                                            </div>

                                            {/* Action buttons for assistant (shown on hover) */}
                                            {msg.role === 'assistant' && msg.status !== 'streaming' && (
                                                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                                                    {/* Copy */}
                                                    <button
                                                        onClick={() => navigator.clipboard.writeText(msg.content)}
                                                        className="p-1 rounded text-slate-500 hover:text-white hover:bg-white/10"
                                                        title="Copy"
                                                    >
                                                        <span className="material-icons-round text-xs">content_copy</span>
                                                    </button>
                                                    {/* Regenerate */}
                                                    <button
                                                        onClick={() => handleRegenerate(msg.id)}
                                                        className="p-1 rounded text-slate-500 hover:text-white hover:bg-white/10"
                                                        title="Regenerate"
                                                    >
                                                        <span className="material-icons-round text-xs">refresh</span>
                                                    </button>
                                                    {/* Good */}
                                                    <button
                                                        onClick={() => handleFeedback(msg.id, 'good')}
                                                        className={`p-1 rounded transition-colors ${messageRatings[msg.id] === 'good'
                                                            ? 'bg-emerald-500/20 text-emerald-400'
                                                            : 'text-slate-500 hover:text-emerald-400'}`}
                                                        title="Good"
                                                    >
                                                        <span className="material-icons-round text-xs">thumb_up</span>
                                                    </button>
                                                    {/* Bad */}
                                                    <button
                                                        onClick={() => handleFeedback(msg.id, 'bad')}
                                                        className={`p-1 rounded transition-colors ${messageRatings[msg.id] === 'bad'
                                                            ? 'bg-red-500/20 text-red-400'
                                                            : 'text-slate-500 hover:text-red-400'}`}
                                                        title="Bad"
                                                    >
                                                        <span className="material-icons-round text-xs">thumb_down</span>
                                                    </button>
                                                </div>
                                            )}
                                        </div>
                                    </div>
                                </div>
                            ))}

                            {/* Processing Steps Indicator */}
                            {isProcessing && (
                                <div className="px-4 py-2 max-w-xl">
                                    <ProcessingSteps
                                        isProcessing={isProcessing}
                                        currentStep={currentStep}
                                        progress={jobProgress}
                                        stepHistory={stepHistory}
                                    />
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Input Area */}
                    <div className="border-t border-white/10 p-4">
                        <div className="max-w-3xl mx-auto">
                            <div className="flex items-center justify-between mb-2 px-1">
                                <div className="flex items-center gap-2">
                                    <ModeToggle currentMode={chatMode} onModeChange={setChatMode} />
                                    <AgentModeToggle mode={agentMode} onChange={setAgentMode} />
                                    <select
                                        value={agentType}
                                        onChange={(e) => setAgentType(e.target.value)}
                                        className="bg-white/5 border border-white/10 rounded px-2 py-1 text-xs text-slate-300 outline-none focus:border-primary/50"
                                    >
                                        {AGENTS.map(a => (
                                            <option key={a.id} value={a.id} className="bg-gray-900">{a.name}</option>
                                        ))}
                                    </select>
                                </div>
                                <ModelSelector
                                    currentModel={selectedModel}
                                    userTier={userTier}
                                    onModelChange={setSelectedModel}
                                />
                            </div>

                            <AgentSuggestionPanel
                                suggestions={suggestions}
                                onAccept={handleAcceptSuggestion}
                                onSkip={() => setSuggestions([])}
                            />

                            {/* Quota Display */}
                            <div className="flex items-center justify-between text-xs text-slate-400 mb-2">
                                <span className="uppercase tracking-wider">Daily Limit ({quota.tier})</span>
                                <span className="font-mono">{quota.used}/{quota.limit} used</span>
                            </div>

                            {/* Hidden file inputs */}
                            <input
                                type="file"
                                ref={imageInputRef}
                                onChange={handleFileSelect}
                                accept={ACCEPTED_IMAGE_TYPES}
                                className="hidden"
                                multiple
                            />
                            <input
                                type="file"
                                ref={docInputRef}
                                onChange={handleFileSelect}
                                accept={ACCEPTED_DOC_TYPES}
                                className="hidden"
                                multiple
                            />

                            {/* Attachment badges row */}
                            {attachments.length > 0 && (
                                <div className="flex flex-wrap gap-2 mb-2">
                                    {attachments.map((att, idx) => (
                                        <AttachmentBadge
                                            key={idx}
                                            attachment={att}
                                            onRemove={() => removeAttachment(idx)}
                                        />
                                    ))}
                                </div>
                            )}

                            <div className="flex items-center gap-3 bg-white/5 rounded-2xl border border-white/10 p-3">
                                {/* Sidebar toggle */}
                                <button
                                    onClick={() => setSidebarOpen(!sidebarOpen)}
                                    className="p-2 hover:bg-white/10 rounded-lg transition-colors"
                                    title={sidebarOpen ? 'Hide sidebar' : 'Show sidebar'}
                                >
                                    <span className="material-icons-round text-slate-400">
                                        {sidebarOpen ? 'menu_open' : 'menu'}
                                    </span>
                                </button>

                                {/* Attachment + button */}
                                <div className="relative">
                                    <button
                                        onClick={() => setIsAttachmentMenuOpen(!isAttachmentMenuOpen)}
                                        className={`p-2 rounded-lg transition-colors ${isAttachmentMenuOpen
                                            ? 'text-primary bg-primary/10'
                                            : 'text-slate-500 hover:text-white hover:bg-white/5'
                                            }`}
                                        title="Add attachment"
                                    >
                                        <span className="material-icons-round">add</span>
                                    </button>
                                    <AttachmentMenu
                                        isOpen={isAttachmentMenuOpen}
                                        onClose={() => setIsAttachmentMenuOpen(false)}
                                        onSelectImage={() => imageInputRef.current?.click()}
                                        onSelectDocument={() => docInputRef.current?.click()}
                                    />
                                </div>

                                <input
                                    type="text"
                                    value={inputValue}
                                    onChange={e => setInputValue(e.target.value)}
                                    onKeyDown={handleKeyDown}
                                    placeholder="Ask anything..."
                                    className="flex-1 bg-transparent outline-none text-slate-200 placeholder-slate-500"
                                    disabled={isProcessing}
                                />
                                {/* Send/Stop Button */}
                                {isProcessing ? (
                                    <button
                                        onClick={handleStop}
                                        className="p-2 bg-red-500 rounded-lg transition-colors hover:bg-red-600"
                                        title="Stop generation"
                                    >
                                        <span className="material-icons-round text-white">stop</span>
                                    </button>
                                ) : (
                                    <button
                                        onClick={handleSend}
                                        disabled={(!inputValue.trim() && attachments.length === 0)}
                                        className="p-2 bg-primary rounded-lg disabled:opacity-50 transition-colors hover:bg-primary/80"
                                    >
                                        <span className="material-icons-round text-white">send</span>
                                    </button>
                                )}
                            </div>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}
