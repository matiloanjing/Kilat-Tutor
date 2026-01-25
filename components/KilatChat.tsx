/**
 * KilatChat - Unified Chat Component with Auto-Routing
 * 
 * The main chat interface that connects to KilatOS.
 * Auto-detects agent, shows code with preview, supports all response types.
 * 
 * Philosophy:
 * - Simple for users (one chat, no agent selection)
 * - Beautiful code display
 * - Copy, run, download buttons
 * 
 * Copyright © 2026 KilatCode Studio
 */

'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useAuth } from '@/lib/auth/AuthProvider';
import DeployPreview from './DeployPreview';
import DeployButton from './DeployButton';
import { AttachButton, AttachedFilesList, type AttachedFile } from './AttachButton';
import { ModeToggle, type ChatMode } from './ModeToggle';
import { ModelSelector } from './ModelSelector';
import { CollapsibleCodeCard } from './CollapsibleCodeCard';
import type { PollinationModel } from '@/lib/config/models';
import type { UserTier } from '@/lib/auth/user-tier';
import { ProcessingSteps } from '@/components/ui/ProcessingSteps';

// ============================================================================
// Types
// ============================================================================

interface KilatResponse {
    success: boolean;
    type: 'text' | 'code' | 'image' | 'math' | 'mixed' | 'error';
    content: string | object;
    metadata?: {
        agent: string;
        executionTime?: number;
        files?: Array<{ name: string; content: string; language?: string }>;
        [key: string]: any;
    };
}

interface Message {
    id: string;
    role: 'user' | 'assistant';
    content: string;
    type?: 'text' | 'code' | 'image' | 'math' | 'mixed' | 'error';
    timestamp: Date;
    agent?: string;
    files?: Array<{ name: string; content: string; language?: string }>;
    executionTime?: number;
    requestId?: string;  // For feedback tracking
    userRating?: 'good' | 'bad' | null;  // User feedback
    deployProjectId?: string;  // For live deploy preview
}

interface KilatChatProps {
    className?: string;
    sessionId?: string;  // External session ID for multi-chat
    onDeployStart?: (projectId: string) => void;
    onFilesGenerated?: (files: Record<string, string>) => void;
    onSessionCreated?: (sessionId: string) => void;  // Notify parent of new session
}

// ============================================================================
// Utilities
// ============================================================================

function generateId(): string {
    return Math.random().toString(36).substring(2, 15);
}

function copyToClipboard(text: string): void {
    navigator.clipboard.writeText(text);
}

function detectLanguage(code: string): string {
    if (!code || typeof code !== 'string') return 'text';
    if (code.includes('import React') || code.includes('useState')) return 'tsx';
    if (code.includes('def ') || code.includes('import ')) return 'python';
    if (code.includes('func ') || code.includes('package ')) return 'go';
    if (code.includes('<?php')) return 'php';
    if (code.includes('const ') || code.includes('function ')) return 'typescript';
    return 'javascript';
}

// ============================================================================
// Code Block Component
// ============================================================================

function CodeBlock({
    code,
    language,
    filename
}: {
    code: string;
    language?: string;
    filename?: string;
}) {
    const [copied, setCopied] = useState(false);
    const detectedLang = language || detectLanguage(code);

    const handleCopy = () => {
        copyToClipboard(code);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    };

    return (
        <div className="relative group rounded-xl overflow-hidden bg-gray-900 border border-white/10">
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-2 bg-gray-800 border-b border-white/10">
                <div className="flex items-center gap-2">
                    <span className="text-xs text-gray-400 font-mono">{filename || detectedLang.toUpperCase()}</span>
                </div>
                <div className="flex gap-2">
                    <button
                        onClick={handleCopy}
                        className="px-3 py-1 text-xs bg-white/10 hover:bg-white/20 rounded-lg transition-colors"
                    >
                        {copied ? '✅ Copied!' : '📋 Copy'}
                    </button>
                </div>
            </div>

            {/* Code */}
            <pre className="p-4 overflow-x-auto text-sm">
                <code className={`language-${detectedLang}`}>{code}</code>
            </pre>
        </div>
    );
}

// ============================================================================
// Message Component
// ============================================================================

