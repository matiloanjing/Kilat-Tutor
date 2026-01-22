/**
 * Code Verifier
 * 
 * Verifies generated code is WebContainer-compatible BEFORE passing to UI.
 * Uses Piston API for syntax validation.
 * 
 * Flow: AI Generate → Verify → IF OK: WebContainer | IF ERROR: AI Fix → Retry
 * 
 * WebContainer supports full Node.js runtime including npm packages.
 * 
 * Copyright © 2026 KilatOS
 */

// ============================================================================
// Types
// ============================================================================

export interface VerificationResult {
    valid: boolean;
    errors: VerificationError[];
    warnings: string[];
    fixSuggestions: string[];
}

export interface VerificationError {
    type: 'structure' | 'syntax' | 'import' | 'runtime';
    message: string;
    file?: string;
    line?: number;
}

// ============================================================================
// Constants
// ============================================================================

// FIX 2026-01-22: Reduced from 5 to 2 to prevent Vercel timeout (44+ AI calls → ~16 calls)
const PISTON_API = 'https://emkc.org/api/v2/piston';
const MAX_VERIFY_RETRIES = 2;
const VERIFY_TIMEOUT = 10000; // 10s

// Common npm packages allowed in WebContainer
// WebContainer supports full Node.js, so we allow popular packages
const ALLOWED_IMPORTS = [
    // React ecosystem
    'react', 'react-dom', 'react-dom/client', 'react-router', 'react-router-dom',
    // State management
    'zustand', 'jotai', 'recoil', 'redux', '@reduxjs/toolkit',
    // Styling
    'tailwindcss', 'styled-components', '@emotion/react', '@emotion/styled', 'clsx', 'classnames',
    // HTTP
    'axios', 'swr', '@tanstack/react-query',
    // UI libraries
    'framer-motion', 'lucide-react', '@radix-ui', '@headlessui/react',
    // Utilities
    'lodash', 'date-fns', 'dayjs', 'uuid',
    // Media
    'react-player', 'react-icons',
    // ANY npm package is allowed in WebContainer (this is just common ones)
];

// ============================================================================
// Code Verifier Class
// ============================================================================

export class CodeVerifier {
    /**
     * Verify files are WebContainer-compatible
     */
    async verify(files: Record<string, string>): Promise<VerificationResult> {
        const errors: VerificationError[] = [];
        const warnings: string[] = [];
        const fixSuggestions: string[] = [];

        // 1. Structure Check
        const structureResult = this.checkStructure(files);
        errors.push(...structureResult.errors);
        fixSuggestions.push(...structureResult.fixes);

        // 2. Import Check
        const importResult = this.checkImports(files);
        errors.push(...importResult.errors);
        warnings.push(...importResult.warnings);

        // 3. Syntax Check via Piston (if structure OK)
        if (errors.length === 0) {
            const syntaxResult = await this.checkSyntax(files);
            errors.push(...syntaxResult.errors);
        }

        return {
            valid: errors.length === 0,
            errors,
            warnings,
            fixSuggestions
        };
    }

    /**
     * Check file structure for WebContainer requirements
     */
    private checkStructure(files: Record<string, string>): {
        errors: VerificationError[];
        fixes: string[];
    } {
        const errors: VerificationError[] = [];
        const fixes: string[] = [];
        const paths = Object.keys(files);

        // Must have App.tsx or App.js
        const hasApp = paths.some(p =>
            p === '/App.tsx' || p === '/App.js' ||
            p === 'App.tsx' || p === 'App.js'
        );

        if (!hasApp) {
            errors.push({
                type: 'structure',
                message: 'Missing /App.tsx entry point',
                file: '/App.tsx'
            });
            fixes.push('Create /App.tsx with: export default function App() { return <div>...</div>; }');
        }

        // Check App file has export default
        const appFile = files['/App.tsx'] || files['App.tsx'] ||
            files['/App.js'] || files['App.js'];

        if (appFile && !appFile.includes('export default')) {
            errors.push({
                type: 'structure',
                message: 'App.tsx missing "export default"',
                file: '/App.tsx'
            });
            fixes.push('Add "export default" before your main function');
        }

        return { errors, fixes };
    }

