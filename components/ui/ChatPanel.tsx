
import { useState, useEffect, useRef } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import SessionList from './SessionList';
import CollapsibleCodeBlock, { ErrorDisplay } from './CollapsibleCodeBlock';
import { AttachmentBadge, AttachmentMenu, createAttachedFile, AttachedFile, ACCEPTED_IMAGE_TYPES, ACCEPTED_DOC_TYPES } from './AttachmentBadge';
import { AgentSwitcherCompact } from './AgentSwitcher';
import { ConnectedAgentsBadge } from './CrossAgentPanel';
import { AGENT_ROUTES, AGENT_TYPE_TO_CATEGORY } from '@/hooks/useCrossAgentContext';
import MessageContent from './MessageContent';
import { ProcessingSteps } from '@/components/ui/ProcessingSteps';

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
    agent?: string;
    status?: 'pending' | 'streaming' | 'complete' | 'error';
    steps?: { label: string; status: 'done' | 'active' | 'pending' }[];
    files?: Record<string, string>;
    error?: string;
}

export interface ChatPanelProps {
    sessionId?: string;
    messages: Message[];
    isProcessing: boolean;
    chatMode: 'planning' | 'fast';
    selectedModel: string;
    onSendMessage: (message: string, attachments?: { type: 'image' | 'document'; name: string; base64: string }[]) => void;
    onModeChange: (mode: 'planning' | 'fast') => void;
    onModelChange: (model: string) => void;
    quota?: { used: number; limit: number; tier: string };
    onSessionSelect?: (sessionId: string) => void;
    onNewChat?: () => void;
    isCollapsed: boolean;
    onToggleCollapse: () => void;
    availableModels?: any[];
    onFileClick?: (filename: string) => void;
    onFeedback?: (messageId: string, rating: 'good' | 'bad') => void;
    onRegenerate?: (messageId: string) => void;
    onCopy?: (content: string) => void;
    onStop?: () => void; // Stop generation
    agentType?: string; // Current agent type for session filtering
    generatedFileCount?: number; // Total files in session for display
    currentStep?: string;
    progress?: number;
    stepHistory?: string[];
}

const SUGGESTIONS = [
    { icon: '🎨', text: 'Buatkan landing page' },
    { icon: '📊', text: 'Hitung integral x²' },
    { icon: '⚛️', text: 'Jelaskan React hooks' },
    { icon: '✍️', text: 'Tulis artikel SEO' },
];

