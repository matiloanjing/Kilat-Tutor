/**
 * WebContainerPreview Component
 *
 * Full Node.js runtime in the browser using WebContainer API.
 * Drop-in replacement for InstantPreview (Sandpack).
 *
 * Features:
 * - Multi-framework support (Express, Vite, Next.js, Static)
 * - npm install in-browser
 * - Live preview with navigation
 * - Collapsible terminal
 *
 * Copyright © 2026 KilatOS
 */

'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { WebContainer } from '@webcontainer/api';
import { Loader2, Terminal, RefreshCw, ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';

// === GLOBAL SINGLETON ===
// Prevents "WebContainer can only be booted once" error in React Strict Mode
// Using window object to survive hot reloads (module-level vars reset on HMR)
let webcontainerBootPromise: Promise<WebContainer> | null = null;
let webcontainerInstance: WebContainer | null = null;

// Get/set global instance (survives hot reload)
function getGlobalWebContainer(): WebContainer | null {
    if (typeof window !== 'undefined') {
        return (window as any).__KILAT_WEBCONTAINER_INSTANCE__ || null;
    }
    return webcontainerInstance;
}

function setGlobalWebContainer(instance: WebContainer): void {
    webcontainerInstance = instance;
    if (typeof window !== 'undefined') {
        (window as any).__KILAT_WEBCONTAINER_INSTANCE__ = instance;
    }
}

// === TYPES ===
export type ContainerStatus = 'idle' | 'booting' | 'mounting' | 'installing' | 'starting' | 'ready' | 'error';
export type FrameworkTemplate = 'express' | 'vite' | 'nextjs' | 'static';

export interface WebContainerPreviewProps {
    /** Files to mount in the container: { '/path/to/file': 'content' } */
    files: Record<string, string>;
    /** Framework template (auto-detected if not specified) */
    template?: FrameworkTemplate;
    /** Callback when files change in the editor (future use) */
    onCodeChange?: (newFiles: Record<string, string>) => void;
    /** Callback when server is ready */
    onServerReady?: (url: string) => void;
    /** Additional CSS classes */
    className?: string;
}

// === TEMPLATE DETECTION ===
function detectFramework(files: Record<string, string>): FrameworkTemplate {
    const packageJsonContent = files['package.json'] || files['/package.json'];
    if (!packageJsonContent) {
        // Check for static HTML
        if (files['index.html'] || files['/index.html']) {
            return 'static';
        }
        return 'express'; // Default
    }

    try {
        const pkg = JSON.parse(packageJsonContent);
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        if (deps.next) return 'nextjs';
        if (deps.vite) return 'vite';

        // CRITICAL FIX: Treat Create React App (react-scripts) as Vite
        // CRA doesn't work in WebContainer, but Vite does
        // We'll auto-convert by injecting vite bootstrap files
        if (deps['react-scripts']) {
            console.log('🔄 [WebContainer] Detected Create React App → Converting to Vite for compatibility');
            return 'vite';
        }

        // React without bundler → assume Vite
        if (deps.react && !deps.express) {
            console.log('🔄 [WebContainer] Detected React → Using Vite bundler');
            return 'vite';
        }

        if (deps.express) return 'express';
    } catch {
        // Invalid JSON, fallback
    }

    return 'express';
}

// === GENERATE PACKAGE.JSON ===
function generatePackageJson(framework: FrameworkTemplate, existingPackageJson?: string): string {
    const templates: Record<FrameworkTemplate, object> = {
        express: {
            name: 'kilat-app',
            type: 'module',
            dependencies: { express: 'latest', cors: 'latest' },
            scripts: { start: 'node index.js' }
        },
        vite: {
            name: 'kilat-vite-app',
            type: 'module',
            dependencies: {
                // NOTE: Synced with project package.json (2026-01-09)
                'react': '^18.3.1',
                'react-dom': '^18.3.1',
                'lucide-react': 'latest',
                'framer-motion': 'latest'
            },
            devDependencies: {
                'vite': '^5.0.0',
                '@vitejs/plugin-react': '^4.2.0',
                'autoprefixer': 'latest',
                'postcss': 'latest',
                'tailwindcss': 'latest'
            },
            scripts: { dev: 'vite --host', build: 'vite build' }
        },
        nextjs: {
            name: 'kilat-next-app',
            dependencies: { next: 'latest', react: 'latest', 'react-dom': 'latest' },
            scripts: { dev: 'next dev' }
        },
        static: {
            name: 'kilat-static',
            dependencies: { 'serve': 'latest' },
            scripts: { start: 'serve .' }
        }
    };

    // FIX: Merge scripts from template if AI package.json is missing required scripts
    if (existingPackageJson) {
        try {
            const existing = JSON.parse(existingPackageJson);
            const template = templates[framework] as any;

            // Ensure scripts object exists
            if (!existing.scripts) {
                existing.scripts = {};
            }

            // Inject missing scripts from template (dev, start, build)
            if (template.scripts) {
                for (const [key, value] of Object.entries(template.scripts)) {
                    if (!existing.scripts[key]) {
                        existing.scripts[key] = value;
                        console.log(`📦 [WebContainer] Injected missing script: ${key}`);
                    }
                }
            }

            // Ensure devDependencies for vite
            if (framework === 'vite' && template.devDependencies) {
                existing.devDependencies = existing.devDependencies || {};
                for (const [pkg, ver] of Object.entries(template.devDependencies)) {
                    if (!existing.devDependencies[pkg]) {
                        existing.devDependencies[pkg] = ver;
                    }
                }
            }

            return JSON.stringify(existing, null, 2);
        } catch {
            // If parse fails, use template
        }
    }

    return JSON.stringify(templates[framework], null, 2);
}

// === VITE BOOTSTRAP FILES ===
// Injects required files for vite to run (index.html, main.jsx, vite.config.js)
function injectViteBootstrap(mountFiles: any, framework: FrameworkTemplate): void {
    if (framework !== 'vite') return;

    // Inject index.html if missing
    if (!mountFiles['index.html']) {
        mountFiles['index.html'] = {
            file: {
                contents: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Kilat Preview</title>
</head>
<body>
    <div id="root"></div>
    <script type="module" src="/main.jsx"></script>
</body>
</html>`
            }
        };
    }

    // Check if App.tsx or App.jsx exists
    const hasAppFile = mountFiles['App.tsx'] || mountFiles['App.jsx'] || mountFiles['app.tsx'] || mountFiles['app.jsx'];

    // Find first available JSX/TSX component if no App file
    let entryComponent = 'App';
    let entryImport = './App.jsx';

    if (!hasAppFile) {
        // Look for any .jsx or .tsx file to use as entry
        const jsxFiles = Object.keys(mountFiles).filter(f =>
            (f.endsWith('.jsx') || f.endsWith('.tsx')) &&
            !f.includes('main') && !f.includes('index')
        );

        if (jsxFiles.length > 0) {
            // Use first JSX file as main component
            const firstFile = jsxFiles[0];
            entryComponent = firstFile.replace(/\.(jsx|tsx)$/, '');
            entryImport = `./${firstFile}`;

            // Also create App.jsx that imports all components
            const imports = jsxFiles.map((f, i) => {
                const name = f.replace(/\.(jsx|tsx)$/, '').replace(/[^a-zA-Z0-9]/g, '');
                return `import Component${i + 1} from './${f}';`;
            }).join('\n');

            const components = jsxFiles.map((_, i) => `<Component${i + 1} />`).join('\n                ');

            mountFiles['App.jsx'] = {
                file: {
                    contents: `${imports}

export default function App() {
    return (
        <div>
            <h1>🚀 Kilat Preview</h1>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
                ${components}
            </div>
        </div>
    );
}`
                }
            };
            entryComponent = 'App';
            entryImport = './App.jsx';
        } else {
            // No JSX files found, create default App
            mountFiles['App.jsx'] = {
                file: {
                    contents: `export default function App() {
    return (
        <div style={{ padding: '20px', fontFamily: 'sans-serif' }}>
            <h1>🚀 Kilat Preview</h1>
            <p>Your code is loading...</p>
        </div>
    );
}`
                }
            };
        }
    } else {
        // App file exists, use it
        entryImport = mountFiles['App.tsx'] || mountFiles['app.tsx'] ? './App.tsx' : './App.jsx';
    }

    // Inject main.jsx if missing
    if (!mountFiles['main.jsx']) {
        mountFiles['main.jsx'] = {
            file: {
                contents: `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '${entryImport}';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);`
            }
        };
    }

    // FIX: Inject index.css if missing (prevents "Failed to resolve import" error)
    if (!mountFiles['index.css']) {
        mountFiles['index.css'] = {
            file: {
                contents: `/* Auto-generated by KilatOS */\n* { box-sizing: border-box; margin: 0; padding: 0; }\nbody { font-family: system-ui, sans-serif; }\n`
            }
        };
        console.log('🎨 [WebContainer] Injected missing index.css');
    }

    // Inject vite.config.js if missing
    if (!mountFiles['vite.config.js']) {
        mountFiles['vite.config.js'] = {
            file: {
                contents: `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    server: {
        host: true,
        port: 5173
    }
});`
            }
        };
    }
}

// === GET START COMMAND ===
function getStartCommand(framework: FrameworkTemplate): { cmd: string; args: string[] } {
    switch (framework) {
        case 'vite':
            return { cmd: 'npm', args: ['run', 'dev'] };
        case 'nextjs':
            return { cmd: 'npm', args: ['run', 'dev'] };
        case 'static':
            return { cmd: 'npx', args: ['serve', '.'] };
        case 'express':
        default:
            return { cmd: 'npm', args: ['start'] };
    }
}

// === SANITIZE JSX/TSX SYNTAX ===
// Fix common AI-generated code syntax errors (like Lovable/Bolt does)
function sanitizeJSXSyntax(content: string, filename: string): string {
    // Only process JSX/TSX/JS/TS files
    if (!/\.(jsx?|tsx?)$/.test(filename)) return content;

    let fixed = content;
    let fixCount = 0;

    // 1. Fix malformed imports: `import { useState from 'react'` -> `import { useState } from 'react'`
    fixed = fixed.replace(/import\s*\{\s*([^}]+)\s+from\s+(['"])/g, (match, imports, quote) => {
        fixCount++;
        return `import { ${imports.trim()} } from ${quote}`;
    });

    // 2. Fix missing semicolons after imports
    fixed = fixed.replace(/(import\s+.*?from\s+['"][^'"]+['"])(?!\s*;)(\s*\n)/g, (match, importStmt, newline) => {
        fixCount++;
        return `${importStmt};${newline}`;
    });

    // 3. Fix incomplete interface/type definitions (common AI cutoff)
    // Pattern: `interface X {\n  prop: string\n` (missing closing brace)
    // This is harder to fix generically, so we just ensure basic structure

    // 4. Fix dangling commas in object/array (not an error in JS, but clean up)
    fixed = fixed.replace(/,(\s*[}\]])/g, '$1');

    // 5. Fix double semicolons
    fixed = fixed.replace(/;;+/g, ';');

    // 6. Fix common JSX issues: self-closing tags without space
    fixed = fixed.replace(/<(\w+)([^>]*[^\s\/])\/>/g, '<$1$2 />');

    // 7. Fix missing closing tags for common elements (basic heuristic)
    // This is complex - skip for now, let Vite handle it

    // 8. Remove BOM and weird Unicode characters
    fixed = fixed.replace(/^\uFEFF/, '');
    fixed = fixed.replace(/[\u200B-\u200F\uFEFF]/g, '');

    // 9. Fix React component without return (add return if function body is JSX)
    // Pattern: `function App() {\n  <div>` -> `function App() {\n  return (<div>`
    fixed = fixed.replace(
        /((?:function\s+\w+|const\s+\w+\s*=\s*(?:\([^)]*\)|[^=]+)\s*=>)\s*\{)\s*\n(\s*)(<[A-Z])/g,
        '$1\n$2return (\n$2  $3'
    );

    // 10. Ensure export default exists for main component files
    if (/App\.(jsx?|tsx?)$/.test(filename) && !fixed.includes('export default')) {
        // Find the main function/const component
        const componentMatch = fixed.match(/(?:function|const)\s+(\w+)/);
        if (componentMatch) {
            const componentName = componentMatch[1];
            // Add export default at end if not present
            if (!fixed.includes(`export default ${componentName}`)) {
                fixed = fixed.trimEnd() + `\n\nexport default ${componentName};\n`;
                fixCount++;
            }
        }
    }

    if (fixCount > 0) {
        console.log(`🔧 [SyntaxFix] Fixed ${fixCount} issues in ${filename}`);
    }

    return fixed;
}

// === SANITIZE FILE PATH ===
// Fixes: "Error: EIO: invalid file name" in WebContainer
function sanitizeFilePath(path: string): string {
    // Remove leading/trailing whitespace
    let sanitized = path.trim();

    // Normalize slashes
    sanitized = sanitized.replace(/\\/g, '/');

    // Remove leading slash (WebContainer uses relative paths)
    sanitized = sanitized.replace(/^\/+/, '');

    // Remove any invisible/control characters (common AI generation issue)
    sanitized = sanitized.replace(/[\x00-\x1F\x7F-\x9F]/g, '');

    // Remove any duplicate slashes
    sanitized = sanitized.replace(/\/+/g, '/');

    // Validate and clean each path segment
    const segments = sanitized.split('/').filter(Boolean);
    const cleanedSegments = segments.map(segment => {
        // Remove invalid characters for file names
        return segment.replace(/[<>:"|?*]/g, '').trim();
    });

    return cleanedSegments.join('/');
}

// === MAIN COMPONENT ===
export default function WebContainerPreview({
    files,
    template,
    onCodeChange,
    onServerReady,
    className = ''
}: WebContainerPreviewProps) {
    // State
    const [status, setStatus] = useState<ContainerStatus>('idle');
    const [previewUrl, setPreviewUrl] = useState<string>('');
    const [logs, setLogs] = useState<string[]>([]);
    const [isTerminalOpen, setIsTerminalOpen] = useState(false);
    const [errorMessage, setErrorMessage] = useState<string>('');

    // Refs
    const containerRef = useRef<WebContainer | null>(null);
    const currentFilesRef = useRef<string>('');

    // Helpers
    const addLog = useCallback((msg: string) => {
        setLogs(prev => [...prev.slice(-100), `[${new Date().toLocaleTimeString()}] ${msg}`]);
    }, []);

    // Detect framework
    const detectedFramework = template || detectFramework(files);

    // === BOOT & MOUNT ===
    useEffect(() => {
        let isMounted = true;

        async function bootAndMount() {
            try {
                // Skip if files haven't changed
                const filesHash = JSON.stringify(files);
                if (filesHash === currentFilesRef.current && containerRef.current) {
                    return;
                }
                currentFilesRef.current = filesHash;

                // Boot WebContainer (singleton)
                // First check if we already have a global instance (survives hot reload)
                const existingInstance = getGlobalWebContainer();
                if (existingInstance) {
                    addLog('♻️ Reusing existing WebContainer instance');
                    containerRef.current = existingInstance;
                } else if (!webcontainerBootPromise) {
                    // CRITICAL: Check if crossOriginIsolated is enabled
                    if (typeof window !== 'undefined' && !window.crossOriginIsolated) {
                        const errorMsg = 'WebContainer requires Cross-Origin Isolation. Please ensure COOP/COEP headers are set.';
                        console.error('❌ ' + errorMsg);
                        addLog('❌ ' + errorMsg);
                        setErrorMessage(errorMsg);
                        setStatus('error');
                        return;
                    }

                    setStatus('booting');
                    addLog('✅ crossOriginIsolated enabled, booting WebContainer...');

                    try {
                        webcontainerBootPromise = WebContainer.boot();
                        const bootedInstance = await webcontainerBootPromise;
                        setGlobalWebContainer(bootedInstance);
                        containerRef.current = bootedInstance;
                    } catch (bootError: any) {
                        // Handle duplicate boot gracefully
                        if (bootError?.message?.includes('Only a single WebContainer instance')) {
                            addLog('♻️ WebContainer already booted, attempting reuse...');
                            // Wait and retry to get the existing instance
                            const retryInstance = getGlobalWebContainer();
                            if (retryInstance) {
                                containerRef.current = retryInstance;
                            } else {
                                throw bootError;
                            }
                        } else {
                            webcontainerBootPromise = null; // Reset to allow retry
                            throw bootError;
                        }
                    }
                } else {
                    const pendingInstance = await webcontainerBootPromise;
                    if (!isMounted) return;
                    setGlobalWebContainer(pendingInstance);
                    containerRef.current = pendingInstance;
                }

                // CRITICAL: Get instance from ref (unified for all branches)
                const instance = containerRef.current;
                if (!instance) {
                    throw new Error('WebContainer instance not available');
                }

                // Convert files to WebContainer format
                setStatus('mounting');
                addLog(`Mounting ${Object.keys(files).length} files...`);

                // Build proper nested directory structure for WebContainer
                // WebContainer requires: { dir: { directory: { file: { contents } } } }
                const buildFileTree = (files: Record<string, string>) => {
                    const tree: any = {};

                    for (const [path, content] of Object.entries(files)) {
                        const sanitizedPath = sanitizeFilePath(path);
                        if (!sanitizedPath) continue;

                        const parts = sanitizedPath.split('/');
                        let current = tree;

                        // Navigate/create directories
                        for (let i = 0; i < parts.length - 1; i++) {
                            const dir = parts[i];
                            if (!current[dir]) {
                                current[dir] = { directory: {} };
                            }
                            current = current[dir].directory;
                        }

                        // Add file at the end
                        const fileName = parts[parts.length - 1];
                        // CRITICAL: Sanitize JSX/TSX syntax BEFORE mounting (Lovable/Bolt-style auto-fix)
                        const sanitizedContent = sanitizeJSXSyntax(content, fileName);
                        current[fileName] = { file: { contents: sanitizedContent } };
                    }

                    return tree;
                };

                const mountFiles = buildFileTree(files);

                // CRITICAL: If framework is Vite, ALWAYS replace package.json with Vite-compatible version
                // This handles CRA projects that were auto-converted to Vite
                if (detectedFramework === 'vite') {
                    const vitePackageJson = generatePackageJson('vite');
                    mountFiles['package.json'] = { file: { contents: vitePackageJson } };
                    addLog('📦 Using Vite-compatible package.json');
                } else if (!mountFiles['package.json']) {
                    // Only generate if missing for other frameworks
                    const packageJsonContent = generatePackageJson(detectedFramework, files['package.json']);
                    mountFiles['package.json'] = { file: { contents: packageJsonContent } };
                }

                // Inject vite bootstrap files if needed (index.html, main.jsx, vite.config.js)
                injectViteBootstrap(mountFiles, detectedFramework);

                await instance.mount(mountFiles);
                if (!isMounted) return;
                addLog('Files mounted successfully');

                // Install dependencies
                setStatus('installing');
                addLog('Running npm install...');

                // DEBUG: Log what package.json is being used
                console.log('📦 [WebContainer] Starting npm install for framework:', detectedFramework);
                console.log('📦 [WebContainer] Package.json mounted:', !!mountFiles['package.json']);

                // FIX: Add timeout to prevent infinite hang on heavy packages
                const installProcess = await instance.spawn('npm', ['install', '--legacy-peer-deps', '--prefer-offline']);

                installProcess.output.pipeTo(new WritableStream({
                    write(data) {
                        addLog(`[npm] ${data}`);
                        // Log progress for debugging
                        if (data.includes('added')) {
                            console.log('📦 [WebContainer] npm progress:', data.trim());
                        }
                    }
                }));

                // FIX: 180 second timeout for npm install (larger projects need more time)
                const installTimeout = new Promise<number>((_, reject) =>
                    setTimeout(() => reject(new Error('npm install timeout (180s) - trying to proceed anyway')), 180000)
                );

                let installExitCode = 0;
                try {
                    installExitCode = await Promise.race([installProcess.exit, installTimeout]) as number;
                    console.log('📦 [WebContainer] npm install exited with code:', installExitCode);
                } catch (timeoutError) {
                    addLog('⚠️ npm install timed out, attempting to start server anyway...');
                    console.warn('📦 [WebContainer] npm install timeout, forcing continue');
                    // Note: WebContainer spawn doesn't have kill() method, just continue
                }
                if (!isMounted) return;

                if (installExitCode !== 0 && installExitCode !== undefined) {
                    addLog(`⚠️ npm install exited with code ${installExitCode}, trying to continue...`);
                    console.warn('📦 [WebContainer] npm install non-zero exit:', installExitCode);
                }
                addLog('Dependencies installed (or timeout reached)');

                // Start server
                setStatus('starting');
                const { cmd, args } = getStartCommand(detectedFramework);
                addLog(`Starting server: ${cmd} ${args.join(' ')}`)
                console.log('🚀 [WebContainer] Starting server:', cmd, args.join(' '));

                const startProcess = await instance.spawn(cmd, args);
                if (!isMounted) return;

                // Track if server started successfully
                let serverStarted = false;

                startProcess.output.pipeTo(new WritableStream({
                    write(data) {
                        addLog(`[server] ${data}`);
                        console.log('🚀 [WebContainer] Server output:', data.substring(0, 100));

                        // Extract URL from Vite output (e.g., "Local: http://localhost:5173/")
                        const urlMatch = data.match(/https?:\/\/localhost:\d+\/?/);
                        if (urlMatch && !serverStarted) {
                            serverStarted = true;
                            const extractedUrl = urlMatch[0];
                            console.log('✅ [WebContainer] Extracted URL from output:', extractedUrl);

                            if (isMounted) {
                                // FIX: Must set previewUrl, not just status!
                                setPreviewUrl(extractedUrl);
                                setStatus('ready');
                                addLog(`Server ready at ${extractedUrl}`);
                                onServerReady?.(extractedUrl);
                            }
                        }

                        // Check for errors
                        if (data.includes('error') || data.includes('Error') || data.includes('ERR!')) {
                            console.error('❌ [WebContainer] Server error:', data);
                        }
                    }
                }));

                // Listen for port event (fires when any port opens/closes)
                // FIX: Use serverStarted flag to prevent duplicate URL setting
                (instance as any).on('port', (port: number, type: 'open' | 'close', url: string) => {
                    if (!isMounted || type !== 'open' || serverStarted) return;
                    console.log('📡 [WebContainer] Port event:', port, type, url);

                    serverStarted = true;
                    setPreviewUrl(url);
                    setStatus('ready');
                    addLog(`Server ready at ${url} (via port event)`);
                    onServerReady?.(url);
                });

                // Listen for server-ready event (official way)
                // FIX: Use serverStarted flag to prevent duplicate URL setting
                (instance as any).on('server-ready', (port: number, url: string) => {
                    if (!isMounted || serverStarted) return;
                    console.log('✅ [WebContainer] Server-ready event fired:', port, url);
                    serverStarted = true;
                    setPreviewUrl(url);
                    setStatus('ready');
                    addLog(`Server ready at ${url}`);
                    onServerReady?.(url);
                });

                // Also listen for errors
                (instance as any).on('error', (error: Error) => {
                    console.error('❌ [WebContainer] Error event:', error);
                });

            } catch (error: any) {
                console.error('WebContainer error:', error);
                if (isMounted) {
                    setStatus('error');
                    setErrorMessage(error.message || 'Unknown error');
                    addLog(`ERROR: ${error.message}`);
                }
            }
        }

        if (files && Object.keys(files).length > 0) {
            bootAndMount();
        }

        return () => {
            isMounted = false;
        };
    }, [files, detectedFramework, addLog, onServerReady]);

    // === REFRESH HANDLER ===
    const handleRefresh = useCallback(async () => {
        if (!containerRef.current) return;
        currentFilesRef.current = ''; // Force remount
        setPreviewUrl('');
        setStatus('mounting');
    }, []);

    // === RENDER ===
    return (
        <div className={`flex flex-col h-full bg-[#020617] ${className}`}>

            {/* Compact Browser Chrome - Single Line */}
            <div className="h-9 border-b border-white/5 flex items-center gap-2 px-3 bg-[#0f172a]/80 backdrop-blur z-20 flex-shrink-0">
                {/* Traffic Lights */}
                <div className="flex gap-1.5 flex-shrink-0">
                    <div className="w-2.5 h-2.5 rounded-full bg-red-500/20 border border-red-500/50" />
                    <div className="w-2.5 h-2.5 rounded-full bg-yellow-500/20 border border-yellow-500/50" />
                    <div className="w-2.5 h-2.5 rounded-full bg-green-500/20 border border-green-500/50" />
                </div>

                {/* URL Bar - Truncated Single Line */}
                <div className="bg-[#1e293b] border border-white/5 rounded h-6 flex items-center px-2 flex-1 min-w-0">
                    <span className="text-[11px] text-gray-400 font-mono truncate">
                        {previewUrl || 'waiting for server...'}
                    </span>
                </div>

                {/* Status Badge */}
                <span className={`text-[10px] font-mono uppercase px-2 py-0.5 rounded flex-shrink-0 ${status === 'ready' ? 'bg-green-500/20 text-green-400' :
                    status === 'error' ? 'bg-red-500/20 text-red-400' :
                        'bg-yellow-500/20 text-yellow-400'
                    }`}>
                    {status}
                </span>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                    <button
                        onClick={handleRefresh}
                        disabled={status === 'booting' || status === 'installing'}
                        className="p-1.5 text-gray-400 hover:text-white hover:bg-white/5 rounded transition disabled:opacity-50"
                        title="Refresh"
                    >
                        <RefreshCw size={14} className={status === 'starting' || status === 'installing' ? 'animate-spin' : ''} />
                    </button>
                    {previewUrl && (
                        <a
                            href={previewUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="p-1.5 text-gray-400 hover:text-white hover:bg-white/5 rounded transition"
                            title="Open in new tab"
                        >
                            <ExternalLink size={14} />
                        </a>
                    )}
                </div>
            </div>

            {/* Preview Canvas */}
            <div className="flex-1 p-2 relative">
                <div className="w-full h-full bg-white rounded-lg overflow-hidden shadow-xl border border-white/10 relative">
                    {/* Iframe */}
                    {previewUrl ? (
                        <iframe
                            src={previewUrl}
                            className="w-full h-full border-none"
                            allow="cross-origin-isolated"
                            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
                        />
                    ) : (
                        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gray-900 text-white">
                            <div className="relative">
                                <div className="absolute inset-0 bg-indigo-500 blur-xl opacity-20 animate-pulse" />
                                <Loader2 size={40} className="relative z-10 text-indigo-500 animate-spin" />
                            </div>
                            <div className="mt-4 text-sm font-medium text-gray-500">
                                {status === 'booting' && 'Booting WebContainer...'}
                                {status === 'mounting' && 'Mounting files...'}
                                {status === 'installing' && 'Installing dependencies...'}
                                {status === 'starting' && 'Starting server...'}
                                {status === 'idle' && 'Initializing...'}
                                {status === 'error' && `Error: ${errorMessage}`}
                            </div>
                        </div>
                    )}

                    {/* Loading Overlay */}
                    {status !== 'ready' && status !== 'error' && previewUrl && (
                        <div className="absolute inset-0 bg-gray-900/50 backdrop-blur-sm flex items-center justify-center z-50">
                            <div className="bg-[#1e293b] border border-white/10 px-6 py-3 rounded-full shadow-2xl flex items-center gap-3">
                                <Loader2 size={16} className="text-indigo-400 animate-spin" />
                                <span className="text-sm font-medium text-gray-200">
                                    {status === 'installing' ? 'Installing modules...' : 'Updating preview...'}
                                </span>
                            </div>
                        </div>
                    )}
                </div>
            </div>

            {/* Terminal */}
            <div className={`border-t border-white/5 bg-[#0f172a] transition-all duration-300 flex flex-col flex-shrink-0 ${isTerminalOpen ? 'h-48' : 'h-9'}`}>
                <button
                    onClick={() => setIsTerminalOpen(!isTerminalOpen)}
                    className="h-9 flex items-center justify-between px-4 text-xs font-medium text-gray-500 hover:text-gray-300 hover:bg-white/5 transition-colors flex-shrink-0"
                >
                    <div className="flex items-center gap-2">
                        <Terminal size={12} />
                        Console
                        {logs.length > 0 && <span className="w-1.5 h-1.5 rounded-full bg-indigo-500" />}
                    </div>
                    {isTerminalOpen ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
                </button>

                {isTerminalOpen && (
                    <div className="flex-1 p-3 overflow-auto font-mono text-[11px] leading-snug text-gray-400 bg-[#0b1221]">
                        {logs.map((log, i) => (
                            <div key={i} className="border-b border-white/5 py-0.5 whitespace-pre-wrap break-all">
                                <span className="text-indigo-500/50 mr-2">$</span>
                                {log}
                            </div>
                        ))}
                        <div ref={el => el?.scrollIntoView({ behavior: 'smooth' })} />
                    </div>
                )}
            </div>
        </div>
    );
}
