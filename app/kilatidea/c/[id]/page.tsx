'use client';
/**
 * KilatIdea - Brainstorm Canvas (Miro-style)
 * Copyright © 2026 KilatCode Studio
 */

import { useState, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/auth/AuthProvider';
import { useQuota } from '@/hooks/useQuota';
import IconNav from '@/components/ui/IconNav';
import { ChatPanel } from '@/components/ui/ChatPanel';
import { GlobalHeader } from '@/components/ui/GlobalHeader';
import { LoadingKilat } from '@/components/ui/LoadingKilat';
import { AgentSuggestionPanel } from '@/components/agents/AgentSuggestionPanel';
import { getPostTaskSuggestions, AGENT_ROUTES, type AgentSuggestion } from '@/lib/agents/post-task-suggestions';

interface Message { id: string; role: 'user' | 'assistant'; content: string; timestamp: number; agent?: string; status?: 'pending' | 'streaming' | 'complete' | 'error'; }
interface IdeaNode { id: string; text: string; type: 'main' | 'sub' | 'detail'; color: string; }
interface PageProps { params: { id: string }; }

export default function KilatIdeaPage({ params }: PageProps) {
    const router = useRouter();
    const { user, loading } = useAuth();
    const projectId = params.id;

    const [messages, setMessages] = useState<Message[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [selectedModel, setSelectedModel] = useState('gemini-fast');
    const [availableModels, setAvailableModels] = useState<any[]>([]);
    const [projectName, setProjectName] = useState('brainstorm');
    const [ideas, setIdeas] = useState<IdeaNode[]>([]);
    const [quota] = useQuota(user?.id, 'code');
    const [isChatCollapsed, setIsChatCollapsed] = useState(false);
    const [suggestions, setSuggestions] = useState<AgentSuggestion[]>([]);

    // Progress Tracking
    const [currentStep, setCurrentStep] = useState<string>('Starting...');
    const [stepHistory, setStepHistory] = useState<string[]>([]);
    const [jobProgress, setJobProgress] = useState<number>(0);

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

    useEffect(() => { if (user) fetch('/api/models').then(r => r.json()).then(data => { if (data.success) { setAvailableModels(data.models); if (data.selected) setSelectedModel(data.selected); } }); }, [user]);
    useEffect(() => { if (!loading && !user) router.push('/login'); }, [user, loading, router]);

    // Post-Task Suggestions
    useEffect(() => {
        if (!isProcessing && messages.length > 0 && messages[messages.length - 1]?.status === 'complete') {
            const timer = setTimeout(() => setSuggestions(getPostTaskSuggestions('ideagen')), 500);
            return () => clearTimeout(timer);
        }
    }, [isProcessing, messages]);

    const handleSendMessage = useCallback(async (content: string, attachments?: { type: 'image' | 'document'; name: string; base64: string }[]) => {
        if ((!content.trim() && (!attachments || attachments.length === 0)) || isProcessing) return;
        setSuggestions([]);
        setMessages(prev => [...prev, { id: `msg_${Date.now()}`, role: 'user', content, timestamp: Date.now() }]);
        setIsProcessing(true);
        setCurrentStep('Starting...');
        setStepHistory([]);
        setJobProgress(0);
        const assistantMsg: Message = { id: `msg_${Date.now()}_assistant`, role: 'assistant', content: '💡 Brainstorming ideas...', timestamp: Date.now(), agent: 'KilatIdea', status: 'streaming' };
        setMessages(prev => [...prev, assistantMsg]);

        try {
            const { jobId } = await (await fetch('/api/kilat/async', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: content, userId: user!.id, sessionId: projectId, mode: 'planning', model: selectedModel, agentType: 'ideagen' }) })).json();
            let completed = false, pollCount = 0;
            while (!completed && pollCount < 300) {
                await new Promise(r => setTimeout(r, 1000)); pollCount++;
                const statusData = await (await fetch(`/api/kilat/status?jobId=${jobId}`)).json();

                // Update Progress
                if (statusData.job) {
                    const progress = statusData.job.progress || 0;
                    const step = statusData.job.currentStep || 'Processing...';
                    setJobProgress(progress);
                    if (step !== currentStep) {
                        setCurrentStep(step);
                        setStepHistory(prev => {
                            if (prev[prev.length - 1] !== step) return [...prev.slice(-20), step];
                            return prev;
                        });
                    }
                }

                if (statusData.job?.status === 'completed') {
                    completed = true;
                    setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: statusData.job.result?.content || 'Ideas generated!', status: 'complete' as const } : m));
                    if (statusData.job.result?.ideas) setIdeas(statusData.job.result.ideas);
                } else if (statusData.job?.status === 'failed') throw new Error(statusData.job.error);
            }
        } catch (e) { setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: `❌ Error: ${e instanceof Error ? e.message : 'Unknown'}`, status: 'error' as const } : m)); }
        finally { setIsProcessing(false); }
    }, [isProcessing, projectId, selectedModel, user?.id]);

    const handleNewProject = useCallback(() => router.push(`/kilatidea/c/${crypto.randomUUID()}`), [router]);

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
                    agentType: 'ideagen',
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
                    agentType: 'ideagen',
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

    const colors = ['bg-yellow-500/20 border-yellow-500/50', 'bg-pink-500/20 border-pink-500/50', 'bg-blue-500/20 border-blue-500/50', 'bg-green-500/20 border-green-500/50', 'bg-purple-500/20 border-purple-500/50'];

    return (
        <div className="flex flex-col h-screen overflow-hidden bg-background-dark font-sans text-slate-200">
            <GlobalHeader onPublish={() => { }} projectName={projectName} />
            <main className="flex flex-1 overflow-hidden relative">
                <IconNav />
                <ChatPanel sessionId={projectId} messages={messages} isProcessing={isProcessing} chatMode="planning" selectedModel={selectedModel}
                    onSendMessage={handleSendMessage} onModeChange={() => { }} onModelChange={setSelectedModel} quota={quota}
                    availableModels={availableModels} onSessionSelect={(id) => router.push(`/kilatidea/c/${id}`)} onNewChat={handleNewProject}
                    isCollapsed={isChatCollapsed} onToggleCollapse={() => setIsChatCollapsed(p => !p)} agentType="ideagen"
                    onFeedback={handleFeedback}
                    onRegenerate={handleRegenerate}
                    onCopy={handleCopy}
                    currentStep={currentStep}
                    progress={jobProgress}
                    stepHistory={stepHistory} />

                {/* Post-Task Suggestions */}
                {suggestions.length > 0 && !isChatCollapsed && (
                    <div className="absolute bottom-20 left-[64px] z-50 w-[360px] px-4">
                        <AgentSuggestionPanel suggestions={suggestions}
                            onAccept={(agent) => router.push(`/${AGENT_ROUTES[agent] || agent}/c/${projectId}`)}
                            onSkip={() => setSuggestions([])} />
                    </div>
                )}

                {/* Ideas Canvas */}
                <div className="flex-1 p-6 overflow-y-auto">
                    {ideas.length === 0 ? (
                        <div className="flex-1 h-full flex items-center justify-center text-center text-slate-500">
                            <div><span className="material-symbols-outlined text-6xl mb-4">lightbulb</span><p>Describe a topic to brainstorm</p></div>
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
                            {ideas.map((idea, i) => (
                                <div key={idea.id} className={`p-4 rounded-xl border-2 ${colors[i % colors.length]} ${idea.type === 'main' ? 'col-span-2 lg:col-span-3' : ''}`}>
                                    <span className="text-xs uppercase font-bold text-slate-400">{idea.type}</span>
                                    <p className={`mt-2 ${idea.type === 'main' ? 'text-xl font-bold' : idea.type === 'sub' ? 'text-base font-medium' : 'text-sm'}`}>{idea.text}</p>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            </main>
        </div>
    );
}
