'use client';
/**
 * KilatDesign - UI Design Studio
 * Visual design generation with Google Stitch-style UI.
 * URL: /kilatdesign/c/[id]
 * Copyright © 2026 KilatCode Studio
 */

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/AuthProvider';
import IconNav from '@/components/ui/IconNav';
import { ChatPanel } from '@/components/ui/ChatPanel';
import { GlobalHeader } from '@/components/ui/GlobalHeader';
import { LoadingKilat } from '@/components/ui/LoadingKilat';
import { AgentSuggestionPanel } from '@/components/agents/AgentSuggestionPanel';
import { getPostTaskSuggestions, AGENT_ROUTES, type AgentSuggestion } from '@/lib/agents/post-task-suggestions';

interface Message { id: string; role: 'user' | 'assistant'; content: string; timestamp: number; agent?: string; status?: 'pending' | 'streaming' | 'complete' | 'error'; }
interface PageProps { params: { id: string }; }

export default function KilatDesignPage({ params }: PageProps) {
    const router = useRouter();
    const { user, loading, signOut } = useAuth();
    const projectId = params.id;

    const [messages, setMessages] = useState<Message[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [selectedModel, setSelectedModel] = useState('gemini-fast');
    const [availableModels, setAvailableModels] = useState<any[]>([]);
    const [projectName, setProjectName] = useState('my-design');
    const [designVariants, setDesignVariants] = useState<string[]>([]);
    const [selectedVariant, setSelectedVariant] = useState<number>(0);
    const [quota, setQuota] = useState({ used: 0, limit: 100, tier: 'free' });
    const [isChatCollapsed, setIsChatCollapsed] = useState(false);
    const [suggestions, setSuggestions] = useState<AgentSuggestion[]>([]);

    useEffect(() => { if (projectId) loadProject(projectId); }, [projectId]);
    const loadProject = async (targetProjectId: string) => {
        try {
            const res = await fetch(`/api/kilat/sessions/${targetProjectId}`);
            const data = await res.json();
            if (data.success && data.messages?.length > 0) {
                setMessages(data.messages.map((m: any) => ({ id: m.id, role: m.role, content: m.content, timestamp: new Date(m.timestamp).getTime(), status: 'complete' })));
                if (data.session?.title) setProjectName(data.session.title);
            }
        } catch (e) { console.error('Load failed:', e); }
    };

    useEffect(() => { if (user) fetch('/api/models').then(r => r.json()).then(data => { if (data.success) { setAvailableModels(data.models); setQuota(prev => ({ ...prev, tier: data.userTier })); if (data.selected) setSelectedModel(data.selected); } }); }, [user]);
    useEffect(() => { if (!loading && !user) router.push('/login'); }, [user, loading, router]);

    // Post-Task Suggestions
    useEffect(() => {
        if (!isProcessing && designVariants.length > 0) {
            const timer = setTimeout(() => setSuggestions(getPostTaskSuggestions('imagegen')), 500);
            return () => clearTimeout(timer);
        }
    }, [isProcessing, designVariants]);

    const handleSendMessage = useCallback(async (content: string, attachments?: { type: 'image' | 'document'; name: string; base64: string }[]) => {
        if ((!content.trim() && (!attachments || attachments.length === 0)) || isProcessing) return;
        setSuggestions([]);
        setMessages(prev => [...prev, { id: `msg_${Date.now()}`, role: 'user', content, timestamp: Date.now() }]);
        setIsProcessing(true);
        const assistantMsg: Message = { id: `msg_${Date.now()}_assistant`, role: 'assistant', content: '🎨 Generating design variants...', timestamp: Date.now(), agent: 'KilatDesign', status: 'streaming' };
        setMessages(prev => [...prev, assistantMsg]);

        try {
            const submitRes = await fetch('/api/kilat/async', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: content, userId: user!.id, sessionId: projectId, mode: 'fast', model: selectedModel, agentType: 'imagegen' }) });
            if (submitRes.status === 401) { await signOut(); router.push('/login'); return; }
            const { jobId } = await submitRes.json();

            let completed = false, pollCount = 0;
            while (!completed && pollCount < 120) {
                await new Promise(r => setTimeout(r, 1000)); pollCount++;
                const statusData = await (await fetch(`/api/kilat/status?jobId=${jobId}`)).json();
                if (statusData.job?.status === 'completed') {
                    completed = true;
                    setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: statusData.job.result?.content || 'Design generated!', status: 'complete' as const } : m));
                    if (statusData.job.result?.images) setDesignVariants(statusData.job.result.images);
                } else if (statusData.job?.status === 'failed') throw new Error(statusData.job.error);
            }
        } catch (e) { setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: `❌ Error: ${e instanceof Error ? e.message : 'Unknown'}`, status: 'error' as const } : m)); }
        finally { setIsProcessing(false); }
    }, [isProcessing, projectId, selectedModel, user?.id]);

    const handleNewProject = useCallback(() => router.push(`/kilatdesign/c/${crypto.randomUUID()}`), [router]);
    const handleProjectSelect = (id: string) => router.push(`/kilatdesign/c/${id}`);
    
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
                    agentType: 'design',
                    modelUsed: selectedModel,
                    userId: user?.id
                })
            });

            const data = await res.json();
            if (data.success) {
                console.log(`✅ Feedback submitted: ${rating}`);
            }
        } catch (error) {
            console.error('❌ Feedback error:', error);
        }
    }, [projectId, selectedModel, user?.id]);

    // AI Learning: Regenerate handler
    const handleRegenerate = useCallback(async (messageId: string) => {
        try {
            await fetch('/api/kilat/regenerate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messageId,
                    sessionId: projectId,
                    agentType: 'design',
                    reason: 'User clicked regenerate button'
                })
            });

            const msgIndex = messages.findIndex(m => m.id === messageId);
            if (msgIndex > 0 && messages[msgIndex - 1]?.role === 'user') {
                console.log('🔄 Regenerating response...');
                await handleSendMessage(messages[msgIndex - 1].content);
            }
        } catch (error) {
            console.error('❌ Regenerate error:', error);
        }
    }, [messages, projectId, handleSendMessage]);

    const handleCopy = useCallback((content: string) => {
        console.log('✂️ Content copied');
    }, []);

    if (loading) return <div className="h-screen w-screen bg-obsidian flex items-center justify-center"><LoadingKilat /></div>;

    return (
        <div className="flex flex-col h-screen overflow-hidden bg-background-dark font-sans text-slate-200">
            <GlobalHeader onPublish={() => { }} projectName={projectName} />
            <main className="flex flex-1 overflow-hidden relative">
                <IconNav />
                <ChatPanel sessionId={projectId} messages={messages} isProcessing={isProcessing} chatMode="fast" selectedModel={selectedModel}
                    onSendMessage={handleSendMessage} onModeChange={() => { }} onModelChange={setSelectedModel} quota={quota}
                    availableModels={availableModels} onSessionSelect={handleProjectSelect} onNewChat={handleNewProject}
                    isCollapsed={isChatCollapsed} onToggleCollapse={() => setIsChatCollapsed(p => !p)} agentType="imagegen"
                    onFeedback={handleFeedback}
                    onRegenerate={handleRegenerate}
                    onCopy={handleCopy} />

                {/* Post-Task Suggestions */}
                {suggestions.length > 0 && !isChatCollapsed && (
                    <div className="absolute bottom-20 left-[64px] z-50 w-[360px] px-4">
                        <AgentSuggestionPanel suggestions={suggestions}
                            onAccept={(agent) => router.push(`/${AGENT_ROUTES[agent] || agent}/c/${projectId}`)}
                            onSkip={() => setSuggestions([])} />
                    </div>
                )}

                {/* Design Canvas */}
                <div className="flex-1 flex flex-col p-6 space-y-4">
                    <div className="flex-1 bg-white/5 rounded-2xl border border-white/10 flex items-center justify-center">
                        {designVariants.length > 0 ? (
                            <img src={designVariants[selectedVariant]} alt="Design" className="max-h-full max-w-full object-contain rounded-lg" />
                        ) : (
                            <div className="text-center text-slate-500">
                                <span className="material-symbols-outlined text-6xl mb-4">palette</span>
                                <p>Describe your design to get started</p>
                            </div>
                        )}
                    </div>
                    {designVariants.length > 1 && (
                        <div className="flex gap-2 justify-center">
                            {designVariants.map((_, i) => (
                                <button key={i} onClick={() => setSelectedVariant(i)}
                                    className={`w-12 h-12 rounded-lg border-2 ${i === selectedVariant ? 'border-primary' : 'border-white/20'}`}>
                                    Var {i + 1}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}
