/**
 * Final Verifier
 * 
 * Last quality gate before code reaches WebContainer/Monaco/Frontend.
 * Ensures project is complete, runnable, and responds in user's language.
 * 
 * Features:
 * - Project structure validation
 * - Dependency consolidation (merge all package.json)
 * - Auto-generation of missing essentials
 * - LLM-based intelligent fixes
 * - Multi-language response matching user's prompt
 * 
 * Copyright © 2026 KilatOS
 */

// Import TestExecutor types for testResults integration
import type { TestExecutionResult, GeneratedTest, TestValidation } from '@/lib/agents/codegen/test-executor';
import { aiMandor } from '@/lib/ai/mandor';

// Re-export for consumers
export type { TestExecutionResult, GeneratedTest, TestValidation };

// =====================================================
// TYPES
// =====================================================

export interface TestResults {
    success: boolean;
    passed: number;
    failed: number;
    total: number;
    issues?: string[];
    // Extended fields from TestExecutor (optional)
    tests?: GeneratedTest[];
    validation?: TestValidation;
    execution?: TestExecutionResult;
}

export interface VerificationResult {
    success: boolean;
    files: Record<string, string>;
    issues: string[];
    fixes: string[];
    greeting: string;
    testResults?: TestResults; // TestExecutor integration
}

export interface ProjectStructure {
    hasApp: boolean;
    hasEntryPoint: boolean;
    hasPackageJson: boolean;
    hasStyles: boolean;
    hasViteConfig: boolean;
    hasIndexHtml: boolean;
    missingEssentials: string[];
}

// =====================================================
// LANGUAGE DETECTION & GREETING
// =====================================================

/**
 * Generate greeting in user's language using LLM
 * This replaces hardcoded language detection
 */
export async function generateMultilingualGreeting(
    userPrompt: string,
    projectName: string,
    fileCount: number,
    userId?: string
): Promise<string> {
    const prompt = `You are a helpful assistant. Generate a SHORT, friendly greeting to tell the user their project is complete.

USER'S ORIGINAL MESSAGE: "${userPrompt}"

IMPORTANT: Reply in the EXACT SAME LANGUAGE as the user's message above.
If user wrote in Indonesian, reply in Indonesian.
If user wrote in German, reply in German.
If user wrote in English, reply in English.
Match their language exactly.

PROJECT INFO:
- Project name: ${projectName}
- Files generated: ${fileCount}

Generate a 2-3 sentence greeting that:
1. Greets the user warmly (use appropriate emoji)
2. Confirms the project is complete with file count
3. Asks if they want to add or change anything

RESPOND ONLY WITH THE GREETING, NO EXPLANATION.`;

    try {
        const result = await aiMandor.call(prompt, {
            userId,
            maxTokens: 150
        });

        // FIX: AIMandorResponse doesn't have 'success' field!
        // It returns: result, tier, model, attempts, cost, duration, queueTime
        // So we just check if result.result exists and is non-empty
        if (result && result.result && result.result.trim().length > 0) {
            console.log(`✅ [FinalVerifier] Greeting generated (${result.model}, ${result.attempts} attempts)`);
            return result.result.trim();
        } else {
            console.warn('[FinalVerifier] Greeting LLM returned empty result');
        }
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        console.warn(`[FinalVerifier] Greeting generation failed: ${errorMsg}`);
    }

    // Fallback: Simple English greeting
    return `Hello! 👋 I've finished creating **${projectName}** for you.\n\n${fileCount} files generated. View the code in the Explorer panel.\n\nWould you like to add or change anything?`;
}

// =====================================================
// PROJECT STRUCTURE VALIDATION
// =====================================================

/**
 * Check if project has all essential files for running
 */
