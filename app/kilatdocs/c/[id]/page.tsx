'use client';
/**
 * KilatDocs - Code Documentation Generator
 * Auto-generate README, API docs, code wikis.
 * URL: /kilatdocs/c/[id]
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
interface DocSection { title: string; content: string; type: 'readme' | 'api' | 'guide' | 'changelog'; }
interface PageProps { params: { id: string }; }

export default function KilatDocsPage({ params }: PageProps) {
    const router = useRouter();
    const { user, loading, signOut } = useAuth();
    const projectId = params.id;

    const [messages, setMessages] = useState<Message[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [selectedModel, setSelectedModel] = useState('gemini-fast');
    const [availableModels, setAvailableModels] = useState<any[]>([]);
    const [projectName, setProjectName] = useState('documentation');
    const [docSections, setDocSections] = useState<DocSection[]>([]);
    const [activeSection, setActiveSection] = useState<number>(0);
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

    // Post-Task Suggestions (docs agent has empty suggestions by default, but still include for consistency)
    useEffect(() => {
        if (!isProcessing && docSections.length > 0) {
            const timer = setTimeout(() => setSuggestions(getPostTaskSuggestions('docs')), 500);
            return () => clearTimeout(timer);
        }
    }, [isProcessing, docSections]);

    const handleSendMessage = useCallback(async (content: string, attachments?: { type: 'image' | 'document'; name: string; base64: string }[]) => {
        if ((!content.trim() && (!attachments || attachments.length === 0)) || isProcessing) return;
        setSuggestions([]);
        setMessages(prev => [...prev, { id: `msg_${Date.now()}`, role: 'user', content, timestamp: Date.now() }]);
        setIsProcessing(true);
        const assistantMsg: Message = { id: `msg_${Date.now()}_assistant`, role: 'assistant', content: '📚 Generating documentation...', timestamp: Date.now(), agent: 'KilatDocs', status: 'streaming' };
        setMessages(prev => [...prev, assistantMsg]);

        try {
            const submitRes = await fetch('/api/kilat/async', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: content, userId: user!.id, sessionId: projectId, mode: 'planning', model: selectedModel, agentType: 'docs' }) });
            if (submitRes.status === 401) { await signOut(); router.push('/login'); return; }
            const { jobId } = await submitRes.json();
            let completed = false, pollCount = 0;
            while (!completed && pollCount < 300) {
                await new Promise(r => setTimeout(r, 1000)); pollCount++;
                const statusData = await (await fetch(`/api/kilat/status?jobId=${jobId}`)).json();
                if (statusData.job?.status === 'completed') {
                    completed = true;
                    const result = statusData.job.result;
                    setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: result?.content || 'Documentation generated!', status: 'complete' as const } : m));
                    if (result?.sections) setDocSections(result.sections);
                } else if (statusData.job?.status === 'failed') throw new Error(statusData.job.error);
            }
        } catch (e) { setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: `❌ Error: ${e instanceof Error ? e.message : 'Unknown'}`, status: 'error' as const } : m)); }
        finally { setIsProcessing(false); }
    }, [isProcessing, projectId, selectedModel, user?.id]);

    const handleNewProject = useCallback(() => router.push(`/kilatdocs/c/${crypto.randomUUID()}`), [router]);
    const handleProjectSelect = (id: string) => router.push(`/kilatdocs/c/${id}`);
    const handleCopySection = (content: string) => navigator.clipboard.writeText(content);
    
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
                    agentType: 'docs',
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
                    agentType: 'docs',
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
    const typeIcon = (t: string) => t === 'readme' ? 'description' : t === 'api' ? 'api' : t === 'guide' ? 'school' : 'history';

    return (
        <div className="flex flex-col h-screen overflow-hidden bg-background-dark font-sans text-slate-200">
            <GlobalHeader onPublish={() => { }} projectName={projectName} />
            <main className="flex flex-1 overflow-hidden relative">
                <IconNav />
                <ChatPanel sessionId={projectId} messages={messages} isProcessing={isProcessing} chatMode="planning" selectedModel={selectedModel}
                    onSendMessage={handleSendMessage} onModeChange={() => { }} onModelChange={setSelectedModel} quota={quota}
                    availableModels={availableModels} onSessionSelect={handleProjectSelect} onNewChat={handleNewProject}
                    isCollapsed={isChatCollapsed} onToggleCollapse={() => setIsChatCollapsed(p => !p)} agentType="docs"
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

                {/* Docs Panel */}
                <div className="flex-1 flex">
                    <div className="w-64 border-r border-white/10 p-4 space-y-2">
                        <h3 className="text-xs font-bold uppercase text-slate-500 mb-4">Sections</h3>
                        {docSections.length === 0 ? (
                            <p className="text-sm text-slate-500">No sections yet</p>
                        ) : (
                            docSections.map((sec, i) => (
                                <button key={i} onClick={() => setActiveSection(i)}
                                    className={`w-full text-left p-3 rounded-lg flex items-center gap-2 ${i === activeSection ? 'bg-primary/20 text-primary' : 'hover:bg-white/5 text-slate-400'}`}>
                                    <span className="material-symbols-outlined text-lg">{typeIcon(sec.type)}</span>
                                    <span className="text-sm truncate">{sec.title}</span>
                                </button>
                            ))
                        )}
                    </div>
                    <div className="flex-1 p-6 overflow-y-auto">
                        {docSections.length === 0 ? (
                            <div className="flex-1 h-full flex items-center justify-center text-center text-slate-500">
                                <div><span className="material-symbols-outlined text-6xl mb-4">menu_book</span><p>Describe your codebase to generate docs</p><p className="text-sm mt-2 text-slate-600">Supports README, API docs, guides</p></div>
                            </div>
                        ) : (
                            <div className="prose prose-invert max-w-none">
                                <div className="flex items-center justify-between mb-4">
                                    <h2 className="text-2xl font-bold">{docSections[activeSection]?.title}</h2>
                                    <button onClick={() => handleCopySection(docSections[activeSection]?.content)} className="px-3 py-1.5 bg-white/10 rounded text-sm hover:bg-white/20 flex items-center gap-1">
                                        <span className="material-symbols-outlined text-sm">content_copy</span>Copy
                                    </button>
                                </div>
                                <div className="whitespace-pre-wrap text-slate-300">{docSections[activeSection]?.content}</div>
                            </div>
                        )}
                    </div>
                </div>
            </main>
        </div>
    );
}
