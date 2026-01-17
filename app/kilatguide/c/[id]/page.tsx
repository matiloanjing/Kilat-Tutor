'use client';
/**
 * KilatGuide - Tutorial Builder (Scribe-style)
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
interface GuideStep { title: string; content: string; image?: string; }
interface PageProps { params: { id: string }; }

export default function KilatGuidePage({ params }: PageProps) {
    const router = useRouter();
    const { user, loading } = useAuth();
    const projectId = params.id;

    const [messages, setMessages] = useState<Message[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [selectedModel, setSelectedModel] = useState('gemini-fast');
    const [availableModels, setAvailableModels] = useState<any[]>([]);
    const [projectName, setProjectName] = useState('tutorial');
    const [guideSteps, setGuideSteps] = useState<GuideStep[]>([]);
    const [activeStep, setActiveStep] = useState(0);
    const [quota, setQuota] = useState({ used: 0, limit: 100, tier: 'free' });
    const [isChatCollapsed, setIsChatCollapsed] = useState(false);
    const [suggestions, setSuggestions] = useState<AgentSuggestion[]>([]);

    useEffect(() => { if (projectId) loadProject(projectId); }, [projectId]);
    const loadProject = async (id: string) => {
        try {
            const data = await (await fetch(`/api/kilat/sessions/${id}`)).json();
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
        if (!isProcessing && guideSteps.length > 0) {
            const timer = setTimeout(() => setSuggestions(getPostTaskSuggestions('guide')), 500);
            return () => clearTimeout(timer);
        }
    }, [isProcessing, guideSteps]);

    const handleSendMessage = useCallback(async (content: string, attachments?: { type: 'image' | 'document'; name: string; base64: string }[]) => {
        if ((!content.trim() && (!attachments || attachments.length === 0)) || isProcessing) return;
        setSuggestions([]);
        setMessages(prev => [...prev, { id: `msg_${Date.now()}`, role: 'user', content, timestamp: Date.now() }]);
        setIsProcessing(true);
        const assistantMsg: Message = { id: `msg_${Date.now()}_assistant`, role: 'assistant', content: '📚 Creating step-by-step guide...', timestamp: Date.now(), agent: 'KilatGuide', status: 'streaming' };
        setMessages(prev => [...prev, assistantMsg]);

        try {
            const { jobId } = await (await fetch('/api/kilat/async', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: content, userId: user!.id, sessionId: projectId, mode: 'planning', model: selectedModel, agentType: 'guide' }) })).json();
            let completed = false, pollCount = 0;
            while (!completed && pollCount < 300) {
                await new Promise(r => setTimeout(r, 1000)); pollCount++;
                const statusData = await (await fetch(`/api/kilat/status?jobId=${jobId}`)).json();
                if (statusData.job?.status === 'completed') {
                    completed = true;
                    setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: statusData.job.result?.content || 'Guide ready!', status: 'complete' as const } : m));
                    if (statusData.job.result?.steps) { setGuideSteps(statusData.job.result.steps); setActiveStep(0); }
                } else if (statusData.job?.status === 'failed') throw new Error(statusData.job.error);
            }
        } catch (e) { setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: `❌ Error: ${e instanceof Error ? e.message : 'Unknown'}`, status: 'error' as const } : m)); }
        finally { setIsProcessing(false); }
    }, [isProcessing, projectId, selectedModel, user?.id]);

    const handleNewProject = useCallback(() => router.push(`/kilatguide/c/${crypto.randomUUID()}`), [router]);
    
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
                    agentType: 'guide',
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
                    agentType: 'guide',
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
                <ChatPanel sessionId={projectId} messages={messages} isProcessing={isProcessing} chatMode="planning" selectedModel={selectedModel}
                    onSendMessage={handleSendMessage} onModeChange={() => { }} onModelChange={setSelectedModel} quota={quota}
                    availableModels={availableModels} onSessionSelect={(id) => router.push(`/kilatguide/c/${id}`)} onNewChat={handleNewProject}
                    isCollapsed={isChatCollapsed} onToggleCollapse={() => setIsChatCollapsed(p => !p)} agentType="guide"
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

                <div className="flex-1 flex">
                    {/* Steps Sidebar */}
                    <div className="w-64 border-r border-white/10 p-4 overflow-y-auto">
                        <h3 className="text-xs font-bold uppercase text-slate-500 mb-4">Steps ({guideSteps.length})</h3>
                        {guideSteps.map((s, i) => (
                            <button key={i} onClick={() => setActiveStep(i)}
                                className={`w-full text-left p-3 rounded-lg flex items-center gap-2 mb-2 ${i === activeStep ? 'bg-teal-500/20 text-teal-400' : 'hover:bg-white/5 text-slate-400'}`}>
                                <span className="w-6 h-6 rounded-full bg-white/10 text-xs flex items-center justify-center font-bold">{i + 1}</span>
                                <span className="text-sm truncate">{s.title}</span>
                            </button>
                        ))}
                    </div>
                    {/* Content */}
                    <div className="flex-1 p-6 overflow-y-auto">
                        {guideSteps.length === 0 ? (
                            <div className="flex-1 h-full flex items-center justify-center text-center text-slate-500">
                                <div><span className="material-symbols-outlined text-6xl mb-4">auto_stories</span><p>Describe a process to create a guide</p></div>
                            </div>
                        ) : (
                            <div className="max-w-2xl">
                                <h2 className="text-2xl font-bold mb-4">{guideSteps[activeStep]?.title}</h2>
                                <div className="prose prose-invert text-slate-300 whitespace-pre-wrap">{guideSteps[activeStep]?.content}</div>
                                <div className="flex justify-between mt-8">
                                    <button onClick={() => setActiveStep(p => Math.max(0, p - 1))} disabled={activeStep === 0} className="px-4 py-2 bg-white/10 rounded disabled:opacity-50">← Previous</button>
                                    <button onClick={() => setActiveStep(p => Math.min(guideSteps.length - 1, p + 1))} disabled={activeStep === guideSteps.length - 1} className="px-4 py-2 bg-teal-500/20 text-teal-400 rounded disabled:opacity-50">Next →</button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </main>
        </div>
    );
}