export function ChatPanel({
    sessionId,
    messages,
    isProcessing,
    chatMode,
    selectedModel,
    onSendMessage,
    onModeChange,
    onModelChange,
    quota = { used: 0, limit: 100, tier: 'Free' },
    onSessionSelect,
    onNewChat,
    isCollapsed,
    onToggleCollapse,
    availableModels = [],
    onFileClick,
    onFeedback,
    onRegenerate,
    onCopy,
    onStop,
    agentType,
    generatedFileCount,
    currentStep = 'Starting...',
    progress = 0,
    stepHistory = []
}: ChatPanelProps) {
    const [inputValue, setInputValue] = useState('');
    const [view, setView] = useState<'chat' | 'history'>('chat');
    const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
    const [isAttachmentMenuOpen, setIsAttachmentMenuOpen] = useState(false);
    const [attachments, setAttachments] = useState<AttachedFile[]>([]);
    const [messageRatings, setMessageRatings] = useState<Record<string, 'good' | 'bad'>>({});
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const modelSelectorRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const docInputRef = useRef<HTMLInputElement>(null);
    const { user } = useAuth();

    // Close model selector on click outside
    useEffect(() => {
        function handleClickOutside(event: MouseEvent) {
            if (modelSelectorRef.current && !modelSelectorRef.current.contains(event.target as Node)) {
                setIsModelSelectorOpen(false);
            }
        }
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    // Auto-scroll on new messages
    useEffect(() => {
        if (view === 'chat') {
            messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
        }
    }, [messages, view]);

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if ((!inputValue.trim() && attachments.length === 0) || isProcessing) return;

        // Convert attachments to format with base64 for backend
        const attachmentData = attachments.map(att => ({
            type: att.type,
            name: att.file.name,
            base64: att.preview || '' // base64 data URL
        }));

        onSendMessage(inputValue.trim(), attachmentData.length > 0 ? attachmentData : undefined);
        setInputValue('');
        setAttachments([]); // Clear attachments after send
    };

    // Handle file selection
    const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
        const files = e.target.files;
        if (!files) return;

        const newAttachments: AttachedFile[] = [];
        for (let i = 0; i < files.length; i++) {
            const attached = await createAttachedFile(files[i]);
            newAttachments.push(attached);
        }
        setAttachments(prev => [...prev, ...newAttachments]);
        e.target.value = ''; // Reset input
    };

    // Remove attachment by index
    const removeAttachment = (index: number) => {
        setAttachments(prev => prev.filter((_, i) => i !== index));
    };

    const quotaPercentage = quota.limit > 0 ? Math.round((quota.used / quota.limit) * 100) : 0;

    return (
        <section
            id="chat-panel"
            className={`
                bg-obsidian border-r border-panel-border flex flex-col z-10 relative flex-shrink-0 transition-all duration-300 ease-in-out
                ${isCollapsed ? 'w-[40px] panel-collapsed' : 'w-full md:w-[380px] panel-expanded'}
            `}
        >
            <div className={`flex flex-col h-full bg-obsidian ${isCollapsed ? 'hidden' : 'flex'}`}>
                {/* Header - Simplified, no duplicate title */}
                <header className="px-3 py-2 border-b border-panel-border flex-shrink-0 bg-obsidian/50 overflow-visible relative z-20">
                    {/* Single Row: Mode Toggle + Agent Switcher + History */}
                    <div className="flex items-center justify-between gap-2">
                        {/* Left: Mode Toggle */}
                        <div className="bg-[#0a0a0f] p-0.5 rounded-lg flex border border-white/5 shrink-0">
                            <button
                                onClick={() => onModeChange('planning')}
                                className={`px-2 py-1 rounded text-[10px] font-bold uppercase transition-all ${chatMode === 'planning'
                                    ? 'bg-primary/20 text-primary'
                                    : 'text-slate-500 hover:text-slate-300'
                                    }`}
                            >
                                Planning
                            </button>
                            <button
                                onClick={() => onModeChange('fast')}
                                className={`px-2 py-1 rounded text-[10px] font-bold uppercase transition-all ${chatMode === 'fast'
                                    ? 'bg-primary/20 text-primary'
                                    : 'text-slate-500 hover:text-slate-300'
                                    }`}
                            >
                                Fast
                            </button>
                        </div>

                        {/* Center: Agent Switcher (if available) */}
                        {sessionId && agentType && AGENT_TYPE_TO_CATEGORY[agentType] && (
                            <div className="flex items-center gap-2">
                                <AgentSwitcherCompact
                                    projectId={sessionId}
                                    currentAgent={AGENT_TYPE_TO_CATEGORY[agentType]}
                                />
                                <ConnectedAgentsBadge
                                    projectId={sessionId}
                                    currentAgent={AGENT_TYPE_TO_CATEGORY[agentType]}
                                />
                            </div>
                        )}

                        {/* Right: History Button */}
                        <button
                            onClick={() => setView(view === 'chat' ? 'history' : 'chat')}
                            className={`p-1.5 rounded-lg transition-colors shrink-0 ${view === 'history'
                                ? 'bg-primary text-white'
                                : 'bg-[#0a0a0f] text-slate-500 hover:text-white border border-white/5'
                                }`}
                            title={view === 'chat' ? 'Show History' : 'Back to Chat'}
                        >
                            <span className="material-icons-round text-sm">history</span>
                        </button>
                    </div>

                    {/* Model Selector */}
                    <div className="relative" ref={modelSelectorRef}>
                        <button
                            onClick={() => setIsModelSelectorOpen(!isModelSelectorOpen)}
                            className="w-full flex items-center justify-between bg-[#0a0a0f] hover:bg-[#121217] border border-white/5 rounded-xl px-4 py-2 text-xs font-bold text-slate-300 transition-all"
                        >
                            <div className="flex items-center gap-2">
                                <span className={`w-2 h-2 rounded-full ${selectedModel ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' : 'bg-slate-500'}`}></span>
                                {availableModels.find(m => m.model_id === selectedModel)?.display_name || selectedModel || 'Select Model'}
                            </div>
                            <span className={`material-icons-round text-sm text-slate-500 transition-transform ${isModelSelectorOpen ? 'rotate-180' : ''}`}>expand_more</span>
                        </button>

                        {/* Dropdown Menu */}
                        {isModelSelectorOpen && (
                            <div className="absolute top-full left-0 right-0 mt-2 bg-[#0d0d12] border border-white/10 rounded-xl shadow-2xl z-50 overflow-hidden backdrop-blur-xl animate-in fade-in slide-in-from-top-2 duration-200">
                                <div className="p-2 max-h-[300px] overflow-y-auto custom-scrollbar">
                                    <div className="px-2 py-1.5 mb-1">
                                        <span className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Available Models</span>
                                    </div>
                                    {availableModels.length > 0 ? (
                                        availableModels.map((model) => (
                                            <button
                                                key={model.model_id}
                                                onClick={() => {
                                                    onModelChange(model.model_id);
                                                    setIsModelSelectorOpen(false);
                                                }}
                                                className={`w-full flex flex-col items-start gap-1 p-3 rounded-lg transition-all text-left mb-1 group
                                                    ${selectedModel === model.model_id
                                                        ? 'bg-primary/20 border border-primary/20'
                                                        : 'hover:bg-white/5 border border-transparent'
                                                    }`}
                                            >
                                                <div className="flex items-center justify-between w-full">
                                                    <span className={`text-[11px] font-bold tracking-wide transition-colors ${selectedModel === model.model_id ? 'text-primary' : 'text-slate-300 group-hover:text-white'}`}>
                                                        {model.display_name}
                                                    </span>
                                                    {selectedModel === model.model_id && (
                                                        <span className="material-icons-round text-xs text-primary">check_circle</span>
                                                    )}
                                                </div>
                                                <div className="flex items-center gap-2">
                                                    <span className="text-[9px] font-medium text-slate-500 border border-white/5 px-1.5 py-0.5 rounded bg-black/20 uppercase">
                                                        {model.provider}
                                                    </span>
                                                    <span className="text-[9px] font-medium text-emerald-500/80 bg-emerald-500/5 px-1.5 py-0.5 rounded uppercase">
                                                        {model.required_tier === 'free' ? 'Standard' : model.required_tier}
                                                    </span>
                                                </div>
                                                {model.description && (
                                                    <p className="text-[10px] text-slate-500 leading-snug line-clamp-1 mt-0.5">
                                                        {model.description}
                                                    </p>
                                                )}
                                            </button>
                                        ))
                                    ) : (
                                        <div className="p-4 text-center">
                                            <span className="text-xs text-slate-600">No models available</span>
                                        </div>
                                    )}
                                </div>
                            </div>
                        )}
                    </div>
                </header>

                {view === 'history' ? (
                    <SessionList
                        currentSessionId={null}
                        onSelectSession={async (id) => {
                            console.log('[ChatPanel] Session selected:', id);
                            setView('chat');  // Switch view immediately
                            if (onSessionSelect) {
                                try {
                                    await onSessionSelect(id);
                                    console.log('[ChatPanel] Session load complete');
                                } catch (err) {
                                    console.error('[ChatPanel] Failed to load session:', err);
                                }
                            } else {
                                console.warn('[ChatPanel] onSessionSelect prop is undefined!');
                            }
                        }}
                        onNewChat={() => {
                            onNewChat?.();
                            setView('chat');
                        }}
                        agentType={agentType}
                    />
                ) : (
                    <>
                        {/* Messages */}
                        <div className="flex-1 overflow-y-auto p-5 space-y-6">
                            {messages.length === 0 ? (
                                <div className="flex flex-col items-center justify-center h-full text-center">
                                    <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-primary/20 to-transparent border border-primary/20 flex items-center justify-center mb-4">
                                        <span className="material-icons-round text-primary text-3xl">electric_bolt</span>
                                    </div>
                                    <h3 className="text-white font-display font-extrabold mb-2 uppercase tracking-wide">Welcome to KilatOS</h3>
                                    <p className="text-slate-500 text-sm">
                                        Just type anything - I&apos;ll automatically route to the right AI agent.
                                    </p>
                                </div>
                            ) : (
                                messages.map((message) => (
                                    <div key={message.id} className="space-y-4 group">
                                        <div className={`flex gap-3 ${message.role === 'user' ? 'flex-row-reverse' : ''}`}>
                                            {/* Avatar */}
                                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 border border-white/10 ${message.role === 'user'
                                                ? 'bg-charcoal-light overflow-hidden'
                                                : 'bg-gradient-to-br from-primary to-[#4c1d95]'
                                                }`}>
                                                {message.role === 'user' ? (
                                                    user?.user_metadata?.avatar_url ? (
                                                        <img src={user.user_metadata.avatar_url} alt="" className="w-full h-full object-cover" />
                                                    ) : (
                                                        <span className="text-white text-xs font-bold">
                                                            {user?.email?.charAt(0).toUpperCase() || 'U'}
                                                        </span>
                                                    )
                                                ) : (
                                                    <span className="material-icons-round text-white text-xs">smart_toy</span>
                                                )}
                                            </div>

                                            {/* Message Bubble */}
                                            <div className={`flex-1 space-y-3 ${message.role === 'user' ? 'max-w-[85%]' : ''}`}>
                                                <div className={`p-4 rounded-2xl text-sm leading-relaxed font-light ${message.role === 'user'
                                                    ? 'bg-primary/10 border border-primary/20 text-slate-200 rounded-tr-sm'
                                                    : 'bg-[#1a1a20] border border-white/5 text-slate-300 rounded-tl-sm'
                                                    }`}>
                                                    <MessageContent
                                                        content={message.content}
                                                        actualFileCount={message.role === 'assistant' ? generatedFileCount : undefined}
                                                    />

                                                    {/* Timestamp */}
                                                    <div className={`mt-2 text-[10px] flex items-center gap-2 ${message.role === 'user' ? 'text-primary/50' : 'text-slate-500'}`}>
                                                        {new Date(message.timestamp).toLocaleTimeString('id-ID', {
                                                            hour: '2-digit',
                                                            minute: '2-digit'
                                                        })}
                                                        {message.agent && <span>• {message.agent}</span>}
                                                        {message.status === 'streaming' && <span className="animate-pulse">⏳</span>}
                                                    </div>
                                                </div>

                                                {/* Processing Steps */}
                                                {message.steps && message.steps.length > 0 && (
                                                    <div className="space-y-2 border border-white/5 bg-white/5 rounded-xl p-3">
                                                        {message.steps.map((step, idx) => (
                                                            <div key={idx} className={`flex items-center gap-3 text-xs ${step.status === 'done' ? 'text-emerald-400' :
                                                                step.status === 'active' ? 'text-primary' : 'text-slate-500'
                                                                }`}>
                                                                <span className={`material-icons-round text-sm ${step.status === 'active' ? 'animate-spin' : ''
                                                                    }`}>
                                                                    {step.status === 'done' ? 'check_circle' :
                                                                        step.status === 'active' ? 'sync' : 'circle'}
                                                                </span>
                                                                <span className={`font-bold uppercase tracking-wider ${step.status === 'pending' ? 'opacity-50' : ''
                                                                    }`}>
                                                                    {step.label}
                                                                </span>
                                                            </div>
                                                        ))}
                                                    </div>
                                                )}

                                                {/* Message Actions (for assistant messages only) */}
                                                {message.role === 'assistant' && message.status !== 'streaming' && (
                                                    <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 hover:opacity-100 transition-opacity">
                                                        {/* Copy */}
                                                        <button
                                                            onClick={() => {
                                                                navigator.clipboard.writeText(message.content);
                                                                onCopy?.(message.content);
                                                            }}
                                                            className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors"
                                                            title="Copy message"
                                                        >
                                                            <span className="material-icons-round text-sm">content_copy</span>
                                                        </button>

                                                        {/* Regenerate */}
                                                        <button
                                                            onClick={() => onRegenerate?.(message.id)}
                                                            className="p-1.5 rounded-lg text-slate-500 hover:text-white hover:bg-white/10 transition-colors"
                                                            title="Regenerate response"
                                                        >
                                                            <span className="material-icons-round text-sm">refresh</span>
                                                        </button>

                                                        {/* Good feedback */}
                                                        <button
                                                            onClick={() => {
                                                                setMessageRatings(prev => ({ ...prev, [message.id]: 'good' }));
                                                                onFeedback?.(message.id, 'good');
                                                            }}
                                                            className={`p-1.5 rounded-lg transition-colors ${messageRatings[message.id] === 'good'
                                                                ? 'bg-emerald-500/20 text-emerald-400'
                                                                : 'text-slate-500 hover:text-emerald-400 hover:bg-emerald-500/10'
                                                                }`}
                                                            title="Good response"
                                                        >
                                                            <span className="material-icons-round text-sm">thumb_up</span>
                                                        </button>

                                                        {/* Bad feedback */}
                                                        <button
                                                            onClick={() => {
                                                                setMessageRatings(prev => ({ ...prev, [message.id]: 'bad' }));
                                                                onFeedback?.(message.id, 'bad');
                                                            }}
                                                            className={`p-1.5 rounded-lg transition-colors ${messageRatings[message.id] === 'bad'
                                                                ? 'bg-red-500/20 text-red-400'
                                                                : 'text-slate-500 hover:text-red-400 hover:bg-red-500/10'
                                                                }`}
                                                            title="Bad response"
                                                        >
                                                            <span className="material-icons-round text-sm">thumb_down</span>
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                ))
                            )}
                            <div ref={messagesEndRef} />
                        </div>

                        {/* Processing Indicator (Pinned to bottom of chat area if loading) */}
                        {isProcessing && (
                            <div className="absolute bottom-32 left-0 right-0 px-6 z-20 pointer-events-none">
                                <div className="max-w-xl mx-auto pointer-events-auto">
                                    <ProcessingSteps
                                        isProcessing={isProcessing}
                                        currentStep={currentStep}
                                        progress={progress}
                                        stepHistory={stepHistory}
                                    />
                                </div>
                            </div>
                        )}

                        {/* Input Area */}
                        <div className="p-5 border-t border-border-premium bg-charcoal">
                            {/* Quota Usage */}
                            <div className="mb-4 flex flex-col gap-1.5">
                                <div className="flex items-center justify-between">
                                    <span className="text-[9px] font-extrabold uppercase tracking-widest text-slate-500">
                                        Daily Limit ({quota.tier})
                                    </span>
                                    <span className="text-[9px] font-extrabold text-primary tracking-tighter">
                                        {quota.used}/{quota.limit} USED
                                    </span>
                                </div>
                                <div className="h-1 w-full bg-[#1a1a20] rounded-full overflow-hidden border border-white/5">
                                    <div
                                        className="h-full bg-gradient-to-r from-primary/60 to-primary rounded-full shadow-[0_0_8px_rgba(139,92,246,0.3)] transition-all"
                                        style={{ width: `${quotaPercentage}%` }}
                                    />
                                </div>
                            </div>

                            {/* Input */}
                            <form onSubmit={handleSubmit} className="relative">
                                {/* Hidden File Inputs */}
                                <input
                                    type="file"
                                    ref={imageInputRef}
                                    className="hidden"
                                    accept={ACCEPTED_IMAGE_TYPES}
                                    multiple
                                    onChange={handleFileSelect}
                                />
                                <input
                                    type="file"
                                    ref={docInputRef}
                                    className="hidden"
                                    accept={ACCEPTED_DOC_TYPES}
                                    multiple
                                    onChange={handleFileSelect}
                                />

                                <div className="bg-white/[0.03] backdrop-blur-sm rounded-xl border border-white/10 overflow-hidden focus-within:border-primary/50 transition-all">
                                    {/* Attachment Badges Preview */}
                                    {attachments.length > 0 && (
                                        <div className="flex flex-wrap gap-2 p-2 border-b border-white/5">
                                            {attachments.map((attachment, index) => (
                                                <AttachmentBadge
                                                    key={index}
                                                    attachment={attachment}
                                                    onRemove={() => removeAttachment(index)}
                                                />
                                            ))}
                                        </div>
                                    )}

                                    <textarea
                                        value={inputValue}
                                        onChange={(e) => setInputValue(e.target.value)}
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter' && !e.shiftKey) {
                                                e.preventDefault();
                                                handleSubmit(e);
                                            }
                                        }}
                                        className="w-full bg-transparent text-slate-200 text-sm border-0 focus:ring-0 p-3 pb-12 resize-none h-24 placeholder:text-slate-600 font-light"
                                        placeholder="Describe what you want to build..."
                                        disabled={isProcessing}
                                    />
                                    <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between">
                                        {/* Attachment Button with Menu */}
                                        <div className="relative overflow-visible">
                                            <button
                                                type="button"
                                                onClick={() => setIsAttachmentMenuOpen(!isAttachmentMenuOpen)}
                                                className={`p-1.5 rounded-lg transition-colors ${isAttachmentMenuOpen
                                                    ? 'text-primary bg-primary/10'
                                                    : 'text-slate-500 hover:text-white hover:bg-white/5'
                                                    }`}
                                            >
                                                <span className="material-symbols-outlined text-lg">add</span>
                                            </button>
                                            <AttachmentMenu
                                                isOpen={isAttachmentMenuOpen}
                                                onClose={() => setIsAttachmentMenuOpen(false)}
                                                onSelectImage={() => imageInputRef.current?.click()}
                                                onSelectDocument={() => docInputRef.current?.click()}
                                            />
                                        </div>
                                        {/* Send/Stop Button */}
                                        {isProcessing && onStop ? (
                                            <button
                                                type="button"
                                                onClick={onStop}
                                                className="p-1.5 rounded-lg bg-red-500 text-white hover:bg-red-600 transition-all transform active:scale-95"
                                                title="Stop generation"
                                            >
                                                <span className="material-icons-round text-sm">stop</span>
                                            </button>
                                        ) : (
                                            <button
                                                type="submit"
                                                disabled={(!inputValue.trim() && attachments.length === 0) || isProcessing}
                                                className="p-1.5 rounded-lg bg-primary text-white hover:bg-primary-dark transition-all transform active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                {isProcessing ? (
                                                    <span className="material-icons-round text-sm animate-spin">sync</span>
                                                ) : (
                                                    <span className="material-icons-round text-sm">arrow_upward</span>
                                                )}
                                            </button>
                                        )}
                                    </div>
                                </div>
                            </form>

                            {/* Suggestions */}
                            {messages.length === 0 && (
                                <div className="mt-3 flex items-center gap-2 overflow-x-auto pb-1 no-scrollbar">
                                    {SUGGESTIONS.map((suggestion, idx) => (
                                        <button
                                            key={idx}
                                            onClick={() => setInputValue(suggestion.text)}
                                            className="px-2.5 py-1 rounded-lg bg-[#0a0a0f] border border-white/5 text-[10px] font-bold text-slate-400 hover:text-white hover:border-primary/40 whitespace-nowrap transition-all uppercase flex items-center gap-1"
                                        >
                                            <span>{suggestion.icon}</span> {suggestion.text}
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>
                    </>
                )}
            </div>

            {/* Collapsed View */}
            <div className={`absolute inset-0 flex flex-col items-center py-6 gap-8 ${!isCollapsed ? 'hidden' : 'flex'}`}>
                <span className="material-icons-round text-primary text-xl">smart_toy</span>
                <span className="text-[10px] font-display font-bold text-primary uppercase tracking-[0.2em] vertical-text whitespace-nowrap">KILATOS AGENT</span>
            </div>

            {/* Toggle Button */}
            <button
                className="absolute -right-3 top-1/2 -translate-y-1/2 z-30 size-6 bg-obsidian border border-panel-border rounded-full flex items-center justify-center text-accent-purple toggle-glow shadow-lg hover:bg-panel-border transition-colors group"
                onClick={onToggleCollapse}
                title={isCollapsed ? "Expand Chat" : "Collapse Chat"}
            >
                <span className={`material-icons-round text-sm transition-transform ${isCollapsed ? 'rotate-180' : ''}`}>
                    chevron_left
                </span>
            </button>
        </section>
    );
}
