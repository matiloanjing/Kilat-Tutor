/**
 * Per-Agent RAG System
 * 
 * Specialized RAG for each agent type with domain-specific knowledge.
 * 
 * Copyright © 2026 KilatOS
 */

import { EnhancedRAG } from '@/lib/rag/EnhancedRAG';
import { kilatCrawl } from '@/lib/agents/crawl/kilatcrawl';
import { fireAndForget } from '@/lib/utils/non-blocking-db';
import { quotaManager } from '@/lib/quota/quota-manager';

// ============================================================================
// Knowledge Base IDs (from migration)
// All 13 agents mapped to their specialized knowledge
// ============================================================================

export const AGENT_KB_MAP: Record<string, { id: string; docs: string[] }> = {
    // Primary code agents
    codegen: {
        id: '11111111-1111-1111-1111-111111111111', // code_examples
        docs: ['https://react.dev/learn', 'https://nextjs.org/docs', 'https://vuejs.org/guide/introduction']
    },
    frontend: {
        id: '11111111-1111-1111-1111-111111111111', // shares with codegen
        docs: ['https://react.dev/learn', 'https://nextjs.org/docs/app']
    },
    backend: {
        id: '11111111-1111-1111-1111-111111111111', // shares with codegen
        docs: ['https://nodejs.org/docs', 'https://expressjs.com/en/starter/installing.html']
    },

    // Design agent
    design: {
        id: '22222222-2222-2222-2222-222222222222', // kb_design
        docs: ['https://tailwindcss.com/docs/installation', 'https://ui.shadcn.com/docs']
    },
    imagegen: {
        id: '22222222-2222-2222-2222-222222222222', // shares with design
        docs: ['https://tailwindcss.com/docs/installation']
    },

    // Research agent
    research: {
        id: '33333333-3333-3333-3333-333333333333', // kb_research
        docs: ['https://en.wikipedia.org/wiki/Main_Page'] // ArXiv/Scholar need API
    },

    // Solve agent (math/logic)
    solve: {
        id: '44444444-4444-4444-4444-444444444444', // kb_solve
        docs: ['https://mathworld.wolfram.com', 'https://www.geeksforgeeks.org/fundamentals-of-algorithms']
    },

    // Guide/tutorial agent
    guide: {
        id: '55555555-5555-5555-5555-555555555555', // kb_guide
        docs: ['https://developer.mozilla.org/en-US/docs/Learn', 'https://www.w3schools.com']
    },

    // Question agent
    question: {
        id: '55555555-5555-5555-5555-555555555555', // shares with guide
        docs: ['https://developer.mozilla.org/en-US/docs/Learn']
    },

    // Cowriter agent
    cowriter: {
        id: '33333333-3333-3333-3333-333333333333', // shares with research
        docs: ['https://en.wikipedia.org/wiki/Main_Page']
    },

    // Crawl agent
    crawl: {
        id: '33333333-3333-3333-3333-333333333333', // shares with research
        docs: [] // Crawl agent doesn't need pre-loaded docs
    },

    // Ideagen agent
    ideagen: {
        id: '33333333-3333-3333-3333-333333333333', // shares with research
        docs: ['https://en.wikipedia.org/wiki/Creativity']
    },

    // Audit agent
    audit: {
        id: '11111111-1111-1111-1111-111111111111', // shares with codegen
        docs: ['https://owasp.org/www-project-top-ten']
    },

    // Chat agent (general)
    chat: {
        id: '55555555-5555-5555-5555-555555555555', // shares with guide
        docs: []
    },

    // Fast mode
    'fast-mode': {
        id: '11111111-1111-1111-1111-111111111111', // shares with codegen
        docs: ['https://react.dev/learn']
    }
};

// ============================================================================
// Types
// ============================================================================

export interface AgentRAGResult {
    agent: string;
    mode: 'cached' | 'fresh' | 'hybrid';
    examples: string[];
    documentation: string;
    citations: Array<{ source: string; url: string }>;
}

export interface AgentRAGConfig {
    agent: string;
    query: string;
    mode?: 'fast' | 'fresh' | 'hybrid';
    userId?: string;
}

// ============================================================================
// Core RAG Function
// ============================================================================

/**
 * Get RAG context for any agent
 */