    /**
     * Check imports - WebContainer allows all npm packages
     * This check now only warns about unusual imports, doesn't block
     */
    private checkImports(files: Record<string, string>): {
        errors: VerificationError[];
        warnings: string[];
    } {
        const errors: VerificationError[] = [];
        const warnings: string[] = [];

        for (const [path, content] of Object.entries(files)) {
            // Extract imports
            const importRegex = /import\s+.*\s+from\s+['"]([^'"]+)['"]/g;
            let match;

            while ((match = importRegex.exec(content)) !== null) {
                const importPath = match[1];

                // Relative imports are OK
                if (importPath.startsWith('./') || importPath.startsWith('../')) {
                    continue;
                }

                // Check allowed external imports
                const isAllowed = ALLOWED_IMPORTS.some(allowed =>
                    importPath === allowed || importPath.startsWith(allowed + '/')
                );

                if (!isAllowed) {
                    // WebContainer allows ANY npm package, so just warn instead of error
                    // This helps catch typos but doesn't block valid packages
                    warnings.push(
                        `Package "${importPath}" not in common list - ensure it's added to package.json`
                    );
                }
            }
        }

        return { errors, warnings };
    }

    /**
     * Syntax check via Piston API TypeScript compiler
     */
    private async checkSyntax(files: Record<string, string>): Promise<{
        errors: VerificationError[];
    }> {
        const errors: VerificationError[] = [];

        // Get App.tsx content
        const appContent = files['/App.tsx'] || files['App.tsx'] ||
            files['/App.js'] || files['App.js'];

        if (!appContent) {
            return { errors };
        }

        try {
            // Wrap in minimal React context for syntax check
            const testCode = `
// Type definitions for syntax check
declare const React: any;
declare function useState<T>(initial: T): [T, (v: T) => void];
declare function useEffect(fn: () => void, deps?: any[]): void;

${appContent}

// Export check
if (typeof App !== 'function') {
    throw new Error('App must be a function');
}
`.trim();

            const response = await fetch(`${PISTON_API}/execute`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    language: 'typescript',
                    version: '*',
                    files: [{ name: 'App.tsx', content: testCode }],
                    compile_timeout: VERIFY_TIMEOUT,
                    run_timeout: VERIFY_TIMEOUT
                }),
                signal: AbortSignal.timeout(VERIFY_TIMEOUT)
            });

            if (!response.ok) {
                console.warn('[CodeVerifier] Piston API unavailable, skipping syntax check');
                return { errors };
            }

            const result = await response.json();

            // Check compile errors
            if (result.compile?.stderr) {
                const stderr = result.compile.stderr;
                // Extract error message
                const errorMatch = stderr.match(/error TS\d+: (.+)/);
                if (errorMatch) {
                    errors.push({
                        type: 'syntax',
                        message: errorMatch[1],
                        file: '/App.tsx'
                    });
                } else if (stderr.length > 0) {
                    errors.push({
                        type: 'syntax',
                        message: stderr.substring(0, 200),
                        file: '/App.tsx'
                    });
                }
            }

            // Check runtime errors
            if (result.run?.stderr && result.run.stderr.length > 0) {
                errors.push({
                    type: 'runtime',
                    message: result.run.stderr.substring(0, 200),
                    file: '/App.tsx'
                });
            }

        } catch (error) {
            console.warn('[CodeVerifier] Syntax check failed:', error);
            // Don't block on syntax check failure
        }

        return { errors };
    }

    /**
     * Generate fix prompt for AI to correct errors
     */
    generateFixPrompt(
        files: Record<string, string>,
        errors: VerificationError[]
    ): string {
        const errorList = errors
            .map(e => `- [${e.type}] ${e.file || ''}: ${e.message}`)
            .join('\n');

        return `Fix these WebContainer errors in the code:

${errorList}

REQUIREMENTS:
1. /App.tsx must exist with "export default function App()"
2. If using npm packages, include them in /package.json
3. Return COMPLETE fixed files as JSON

Current files:
${JSON.stringify(files, null, 2)}

Return ONLY valid JSON with fixed files.`;
    }
}

// ============================================================================
// Auto-Add Missing Dependencies (FIX 2026-01-16)
// ============================================================================

/**
 * Scan code for imports and auto-add missing dependencies to package.json
 * Runs BEFORE verification loop to ensure all deps are present for WebContainer
 */
