/**
 * WorkspacePanel Component
 *
 * The Right-Side Panel in the Split-Screen Layout.
 * Handles:
 * - WebContainer Preview (Node.js runtime) for React/JS/TS/Express
 * - Console Output (Piston API) for Python, Go, PHP, etc.
 * - Deployed Preview (Vercel)
 *
 * Updated: 2026-01-08 - Migrated from Sandpack to WebContainer
 *
 * Copyright © 2026 KilatOS
 */

'use client';

import { useState, useMemo } from 'react';
import dynamic from 'next/dynamic';
import DeployPreview from './DeployPreview';
import WebContainerPreview from './WebContainerPreview';
import ConsoleOutput from './ConsoleOutput';

// Dynamic import for Monaco (no SSR - avoids hydration issues)
const CodeEditor = dynamic(() => import('./ui/CodeEditor'), {
    ssr: false,
    loading: () => (
        <div className="flex items-center justify-center h-full bg-[#1e1e1e] text-slate-400">
            <div className="flex flex-col items-center gap-2">
                <div className="animate-spin w-6 h-6 border-2 border-accent-purple border-t-transparent rounded-full"></div>
                <span className="text-sm">Loading editor...</span>
            </div>
        </div>
    ),
});

interface WorkspacePanelProps {
    projectId: string | null;
    files: Record<string, string> | null;
    activeFile?: string | null;
    onFileChange?: (filename: string, content: string) => void;
    onServerReady?: (url: string) => void;
    className?: string;
}

// Language detection from file extensions
// WebContainer handles: JS, TS, JSX, TSX, HTML, CSS (all web files)
const WEBCONTAINER_EXTENSIONS = ['.tsx', '.jsx', '.js', '.ts', '.html', '.css', '.json', '.mjs', '.cjs'];
// Console (Piston API) handles: backend languages without browser runtime
const CONSOLE_EXTENSIONS = ['.py', '.go', '.php', '.rb', '.rs', '.java', '.cpp', '.c'];

type PreviewMode = 'webcontainer' | 'console' | 'none';