export async function agenticRAG(config: AgentRAGConfig): Promise<AgentRAGResult> {
    const { agent, query, mode = 'fast', userId } = config;
    const kbConfig = AGENT_KB_MAP[agent] || AGENT_KB_MAP.codegen;

    console.log(`📚 [AgentRAG] ${agent} mode=${mode} query="${query.substring(0, 50)}..."`);

    const rag = new EnhancedRAG();
    const result: AgentRAGResult = {
        agent,
        mode: 'cached',
        examples: [],
        documentation: '',
        citations: []
    };

    try {
        // Phase 1: Search cached knowledge
        const cachedResults = await rag.hybridSearch({
            query: query,
            limit: 5,
            threshold: 0.3,
            filters: { kb_id: kbConfig.id }
        });

        if (cachedResults.length > 0) {
            result.examples = cachedResults.map(r => r.chunk_text).slice(0, 3);
            result.citations = cachedResults.map(r => ({
                source: r.source || 'cached',
                url: (r.metadata as any)?.url || ''
            }));
            console.log(`   ✅ Found ${cachedResults.length} cached results`);
        }

        // Phase 2: Fresh crawl if needed and allowed
        if (mode === 'fresh' || (mode === 'hybrid' && result.examples.length < 2)) {
            const docUrl = kbConfig.docs[0];

            if (docUrl && !docUrl.includes('arxiv') && !docUrl.includes('scholar')) {
                console.log(`   🔍 Crawling fresh: ${docUrl}`);

                try {
                    const crawlResult = await kilatCrawl.crawl(docUrl);
                    result.documentation = crawlResult.markdown?.substring(0, 2000) || '';
                    result.mode = 'fresh';
                    result.citations.push({
                        source: 'live_crawl',
                        url: docUrl
                    });

                    // Track crawl usage
                    if (userId) {
                        fireAndForget(() => quotaManager.incrementUsage(userId, 'crawl'));
                    }
                } catch (crawlError) {
                    console.warn(`   ⚠️ Crawl failed for ${docUrl}:`, crawlError);
                }
            }
        }

        if (mode === 'hybrid' && result.examples.length > 0) {
            result.mode = 'hybrid';
        }

    } catch (error) {
        console.error(`[AgentRAG] Error for ${agent}:`, error);
    }

    return result;
}

// ============================================================================
// Agent-Specific Wrappers
// ============================================================================

export async function ragForDesign(query: string, userId?: string): Promise<AgentRAGResult> {
    return agenticRAG({ agent: 'design', query, mode: 'hybrid', userId });
}

export async function ragForResearch(query: string, userId?: string): Promise<AgentRAGResult> {
    return agenticRAG({ agent: 'research', query, mode: 'fast', userId });
}

export async function ragForSolve(query: string, userId?: string): Promise<AgentRAGResult> {
    return agenticRAG({ agent: 'solve', query, mode: 'fast', userId });
}

export async function ragForGuide(query: string, userId?: string): Promise<AgentRAGResult> {
    return agenticRAG({ agent: 'guide', query, mode: 'hybrid', userId });
}

// ============================================================================
// Format for Prompt Injection
// ============================================================================

export function formatRAGContext(result: AgentRAGResult): string {
    if (result.examples.length === 0 && !result.documentation) {
        return '';
    }

    let context = `\n[${result.agent.toUpperCase()} KNOWLEDGE (${result.mode})]\n`;

    if (result.examples.length > 0) {
        context += '\nRelevant Examples:\n';
        context += result.examples.map((e, i) => `${i + 1}. ${e.substring(0, 500)}`).join('\n\n');
    }

    if (result.documentation) {
        context += '\n\nFresh Documentation:\n' + result.documentation.substring(0, 1000);
    }

    if (result.citations.length > 0) {
        context += '\n\nSources: ' + result.citations.map(c => c.url).filter(u => u).join(', ');
    }

    context += `\n[/${result.agent.toUpperCase()} KNOWLEDGE]\n`;

    return context;
}

// ============================================================================
// AI Learning: Sync Generated Code to KB
// ============================================================================

/**
 * Sync successful code generation to knowledge base for AI learning
 * This enables RAG to use past successful generations as examples
 * 
 * @param userQuery - Original user request
 * @param generatedFiles - Map of filename → code content
 * @param agentType - Which agent generated this (for KB routing)
 */
