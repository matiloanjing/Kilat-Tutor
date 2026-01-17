'use client';
/**
 * KilatCrawl - Web Scraper (Apify-style)
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
interface ScrapeResult { url: string; title: string; data: Record<string, any>; }
interface PageProps { params: { id: string }; }

export default function KilatCrawlPage({ params }: PageProps) {
    const router = useRouter();
    const { user, loading } = useAuth();
    const projectId = params.id;

    const [messages, setMessages] = useState<Message[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [selectedModel, setSelectedModel] = useState('gemini-fast');
    const [availableModels, setAvailableModels] = useState<any[]>([]);
    const [projectName, setProjectName] = useState('scraper');
    const [results, setResults] = useState<ScrapeResult[]>([]);
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
        if (!isProcessing && results.length > 0) {
            const timer = setTimeout(() => setSuggestions(getPostTaskSuggestions('crawl')), 500);
            return () => clearTimeout(timer);
        }
    }, [isProcessing, results]);

    const handleSendMessage = useCallback(async (content: string, attachments?: { type: 'image' | 'document'; name: string; base64: string }[]) => {
        if ((!content.trim() && (!attachments || attachments.length === 0)) || isProcessing) return;
        setSuggestions([]);
        setMessages(prev => [...prev, { id: `msg_${Date.now()}`, role: 'user', content, timestamp: Date.now() }]);
        setIsProcessing(true);
        const assistantMsg: Message = { id: `msg_${Date.now()}_assistant`, role: 'assistant', content: '🕷️ Crawling...', timestamp: Date.now(), agent: 'KilatCrawl', status: 'streaming' };
        setMessages(prev => [...prev, assistantMsg]);

        try {
            const { jobId } = await (await fetch('/api/kilat/async', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: content, userId: user!.id, sessionId: projectId, mode: 'planning', model: selectedModel, agentType: 'crawl' }) })).json();
            let completed = false, pollCount = 0;
            while (!completed && pollCount < 300) {
                await new Promise(r => setTimeout(r, 1000)); pollCount++;
                const statusData = await (await fetch(`/api/kilat/status?jobId=${jobId}`)).json();
                if (statusData.job?.status === 'completed') {
                    completed = true;
                    setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: statusData.job.result?.content || 'Crawl complete!', status: 'complete' as const } : m));
                    if (statusData.job.result?.results) setResults(statusData.job.result.results);
                } else if (statusData.job?.status === 'failed') throw new Error(statusData.job.error);
            }
        } catch (e) { setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: `❌ Error: ${e instanceof Error ? e.message : 'Unknown'}`, status: 'error' as const } : m)); }
        finally { setIsProcessing(false); }
    }, [isProcessing, projectId, selectedModel, user?.id]);

    const handleNewProject = useCallback(() => router.push(`/kilatcrawl/c/${crypto.randomUUID()}`), [router]);
    const handleExport = () => { const blob = new Blob([JSON.stringify(results, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = 'crawl-data.json'; a.click(); };
    
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
                    agentType: 'crawl',
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
                    agentType: 'crawl',
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
                    availableModels={availableModels} onSessionSelect={(id) => router.push(`/kilatcrawl/c/${id}`)} onNewChat={handleNewProject}
                    isCollapsed={isChatCollapsed} onToggleCollapse={() => setIsChatCollapsed(p => !p)} agentType="crawl"
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

                <div className="flex-1 flex flex-col p-6 overflow-hidden">
                    <div className="flex items-center justify-between mb-4">
                        <h3 className="font-semibold">Results ({results.length})</h3>
                        {results.length > 0 && <button onClick={handleExport} className="px-3 py-1.5 bg-red-500/20 text-red-400 rounded text-sm flex items-center gap-1"><span className="material-symbols-outlined text-sm">download</span>Export JSON</button>}
                    </div>
                    <div className="flex-1 overflow-y-auto space-y-3">
                        {results.length === 0 ? (
                            <div className="flex-1 h-full flex items-center justify-center text-center text-slate-500">
                                <div><span className="material-symbols-outlined text-6xl mb-4">language</span><p>Enter a URL or describe what to scrape</p></div>
                            </div>
                        ) : (
                            results.map((r, i) => (
                                <div key={i} className="p-4 bg-white/5 rounded-lg border border-white/10">
                                    <div className="flex items-center justify-between mb-2">
                                        <a href={r.url} target="_blank" rel="noopener noreferrer" className="text-sm text-red-400 hover:underline truncate">{r.url}</a>
                                    </div>
                                    <p className="font-medium mb-2">{r.title}</p>
                                    <pre className="text-xs text-slate-400 bg-black/30 p-2 rounded overflow-x-auto">{JSON.stringify(r.data, null, 2)}</pre>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </main>
        </div>
    );
}
