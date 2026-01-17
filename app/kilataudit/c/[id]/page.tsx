'use client';
/**
 * KilatAudit - Code Audit Tool (Jules.google.com style)
 * GitHub repo analysis with security, quality, performance auditing.
 * URL: /kilataudit/c/[id]
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
interface AuditResult { category: string; severity: 'critical' | 'warning' | 'info'; title: string; description: string; file?: string; line?: number; }
interface PageProps { params: { id: string }; }

export default function KilatAuditPage({ params }: PageProps) {
    const router = useRouter();
    const { user, loading, signOut } = useAuth();
    const projectId = params.id;

    const [messages, setMessages] = useState<Message[]>([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [selectedModel, setSelectedModel] = useState('gemini-fast');
    const [availableModels, setAvailableModels] = useState<any[]>([]);
    const [projectName, setProjectName] = useState('code-audit');
    const [auditResults, setAuditResults] = useState<AuditResult[]>([]);
    const [repoUrl, setRepoUrl] = useState('');
    const [quota, setQuota] = useState({ used: 0, limit: 100, tier: 'free' });
    const [isChatCollapsed, setIsChatCollapsed] = useState(false);
    const [activeTab, setActiveTab] = useState<'overview' | 'security' | 'quality'>('overview');
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
        if (!isProcessing && auditResults.length > 0) {
            const timer = setTimeout(() => setSuggestions(getPostTaskSuggestions('audit')), 500);
            return () => clearTimeout(timer);
        }
    }, [isProcessing, auditResults]);

    const handleSendMessage = useCallback(async (content: string, attachments?: { type: 'image' | 'document'; name: string; base64: string }[]) => {
        if ((!content.trim() && (!attachments || attachments.length === 0)) || isProcessing) return;
        const urlMatch = content.match(/github\.com\/[\w-]+\/[\w-]+/);
        if (urlMatch) setRepoUrl(`https://${urlMatch[0]}`);
        setSuggestions([]);
        setMessages(prev => [...prev, { id: `msg_${Date.now()}`, role: 'user', content, timestamp: Date.now() }]);
        setIsProcessing(true);
        const assistantMsg: Message = { id: `msg_${Date.now()}_assistant`, role: 'assistant', content: '🔍 Analyzing repository...', timestamp: Date.now(), agent: 'KilatAudit', status: 'streaming' };
        setMessages(prev => [...prev, assistantMsg]);

        try {
            const submitRes = await fetch('/api/kilat/async', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: content, userId: user!.id, sessionId: projectId, mode: 'planning', model: selectedModel, agentType: 'audit' }) });
            if (submitRes.status === 401) { await signOut(); router.push('/login'); return; }
            const { jobId } = await submitRes.json();
            let completed = false, pollCount = 0;
            while (!completed && pollCount < 300) {
                await new Promise(r => setTimeout(r, 1000)); pollCount++;
                const statusData = await (await fetch(`/api/kilat/status?jobId=${jobId}`)).json();
                if (statusData.job?.status === 'completed') {
                    completed = true;
                    setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: statusData.job.result?.content || 'Audit complete!', status: 'complete' as const } : m));
                    if (statusData.job.result?.audits) setAuditResults(statusData.job.result.audits);
                } else if (statusData.job?.status === 'failed') throw new Error(statusData.job.error);
            }
        } catch (e) { setMessages(prev => prev.map(m => m.id === assistantMsg.id ? { ...m, content: `❌ Error: ${e instanceof Error ? e.message : 'Unknown'}`, status: 'error' as const } : m)); }
        finally { setIsProcessing(false); }
    }, [isProcessing, projectId, selectedModel, user?.id]);

    const handleNewProject = useCallback(() => router.push(`/kilataudit/c/${crypto.randomUUID()}`), [router]);
    const handleProjectSelect = (id: string) => router.push(`/kilataudit/c/${id}`);
    
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
                    agentType: 'audit',
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
                    agentType: 'audit',
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
    const severityColor = (s: string) => s === 'critical' ? 'text-red-400 bg-red-500/10' : s === 'warning' ? 'text-amber-400 bg-amber-500/10' : 'text-blue-400 bg-blue-500/10';

    return (
        <div className="flex flex-col h-screen overflow-hidden bg-background-dark font-sans text-slate-200">
            <GlobalHeader onPublish={() => { }} projectName={projectName} />
            <main className="flex flex-1 overflow-hidden relative">
                <IconNav />
                <ChatPanel sessionId={projectId} messages={messages} isProcessing={isProcessing} chatMode="planning" selectedModel={selectedModel}
                    onSendMessage={handleSendMessage} onModeChange={() => { }} onModelChange={setSelectedModel} quota={quota}
                    availableModels={availableModels} onSessionSelect={handleProjectSelect} onNewChat={handleNewProject}
                    isCollapsed={isChatCollapsed} onToggleCollapse={() => setIsChatCollapsed(p => !p)} agentType="audit"
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

                {/* Audit Panel */}
                <div className="flex-1 flex flex-col">
                    <div className="flex border-b border-white/10 px-4">
                        {['overview', 'security', 'quality'].map(tab => (
                            <button key={tab} onClick={() => setActiveTab(tab as any)}
                                className={`px-4 py-3 text-sm font-medium capitalize ${activeTab === tab ? 'text-primary border-b-2 border-primary' : 'text-slate-400 hover:text-slate-200'}`}>
                                {tab}
                            </button>
                        ))}
                    </div>
                    <div className="flex-1 p-6 overflow-y-auto space-y-4">
                        {auditResults.length === 0 ? (
                            <div className="flex-1 flex items-center justify-center text-center text-slate-500">
                                <div><span className="material-symbols-outlined text-6xl mb-4">bug_report</span><p>Paste a GitHub URL to start auditing</p><p className="text-sm mt-2 text-slate-600">Example: github.com/user/repo</p></div>
                            </div>
                        ) : (
                            auditResults.filter(r => activeTab === 'overview' || r.category.toLowerCase() === activeTab).map((result, i) => (
                                <div key={i} className={`p-4 rounded-lg border border-white/10 ${severityColor(result.severity)}`}>
                                    <div className="flex items-center gap-2 mb-2"><span className={`px-2 py-0.5 rounded text-xs font-bold uppercase ${severityColor(result.severity)}`}>{result.severity}</span><span className="text-xs text-slate-500">{result.category}</span></div>
                                    <h4 className="font-semibold mb-1">{result.title}</h4><p className="text-sm text-slate-400">{result.description}</p>
                                    {result.file && <p className="text-xs text-slate-500 mt-2">📁 {result.file}{result.line ? `:${result.line}` : ''}</p>}
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </main>
        </div>
    );
}
