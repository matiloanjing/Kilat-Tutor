/**
 * QStash Client for Background Job Processing
 * 
 * Uses Upstash QStash to run long-running jobs outside Vercel Lambda timeout.
 * Supports 15min+ execution with automatic retries.
 * 
 * Copyright © 2026 KilatCode Studio
 */

import { Client, Receiver } from '@upstash/qstash';

// ============================================================================
// QSTASH CLIENT (For publishing messages)
// ============================================================================

if (!process.env.QSTASH_TOKEN) {
    console.warn('⚠️ QSTASH_TOKEN not set - background jobs will fall back to fire-and-forget');
}

export const qstash = new Client({
    token: process.env.QSTASH_TOKEN || '',
});

// ============================================================================
// QSTASH RECEIVER (For verifying incoming webhooks)
// ============================================================================

export const qstashReceiver = new Receiver({
    currentSigningKey: process.env.QSTASH_CURRENT_SIGNING_KEY || '',
    nextSigningKey: process.env.QSTASH_NEXT_SIGNING_KEY || '',
});

// ============================================================================
// JOB PAYLOAD TYPE
// ============================================================================

export interface QStashJobPayload {
    jobId: string;
    message: string;
    mode: 'planning' | 'fast';
    selectedModel: string;
    sessionId?: string;
    userId: string;
    agentType: string;
    attachments?: any[];
    authToken?: string; // For RLS-scoped Supabase client
}

// ============================================================================
// HELPER: Publish Job to QStash
// ============================================================================

/**
 * Publish a job to QStash for background processing
 * Returns messageId if successful, null if fallback to fire-and-forget
 */
export async function publishJobToQStash(
    payload: QStashJobPayload,
    baseUrl: string
): Promise<{ messageId: string | null; fallback: boolean }> {
    // Check if QStash is configured
    if (!process.env.QSTASH_TOKEN) {
        console.warn('⚠️ QStash not configured, using fallback');
        return { messageId: null, fallback: true };
    }

    try {
        const targetUrl = `${baseUrl}/api/kilat/process-job`;

        const response = await qstash.publishJSON({
            url: targetUrl,
            body: payload,
            retries: 3,
            // Callback on completion (optional - for monitoring)
            // callback: `${baseUrl}/api/kilat/job-callback`,
            // 15 minute timeout (QStash max)
            timeout: '15m',
        });

        console.log(`✅ Job ${payload.jobId} queued to QStash: ${response.messageId}`);
        return { messageId: response.messageId, fallback: false };
    } catch (error) {
        console.error('❌ QStash publish failed:', error);
        return { messageId: null, fallback: true };
    }
}

// ============================================================================
// HELPER: Verify QStash Webhook Signature
// ============================================================================

/**
 * Verify that the request came from QStash (not a random attacker)
 */
export async function verifyQStashSignature(
    signature: string,
    body: string
): Promise<boolean> {
    if (!process.env.QSTASH_CURRENT_SIGNING_KEY) {
        console.warn('⚠️ QStash signing keys not configured, skipping verification');
        return true; // Allow in dev mode
    }

    try {
        const isValid = await qstashReceiver.verify({
            signature,
            body,
        });
        return isValid;
    } catch (error) {
        console.error('❌ QStash signature verification failed:', error);
        return false;
    }
}