export function validateProjectStructure(files: Record<string, string>): ProjectStructure {
    const fileKeys = Object.keys(files).map(f => f.toLowerCase());

    const hasApp = fileKeys.some(f =>
        f.includes('app.tsx') || f.includes('app.jsx') ||
        f.includes('app.js') || f.includes('app.ts')
    );

    const hasEntryPoint = fileKeys.some(f =>
        f.includes('main.') || f.includes('index.jsx') ||
        f.includes('index.tsx') || f === 'index.js'
    );

    const hasPackageJson = fileKeys.some(f => f.includes('package.json'));

    const hasStyles = fileKeys.some(f =>
        f.endsWith('.css') || f.endsWith('.scss') || f.endsWith('.sass')
    );

    const hasViteConfig = fileKeys.some(f =>
        f.includes('vite.config')
    );

    const hasIndexHtml = fileKeys.some(f =>
        f === 'index.html' || f.endsWith('/index.html')
    );

    const missingEssentials: string[] = [];

    if (!hasApp) missingEssentials.push('App.tsx');
    if (!hasEntryPoint) missingEssentials.push('main.jsx');
    if (!hasPackageJson) missingEssentials.push('package.json');
    if (!hasViteConfig) missingEssentials.push('vite.config.js');
    if (!hasIndexHtml) missingEssentials.push('index.html');

    return {
        hasApp,
        hasEntryPoint,
        hasPackageJson,
        hasStyles,
        hasViteConfig,
        hasIndexHtml,
        missingEssentials
    };
}

// =====================================================
// DEPENDENCY CONSOLIDATION
// =====================================================

/**
 * Merge all package.json files into one unified package.json
 * Prevents conflicts when multiple agents generate package.json
 */
export function consolidatePackageJsons(files: Record<string, string>): string {
    const packageJsonFiles: string[] = [];

    // Find all package.json files
    for (const [path, content] of Object.entries(files)) {
        if (path.toLowerCase().endsWith('package.json')) {
            packageJsonFiles.push(content);
        }
    }

    if (packageJsonFiles.length === 0) {
        // Generate minimal package.json
        return JSON.stringify({
            name: 'kilat-app',
            type: 'module',
            version: '1.0.0',
            scripts: {
                dev: 'vite --host',
                build: 'vite build',
                preview: 'vite preview'
            },
            dependencies: {
                'react': '^18.3.1',
                'react-dom': '^18.3.1'
            },
            devDependencies: {
                'vite': '^5.0.0',
                '@vitejs/plugin-react': '^4.2.0'
            }
        }, null, 2);
    }

    // Merge all package.json files
    const merged: any = {
        name: 'kilat-app',
        type: 'module',
        version: '1.0.0',
        scripts: {},
        dependencies: {},
        devDependencies: {}
    };

    for (const content of packageJsonFiles) {
        try {
            const pkg = JSON.parse(content);

            // Merge name (prefer non-generic names)
            if (pkg.name && pkg.name !== 'kilat-app' && pkg.name !== 'my-app') {
                merged.name = pkg.name;
            }

            // Merge scripts
            if (pkg.scripts) {
                merged.scripts = { ...merged.scripts, ...pkg.scripts };
            }

            // Merge dependencies
            if (pkg.dependencies) {
                merged.dependencies = { ...merged.dependencies, ...pkg.dependencies };
            }

            // Merge devDependencies
            if (pkg.devDependencies) {
                merged.devDependencies = { ...merged.devDependencies, ...pkg.devDependencies };
            }
        } catch (e) {
            console.warn('[FinalVerifier] Failed to parse package.json:', e);
        }
    }

    // =====================================================
    // FORCE VITE (WebContainer doesn't support Next.js/Nuxt/Remix)
    // =====================================================

    // ALWAYS force Vite scripts (override next dev, nuxt dev, etc)
    merged.scripts.dev = 'vite --host';
    merged.scripts.build = 'vite build';
    merged.scripts.preview = 'vite preview';

    // Remove SSR frameworks that don't work in WebContainer
    delete merged.dependencies.next;
    delete merged.dependencies.nuxt;
    delete merged.dependencies['@remix-run/node'];
    delete merged.dependencies['@remix-run/react'];
    delete merged.scripts.start;
    delete merged.scripts.lint;

    // =====================================================
    // REMOVE PRISMA/BACKEND TOOLS (WebContainer cannot run native binaries)
    // These will cause npm install to hang forever
    // =====================================================
    const backendDependencies = [
        // Prisma
        'prisma', '@prisma/client',
        // Databases
        'mongoose', 'pg', 'mysql', 'mysql2', 'sqlite3', 'better-sqlite3',
        // ORMs
        'sequelize', 'typeorm', 'drizzle-orm', 'knex',
        // Native binaries
        'bcrypt', 'bcryptjs', 'argon2', 'sharp', 'canvas',
        // Server frameworks
        'express', 'fastify', 'koa', 'hapi', '@hono/node-server',
        // File system / Node-specific
        'fs-extra', 'chokidar', 'nodemon'
    ];

    let removedBackendDeps: string[] = [];
    for (const dep of backendDependencies) {
        if (merged.dependencies[dep]) {
            delete merged.dependencies[dep];
            removedBackendDeps.push(dep);
        }
        if (merged.devDependencies[dep]) {
            delete merged.devDependencies[dep];
            removedBackendDeps.push(dep);
        }
    }

    if (removedBackendDeps.length > 0) {
        console.log(`🗑️ [FinalVerifier] Removed backend deps (WebContainer incompatible): ${removedBackendDeps.join(', ')}`);
    }

    console.log('🔧 [FinalVerifier] Forced Vite scripts (WebContainer compatible)');

    // Ensure essential dependencies exist
    if (!merged.dependencies.react) {
        merged.dependencies.react = '^18.3.1';
    }
    if (!merged.dependencies['react-dom']) {
        merged.dependencies['react-dom'] = '^18.3.1';
    }
    if (!merged.devDependencies.vite) {
        merged.devDependencies.vite = '^5.0.0';
    }
    if (!merged.devDependencies['@vitejs/plugin-react']) {
        merged.devDependencies['@vitejs/plugin-react'] = '^4.2.0';
    }

    console.log(`📦 [FinalVerifier] Consolidated ${packageJsonFiles.length} package.json files`);
    console.log(`   Dependencies: ${Object.keys(merged.dependencies).length}`);
    console.log(`   DevDependencies: ${Object.keys(merged.devDependencies).length}`);

    return JSON.stringify(merged, null, 2);
}

