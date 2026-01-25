'use client';
/**
 * KilatQuestion - Quiz Builder (Kahoot-style)
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
interface Question { question: string; options: string[]; correct: number; explanation?: string; }
interface PageProps { params: { id: string }; }

export default function KilatQuestionPage({ params }: PageProps) {
    const router = useRouter();
    const { user, loading } = useAuth();
    const projectId = params.id;

    const [messages, setMessages] = useState<Message[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [selectedModel, setSelectedModel] = useState('gemini-fast');
    const [availableModels, setAvailableModels] = useState<any[]>([]);
    const [projectName, setProjectName] = useState('quiz');
    const [questions, setQuestions] = useState<Question[]>([]);
    const [activeQ, setActiveQ] = useState(0);
    const [showAnswer, setShowAnswer] = useState(false);
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
        if (!isProcessing && questions.length > 0) {
            const timer = setTimeout(() => setSuggestions(getPostTaskSuggestions('question')), 500);
            return () => clearTimeout(timer);
        }
    }, [isProcessing, questions]);

    const handleSendMessage = useCallback(async (content: string, attachments?: { type: 'image' | 'document'; name: string; base64: string }[]) => {
        if ((!content.trim() && (!attachments || attachments.length === 0)) || isProcessing) return;
        setSuggestions([]);
        setMessages(prev => [...prev, { id: `msg_${Date.now()}`, role: 'user', content, timestamp: Date.now() }]);
        setIsProcessing(true);
        setCurrentStep('Starting...');
        setStepHistory([]);
        setJobProgress(0);
        const assistantMsg: Message = { id: `msg_${Date.now()}_assistant`, role: 'assistant', content: '📝 Generating questions...', timestamp: Date.now(), agent: 'KilatQuestion', status: 'streaming' };
        setMessages(prev => [...prev, assistantMsg]);

        try {
            const { jobId } = await (await fetch('/api/kilat/async', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: content, userId: user!.id, sessionId: projectId, mode: 'planning', model: selectedModel, agentType: 'question' }) })).json();
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
                    setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: statusData.job.result?.content || 'Quiz ready!', status: 'complete' as const } : m));
                    if (statusData.job.result?.questions) { setQuestions(statusData.job.result.questions); setActiveQ(0); setShowAnswer(false); }
                } else if (statusData.job?.status === 'failed') throw new Error(statusData.job.error);
            }
        } catch (e) { setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: `❌ Error: ${e instanceof Error ? e.message : 'Unknown'}`, status: 'error' as const } : m)); }
        finally { setIsProcessing(false); }
    }, [isProcessing, projectId, selectedModel, user?.id]);

    const handleNewProject = useCallback(() => router.push(`/kilatquestion/c/${crypto.randomUUID()}`), [router]);
    const handleNext = () => { if (activeQ < questions.length - 1) { setActiveQ(p => p + 1); setShowAnswer(false); } };
    const handlePrev = () => { if (activeQ > 0) { setActiveQ(p => p - 1); setShowAnswer(false); } };

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
                    agentType: 'question',
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
                    agentType: 'question',
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

    const q = questions[activeQ];
    const colors = ['bg-red-500/20 border-red-500/50', 'bg-blue-500/20 border-blue-500/50', 'bg-amber-500/20 border-amber-500/50', 'bg-green-500/20 border-green-500/50'];

    return (
        <div className="flex flex-col h-screen overflow-hidden bg-background-dark font-sans text-slate-200">
            <GlobalHeader onPublish={() => { }} projectName={projectName} />
            <main className="flex flex-1 overflow-hidden relative">
                <IconNav />
                <ChatPanel sessionId={projectId} messages={messages} isProcessing={isProcessing} chatMode="planning" selectedModel={selectedModel}
                    onSendMessage={handleSendMessage} onModeChange={() => { }} onModelChange={setSelectedModel} quota={quota}
                    availableModels={availableModels} onSessionSelect={(id) => router.push(`/kilatquestion/c/${id}`)} onNewChat={handleNewProject}
                    isCollapsed={isChatCollapsed} onToggleCollapse={() => setIsChatCollapsed(p => !p)} agentType="question"
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

                {/* Quiz Panel */}
                <div className="flex-1 flex flex-col p-6">
                    {questions.length === 0 ? (
                        <div className="flex-1 flex items-center justify-center text-center text-slate-500">
                            <div><span className="material-symbols-outlined text-6xl mb-4">quiz</span><p>Describe a topic to generate quiz</p></div>
                        </div>
                    ) : (
                        <>
                            <div className="flex items-center justify-between mb-4">
                                <span className="text-sm text-slate-400">Question {activeQ + 1} of {questions.length}</span>
                                <div className="flex gap-2">
                                    <button onClick={handlePrev} disabled={activeQ === 0} className="px-3 py-1 rounded bg-white/10 disabled:opacity-50">Prev</button>
                                    <button onClick={handleNext} disabled={activeQ === questions.length - 1} className="px-3 py-1 rounded bg-white/10 disabled:opacity-50">Next</button>
                                </div>
                            </div>
                            <div className="flex-1 flex flex-col">
                                <div className="p-6 bg-white/5 rounded-xl border border-white/10 mb-6"><p className="text-xl font-semibold">{q?.question}</p></div>
                                <div className="grid grid-cols-2 gap-4 flex-1">
                                    {q?.options.map((opt, i) => (
                                        <button key={i} onClick={() => setShowAnswer(true)}
                                            className={`p-4 rounded-xl border-2 text-left font-medium transition-all ${colors[i]} ${showAnswer && i === q.correct ? 'ring-2 ring-green-400' : ''}`}>
                                            {opt}
                                        </button>
                                    ))}
                                </div>
                                {showAnswer && q?.explanation && (
                                    <div className="mt-4 p-4 bg-green-500/10 border border-green-500/30 rounded-lg"><p className="text-sm text-green-300">{q.explanation}</p></div>
                                )}
                            </div>
                        </>
                    )}
                </div>
            </main>
        </div>
    );
}