export default function WorkspacePanel({
    projectId,
    files,
    activeFile,
    onFileChange,
    onServerReady,
    className = ''
}: WorkspacePanelProps) {
    const [activeTab, setActiveTab] = useState<'preview' | 'editor' | 'deployed'>('preview');
    const [previewUrl, setPreviewUrl] = useState<string | null>(null);

    // Detect preview mode based on file extensions
    const previewMode = useMemo<PreviewMode>(() => {
        if (!files || Object.keys(files).length === 0) return 'none';

        const filePaths = Object.keys(files);

        // Check for WebContainer-compatible files (priority)
        const hasWebFiles = filePaths.some(path =>
            WEBCONTAINER_EXTENSIONS.some(ext => path.endsWith(ext))
        );

        if (hasWebFiles) return 'webcontainer';

        // Check for console languages
        const hasConsoleFiles = filePaths.some(path =>
            CONSOLE_EXTENSIONS.some(ext => path.endsWith(ext))
        );

        if (hasConsoleFiles) return 'console';

        // Default to webcontainer for unknown (can serve static files)
        return 'webcontainer';
    }, [files]);

    // Detect language for console mode
    const detectedLanguage = useMemo<string | undefined>(() => {
        if (previewMode !== 'console' || !files) return undefined;

        const langMap: Record<string, string> = {
            '.py': 'python',
            '.go': 'go',
            '.php': 'php',
            '.rb': 'ruby',
            '.rs': 'rust',
            '.java': 'java',
            '.cpp': 'cpp',
            '.c': 'c',
        };

        const filePaths = Object.keys(files);
        for (const path of filePaths) {
            for (const [ext, lang] of Object.entries(langMap)) {
                if (path.endsWith(ext)) return lang;
            }
        }

        return undefined;
    }, [files, previewMode]);

    // Show "Preview" tab if files exist
    const hasPreview = files && Object.keys(files).length > 0;
    const hasDeployment = !!projectId;
    const activeFileContent = (files && activeFile) ? files[activeFile] : null;

    // DEBUG
    console.log('[WorkspacePanel] files:', files ? Object.keys(files) : 'null');
    console.log('[WorkspacePanel] activeFile:', activeFile);

    // Empty state: No files and no deployment
    if (!hasPreview && !hasDeployment) {
        return (
            <div className={`flex flex-col items-center justify-center bg-gray-900/50 border-l border-white/5 backdrop-blur-xl p-8 text-center ${className}`}>
                <div className="max-w-md space-y-6">
                    {/* Empty State Illustration */}
                    <div className="relative w-32 h-32 mx-auto opacity-50">
                        <div className="absolute inset-0 bg-purple-500/20 rounded-full animate-pulse" />
                        <div className="absolute inset-4 bg-gray-900 rounded-full flex items-center justify-center border border-white/10">
                            <span className="text-4xl">⚡</span>
                        </div>
                    </div>

                    <div>
                        <h2 className="text-xl font-display font-bold bg-gradient-to-r from-purple-400 to-pink-400 bg-clip-text text-transparent mb-2 uppercase tracking-wide">
                            Ready to Build
                        </h2>
                        <p className="text-sm text-gray-400 leading-relaxed">
                            Generate code in the chat, then see your live preview here instantly.
                            <br />
                            Try asking: <span className="text-white">"Generate website landing page crypto"</span>
                        </p>
                    </div>

                    <div className="grid grid-cols-2 gap-4 text-xs text-gray-500">
                        <div className="p-3 bg-white/5 rounded-lg border border-white/5">
                            <span className="block mb-1 text-purple-400">⚡ WebContainer</span>
                            Live Node.js in browser
                        </div>
                        <div className="p-3 bg-white/5 rounded-lg border border-white/5">
                            <span className="block mb-1 text-green-400">🖥️ Console</span>
                            Python, Go, PHP output
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    return (
        <div className={`flex flex-col bg-gray-900 border-l border-white/10 ${className}`}>
            {/* Tab Header */}
            {(hasPreview || hasDeployment) && (
                <div className="flex border-b border-white/10 bg-gray-800/50">
                    {/* Code Editor Tab */}
                    {hasPreview && (
                        <button
                            onClick={() => setActiveTab('editor')}
                            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${activeTab === 'editor'
                                ? 'bg-gray-900 text-primary border-b-2 border-primary'
                                : 'text-gray-400 hover:text-gray-300 hover:bg-gray-800/80'
                                }`}
                        >
                            <span className="flex items-center justify-center gap-2">
                                <span className="material-symbols-outlined text-sm">code</span>
                                <span>Code</span>
                                {activeFile && (
                                    <span className="text-[10px] opacity-60 bg-white/5 px-1.5 py-0.5 rounded truncate max-w-[100px]">
                                        {activeFile.split('/').pop()}
                                    </span>
                                )}
                            </span>
                        </button>
                    )}

                    {/* Preview Tab */}
                    {hasPreview && (
                        <button
                            onClick={() => setActiveTab('preview')}
                            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${activeTab === 'preview'
                                ? 'bg-gray-900 text-purple-400 border-b-2 border-purple-500'
                                : 'text-gray-400 hover:text-gray-300 hover:bg-gray-800/80'
                                }`}
                        >
                            <span className="flex items-center justify-center gap-2">
                                <span className="material-symbols-outlined text-sm">visibility</span>
                                <span>Preview</span>
                            </span>
                        </button>
                    )}

                    {/* Deployed Tab */}
                    {hasDeployment && (
                        <button
                            onClick={() => setActiveTab('deployed')}
                            className={`flex-1 px-4 py-3 text-sm font-medium transition-colors ${activeTab === 'deployed'
                                ? 'bg-gray-900 text-pink-400 border-b-2 border-pink-500'
                                : 'text-gray-400 hover:text-gray-300 hover:bg-gray-800/80'
                                }`}
                        >
                            <span className="flex items-center justify-center gap-2">
                                <span className="material-symbols-outlined text-sm">rocket_launch</span>
                                <span>Deployed</span>
                            </span>
                        </button>
                    )}
                </div>
            )}

            {/* Tab Content */}
            <div className="flex-1 overflow-hidden">
                {/* Editor Tab */}
                {activeTab === 'editor' && (
                    <CodeEditor
                        files={files || {}}
                        activeFile={activeFile || null}
                        onFileChange={onFileChange}
                        className="h-full"
                    />
                )}

                {/* Preview Tab - WebContainer or Console based on file type */}
                {activeTab === 'preview' && hasPreview && (
                    <div className="h-full flex flex-col">
                        {/* URL bar handled by WebContainerPreview */}

                        {/* Preview Content */}
                        <div className="flex-1 min-h-0">
                            {previewMode === 'webcontainer' && (
                                <WebContainerPreview
                                    files={files!}
                                    className="h-full"
                                    onServerReady={(url) => {
                                        setPreviewUrl(url);
                                        onServerReady?.(url);
                                    }}
                                />
                            )}
                            {previewMode === 'console' && (
                                <ConsoleOutput
                                    files={files}
                                    language={detectedLanguage}
                                    autoRun={true}
                                />
                            )}
                        </div>
                    </div>
                )}

                {/* Deployed Preview Tab */}
                {activeTab === 'deployed' && hasDeployment && (
                    <div className="h-full p-4">
                        <div className="h-full rounded-xl overflow-hidden bg-gray-800/50 border border-white/10 shadow-2xl relative">
                            <DeployPreview
                                projectId={projectId}
                                onClose={() => console.log('Close preview')}
                            />
                        </div>
                    </div>
                )}
            </div>
        </div>
    );
}