function ChatMessage({
    message,
    onFeedback,
    onRegenerate,
    onDeployStart
}: {
    message: Message;
    onFeedback?: (messageId: string, rating: 'good' | 'bad') => void;
    onRegenerate?: (messageId: string) => void;
    onDeployStart?: (projectId: string) => void;
}) {
    const isUser = message.role === 'user';
    const [localRating, setLocalRating] = useState<'good' | 'bad' | null>(message.userRating || null);

    // Render markdown images
    const renderMarkdown = (text: string) => {
        // Extract image URLs from markdown ![alt](url)
        const imageRegex = /!\[([^\]]*)\]\(([^)]+)\)/g;
        const parts: Array<{ type: 'text' | 'image', content: string, alt?: string }> = [];
        let lastIndex = 0;
        let match;

        while ((match = imageRegex.exec(text)) !== null) {
            // Text before image
            if (match.index > lastIndex) {
                parts.push({
                    type: 'text',
                    content: text.slice(lastIndex, match.index)
                });
            }
            // Image
            parts.push({
                type: 'image',
                content: match[2], // URL
                alt: match[1] // Alt text
            });
            lastIndex = match.index + match[0].length;
        }

        // Remaining text
        if (lastIndex < text.length) {
            parts.push({
                type: 'text',
                content: text.slice(lastIndex)
            });
        }

        if (parts.length === 0) {
            return <p className="whitespace-pre-wrap">{text}</p>;
        }

        return parts.map((part, index) => {
            if (part.type === 'image') {
                return (
                    // eslint-disable-next-line @next/next/no-img-element
                    <div key={index} className="my-4">
                        <img
                            src={part.content}
                            alt={part.alt || 'Generated image'}
                            className="max-w-full h-auto rounded-lg border border-white/10"
                            loading="lazy"
                            onError={(e) => {
                                // If image fails to load, try adding a cache-bust or show placeholder
                                const img = e.target as HTMLImageElement;
                                if (!img.dataset.retried) {
                                    img.dataset.retried = 'true';
                                    // Add timestamp to bust cache and retry
                                    img.src = part.content + (part.content.includes('?') ? '&' : '?') + 't=' + Date.now();
                                } else {
                                    // Show placeholder on second failure
                                    img.alt = '⚠️ Image failed to load - Pollinations CDN may be slow. Try refreshing.';
                                    img.style.display = 'none';
                                    img.parentElement?.insertAdjacentHTML('beforeend', `
                                        <div class="p-4 bg-red-500/10 border border-red-500/30 rounded-lg text-red-300 text-sm">
                                            ⚠️ Image failed to load. The Pollinations CDN may be slow.<br/>
                                            <button onclick="this.parentElement.previousElementSibling.style.display='block';this.parentElement.previousElementSibling.src='${part.content}&retry=' + Date.now();this.parentElement.remove()" class="mt-2 px-2 py-1 bg-red-500/20 rounded hover:bg-red-500/30">
                                                🔄 Retry
                                            </button>
                                        </div>
                                    `);
                                }
                            }}
                        />
                        <a
                            href={part.content}
                            download
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-block mt-2 px-3 py-1 text-xs bg-purple-500/20 hover:bg-purple-500/30 text-purple-300 rounded-lg transition-colors"
                        >
                            📥 Download Image
                        </a>
                    </div>
                );
            }
            return <p key={index} className="whitespace-pre-wrap">{part.content}</p>;
        });
    };

    // Special rendering for Progress Messages (Premium UI)
    if (message.role === 'assistant' && typeof message.content === 'string' && message.content.includes('Multi-Agent Progress:')) {
        const progressMatch = message.content.match(/Progress: (\d+)%/);
        const progress = progressMatch ? parseInt(progressMatch[1]) : 0;

        const stepMatch = message.content.match(/📍 (.*)/);
        const step = stepMatch ? stepMatch[1] : 'Processing...';

        const jobIdMatch = message.content.match(/Job ID: (.*)/);
        const jobId = jobIdMatch ? jobIdMatch[1] : 'unknown';

        return (
            <div className="glass rounded-2xl p-5 my-4 border border-purple-500/30 animate-slide-up overflow-hidden relative">
                {/* Background glow effect */}
                <div className="absolute inset-0 bg-gradient-to-br from-purple-600/10 via-transparent to-pink-600/10 pointer-events-none" />

                {/* Header */}
                <div className="flex items-center justify-between mb-4 relative z-10">
                    <div className="flex items-center gap-3">
                        <div className="relative">
                            <div className="w-3 h-3 bg-purple-500 rounded-full animate-ping absolute opacity-75" />
                            <div className="w-3 h-3 bg-purple-500 rounded-full relative" />
                        </div>
                        <span className="font-semibold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
                            KilatAgent Active
                        </span>
                    </div>
                    <span className="text-sm font-mono text-purple-300 tabular-nums">{progress}%</span>
                </div>

                {/* Apple-Style Progress Bar */}
                <div className="h-3 bg-gray-800/60 rounded-full overflow-hidden mb-5 relative shadow-inner">
                    {/* Track glow */}
                    <div className="absolute inset-0 rounded-full ring-1 ring-white/5" />

                    {/* Animated fill with smooth spring-like transition */}
                    <div
                        className="h-full rounded-full relative overflow-hidden"
                        style={{
                            width: `${Math.max(progress, 5)}%`,
                            background: 'linear-gradient(90deg, #8b5cf6 0%, #ec4899 50%, #8b5cf6 100%)',
                            backgroundSize: '200% 100%',
                            transition: 'width 1.5s cubic-bezier(0.4, 0, 0.2, 1)',
                        }}
                    >
                        {/* Shimmer sweep effect */}
                        <div
                            className="absolute inset-0"
                            style={{
                                background: 'linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.4) 50%, transparent 100%)',
                                animation: 'shimmer 2s infinite',
                            }}
                        />
                        {/* Subtle pulse overlay */}
                        <div className="absolute inset-0 bg-white/20 animate-pulse" />
                    </div>

                    {/* Indeterminate mode overlay when progress stalls */}
                    {progress > 0 && progress < 100 && (
                        <div
                            className="absolute inset-0 overflow-hidden rounded-full"
                            style={{ opacity: 0.3 }}
                        >
                            <div
                                className="h-full w-1/3 rounded-full"
                                style={{
                                    background: 'linear-gradient(90deg, transparent, rgba(139,92,246,0.5), transparent)',
                                    animation: 'indeterminate 1.5s infinite ease-in-out',
                                }}
                            />
                        </div>
                    )}
                </div>

                {/* Current Step - Premium Card */}
                <div className="flex items-center gap-3 p-4 bg-gradient-to-r from-white/5 to-transparent rounded-xl border border-white/5 backdrop-blur-sm relative z-10">
                    <div className="text-2xl" style={{ filter: 'drop-shadow(0 0 8px rgba(139,92,246,0.5))' }}>
                        {progress < 30 ? '🧠' : progress < 60 ? '🏗️' : progress < 90 ? '💅' : '✅'}
                    </div>
                    <div className="flex-1 min-w-0">
                        <p className="text-[10px] text-gray-400 uppercase tracking-widest mb-1">Current Action</p>
                        <p className="text-sm text-gray-100 font-medium truncate">{step}</p>
                    </div>
                    {/* Spinner for active state */}
                    {progress < 100 && (
                        <div className="w-5 h-5 border-2 border-purple-500/30 border-t-purple-500 rounded-full animate-spin" />
                    )}
                </div>

                {/* Footer: Job ID */}
                <div className="flex items-center justify-between pt-4 mt-4 border-t border-white/5 relative z-10">
                    <span className="text-[10px] text-gray-500 font-mono">ID: {jobId}</span>
                    <button
                        onClick={() => copyToClipboard(jobId)}
                        className="text-[10px] text-purple-400 hover:text-purple-300 transition-colors flex items-center gap-1 hover:scale-105 active:scale-95"
                    >
                        📋 Copy ID
                    </button>
                </div>

                {/* CSS for custom animations */}
                <style jsx>{`
                    @keyframes shimmer {
                        0% { transform: translateX(-100%); }
                        100% { transform: translateX(200%); }
                    }
                    @keyframes indeterminate {
                        0% { transform: translateX(-100%); }
                        100% { transform: translateX(400%); }
                    }
                `}</style>
            </div>
        );
    }

    // Parse content for code blocks
    const renderContent = () => {
        const content = typeof message.content === 'string'
            ? message.content
            : JSON.stringify(message.content, null, 2);

        // Simple markdown code block detection
        const codeBlockRegex = /```(\w+)?\n([\s\S]*?)```/g;
        const parts: Array<{ type: 'text' | 'code'; content: string; language?: string }> = [];
        let lastIndex = 0;
        let match;

        while ((match = codeBlockRegex.exec(content)) !== null) {
            // Text before code block
            if (match.index > lastIndex) {
                parts.push({
                    type: 'text',
                    content: content.slice(lastIndex, match.index)
                });
            }
            // Code block
            parts.push({
                type: 'code',
                content: match[2].trim(),
                language: match[1] || detectLanguage(match[2])
            });
            lastIndex = match.index + match[0].length;
        }

        // Remaining text after last code block
        if (lastIndex < content.length) {
            parts.push({
                type: 'text',
                content: content.slice(lastIndex)
            });
        }

        if (parts.length === 0) {
            parts.push({ type: 'text', content });
        }

        return parts.map((part, index) => {
            if (part.type === 'code') {
                return (
                    <CodeBlock
                        key={index}
                        code={part.content}
                        language={part.language}
                    />
                );
            }
            return <div key={index}>{renderMarkdown(part.content)}</div>;
        });
    };

    // Generate conversational message for code responses (LOVABLE-STYLE)
    const getConversationalMessage = () => {
        if (!message.files || message.files.length === 0) return null;

        const fileCount = message.files.length;
        const frameworks = message.files.some(f => f.content.includes('import React')) ? 'React' :
            message.files.some(f => f.content.includes('from "next')) ? 'Next.js' :
                message.files.some(f => f.content.includes('vue')) ? 'Vue' : 'JavaScript';

        return `✨ I've created ${fileCount === 1 ? 'a' : fileCount} ${frameworks} ${fileCount === 1 ? 'file' : 'files'} for you. The code is ready to preview on the right panel!`;
    };

    // Render files if present (LOVABLE-STYLE: Collapsible)
    const renderFiles = () => {
        if (!message.files || message.files.length === 0) return null;

        return (
            <details className="mt-4 group">
                <summary className="cursor-pointer list-none">
                    <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-white/5 hover:bg-white/10 rounded-lg transition-colors border border-white/10">
                        <span className="text-sm text-gray-400">📄 View Code</span>
                        <span className="text-xs text-gray-500">({message.files.length} {message.files.length === 1 ? 'file' : 'files'})</span>
                        <svg className="w-4 h-4 text-gray-500 group-open:rotate-180 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                    </div>
                </summary>
                <div className="mt-3 space-y-3">
                    {message.files.map((file, index) => (
                        <CodeBlock
                            key={index}
                            code={file.content}
                            language={file.language}
                            filename={file.name}
                        />
                    ))}
                </div>
            </details>
        );
    };

    const handleFeedback = (rating: 'good' | 'bad') => {
        setLocalRating(rating);
        onFeedback?.(message.id, rating);
    };

    return (
        <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} animate-fade-in`}>
            <div
                className={`max-w-[90%] rounded-2xl px-5 py-4 ${isUser
                    ? 'bg-gradient-to-r from-purple-600 to-pink-500 text-white'
                    : 'bg-gray-800/80 text-gray-100 border border-white/10'
                    }`}
            >
                {/* Agent badge */}
                {!isUser && message.agent && (
                    <div className="flex items-center gap-2 mb-2 text-xs text-gray-400">
                        <span className="px-2 py-0.5 bg-white/10 rounded-full">
                            {message.agent}
                        </span>
                        {message.executionTime && (
                            <span>⚡ {message.executionTime}ms</span>
                        )}
                    </div>
                )}

                {/* Content */}
                <div className="text-sm leading-relaxed">
                    {/* Show conversational message if files exist (Lovable-style) */}
                    {message.files && message.files.length > 0 ? (
                        <div className="space-y-2">
                            <p className="text-base font-medium">{getConversationalMessage()}</p>
                            {message.content && !message.content.includes('```') && (
                                <p className="text-gray-400 text-sm">{message.content}</p>
                            )}
                        </div>
                    ) : (
                        renderContent()
                    )}
                </div>

                {/* Files */}
                {renderFiles()}

                {/* Deploy Button (for code responses with files) */}
                {!isUser && message.files && message.files.length > 0 && (
                    <div className="mt-3">
                        <DeployButton
                            files={Object.fromEntries(
                                message.files.map(f => [f.name, f.content])
                            )}
                            projectName={`Project-${message.id.slice(0, 8)}`}
                            onDeployStart={(projectId) => {
                                console.log('Deploy started:', projectId);
                                onDeployStart?.(projectId);
                            }}
                            onDeployComplete={(projectId, previewUrl) => {
                                console.log('Deploy complete:', previewUrl);
                                // Could update message with deployProjectId here
                            }}
                            onError={(error) => {
                                console.error('Deploy error:', error);
                            }}
                        />
                    </div>
                )}



                {/* Footer: Timestamp + Feedback */}
                <div className="flex items-center justify-between mt-3">
                    <p className="text-xs opacity-50">
                        {message.timestamp.toLocaleTimeString()}
                    </p>

                    {/* Feedback buttons for assistant messages */}
                    {!isUser && (
                        <div className="flex items-center gap-1">
                            {/* Regenerate */}
                            <button
                                onClick={() => onRegenerate?.(message.id)}
                                className="p-1.5 hover:bg-white/10 rounded-lg transition-colors text-gray-400 hover:text-white"
                                title="Regenerate response"
                            >
                                🔄
                            </button>

                            {/* Good rating */}
                            <button
                                onClick={() => handleFeedback('good')}
                                className={`p-1.5 rounded-lg transition-colors ${localRating === 'good'
                                    ? 'bg-green-500/20 text-green-400'
                                    : 'hover:bg-white/10 text-gray-400 hover:text-green-400'
                                    }`}
                                title="Good response"
                            >
                                👍
                            </button>

                            {/* Bad rating */}
                            <button
                                onClick={() => handleFeedback('bad')}
                                className={`p-1.5 rounded-lg transition-colors ${localRating === 'bad'
                                    ? 'bg-red-500/20 text-red-400'
                                    : 'hover:bg-white/10 text-gray-400 hover:text-red-400'
                                    }`}
                                title="Bad response"
                            >
                                👎
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}

// ============================================================================
// Loading Indicator
// ============================================================================

function LoadingIndicator() {
    return (
        <div className="flex justify-start animate-fade-in">
            <div className="bg-gray-800/80 rounded-2xl px-6 py-4 border border-white/10">
                <div className="flex items-center gap-3">
                    <div className="flex gap-1">
                        <div className="w-2 h-2 bg-purple-500 rounded-full animate-bounce" />
                        <div className="w-2 h-2 bg-pink-500 rounded-full animate-bounce [animation-delay:150ms]" />
                        <div className="w-2 h-2 bg-cyan-500 rounded-full animate-bounce [animation-delay:300ms]" />
                    </div>
                    <span className="text-sm text-gray-400">KilatOS is thinking...</span>
                </div>
            </div>
        </div>
    );
}

// ============================================================================
// Main Component
// ============================================================================

export default function KilatChat({
    className = '',
    sessionId: externalSessionId,
    onDeployStart,
    onFilesGenerated,
    onSessionCreated
}: KilatChatProps) {
    const { user } = useAuth(); // Get authenticated user
    const [messages, setMessages] = useState<Message[]>([]);
    const [input, setInput] = useState('');
    const [isLoading, setIsLoading] = useState(false);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    // Processing Steps State (Claude Code Style)
    const [currentStep, setCurrentStep] = useState<string>('Starting...');
    const [jobProgress, setJobProgress] = useState<number>(0);
    const [stepHistory, setStepHistory] = useState<string[]>([]);

    // NEW: Lovable UI state
    const [chatMode, setChatMode] = useState<ChatMode>('planning');
    const [selectedModel, setSelectedModel] = useState<PollinationModel>('gemini-fast');
    const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
    const [userTier, setUserTier] = useState<UserTier>('free');

    // NEW: Fetch user tier from API on mount
    // This enables dynamic tier-based model filtering
    useEffect(() => {
        const fetchUserTier = async () => {
            try {
                const res = await fetch('/api/models?type=text');
                const data = await res.json();
                if (data.success && data.userTier) {
                    console.log(`🔓 User tier detected: ${data.userTier}`);
                    setUserTier(data.userTier);

                    // Auto-select default model for tier if available
                    if (data.models && data.models.length > 0) {
                        const defaultModel = data.selected || data.models[0].model_id;
                        setSelectedModel(defaultModel as PollinationModel);
                    }
                }
            } catch (error) {
                console.error('Failed to fetch user tier:', error);
                // Keep 'free' as fallback
            }
        };

        fetchUserTier();
    }, []);

    // Session ID - use external prop if provided, otherwise use localStorage
    const [internalSessionId] = useState<string>(() => {
        if (typeof window !== 'undefined') {
            const stored = localStorage.getItem('kilat_session_id');
            if (stored) return stored;
            const newId = `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
            localStorage.setItem('kilat_session_id', newId);
            return newId;
        }
        return `sess_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    });

    // Use external sessionId if provided, otherwise use internal
    const sessionId = externalSessionId || internalSessionId;

    // Update localStorage when external sessionId changes
    useEffect(() => {
        if (externalSessionId && typeof window !== 'undefined') {
            localStorage.setItem('kilat_session_id', externalSessionId);
        }
    }, [externalSessionId]);

    // Auto-scroll
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    // Focus input on mount
    useEffect(() => {
        inputRef.current?.focus();
    }, []);


    // Load history on mount
    useEffect(() => {
        const loadHistory = async () => {
            if (!sessionId) return;

            try {
                console.log('🔄 Loading history for session:', sessionId);
                const res = await fetch(`/api/kilat/history?sessionId=${sessionId}`);
                const data = await res.json();

                if (data.success && Array.isArray(data.messages) && data.messages.length > 0) {
                    console.log(`✅ Restored ${data.messages.length} messages`);
                    // Convert timestamp strings back to Date objects
                    const restoredMessages = data.messages.map((m: any) => ({
                        ...m,
                        timestamp: new Date(m.timestamp)
                    }));
                    setMessages(restoredMessages);

                    // FIX: Restore WebContainer files from latest message
                    const lastMessageWithFiles = [...restoredMessages].reverse().find(m => m.files && m.files.length > 0);
                    if (lastMessageWithFiles && onFilesGenerated) {
                        console.log('📂 Restoring WebContainer files from history:', lastMessageWithFiles.files.length);
                        const fileMap = Object.fromEntries(
                            lastMessageWithFiles.files.map((f: any) => [f.name, f.content])
                        );
                        onFilesGenerated(fileMap);
                    }
                }
            } catch (error) {
                console.error('Failed to load history:', error);
            }
        };

        loadHistory();
    }, [sessionId]);

    // Submit handler with async polling for long tasks
    const handleSubmit = useCallback(async (e: React.FormEvent) => {
        e.preventDefault();
        if (!input.trim() || isLoading) return;

        const userMessage: Message = {
            id: generateId(),
            role: 'user',
            content: input.trim(),
            timestamp: new Date(),
        };

        setMessages(prev => [...prev, userMessage]);
        setInput('');
        setIsLoading(true);

        // UNIFIED ARCHITECTURE: "Everything is a Job"
        // User request: "mau jalur apapun... semua harus ada jobid dan loading animasi"
        // Solution: Force ALL requests to use Async/Queue system.
        try {
            await handleAsyncTask(userMessage.content);
        } catch (error) {
            const errorMessage: Message = {
                id: generateId(),
                role: 'assistant',
                content: `Error: ${error instanceof Error ? error.message : 'Connection failed'}`,
                type: 'error',
                timestamp: new Date(),
                agent: 'System',
            };
            setMessages(prev => [...prev, errorMessage]);
        } finally {
            setIsLoading(false);
            inputRef.current?.focus();
        }
    }, [input, isLoading]);

    // Async task handler with polling
    const handleAsyncTask = async (message: string) => {
        // Show pending message
        const pendingId = generateId();
        setMessages(prev => [...prev, {
            id: pendingId,
            role: 'assistant',
            content: '🚀 Starting multi-agent orchestration...\n\nThis may take 2-5 minutes. Progress will update below.',
            type: 'text',
            timestamp: new Date(),
            agent: 'KilatCode (Multi-Agent)',
        }]);

        // Submit job with mode and model
        const submitRes = await fetch('/api/kilat/async', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                message,
                userId: user!.id, // REQUIRED - auth is mandatory
                sessionId,  // NEW: For conversation context persistence
                mode: chatMode,  // 'planning' | 'fast'
                model: selectedModel,  // User-selected LLM model
                attachedFiles: attachedFiles.length > 0 ? attachedFiles : undefined,
            }),
        });

        const submitData = await submitRes.json();

        if (!submitData.success || !submitData.jobId) {
            throw new Error(submitData.error || 'Failed to submit job');
        }

        const jobId = submitData.jobId;

        // Poll for status (Faster polling for real-time feel)
        let completed = false;
        let pollCount = 0;

        while (!completed) {
            await new Promise(resolve => setTimeout(resolve, 800)); // 0.8s polling
            pollCount++;

            try {
                const statusRes = await fetch(`/api/kilat/status?jobId=${jobId}`);

                // Check if response is ok before parsing
                if (!statusRes.ok) {
                    if (pollCount % 5 === 0) console.warn('Status check network error');
                    continue;
                }

                const statusData = await statusRes.json();

                if (!statusData.success) {
                    if (statusData.error === 'Job not found') {
                        throw new Error('Job lost in queue. Please try again.');
                    }
                    // Continue polling if job not ready yet
                    continue;
                }

                // Update UI with progress
                if (statusData.job) {
                    const job = statusData.job;
                    const progress = job.progress || 0;
                    const step = job.currentStep || 'Processing...';

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

                    if (job.status === 'completed') {
                        completed = true;

                        // Remove the pending message
                        setMessages(prev => prev.filter(m => m.id !== pendingId));

                        // Add response message
                        const responseMessage: Message = {
                            id: generateId(),
                            role: 'assistant',
                            content: job.result?.content || 'Task completed',
                            type: job.result?.files ? 'code' : 'text',
                            timestamp: new Date(),
                            agent: job.agent_type || 'KilatAgent',
                            files: job.result?.files ? Object.entries(job.result.files).map(([name, content]) => ({
                                name,
                                content: content as string,
                                language: detectLanguage(content as string)
                            })) : undefined,
                            executionTime: job.metadata?.executionTime,
                            requestId: job.id
                        };
                        setMessages(prev => [...prev, responseMessage]);

                        // Trigger file generated callback if provided
                        if (job.result?.files && onFilesGenerated) {
                            onFilesGenerated(job.result.files as Record<string, string>);
                        }

                    } else if (job.status === 'failed') {
                        completed = true;
                        // Remove pending message
                        setMessages(prev => prev.filter(m => m.id !== pendingId));
                        throw new Error(job.error_message || 'Job failed');
                    }
                }
            } catch (error) {
                console.error('Polling error:', error);
                // Continue polling unless it's a critical error or timeout
                if (pollCount > 300) { // Timeout
                    completed = true;
                    throw new Error('Operation timed out');
                }
            }
        }
    };

    // Handle user feedback (👍/👎)
    const handleFeedback = async (messageId: string, rating: 'good' | 'bad') => {
        // Update local state
        setMessages(prev => prev.map(m =>
            m.id === messageId ? { ...m, userRating: rating } : m
        ));

        // Send feedback to API
        try {
            await fetch('/api/kilat/feedback', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    messageId,
                    rating,
                    score: rating === 'good' ? 100 : 20
                }),
            });
            console.log(`✅ Feedback submitted: ${rating} for ${messageId}`);
        } catch (error) {
            console.error('Feedback submission failed:', error);
        }
    };

    // Handle regenerate (🔄) - with debounce
    const [isRegenerating, setIsRegenerating] = useState(false);
    const handleRegenerate = async (messageId: string) => {
        // DEBOUNCE: Prevent double click
        if (isRegenerating || isLoading) return;
        setIsRegenerating(true);

        try {
            // Find the user message before this assistant message
            const messageIndex = messages.findIndex(m => m.id === messageId);
            if (messageIndex <= 0) return;

            const userMessage = messages[messageIndex - 1];
            if (userMessage.role !== 'user') return;

            // Remove the old response
            setMessages(prev => prev.slice(0, messageIndex));

            // Re-submit the user message
            setInput(userMessage.content);
            setTimeout(() => {
                const form = document.querySelector('form');
                form?.dispatchEvent(new Event('submit', { bubbles: true }));
            }, 100);
        } finally {
            // Reset after short delay to prevent rapid re-clicks
            setTimeout(() => setIsRegenerating(false), 2000);
        }
    };

    return (
        <div className={`flex flex-col h-full bg-gray-900/50 rounded-2xl overflow-hidden backdrop-blur-xl border border-white/10 ${className}`}>
            {/* Header */}
            <div className="px-6 py-4 bg-gray-800/80 border-b border-white/10">
                <div className="flex items-center gap-3">
                    <span className="text-2xl">⚡</span>
                    <div>
                        <h2 className="text-xl font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent">
                            KilatOS
                        </h2>
                        <p className="text-xs text-gray-400">
                            9 AI agents at your service • Auto-routing enabled
                        </p>
                    </div>
                </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
                {messages.length === 0 ? (
                    <div className="flex flex-col items-center justify-center h-full text-center">
                        <div className="text-6xl mb-4 opacity-30">⚡</div>
                        <h3 className="text-lg font-medium text-gray-300 mb-2">
                            Welcome to KilatOS
                        </h3>
                        <p className="text-sm text-gray-500 max-w-md">
                            Just type anything - I'll automatically route to the right AI agent.
                        </p>
                        <div className="flex flex-wrap gap-2 mt-6 max-w-md justify-center">
                            {[
                                '💻 "Buatkan landing page"',
                                '🧮 "Hitung integral x²"',
                                '📚 "Jelaskan React hooks"',
                                '✍️ "Tulis artikel SEO"',
                            ].map((suggestion, i) => (
                                <button
                                    key={i}
                                    onClick={() => setInput(suggestion.split('"')[1])}
                                    className="px-3 py-1.5 text-xs bg-white/5 hover:bg-white/10 rounded-lg transition-colors"
                                >
                                    {suggestion}
                                </button>
                            ))}
                        </div>
                    </div>
                ) : (
                    messages.map((message) => (
                        <ChatMessage
                            key={message.id}
                            message={message}
                            onFeedback={handleFeedback}
                            onRegenerate={handleRegenerate}
                            onDeployStart={onDeployStart}
                        />
                    ))
                )}

                <div ref={messagesEndRef} />
            </div>

            {/* Processing Indicator (Pinned to bottom of chat area if loading) */}
            {isLoading && (
                <div className="absolute bottom-32 left-0 right-0 px-6 z-20 pointer-events-none">
                    <div className="max-w-3xl mx-auto pointer-events-auto">
                        <ProcessingSteps
                            isProcessing={isLoading}
                            currentStep={currentStep}
                            progress={jobProgress}
                            stepHistory={stepHistory}
                        />
                    </div>
                </div>
            )}

            {/* Lovable-Style Input Bar */}
            <div className="bg-gray-800/80 border-t border-white/10 z-30 relative">
                {/* Attached Files Preview */}
                {attachedFiles.length > 0 && (
                    <AttachedFilesList
                        files={attachedFiles}
                        onRemove={(id) => setAttachedFiles(prev => prev.filter(f => f.id !== id))}
                    />
                )}

                {/* Main Input Row */}
                <form onSubmit={handleSubmit} className="p-3">
                    <div className="flex items-center gap-2">
                        {/* Left: Attach button only */}
                        <div className="flex items-center">
                            <AttachButton
                                attachedFiles={attachedFiles}
                                onFilesChange={setAttachedFiles}
                            />
                        </div>

                        {/* Center: Input field */}
                        <input
                            ref={inputRef}
                            type="text"
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            placeholder="Ask anything... (auto-routes to best agent)"
                            disabled={isLoading}
                            className="flex-1 px-4 py-2.5 bg-gray-900/50 rounded-lg border border-white/10 
                                           text-white placeholder-gray-500 focus:outline-none focus:border-purple-500
                                           disabled:opacity-50 transition-colors text-sm"
                        />

                        {/* Right: Mode, Model, Send - NO SHRINK to prevent cut-off */}
                        <div className="flex items-center gap-2 flex-shrink-0">
                            <ModeToggle
                                currentMode={chatMode}
                                onModeChange={setChatMode}
                            />
                            <ModelSelector
                                currentModel={selectedModel}
                                userTier={userTier}
                                onModelChange={(model) => setSelectedModel(model as PollinationModel)}
                            />
                            <button
                                type="submit"
                                disabled={isLoading || !input.trim()}
                                className="p-2.5 bg-gradient-to-r from-purple-600 to-pink-500 rounded-lg
                                               text-white hover:opacity-90 disabled:opacity-50 
                                               disabled:cursor-not-allowed transition-opacity flex-shrink-0"
                            >
                                {isLoading ? (
                                    <span className="w-5 h-5 block border-2 border-white/30 border-t-white rounded-full animate-spin" />
                                ) : (
                                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                                    </svg>
                                )}
                            </button>
                        </div>
                    </div>
                </form>
            </div>
        </div>
    );
}