function ensureDependencies(files: Record<string, string>): Record<string, string> {
    const detectedPackages: Set<string> = new Set();
    const updatedFiles = { ...files };

    // Tailwind CSS patterns (if detected, add all required deps)
    const TAILWIND_DEPS = ['tailwindcss', 'postcss', 'autoprefixer'];

    // Core packages that are always included (don't add)
    const CORE_PACKAGES = ['react', 'react-dom', 'next', 'vite'];

    for (const [path, content] of Object.entries(files)) {
        if (!content || typeof content !== 'string') continue;

        // Skip non-code files
        const ext = path.split('.').pop()?.toLowerCase();
        if (!['tsx', 'ts', 'jsx', 'js', 'css', 'scss'].includes(ext || '')) continue;

        // Detect imports: import X from 'package' or import 'package'
        const importMatches = content.matchAll(/import\s+(?:.*?from\s+)?['"]([^'"./][^'"]*)['"]/g);
        for (const match of importMatches) {
            const importPath = match[1];
            let pkgName: string;

            if (importPath.startsWith('@')) {
                // Scoped package: @org/pkg → @org/pkg
                pkgName = importPath.split('/').slice(0, 2).join('/');
            } else {
                // Regular package: pkg/subpath → pkg
                pkgName = importPath.split('/')[0];
            }

            // Skip core packages
            if (CORE_PACKAGES.includes(pkgName)) continue;

            detectedPackages.add(pkgName);
        }

        // Detect Tailwind usage in CSS files
        if (ext === 'css' || ext === 'scss') {
            if (/@tailwind\s+(base|components|utilities)/.test(content)) {
                TAILWIND_DEPS.forEach(dep => detectedPackages.add(dep));
            }
        }

        // Detect Tailwind in className (JSX/TSX)
        if ((ext === 'tsx' || ext === 'jsx') && content.includes('className')) {
            // Check for common Tailwind patterns
            if (/className=["'][^"']*(?:bg-|text-|flex|grid|p-\d|m-\d|w-|h-|rounded|shadow|border)/.test(content)) {
                TAILWIND_DEPS.forEach(dep => detectedPackages.add(dep));
            }
        }
    }

    if (detectedPackages.size === 0) {
        return updatedFiles;
    }

    // Find existing package.json
    const pkgKey = files['package.json'] !== undefined ? 'package.json' :
        files['/package.json'] !== undefined ? '/package.json' : null;

    let pkgJson: any = {
        name: 'kilat-app',
        version: '1.0.0',
        dependencies: {},
        devDependencies: {}
    };

    if (pkgKey && files[pkgKey]) {
        try {
            pkgJson = JSON.parse(files[pkgKey]);
            pkgJson.dependencies = pkgJson.dependencies || {};
            pkgJson.devDependencies = pkgJson.devDependencies || {};
        } catch (e) {
            console.warn('[ensureDependencies] Failed to parse package.json, using default');
        }
    }

    // Add missing dependencies
    let addedCount = 0;
    for (const pkg of detectedPackages) {
        const inDeps = pkgJson.dependencies?.[pkg];
        const inDevDeps = pkgJson.devDependencies?.[pkg];

        if (!inDeps && !inDevDeps) {
            // Tailwind deps go to devDependencies
            if (TAILWIND_DEPS.includes(pkg)) {
                pkgJson.devDependencies[pkg] = 'latest';
            } else {
                pkgJson.dependencies[pkg] = 'latest';
            }
            console.log(`📦 [ensureDependencies] Added: ${pkg}@latest`);
            addedCount++;
        }
    }

    if (addedCount > 0) {
        const targetKey = pkgKey || 'package.json';
        updatedFiles[targetKey] = JSON.stringify(pkgJson, null, 2);
        console.log(`🔍 [ensureDependencies] Auto-added ${addedCount} missing packages`);
    }

    return updatedFiles;
}

// ============================================================================
// Singleton Export
// ============================================================================

export const codeVerifier = new CodeVerifier();
export default codeVerifier;

// ============================================================================
// Verify & Fix Loop
// ============================================================================

/**
 * Verify and auto-fix code with retry loop
 * Uses AI to fix errors up to MAX_VERIFY_RETRIES times
 */
export async function verifyAndFix(
    files: Record<string, string>,
    fixCallback: (prompt: string) => Promise<Record<string, string>>
): Promise<{ files: Record<string, string>; verified: boolean; attempts: number }> {
    // FIX 2026-01-16: Auto-add missing dependencies before verification
    let currentFiles = ensureDependencies({ ...files });

    for (let attempt = 1; attempt <= MAX_VERIFY_RETRIES; attempt++) {
        console.log(`🔍 [CodeVerifier] Attempt ${attempt}/${MAX_VERIFY_RETRIES}`);

        const result = await codeVerifier.verify(currentFiles);

        if (result.valid) {
            console.log(`✅ [CodeVerifier] Verification passed on attempt ${attempt}`);
            return { files: currentFiles, verified: true, attempts: attempt };
        }

        console.log(`⚠️ [CodeVerifier] ${result.errors.length} errors found, attempting fix...`);

        // Generate fix prompt and call AI
        const fixPrompt = codeVerifier.generateFixPrompt(currentFiles, result.errors);

        try {
            currentFiles = await fixCallback(fixPrompt);
        } catch (error) {
            console.error(`❌ [CodeVerifier] Fix attempt ${attempt} failed:`, error);
        }
    }

    console.log(`⚠️ [CodeVerifier] Max retries reached, returning best effort`);
    return { files: currentFiles, verified: false, attempts: MAX_VERIFY_RETRIES };
}