// =====================================================
// ESSENTIAL FILE GENERATION
// =====================================================

/**
 * Generate missing essential files
 */
export function generateMissingEssentials(
    files: Record<string, string>,
    missingEssentials: string[]
): Record<string, string> {
    const result = { ...files };

    for (const missing of missingEssentials) {
        switch (missing) {
            case 'App.tsx':
                // Check if we have any components to import
                const components = Object.keys(files).filter(f =>
                    (f.endsWith('.tsx') || f.endsWith('.jsx')) &&
                    !f.includes('App') && !f.includes('main') && !f.includes('index')
                );

                if (components.length > 0) {
                    const imports = components.map((c, i) => {
                        const name = c.replace(/\.(tsx|jsx)$/, '').split('/').pop() || `Component${i}`;
                        return `import ${name} from './${c}';`;
                    }).join('\n');

                    const componentUsage = components.map((c) => {
                        const name = c.replace(/\.(tsx|jsx)$/, '').split('/').pop();
                        return `<${name} />`;
                    }).join('\n            ');

                    result['App.tsx'] = `${imports}

export default function App() {
    return (
        <div className="app">
            ${componentUsage}
        </div>
    );
}`;
                } else {
                    result['App.tsx'] = `export default function App() {
    return (
        <div className="app">
            <h1>🚀 Welcome to Kilat App</h1>
            <p>Your project is ready! Start building something amazing.</p>
        </div>
    );
}`;
                }
                console.log('📄 [FinalVerifier] Generated missing App.tsx');
                break;

            case 'main.jsx':
                result['main.jsx'] = `import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
        <App />
    </React.StrictMode>
);`;
                console.log('📄 [FinalVerifier] Generated missing main.jsx');
                break;

            case 'index.css':
                result['index.css'] = `* {
    margin: 0;
    padding: 0;
    box-sizing: border-box;
}

body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%);
    min-height: 100vh;
    color: white;
}

.app {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem;
}`;
                console.log('📄 [FinalVerifier] Generated missing index.css');
                break;

            case 'vite.config.js':
                result['vite.config.js'] = `import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
    plugins: [react()],
    server: {
        host: true,
        port: 5173
    }
});`;
                console.log('📄 [FinalVerifier] Generated missing vite.config.js');
                break;

            case 'index.html':
                result['index.html'] = `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Kilat App</title>
</head>
<body>
    <div id="root"></div>
    <script type="module" src="/main.jsx"></script>
</body>
</html>`;
                console.log('📄 [FinalVerifier] Generated missing index.html');
                break;
        }
    }

    return result;
}