export async function syncGeneratedCodeToKB(
    userQuery: string,
    generatedFiles: Record<string, string>,
    agentType: string = 'codegen'
): Promise<boolean> {
    try {
        const kbConfig = AGENT_KB_MAP[agentType] || AGENT_KB_MAP.codegen;
        const rag = new EnhancedRAG();

        // Format code examples for RAG
        const codeExamples = Object.entries(generatedFiles)
            .filter(([filename]) =>
                filename.endsWith('.tsx') ||
                filename.endsWith('.ts') ||
                filename.endsWith('.jsx') ||
                filename.endsWith('.js')
            )
            .slice(0, 3) // Limit to top 3 code files
            .map(([filename, content]) => `
\`\`\`${filename.endsWith('.tsx') ? 'tsx' : 'typescript'} filename="${filename}"
${content.substring(0, 1500)}
\`\`\`
            `.trim())
            .join('\n\n');

        if (!codeExamples) return false;

        // Create document for RAG
        const documentText = `
User Request: ${userQuery}

Generated Code:
${codeExamples}
        `.trim();

        // Add to KB (uses supabaseAdmin internally)
        await rag.addDocument({
            kb_id: kbConfig.id,
            text: documentText,
            metadata: {
                type: 'generated_code',
                agent: agentType,
                query_hash: userQuery.substring(0, 50),
                file_count: Object.keys(generatedFiles).length,
                synced_at: new Date().toISOString()
            },
            chunk_size: 512
        });

        console.log(`📚 [RAG Learning] Synced ${Object.keys(generatedFiles).length} files to ${agentType} KB`);
        return true;

    } catch (error) {
        console.error('[RAG Learning] Failed to sync code:', error);
        return false;
    }
}

/**
 * Sync test results back to learning system
 * Helps AI understand what patterns lead to passing/failing tests
 */
export async function syncTestResultsToLearning(
    userQuery: string,
    testResults: {
        success: boolean;
        passed: number;
        failed: number;
        total: number;
        issues?: string[];
    },
    generatedFiles: Record<string, string>
): Promise<boolean> {
    try {
        const rag = new EnhancedRAG();

        // Get main code file
        const appCode = generatedFiles['App.tsx'] || generatedFiles['src/App.tsx'] || '';
        const codeSnippet = appCode.substring(0, 1000);

        // Create learning document
        const documentText = `
User Request: ${userQuery}

Test Results:
- Passed: ${testResults.passed}/${testResults.total}
- Success: ${testResults.success ? 'YES' : 'NO'}
${testResults.issues?.length ? `- Issues: ${testResults.issues.join(', ')}` : ''}

Code Pattern:
\`\`\`tsx
${codeSnippet}
\`\`\`
        `.trim();

        await rag.addDocument({
            kb_id: 'kb_codegen',
            text: documentText,
            metadata: {
                type: 'test_results',
                success: testResults.success,
                pass_rate: testResults.total > 0 ? testResults.passed / testResults.total : 0,
                synced_at: new Date().toISOString()
            },
            chunk_size: 512
        });

        console.log(`🧪 [RAG Learning] Synced test results: ${testResults.passed}/${testResults.total}`);
        return true;

    } catch (error) {
        console.error('[RAG Learning] Failed to sync test results:', error);
        return false;
    }
}

/**
 * Sync fallback pattern to learning
 * Tracks when fallback models succeed so AI can learn better model selection
 */
export async function syncFallbackPatternToLearning(params: {
    originalModel: string;
    successModel: string;
    promptStyle: string;
    promptSnippet: string;
    userId?: string;
}): Promise<boolean> {
    try {
        const rag = new EnhancedRAG(params.userId);

        const documentText = `
# Image Generation Fallback Pattern

## Context
- Original model failed: ${params.originalModel}
- Success model: ${params.successModel}  
- Prompt style: ${params.promptStyle}

## Prompt Snippet
"${params.promptSnippet}"

## Learning
For "${params.promptStyle}" style prompts, prefer ${params.successModel} over ${params.originalModel} when ${params.originalModel} is unavailable.

## Recorded
${new Date().toISOString()}
        `.trim();

        await rag.addDocument({
            kb_id: 'kb_design', // imagegen shares with design KB
            text: documentText,
            metadata: {
                type: 'fallback_pattern',
                original_model: params.originalModel,
                success_model: params.successModel,
                prompt_style: params.promptStyle,
                synced_at: new Date().toISOString()
            },
            chunk_size: 256
        });

        console.log(`📊 [RAG Learning] Synced fallback: ${params.originalModel} → ${params.successModel}`);
        return true;

    } catch (error) {
        console.error('[RAG Learning] Failed to sync fallback pattern:', error);
        return false;
    }
}

export default {
    agenticRAG,
    ragForDesign,
    ragForResearch,
    ragForSolve,
    ragForGuide,
    formatRAGContext,
    syncGeneratedCodeToKB,
    syncTestResultsToLearning,
    syncFallbackPatternToLearning,
    AGENT_KB_MAP
};