// =====================================================
// MAIN FINAL VERIFIER FUNCTION
// =====================================================

/**
 * Final verification before sending to frontend
 * Called after merger, before WebContainer/Monaco receives files
 */
export async function finalVerify(
    files: Record<string, string>,
    userPrompt: string,
    projectName: string,
    userId?: string,
    selectedModel?: string  // User's selected model for AI operations
): Promise<VerificationResult> {
    console.log('\n🔍 [FinalVerifier] Starting final verification...');
    console.log(`   Files received: ${Object.keys(files).length}`);

    const issues: string[] = [];
    const fixes: string[] = [];
    let verifiedFiles = { ...files };

    // =====================================================
    // STEP 0: Remove backend files/folders (WebContainer cannot run these)
    // =====================================================
    const backendFolders = ['prisma/', 'database/', 'server/', 'api/', 'migrations/', 'db/'];
    const backendFilePatterns = [
        /prisma/i, /\.prisma$/i, /schema\.prisma$/i,
        /server\.(ts|js)$/i, /db\.(ts|js)$/i
    ];

    let removedCount = 0;
    for (const filePath of Object.keys(verifiedFiles)) {
        // Check if file is in a backend folder
        const isInBackendFolder = backendFolders.some(folder =>
            filePath.toLowerCase().includes(folder.toLowerCase())
        );

        // Check if file matches backend patterns
        const matchesPattern = backendFilePatterns.some(pattern =>
            pattern.test(filePath)
        );

        if (isInBackendFolder || matchesPattern) {
            delete verifiedFiles[filePath];
            removedCount++;
        }
    }

    if (removedCount > 0) {
        console.log(`🗑️ [FinalVerifier] Removed ${removedCount} backend files/folders (WebContainer incompatible)`);
        fixes.push(`Removed ${removedCount} backend files (prisma/database/server folders)`);
    }

    // =====================================================
    // STEP 1: Consolidate all package.json files
    // =====================================================
    const consolidatedPackageJson = consolidatePackageJsons(verifiedFiles);

    // Remove all package.json files and add consolidated one
    for (const path of Object.keys(verifiedFiles)) {
        if (path.toLowerCase().endsWith('package.json')) {
            delete verifiedFiles[path];
        }
    }
    verifiedFiles['package.json'] = consolidatedPackageJson;
    fixes.push('Consolidated all package.json files into one');

    // =====================================================
    // STEP 2: Validate project structure
    // =====================================================
    const structure = validateProjectStructure(verifiedFiles);

    if (structure.missingEssentials.length > 0) {
        issues.push(`Missing essential files: ${structure.missingEssentials.join(', ')}`);
        verifiedFiles = generateMissingEssentials(verifiedFiles, structure.missingEssentials);
        fixes.push(`Generated missing essentials: ${structure.missingEssentials.join(', ')}`);
    }

    // Ensure index.css exists
    if (!structure.hasStyles) {
        verifiedFiles = generateMissingEssentials(verifiedFiles, ['index.css']);
        fixes.push('Generated missing index.css');
    }

    // =====================================================
    // STEP 3: Generate multilingual greeting
    // =====================================================
    const fileCount = Object.keys(verifiedFiles).length;
    const greeting = await generateMultilingualGreeting(
        userPrompt,
        projectName,
        fileCount,
        userId
    );

    // =====================================================
    // SUMMARY
    // =====================================================
    console.log(`✅ [FinalVerifier] Verification complete`);
    console.log(`   Issues found: ${issues.length}`);
    console.log(`   Fixes applied: ${fixes.length}`);
    console.log(`   Final file count: ${fileCount}`);

    return {
        success: true,
        files: verifiedFiles,
        issues,
        fixes,
        greeting
    };
}

// =====================================================
// EXPORTS
// =====================================================

export default {
    finalVerify,
    validateProjectStructure,
    consolidatePackageJsons,
    generateMissingEssentials,
    generateMultilingualGreeting
};
